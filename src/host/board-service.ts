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
import { isSticky } from '../contract/activity.ts'
import {
  declaredActivity,
  isPausedWorker,
  isTerminalPhase,
  normalizeWorker,
  workerSessionTitle,
} from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { snapshotKey } from './observer-service.ts'
import { changesRequestedCycles, ourReviewIds, summarizeReviewRuns } from '../review/runs.ts'
import type { ReviewRun } from '../review/runs.ts'
import { isBotAuthor, isResolvedComment } from '../domain/pr-snapshot.ts'
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
   * The connected projects, oldest first — EVERY project, even on a scoped read.
   *
   * Deliberately not filtered with the cards. The page's entry points are one sidebar row
   * and one main panel per project, so the project list is the only thing that tells it
   * which rows should exist — and a scoped read is exactly the read a panel makes. If this
   * list were scoped too, each panel would report a single project and the row list would
   * collapse to whichever panel polled last.
   *
   * Carried on the snapshot rather than fetched separately, so naming the project and
   * listing the projects cost no extra request. The settings payload is a separate request
   * because it is only needed once the dialog opens -- and the board poll must not grow
   * with every setting the page gains.
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
  // The declared blockage first, through the ported predicates rather than by hand.
  const declared = isPausedWorker(worker) ? declaredActivity(worker) : undefined
  // `isSticky` is the SECOND question, and it is the one this branch exists for: "may a clock
  // demote this?" (§12.4, R20). Asking it here — rather than ANDing it into the predicate
  // above, where it could only ever agree — is what makes the ported guarantee structural:
  // a declared pause is returned as the worker's activity, so the live `AgentStatus` is never
  // consulted, and a quiet session cannot be inferred `idle` and then aged into `No signal`
  // while the question is still unanswered.
  if (declared !== undefined && isSticky(declared)) return declared
  return activityOf?.(worker.id) ?? 'unknown'
}

/**
 * The external (not ours) review facts the column reducer reads.
 *
 * Two rules changed here, both from finding G4:
 *
 *   1. `comments` used to be `external.length > 0 && external.every(state === 'COMMENTED')`,
 *      which is a reading of *reviews*, not of *discussions*. A reviewer who submitted
 *      `CHANGES_REQUESTED` **and** left line comments made it false, so unanswered line
 *      comments sat on a card that could not report them. The two facts are independent and
 *      are now computed independently — "there are outstanding comments" and "someone
 *      requested changes" can both be true — and the reducer's own precedence decides which
 *      phrase wins.
 *   2. A **resolved** thread is no longer outstanding, which is what makes "is the review
 *      still waiting on the worker?" a decidable fact rather than a heuristic.
 *
 * Our own reviews and comments are excluded by id through the one shared definition
 * ({@link ourReviewIds}): the aggregate `reviewDecision` mixes ours with a person's and
 * cannot tell whose turn it is.
 */
export function externalReviewSummary(
  snapshot: PrSnapshot,
  ourIds: ReadonlySet<string>,
): { approved: boolean; changesRequested: boolean; comments: boolean } {
  const external = (snapshot.reviews ?? []).filter((review) => !ourIds.has(review.id))
  const approved = external.some((review) => review.state === 'APPROVED')
  const changesRequested = external.some((review) => review.state === 'CHANGES_REQUESTED')

  // Any external COMMENTED review counts, body or not — and the empty body is the reason.
  // A review is submitted *from clicked lines* with an empty body and its text on the
  // inline comments; those live in a list this snapshot may not have fetched (the field is
  // absent on a record written before threads existed, and a failed comment fetch leaves the
  // prior list behind). Requiring a body would therefore drop a person's line comments
  // entirely on a snapshot we cannot prove had none, which is the direction that matters.
  //
  // A review body has no resolution state — GitHub models resolution per thread — so this
  // half stays outstanding until the review itself is superseded.
  const commentedReviews = external.some((review) => review.state === 'COMMENTED')

  const inlineOutstanding = (snapshot.reviewComments ?? []).some((comment) => {
    if (comment.body.trim() === '') return false
    if (comment.isBot === true) return false
    // Ours, by parent review or by its own id: our reviewer posts one inline comment per
    // finding, and counting those as a person's would make every pass look like human
    // feedback.
    if (ourIds.has(comment.reviewId) || ourIds.has(comment.id)) return false
    return !isResolvedComment(snapshot, comment.restId)
  })

  return { approved, changesRequested, comments: commentedReviews || inlineOutstanding }
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
  // The set comes from ONE shared definition. The inline copy that used to be here built
  // its set from `githubReviewId` -- the REST id -- while the snapshot reports node ids, so
  // every comparison was false and the exclusion never removed anything.
  const ourIds = ourReviewIds(runs)

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
      // The reference synthesizes its own mergeability and feeds the card the reasons;
      // we keep ours from the domain and carry them through, so the phrase and the reasons
      // describe the same pull request (finding G3).
      mergeBlockers: [...(snapshot.mergeBlockers ?? [])],
      reviewRun: summarizeReviewRuns({ runs, headSha, bounds }),
      externalReview: externalReviewSummary(snapshot, ourIds),
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
  // DERIVED, once, from the phase — the authority -- because hardcoding `false` made two
  // documented behaviours unreachable. `session.isTerminated` short-circuits BOTH derivations
  // -- kanban.ts:475 sends the card to the `archive` column, status.ts:190 returns the
  // `Terminated` or `Merged` status -- so with it always false the archive sheet was always
  // empty and those two statuses could never be displayed. The board was fetching
  // `lenses.archive` every poll and rendering a count that was always 0. `isTerminalPhase`
  // documents the precedence (§12.3) that keeps this flag, the phase and the `endedAt`
  // watermark from drifting apart.
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
 * Which project a read is scoped to.
 *
 * `repoId: ''` is the whole install, which is what the tool and a project list need;
 * a non-empty id is ONE project's board, which is what each panel draws. The filter is
 * applied here rather than in the page for two reasons: the lanes, the archive sheet
 * and the counts are all derived from the same worker set, so filtering one and not the
 * others would leave a header disagreeing with its board; and a page-side filter would
 * make the scoped board's correctness untestable without a browser.
 */
export interface BoardScope {
  /** A {@link Repo} id, or `''` for every project. */
  repoId?: string
}

/**
 * Assembles the whole board.
 *
 * **One snapshot, no per-card fan-out** (the performance NFR): every store is read
 * once, and the lanes are computed from that in memory.
 */
export async function buildBoard(deps: BoardDeps, scope: BoardScope = {}): Promise<BoardSnapshot> {
  const now = (deps.now ?? Date.now)()
  const store = await deps.store.get()
  const repoId = (scope.repoId ?? '').trim()

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
  /**
   * A worker's project is its ISSUE's, not its own.
   *
   * `Worker.workspaceId` is the DSH Workspace of the worker's **worktree** — a path under
   * the project, with a different id — so it cannot answer "which project is this". The
   * issue is the record that was created against a `repoId`, and it is the only link the
   * plugin actually writes.
   *
   * A worker whose issue is missing (a record from a hand-edited store) or whose issue
   * carries no `repoId` belongs to no project, so a scoped board leaves it out rather
   * than guessing. It is still on the unscoped board, which is what the `orchestrator_board`
   * tool and the projects read see.
   */
  const issueById = new Map(normalizedIssues.map((issue) => [issue.id, issue]))
  const scoped = workers.map(normalizeWorker).filter((worker) => {
    if (repoId === '') return true
    return issueById.get(worker.issueId)?.repoId === repoId
  })
  // Keyed by worker id, which is how the OBSERVER writes them (`snapshotKey`). An
  // earlier version matched by URL instead, and the two disagreed the moment a
  // worker's `pr.url` differed from the snapshot's -- so a real pull request never
  // moved a card, silently, even though both halves were individually tested. A live
  // end-to-end run is what surfaced it; a unit test on either side could not.
  const snapshotByWorker = new Map<string, PrSnapshot>()
  for (const worker of scoped) {
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

  const cards = scoped.map((worker) => {
    const issue = issueById.get(worker.issueId)
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
 * The projects as the page shows them: the install's configured one FIRST, then oldest first.
 *
 * The order is load-bearing rather than cosmetic. It is the order the sidebar's project rows
 * are registered in, so the project the install is configured for leads the list — and the
 * settings route picks a project by its own rule (`settings-service.selectProject`, which
 * also prefers `defaultRepo`). Two orderings would mean the row the user reaches for first
 * and the project the dialog opens by default being different projects, with no visible sign.
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
        // What is left before the merge, when there is one. A settled card (Merged,
        // Closed) has nothing left to say, and printing reasons on it would report stale
        // facts about a branch nobody is going to merge.
        const waiting =
          card.mergeBlockers && card.mergeBlockers.length > 0 ? ` — waiting on: ${card.mergeBlockers.join(', ')}` : ''
        lines.push(`${mark} ${card.id}  ${card.displayStatus}${reason}${waiting}  ${card.title}`)
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
