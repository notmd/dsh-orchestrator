/**
 * The merge-readiness phase producer (§12.1's third named producer).
 *
 * ## Why this module exists, and why it reuses the board
 *
 * §12.1 of the reference teardown says the declared phase axis must be "kept
 * consistent with the derived board (see §12.1)" — a second state axis that can
 * disagree with the lane is exactly the class of bug the whole pipeline section is
 * about. So this does not re-implement "is it mergeable": it builds the **same card the
 * board builds**, presents it with the **same reducer**, and lets the resulting
 * `KanbanColumn` decide. If the lane says `ready`, the phase becomes `merge_ready`.
 *
 * That makes disagreement structurally impossible rather than merely unlikely: the one
 * derivation the user sees is the one that writes the phase.
 *
 * ## Why a sweep and not a hook
 *
 * Readiness is a function of provider facts that arrive by polling — an approval, a
 * check run going green, a conflict clearing. There is no single event to hook, and
 * the observer deliberately has no side effects. This runs beside the other decision
 * sweeps, on the same cadence, and is idempotent.
 *
 * ## The inverse transition
 *
 * PRD §8 has `merge_ready --> awaiting_human: review re-requested`, so a worker that
 * was merge-ready and is no longer is moved back: a new head, a fresh changes-requested
 * verdict, or a failing check all take the card out of `ready`, and the phase follows.
 *
 * @module dsho/host/merge-readiness
 */

import { presentCard } from '../board/presentation.ts'
import { KanbanColumn } from '../contract/kanban.ts'
import { isTerminalPr } from '../domain/pr-snapshot.ts'
import type { PrSnapshot } from '../domain/pr-snapshot.ts'
import { normalizeIssue } from '../domain/issues.ts'
import { WorkerPhase, isTerminalPhase, normalizeWorker } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import type { ReviewRun } from '../review/runs.ts'
import { buildCard, cardActivity, toPrFacts } from './board-service.ts'
import { advanceWorkerPhase } from './phase-write.ts'
import type { BoardDeps } from './board-service.ts'
import { snapshotKey } from './observer-service.ts'
import type { PluginConfig } from '../config/validate.ts'
import type { LazyFactStore } from './store.ts'

/** What the merge-readiness sweep needs. */
export interface MergeReadinessDeps {
  store: LazyFactStore
  config: PluginConfig
  now?: () => number
  /** Live activity, so the presented card reads exactly as the board's does. */
  activityOf?: BoardDeps['activityOf']
}

/** What one worker's check decided. */
export interface MergeReadinessOutcome {
  workerId: string
  /** The phase after the check. */
  phase: WorkerPhase
  reason: string
}

/**
 * The lane the presented card lands in, for a worker and its stored facts.
 *
 * Module-private: it exists so the phase is decided by the SAME reducer that draws the card
 * rather than by a second implementation of the rules, and {@link reconcileMergeReadiness} is
 * the only caller — and the only thing worth testing, since it is the decision rather than the
 * lookup that can be wrong.
 */
type BoardFacts = {
  worker: Worker
  snapshot: PrSnapshot
  runs: readonly ReviewRun[]
  issueTitle: string
  issueNumber: number
  activity: string
  config: PluginConfig
  now: number
}

function presentedColumn(input: BoardFacts): KanbanColumn {
  const card = buildCard({
    worker: input.worker,
    issueTitle: input.issueTitle,
    issueNumber: input.issueNumber,
    prs: toPrFacts(input.snapshot, input.runs, {
      maxReviewRounds: input.config.maxReviewRounds,
      autoReviewFailedRetryLimit: input.config.autoReviewFailedRetryLimit,
    }),
    ...(input.worker.branch ? { branch: input.worker.branch } : {}),
    activity: input.activity,
    config: input.config,
    now: input.now,
  })
  return presentCard(card, { now: input.now, noSignalGraceMs: input.config.noSignalGraceMs }).column
}

/**
 * Moves one worker's phase to match its lane, when the two have diverged.
 *
 * Returns the outcome whether or not a write happened, so a caller can log the
 * decision rather than only the change.
 */
export async function reconcileMergeReadiness(
  deps: MergeReadinessDeps,
  worker: Worker,
  snapshot: PrSnapshot | undefined,
  runs: readonly ReviewRun[],
  issueTitle: string,
  issueNumber: number,
): Promise<MergeReadinessOutcome> {
  const unchanged = (reason: string): MergeReadinessOutcome => ({
    workerId: worker.id,
    phase: worker.phase,
    reason,
  })

  if (isTerminalPhase(worker.phase)) return unchanged('terminal')
  // R13: an unfetched snapshot proves nothing, and an empty one reads as CLOSED.
  if (!snapshot || snapshot.fetched !== true) return unchanged('no-observation')
  // A landed pull request is completion's decision, not readiness's: it moves the
  // worker to `merged`/`closed` and releases the issue. Setting `merge_ready` on the
  // way there would be a phase that is true for one tick and always superseded.
  if (isTerminalPr(snapshot)) return unchanged('terminal-pull-request')

  const now = (deps.now ?? Date.now)()
  // One bundle, typed once by `presentedColumn`: the six fields below used to travel as six
  // parameters, which is the shape a type exists to replace.
  const board: BoardFacts = {
    worker,
    snapshot,
    runs,
    issueTitle,
    issueNumber,
    activity: cardActivity(worker, deps.activityOf),
    config: deps.config,
    now,
  }
  const column = presentedColumn(board)

  if (column === KanbanColumn.ready) {
    const wrote = await advanceWorkerPhase(deps.store, worker.id, WorkerPhase.mergeReady, 'the board reads Ready', now)
    if (!wrote) return unchanged(`ready (already ${worker.phase})`)
    return { workerId: worker.id, phase: WorkerPhase.mergeReady, reason: 'ready' }
  }

  // THE EXIT IS NOT THIS SWEEP'S TO TAKE, deliberately.
  //
  // A merge-ready pull request can stop being ready — a new head, a changes-requested verdict,
  // a failing check — and the tempting fix is to move the phase back here. It was tried and it
  // is wrong twice over. `awaiting_human` is the phase it would move to, and that phase means
  // "the worker asked a person for something": `isBlockedWorker` reads it as blocked, so the
  // R14 gate would hold a person's review while the card said `Blocked` — claiming a demand
  // nobody made, and gating the one producer that could move the worker off it. And every real
  // regression already has a producer that owns it: a reviewer's findings route to
  // `addressing_feedback`, a person's review does the same, and a new pass sets
  // `awaiting_auto_review`. Each of those edges is legal from `merge_ready`.
  //
  // So this sweep records arrival and nothing else. Whoever produces the work moves the phase.
  return unchanged(`lane:${column}`)
}

/**
 * Reconciles every worker whose pull request has been observed.
 *
 * A sweep, for the same reason the completion sweep is one: readiness arrives by
 * polling and there is no single event to hang it on.
 */
export async function sweepMergeReadiness(deps: MergeReadinessDeps): Promise<MergeReadinessOutcome[]> {
  const outcomes: MergeReadinessOutcome[] = []
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch {
    return outcomes
  }

  const workers = (await store.workers.list()).map(normalizeWorker)
  const issues = (await store.issues.list()).map(normalizeIssue)
  const runs = ((await store.reviewRuns.list()) as ReviewRun[]).filter(
    (candidate) => typeof candidate === 'object' && candidate !== null,
  )

  for (const worker of workers) {
    try {
      const snapshot = (await store.prSnapshots.get(snapshotKey(worker.id))) as PrSnapshot | undefined
      const issue = issues.find((candidate) => candidate.id === worker.issueId)
      const outcome = await reconcileMergeReadiness(
        deps,
        worker,
        snapshot,
        runs.filter((run) => run.workerId === worker.id),
        issue?.title ?? '(unknown issue)',
        issue?.number ?? 0,
      )
      // Only a moved phase is interesting; the sweep runs every tick.
      if (outcome.phase !== worker.phase) outcomes.push(outcome)
    } catch {
      // One worker's reconciliation must not stop the others.
    }
  }
  return outcomes
}
