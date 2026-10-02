/**
 * The human feedback loop (M4, PRD §7.6).
 *
 * The plugin's own reviewer is not the last word: a person can read the pull request
 * and ask for changes, and **the worker has to hear about it** or the review sits
 * unanswered while the card claims the work is progressing. This routes a human's
 * `CHANGES_REQUESTED` and their comments to the owning worker.
 *
 * ## Three rules that are easy to get wrong
 *
 * **Never route the same thing twice.** A review is routed once, keyed by its provider
 * id. Without dedup the worker is nudged on every poll — every 30 seconds — for one
 * comment, which reads as a broken loop and burns the worker's context.
 *
 * **Never route our own reviews back.** `isBotAuthor` is consulted, and an untyped
 * author is treated as **human**: routing our own finding to the worker twice is
 * merely wasteful, while dropping a person's review is the failure the PRD cares about.
 *
 * **Bound the nudges per commit.** `reviewMaxNudge` exists because a worker that
 * cannot satisfy a reviewer will otherwise be told forever. At the cap the plugin stops
 * *and says so* — a loop that quietly gives up is indistinguishable from a loop that is
 * working.
 *
 * A failed observation routes nothing (R13): an unfetched snapshot's empty review list
 * must not read as "the human withdrew their objection".
 *
 * @module dsho/host/feedback-service
 */

import { isResolvedComment } from '../domain/pr-snapshot.ts'
import type { PrReview, PrReviewComment, PrSnapshot } from '../domain/pr-snapshot.ts'
import {
  WorkerPhase,
  isBlockedWorker,
  isValidPhaseTransition,
  normalizeWorker,
  setPhase,
} from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { ourReviewIds } from '../review/runs.ts'
import type { ReviewRun } from '../review/runs.ts'
import type { PluginConfig } from '../config/validate.ts'
import type { LiveWorkers } from './handle-registry.ts'
import type { LazyFactStore } from './store.ts'

/** What the feedback loop needs. */
export interface FeedbackDeps {
  store: LazyFactStore
  config: PluginConfig
  live?: LiveWorkers
  now?: () => number
}

/** What one pass did. */
export interface FeedbackOutcome {
  workerId: string
  routed: number
  /** `requested-changes` | `comments` | why nothing was sent. */
  reason: string
  /** Set when the cap was reached rather than the work being current. */
  capped?: boolean
}

/** One piece of feedback worth acting on, whatever its source. */
interface Actionable {
  id: string
  kind: 'changes_requested' | 'comment' | 'ci_failed' | 'merge_conflict'
  author: string
  body: string
  /**
   * Where an inline comment was anchored.
   *
   * Carried because "can you also remove this" is unanswerable without it: the worker has
   * a branch full of files and no way to know which "this" a person clicked. A review-level
   * comment has no location, so both stay optional.
   */
  path?: string
  line?: number
}

/**
 * Whether an author is human — untyped counts as human, deliberately.
 *
 * Read from the PARSED `isBot` field, not by calling `isBotAuthor` again. `isBotAuthor`
 * reads `__typename`/`type` from a RAW provider payload; a parsed `PrReview` carries the
 * verdict in `isBot`, so calling it here returned `undefined` for every review and let
 * our own bot reviews through — which the test caught.
 */
function isHuman(review: PrReview): boolean {
  return review.isBot !== true
}

/**
 * The same rule for an inline comment.
 *
 * Kept separate rather than generalized over both shapes: they are different records from
 * different endpoints, and this one carries a real marker (REST `user.type`) that the
 * review payload does not — so the two will not necessarily agree, and a shared helper
 * would have to pretend they do.
 */
function isHumanComment(comment: PrReviewComment): boolean {
  return comment.isBot !== true
}

/**
 * The feedback that has not been routed yet.
 *
 * Exported because it is the whole of the dedup logic and is worth testing without a
 * store, a worker, or a session in the way.
 *
 * `ourIds` is the set from {@link import('../review/runs.ts').ourReviewIds}. Without it the
 * plugin's own review is indistinguishable from a person's — both are `COMMENTED`, both are
 * authored by the same login, and `isBot` is `undefined` for both — so the loop routes the
 * plugin's findings back to the worker as though a human had asked for them, spending a
 * nudge from a bounded budget on its own output.
 *
 * Inline comments are read as well as review bodies, because that is where a person
 * reviewing a diff types: a review submitted from clicked lines has an empty body, and its
 * text is on `pulls/{n}/comments` instead.
 */
export function actionableFeedback(
  snapshot: PrSnapshot,
  alreadyRouted: readonly string[],
  ours: ReadonlySet<string> = new Set(),
): Actionable[] {
  const routed = new Set(alreadyRouted)
  const out: Actionable[] = []
  for (const review of snapshot.reviews ?? []) {
    if (routed.has(review.id) || !isHuman(review)) continue
    if (ours.has(review.id)) continue
    if (review.state === 'CHANGES_REQUESTED') {
      out.push({ id: review.id, kind: 'changes_requested', author: review.author, body: review.body ?? '' })
    } else if (review.state === 'COMMENTED' && (review.body ?? '').trim() !== '') {
      out.push({ id: review.id, kind: 'comment', author: review.author, body: review.body ?? '' })
    }
  }

  // INLINE comments, which are where a person reviewing a diff actually types.
  //
  // These were invisible until this endpoint was fetched, and no review-level rule can
  // recover them: a review submitted from clicked lines has an EMPTY body, so the loop
  // above sees nothing to route whether or not the body check is relaxed. An item added
  // here is a different id from its parent review's, so a review that has both a summary
  // and line comments routes both -- which is correct, they say different things.
  const comments = snapshot.reviewComments ?? []
  /**
   * The REST ids of comments that sit on OUR OWN reviews -- the roots of our threads.
   *
   * Measured live, and the reason this set exists: the worker answers each finding by
   * replying in its thread ("Done in 53d8ce5 — the same line now names..."). A reply is a
   * NEW review with a fresh id, so the parent-review exclusion above does not catch it, and
   * without this the worker's own words come back to it attributed to a person -- and
   * because the routed list resets on every new head, each push re-sends them. That is a
   * nudge loop bounded only by `reviewMaxNudge`.
   */
  const ourThreadRoots = new Set(
    comments
      .filter((comment) => ours.has(comment.reviewId) || ours.has(comment.id))
      .map((comment) => comment.restId)
      .filter((id) => id !== ''),
  )

  for (const comment of comments) {
    if (routed.has(comment.id) || !isHumanComment(comment)) continue
    // Ours by parent review. Our own reviewer posts one inline comment per finding, so
    // without this the loop would hand the worker its own review back as human feedback.
    if (ours.has(comment.reviewId) || ours.has(comment.id)) continue
    // A direct reply into one of our threads. Deliberately ONE level: a reply to a reply is
    // either the worker again or a person engaging, and the PRD ranks dropping a person's
    // comment as the failure that matters -- so the doubt routes.
    if (comment.inReplyToId !== undefined && ourThreadRoots.has(comment.inReplyToId)) continue
    if (comment.body.trim() === '') continue
    // A **resolved** thread is not outstanding feedback (finding G4). Without the thread
    // state, a discussion a person already resolved kept counting as unanswered until the
    // next head, so the worker was re-nudged about something that was finished. The check
    // fails OPEN: `reviewThreads` is absent on a snapshot fetched before this existed, and
    // `isResolvedComment` then answers "no" for everything — routing a resolved comment is
    // wasteful, dropping a person's comment is the failure that matters.
    if (isResolvedComment(snapshot, comment.restId)) continue
    out.push({
      id: comment.id,
      kind: 'comment',
      author: comment.author,
      body: comment.body,
      ...(comment.path ? { path: comment.path } : {}),
      ...(comment.line !== undefined ? { line: comment.line } : {}),
    })
  }
  return out
}

/**
 * CI failures and merge conflicts, as routable items (R5-adjacent, M4).
 *
 * **This is what makes `autoInjectCI` real.** The flag was read ONLY by the board, so a
 * card with failing checks displayed `Fixing CI failures` while nothing ever told the
 * worker -- the board asserting an active loop that was not running, which is the
 * failure mode the reducer's own divergence notes forbid.
 *
 * Keyed by the HEAD COMMIT, so a new commit naturally starts a fresh round of feedback
 * and a repeat of the same failure on the same commit is not sent twice. The key also
 * carries the kind, so a CI failure and a conflict on one commit are separate items.
 */
export function ciFeedback(snapshot: PrSnapshot, alreadyRouted: readonly string[]): Actionable[] {
  const routed = new Set(alreadyRouted)
  const head = snapshot.headSha ?? ''
  if (head === '') return []
  const out: Actionable[] = []

  if (snapshot.ciState === 'failing') {
    const id = `ci:${head}`
    if (!routed.has(id)) {
      out.push({
        id,
        kind: 'ci_failed',
        author: 'checks',
        body: 'Continuous integration is failing on this commit. Read the failing job output, fix it, and push.',
      })
    }
  }
  // `CONFLICTING` is the provider's own word; `DIRTY` is the merge-state equivalent, and
  // either means the branch no longer applies cleanly.
  if (snapshot.mergeable === 'CONFLICTING' || snapshot.mergeStateStatus === 'DIRTY') {
    const id = `conflict:${head}`
    if (!routed.has(id)) {
      out.push({
        id,
        kind: 'merge_conflict',
        author: 'git',
        body:
          'This branch no longer applies cleanly to its base. Rebase or merge the base in, resolve the ' +
          'conflicts, and push.',
      })
    }
  }
  return out
}

/** The message that tells the worker what a person asked for. */
export function renderFeedback(worker: Worker, items: readonly Actionable[], prUrl: string): string {
  const lines = [`Changes are needed on ${worker.branch} (${prUrl}).`, '']
  for (const item of items) {
    // A person's feedback is attributed to them; a check failure is attributed to the
    // check, because "a person requested changes" would be a lie the worker might act on
    // differently.
    const label =
      item.kind === 'changes_requested' ? 'requested changes'
      : item.kind === 'comment' ? 'commented'
      : item.kind === 'ci_failed' ? 'is failing'
      : 'does not apply cleanly'
    lines.push(item.kind === 'changes_requested' || item.kind === 'comment' ? `${item.author} ${label}:` : `The ${item.author} ${label}:`)
    // The location goes ABOVE the text for an inline comment, so the worker reads which
    // file and line before it reads what was asked -- "this" is meaningless without it.
    if (item.path) {
      lines.push(`  ${item.path}${item.line !== undefined ? `:${item.line}` : ''}`)
    }
    lines.push(item.body.trim() === '' ? '  (no comment body)' : item.body.trim())
    lines.push('')
  }
  lines.push('Address these, push, and the automated review will run again on the new commit.')
  return lines.join('\n')
}

/**
 * Routes a human's feedback to the owning worker, once per item and at most
 * `reviewMaxNudge` times per commit.
 */
export async function routeHumanFeedback(
  deps: FeedbackDeps,
  worker: Worker,
  snapshot: PrSnapshot | undefined,
): Promise<FeedbackOutcome> {
  // R13: an unfetched snapshot reports nothing, and an empty review list must never be
  // read as "the objection was withdrawn".
  if (!snapshot || snapshot.fetched !== true) {
    return { workerId: worker.id, routed: 0, reason: 'no-observation' }
  }

  const headSha = snapshot.headSha ?? ''
  // A new commit resets the count: the cap is per head, not per worker, so a worker
  // that fixed what it was told to fix gets a fresh budget.
  const prior = worker.feedback
  const routedIds = prior && prior.headSha === headSha ? prior.routedIds : []
  const nudgedAtHead = prior && prior.headSha === headSha ? prior.nudgedAtHead : 0

  const store = await deps.store.get()

  // Which of the reviews on this PR are OURS. Read from the stored review runs rather than
  // guessed from the author, because there is no bot identity to guess from (see
  // `ourReviewIds`). A store read failure yields an empty set: the guard is about avoiding
  // a wasted nudge, and failing it must not silence a person.
  let ours: Set<string> = new Set()
  try {
    const runs = (await store.reviewRuns.list()).filter((candidate) => {
      const run = candidate as ReviewRun | null
      return typeof run === 'object' && run !== null && run.workerId === worker.id
    }) as ReviewRun[]
    ours = ourReviewIds(runs)
  } catch {
    // Leave `ours` empty.
  }

  // `autoInjectCI` gates the check-driven items, which is what makes the flag real
  // rather than a board-only annotation.
  const items = [
    ...actionableFeedback(snapshot, routedIds, ours),
    ...(deps.config.autoInjectCI ? ciFeedback(snapshot, routedIds) : []),
  ]
  if (items.length === 0) {
    return { workerId: worker.id, routed: 0, reason: 'nothing-new' }
  }
  if (nudgedAtHead >= deps.config.reviewMaxNudge) {
    return { workerId: worker.id, routed: 0, reason: 'nudge-limit', capped: true }
  }

  // R14 / Guardrail 3: a blocked worker is never injected into. Input arriving while a
  // permission prompt is pending can read as an ANSWER to it, which is why the PRD
  // rates this High. The feedback is HELD rather than dropped -- nothing is recorded, so
  // the next sweep after the block clears sends it. That is "queues until the block
  // clears", and recording it here would silently discard a person's review instead.
  if (isBlockedWorker(worker)) {
    return { workerId: worker.id, routed: 0, reason: 'blocked' }
  }

  const live = deps.live?.byWorker(worker.id)
  if (!live) {
    // Recorded as routed ONLY when it was actually delivered. Marking it here would
    // lose the feedback for a worker whose session is momentarily absent.
    return { workerId: worker.id, routed: 0, reason: 'no-live-handle' }
  }

  live.handle.agent.followup({
    content: [{ type: 'text', text: renderFeedback(worker, items, snapshot.url ?? '') }],
    source: { kind: 'user' },
  })
  // Routing feedback *is* the transition into `addressing_feedback` (§12.1's second
  // named producer) — but it is written in the SAME put as the dedup state, because
  // splitting them would let a crash between the two re-nudge the worker for feedback
  // it has already been told about. That is the invariant the `feedback` field's own
  // comment records, and a phase write on its own line would quietly violate it.
  const at = (deps.now ?? Date.now)()
  const routed: Worker = {
    ...worker,
    feedback: {
      routedIds: [...routedIds, ...items.map((item) => item.id)],
      nudgedAtHead: nudgedAtHead + 1,
      headSha,
    },
    lastSignalAt: at,
    updatedAt: at,
  }
  await store.workers.put(
    worker.id,
    isValidPhaseTransition(worker.phase, WorkerPhase.addressingFeedback)
      ? setPhase(routed, WorkerPhase.addressingFeedback, 'human feedback routed', at)
      : routed,
  )

  return { workerId: worker.id, routed: items.length, reason: items[0]!.kind }
}

/** Routes for every worker, so the observer tick can call it in one step. */
export async function sweepHumanFeedback(deps: FeedbackDeps): Promise<FeedbackOutcome[]> {
  const outcomes: FeedbackOutcome[] = []
  let store
  try {
    store = await deps.store.get()
  } catch {
    return outcomes
  }
  for (const worker of (await store.workers.list()).map(normalizeWorker)) {
    try {
      const snapshot = (await store.prSnapshots.get(worker.id)) as PrSnapshot | undefined
      const outcome = await routeHumanFeedback(deps, worker, snapshot)
      if (outcome.routed > 0) outcomes.push(outcome)
    } catch {
      // One worker's feedback must not stop the others.
    }
  }
  return outcomes
}
