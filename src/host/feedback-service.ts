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

import type { PrReview, PrSnapshot } from '../domain/pr-snapshot.ts'
import { normalizeWorker } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
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

/** One piece of human feedback worth acting on. */
interface Actionable {
  id: string
  kind: 'changes_requested' | 'comment'
  author: string
  body: string
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
 * The feedback that has not been routed yet.
 *
 * Exported because it is the whole of the dedup logic and is worth testing without a
 * store, a worker, or a session in the way.
 */
export function actionableFeedback(snapshot: PrSnapshot, alreadyRouted: readonly string[]): Actionable[] {
  const routed = new Set(alreadyRouted)
  const out: Actionable[] = []
  for (const review of snapshot.reviews ?? []) {
    if (routed.has(review.id) || !isHuman(review)) continue
    if (review.state === 'CHANGES_REQUESTED') {
      out.push({ id: review.id, kind: 'changes_requested', author: review.author, body: review.body ?? '' })
    } else if (review.state === 'COMMENTED' && (review.body ?? '').trim() !== '') {
      out.push({ id: review.id, kind: 'comment', author: review.author, body: review.body ?? '' })
    }
  }
  return out
}

/** The message that tells the worker what a person asked for. */
export function renderFeedback(worker: Worker, items: readonly Actionable[], prUrl: string): string {
  const lines = [
    `A person requested changes on ${worker.branch} (${prUrl}).`,
    '',
  ]
  for (const item of items) {
    const label = item.kind === 'changes_requested' ? 'requested changes' : 'commented'
    lines.push(`${item.author} ${label}:`)
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

  const items = actionableFeedback(snapshot, routedIds)
  if (items.length === 0) {
    return { workerId: worker.id, routed: 0, reason: 'nothing-new' }
  }
  if (nudgedAtHead >= deps.config.reviewMaxNudge) {
    return { workerId: worker.id, routed: 0, reason: 'nudge-limit', capped: true }
  }

  const live = deps.live?.byWorker(worker.id)
  if (!live) {
    // Recorded as routed ONLY when it was actually delivered. Marking it here would
    // lose the feedback for a worker whose session is momentarily absent.
    return { workerId: worker.id, routed: 0, reason: 'no-live-handle' }
  }

  const store = await deps.store.get()
  live.handle.agent.followup({
    content: [{ type: 'text', text: renderFeedback(worker, items, snapshot.url ?? '') }],
    source: { kind: 'user' },
  })
  await store.workers.put(worker.id, {
    ...worker,
    feedback: {
      routedIds: [...routedIds, ...items.map((item) => item.id)],
      nudgedAtHead: nudgedAtHead + 1,
      headSha,
    },
    lastSignalAt: (deps.now ?? Date.now)(),
    updatedAt: (deps.now ?? Date.now)(),
  })

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
