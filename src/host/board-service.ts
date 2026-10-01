/**
 * Assembling the board: stored facts → lanes of presented cards.
 *
 * The reducer, the presentation layer, and the stores all already existed; this is
 * the assembly that joins them, and it is deliberately the **only** place that does.
 * Both readers — `orchestrator_board` for the agent and `/dsho/api/board` for the
 * client — build from here, so a card can never say one thing to the model and
 * another to the GUI.
 *
 * ## The display status is the *session* status, and it is not the lane
 *
 * A card carries both, and they are different readings on purpose: the lane's
 * `displayStatus` describes the PR the column was chosen from (the **best**
 * landing), while the card's `status` aggregates the session's **worst** open PR.
 * A30's finished gate reads the session status, and the spinner must read the
 * lane's — the reference's #5081 bug was exactly this confusion, which spun a
 * settled `Mergeable` card forever whenever a sibling PR was still pending.
 *
 * @module dsho/host/board-service
 */

import type { CardReviewer } from '../board/presentation.ts'
import {
  KANBAN_LANES,
  KanbanColumn,
  prFacts,
} from '../contract/kanban.ts'
import type { KanbanPRFacts, KanbanPRFactsInput } from '../contract/kanban.ts'
import { deriveStatus, prStatusFacts, sessionFacts } from '../contract/status.ts'
import { archiveSheet, groupIntoLanes, orderCards, presentCard } from '../board/presentation.ts'
import type { BoardCard, BoardCardView } from '../board/presentation.ts'
import { normalizeIssue } from '../domain/issues.ts'
import { WorkerPhase, isTerminalPhase, normalizeWorker, workerSessionTitle } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { snapshotKey } from './observer-service.ts'
import { changesRequestedCycles, summarizeReviewRuns } from '../review/runs.ts'
import type { ReviewRun } from '../review/runs.ts'
import { isBotAuthor } from '../domain/pr-snapshot.ts'
import type { PrSnapshot } from '../domain/pr-snapshot.ts'
import type { PluginConfig } from '../config/validate.ts'
import { normalizeRepo } from './repo.ts'
import type { Repo } from './repo.ts'
import { toProjectRef } from './settings-service.ts'
import type { ProjectRef } from './settings-service.ts'
import type { LazyFactStore } from './store.ts'

/** What the board needs. */
export interface BoardDeps {
  store: LazyFactStore
  config: PluginConfig
  now?: () => number
  /**
   * The live activity of a worker, when it can be determined.
   *
   * Injected rather than read from the registry directly, so the board can be built
   * without one — and because `unknown` is a real answer that must be reachable:
   * after a restart, before a handle exists, that is the honest reading, and the
   * board must not claim `idle`.
   */
  activityOf?: (workerId: string) => 'active' | 'idle' | 'blocked' | 'waiting_input' | 'exited' | 'unknown'
}

/** The whole board, as both readers see it. */
export interface BoardSnapshot {
  generatedAt: number
  lenses: {
    lanes: Record<string, BoardCardView[]>
    archive: BoardCardView[]
  }
  counts: { total: number; needsAttention: number; byLane: Record<string, number> }
  /**
   * The connected projects, oldest first.
   *
   * Carried on the snapshot rather than fetched separately so the panel can name the
   * project whose settings its "..." menu opens, from the poll it already makes. The
   * settings payload is a separate request because it is only needed once the dialog
   * opens -- and the board poll must not grow with every setting the page gains.
   */
  projects: ProjectRef[]
}

/**
 * The humans who reviewed, and their latest verdict -- one entry per person.
 *
 * A person can review more than once, so the LAST entry for an author wins: an earlier
 * `CHANGES_REQUESTED` followed by an `APPROVED` means they are satisfied, and showing
 * the stale state would make the card claim a person is blocking when they are not.
 *
 * Bots are dropped deliberately. The card is answering "is this waiting on me?", and our
 * own reviewer's approval is already the status line -- repeating it as an avatar would
 * suggest a human had looked.
 */
export function reviewerEvidence(snapshot: PrSnapshot | undefined): CardReviewer[] {
  if (!snapshot || snapshot.fetched !== true) return []
  const latest = new Map<string, CardReviewer>()
  for (const review of snapshot.reviews ?? []) {
    if (review.isBot === true) continue
    const name = (review.author ?? '').trim()
    // A review with no author names no one, and an unnamed badge is worse than none.
    if (name === '') continue
    // Later entries overwrite earlier ones, which is why this walks forward.
    latest.set(name, { name, state: review.state ?? '' })
  }
  return [...latest.values()]
}

/**
 * The card's activity: the protocol's explicit blockage FIRST, live status as fallback.
 *
 * R9 is explicit about the order -- "the protocol tool makes blockage explicit; inference
 * is a fallback, never the primary signal" -- and getting it backwards enables R20, which
 * is rated High: a worker waiting on a person whose session is quiet would be inferred
 * `idle`, then demoted to `No signal` once the grace elapsed, and the card would SILENTLY
 * leave `Needs you` **while the question was still unanswered**.
 *
 * `AgentStatus` cannot carry this. It is only `idle | running`, so a session waiting on a
 * person is indistinguishable from an idle one at that level -- which is precisely why the
 * protocol records the question.
 */
export function cardActivity(
  worker: Worker,
  activityOf?: BoardDeps['activityOf'],
): 'active' | 'idle' | 'blocked' | 'waiting_input' | 'exited' | 'unknown' {
  if (worker.pendingQuestion !== undefined) return 'waiting_input'
  if (worker.phase === WorkerPhase.awaitingHuman) return 'blocked'
  return activityOf?.(worker.id) ?? 'unknown'
}

/** Maps a stored PR snapshot onto the reducer's facts. */
export function toPrFacts(
  snapshot: PrSnapshot | undefined,
  runs: readonly ReviewRun[],
  bounds: { maxReviewRounds: number; autoReviewFailedRetryLimit: number },
): KanbanPRFacts[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const headSha = snapshot.headSha ?? ''
  // Our own provider reviews are excluded by id, because the aggregate
  // `reviewDecision` mixes ours with a person's and cannot tell whose turn it is.
  const ourReviewIds = new Set(runs.map((run) => run.githubReviewId).filter((id): id is string => !!id))
  const external = (snapshot.reviews ?? []).filter((review) => !ourReviewIds.has(review.id))

  // Normalized on the way out, so a caller gets Go's zero values on every field
  // rather than an object with holes. The reducer tolerates holes; a caller reading
  // `facts.externalReview.approved` does not.
  return [
    prFacts({
      url: snapshot.url || `#${snapshot.number}`,
      ...(snapshot.number ? { number: snapshot.number } : {}),
      draft: snapshot.isDraft === true,
      merged: snapshot.state === 'MERGED',
      closed: snapshot.state === 'CLOSED',
      ci: snapshot.ciState === 'unknown' ? '' : snapshot.ciState,
      review: (snapshot.reviewDecision ?? '').toLowerCase(),
      mergeability: (snapshot.mergeable ?? '').toLowerCase(),
      updatedAt: Date.parse(snapshot.updatedAt ?? '') || snapshot.observedAt || 0,
      reviewRun: summarizeReviewRuns({ runs, headSha, bounds }),
      externalReview: {
        approved: external.some((review) => review.state === 'APPROVED'),
        changesRequested: external.some((review) => review.state === 'CHANGES_REQUESTED'),
        comments: external.length > 0 && external.every((review) => review.state === 'COMMENTED'),
      },
    }),
  ]
}

/**
 * Builds one card from a worker and everything attached to it.
 *
 * Exported because it is the unit worth testing: the lane rules are already covered
 * in `../contract/kanban.ts`, so what is unverified is the *joins*.
 */
export function buildCard(options: {
  worker: ReturnType<typeof normalizeWorker>
  issueTitle: string
  issueNumber: number
  prs: KanbanPRFactsInput[]
  branch?: string
  reviewers?: readonly CardReviewer[]
  review?: BoardCard['review']
  activity: string
  config: PluginConfig
  now: number
}): BoardCard {
  const { worker, config } = options
  // DERIVED, once, because hardcoding `false` made two documented behaviours
  // unreachable. `session.isTerminated` short-circuits BOTH derivations -- kanban.ts:475
  // sends the card to the `archive` column, status.ts:190 returns the `Terminated` or
  // `Merged` status -- so with it always false the archive sheet was always empty and
  // those two statuses could never be displayed. The board was fetching
  // `lenses.archive` every poll and rendering a count that was always 0.
  const terminated = isTerminalPhase(worker.phase)

  const session = sessionFacts({
    activity: options.activity,
    lastActivityAt: worker.lastSignalAt,
    hasSignal: worker.lastSignalAt > 0,
    signalExpected: true,
    isTerminated: terminated,
    autoReview: config.autoReview,
    autoInjectReview: config.autoInjectReview,
    autoInjectCI: config.autoInjectCI,
    requireHumanApprovalBeforeReady: config.requireHumanApprovalBeforeReady,
  })
  const status = deriveStatus(session, options.prs.map(prStatusFacts), options.now, config.noSignalGraceMs)

  return {
    id: worker.id,
    sessionId: worker.sessionId,
    title: workerSessionTitle(options.issueNumber, options.issueTitle),
    updatedAt: worker.updatedAt,
    status,
    // `statusReadiness` is deliberately absent: the plugin always knows whether a
    // worker exists, and inventing a `checking` phase here would suppress attention
    // for every card.
    activity: options.activity,
    isTerminated: terminated,
    lastActivityAt: worker.lastSignalAt,
    hasSignal: worker.lastSignalAt > 0,
    signalExpected: true,
    autoReview: config.autoReview,
    autoInjectReview: config.autoInjectReview,
    autoInjectCI: config.autoInjectCI,
    requireHumanApprovalBeforeReady: config.requireHumanApprovalBeforeReady,
    prs: options.prs,
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.reviewers ? { reviewers: options.reviewers } : {}),
    ...(options.review ? { review: options.review } : {}),
  }
}

/**
 * The review evidence the inspector shows, from the runs at the CURRENT head.
 *
 * Head-scoped like everything else about reviews: an earlier head's findings are
 * history, and presenting them as if they applied to the commit under review is the
 * confusion head-scoping exists to prevent.
 */
export function reviewEvidence(
  runs: readonly ReviewRun[],
  headSha: string,
  maxRounds: number,
): BoardCard['review'] | undefined {
  if (headSha === '') return undefined
  const atHead = runs.filter((run) => run.headSha === headSha)
  if (atHead.length === 0) return undefined
  const latest = atHead[atHead.length - 1]!
  // The round to display. A RUNNING pass is the one in progress, so it is the cycles
  // so far plus one; a COMPLETE or FAILED pass already has its own number, and using
  // cycles+1 for it displays a round that has not happened -- which showed a card as
  // `3/3` (budget spent) while the lane below it correctly said `Needs review`. The
  // PRD wants the bound visible so it is not surprising when it trips; a bound that
  // reads as tripped when it has not is the same problem inverted.
  const inProgress = latest.status === 'running'
  return {
    round: inProgress ? changesRequestedCycles(runs) + 1 : (latest.round ?? changesRequestedCycles(runs) + 1),
    maxRounds,
    ...(latest.verdict ? { verdict: latest.verdict } : {}),
    ...(latest.githubReviewId ? { githubReviewId: latest.githubReviewId } : {}),
    findings: (latest.findings ?? []).map((finding) => ({
      severity: finding.severity,
      ...(finding.path ? { path: finding.path } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      summary: finding.summary,
      detail: finding.detail,
    })),
  }
}

/**
 * Assembles the whole board.
 *
 * **One snapshot, no per-card fan-out** (the performance NFR): every store is read
 * once, and the lanes are computed from that in memory.
 */
export async function buildBoard(deps: BoardDeps): Promise<BoardSnapshot> {
  const now = (deps.now ?? Date.now)()
  const store = await deps.store.get()

  const [workers, issues, snapshots, runs, repos] = await Promise.all([
    store.workers.list(),
    store.issues.list(),
    store.prSnapshots.list(),
    store.reviewRuns.list(),
    store.repos.list(),
  ])

  const normalizedIssues = issues.map(normalizeIssue)
  const normalizedRuns = runs.filter(
    (candidate): candidate is ReviewRun => typeof candidate === 'object' && candidate !== null,
  )
  // Keyed by worker id, which is how the OBSERVER writes them (`snapshotKey`). An
  // earlier version matched by URL instead, and the two disagreed the moment a
  // worker's `pr.url` differed from the snapshot's -- so a real pull request never
  // moved a card, silently, even though both halves were individually tested. A live
  // end-to-end run is what surfaced it; a unit test on either side could not.
  const snapshotByWorker = new Map<string, PrSnapshot>()
  for (const worker of workers.map(normalizeWorker)) {
    const snapshot = await store.prSnapshots.get(snapshotKey(worker.id))
    if (snapshot && typeof snapshot === 'object') {
      snapshotByWorker.set(worker.id, snapshot as PrSnapshot)
      continue
    }
    // Tolerate a snapshot written under another key by matching the URL, so a record
    // from an older build still shows on the board rather than vanishing.
    const byUrl = snapshots.find(
      (candidate) => typeof candidate === 'object' && candidate !== null && (candidate as PrSnapshot).url === worker.pr?.url,
    )
    if (byUrl) snapshotByWorker.set(worker.id, byUrl as PrSnapshot)
  }

  const bounds = {
    maxReviewRounds: deps.config.maxReviewRounds,
    autoReviewFailedRetryLimit: deps.config.autoReviewFailedRetryLimit,
  }

  const cards = workers.map(normalizeWorker).map((worker) => {
    const issue = normalizedIssues.find((candidate) => candidate.id === worker.issueId)
    const workerRuns = normalizedRuns.filter((run) => run.workerId === worker.id)
    // Computed before the literal: the review evidence is a lookup, and repeating it
    // inside a spread conditional reads as though the two calls could differ.
    const review = reviewEvidence(workerRuns, worker.pr?.headSha ?? '', bounds.maxReviewRounds)
    return buildCard({
      worker,
      issueTitle: issue?.title ?? '(unknown issue)',
      issueNumber: issue?.number ?? 0,
      prs: toPrFacts(snapshotByWorker.get(worker.id), workerRuns, bounds),
      ...(worker.branch ? { branch: worker.branch } : {}),
      ...(reviewerEvidence(snapshotByWorker.get(worker.id)).length > 0
        ? { reviewers: reviewerEvidence(snapshotByWorker.get(worker.id)) }
        : {}),
      ...(review ? { review } : {}),
      activity: cardActivity(worker, deps.activityOf),
      config: deps.config,
      now,
    })
  })

  const views = cards.map((card) => presentCard(card, { now, noSignalGraceMs: deps.config.noSignalGraceMs }))
  const lanes = groupIntoLanes(views)
  // Ordered inside each lane, so a worker waiting on a person floats above a
  // freshly-updated idle one.
  for (const lane of KANBAN_LANES) lanes[lane] = orderCards(lanes[lane], (card) => card.displayStatus)

  const byLane: Record<string, number> = {}
  for (const lane of KANBAN_LANES) byLane[lane] = lanes[lane].length

  return {
    generatedAt: now,
    lenses: { lanes, archive: archiveSheet(views) },
    counts: {
      total: views.length,
      needsAttention: views.filter((view) => view.needsAttention).length,
      byLane,
    },
    projects: orderProjects(repos.map(normalizeRepo), deps.config),
  }
}

/**
 * The projects as the panel shows them: the install's configured one FIRST, then oldest first.
 *
 * The order is load-bearing rather than cosmetic. The panel labels its `...` menu with the
 * FIRST project in this list, and the settings route picks a project by its own rule
 * (`settings-service.selectProject`, which also prefers `defaultRepo`). Two orderings would
 * mean the header naming one project while the dialog edits another -- and the user would
 * have no way to see the disagreement.
 */
export function orderProjects(repos: readonly Repo[], config: PluginConfig): ProjectRef[] {
  const configured = (config.defaultRepo ?? '').trim()
  const ordered = [...repos].sort((left, right) => {
    if (configured !== '') {
      const leftChosen = left.rootPath === configured
      const rightChosen = right.rootPath === configured
      if (leftChosen !== rightChosen) return leftChosen ? -1 : 1
    }
    return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  })
  return ordered.map(toProjectRef)
}

/** Renders the board for the model. */
export function renderBoard(snapshot: BoardSnapshot): string {
  const lines = [
    `Board — ${snapshot.counts.total} worker(s), ${snapshot.counts.needsAttention} needing attention`,
    '',
  ]
  for (const lane of KANBAN_LANES) {
    const cards = snapshot.lenses.lanes[lane] ?? []
    lines.push(`${lane} (${cards.length})`)
    if (cards.length === 0) {
      lines.push('  (empty)')
    } else {
      for (const card of cards) {
        const mark = card.needsAttention ? '!' : ' '
        const reason = card.escalationReason ? ` [${card.escalationReason}]` : ''
        lines.push(`${mark} ${card.id}  ${card.displayStatus}${reason}  ${card.title}`)
      }
    }
    lines.push('')
  }
  if (snapshot.lenses.archive.length > 0) {
    lines.push(`archive (${snapshot.lenses.archive.length}) — terminated sessions, not a lane`)
    for (const card of snapshot.lenses.archive) lines.push(`  ${card.id}  ${card.title}`)
  }
  return lines.join('\n')
}

/** The lane a card is in, for a caller that has only a card. */
export function laneOf(snapshot: BoardSnapshot, workerId: string): KanbanColumn | undefined {
  for (const lane of KANBAN_LANES) {
    if ((snapshot.lenses.lanes[lane] ?? []).some((card) => card.id === workerId)) return lane as KanbanColumn
  }
  if (snapshot.lenses.archive.some((card) => card.id === workerId)) return KanbanColumn.archive
  return undefined
}
