/**
 * Head-scoped review-run facts.
 *
 * `ReviewRun` records are keyed by the head commit they judged. This module turns
 * a PR's raw run history into the facts the board reducer reads.
 *
 * **A run has two orthogonal fields, exactly as the reference implementation
 * does** (AO `backend/pkg/contract/scm.go`): `status` is the lifecycle
 * (`running · complete · delivered · failed · cancelled`) and `verdict` is the
 * outcome (`'' · approved · changes_requested`). A verdict only exists once a
 * pass has completed or been delivered.
 *
 * The PRD (§7.5) describes a single merged `state` field
 * (`queued · running · approved · changes_requested · failed · cancelled`). That
 * merged field is **lossy** — it cannot distinguish "failed with no verdict" from
 * "failed after requesting changes" — and the ported reducer needs the split, so
 * storage keeps `status` + `verdict`. The PRD's vocabulary survives as:
 *
 *   - a per-head plan status (`AOReviewState` in `./planner.ts`), which is what
 *     the board and the API report; and
 *   - `queued`, which in the reference model is not a stored status at all: a
 *     pass that is scheduled but has not started has **no run row**, and the
 *     reducer renders `Review scheduled` from `present === false`.
 *
 * The aggregation shape is ported from AO
 * `backend/internal/service/session/kanban.go` -> `toContractKanbanPRFacts`, and
 * the retry-limit rule from `backend/internal/autoreview/coordinator.go` ->
 * `existingHeadReason`. See NOTICE.
 *
 * @module dsho/review/runs
 */

import { reviewRunFacts } from '../contract/kanban.ts'
import type { KanbanReviewRunFacts } from '../contract/kanban.ts'

/**
 * Lifecycle of one review pass.
 *
 * `complete` and `delivered` are the two terminal success states in the
 * reference; the difference is whether the verdict has been handed back to the
 * worker yet, and nothing in this plugin's logic depends on it.
 */
export const ReviewRunStatus = Object.freeze({
  running: 'running',
  complete: 'complete',
  delivered: 'delivered',
  failed: 'failed',
  cancelled: 'cancelled',
} as const)

/** The union of every run status. */
export type ReviewRunStatus = (typeof ReviewRunStatus)[keyof typeof ReviewRunStatus]

/** The outcome of a pass. An empty verdict means the pass produced none. */
export const ReviewVerdict = Object.freeze({
  none: '',
  approved: 'approved',
  changesRequested: 'changes_requested',
} as const)

/** The union of every verdict, including the empty one. */
export type ReviewVerdict = (typeof ReviewVerdict)[keyof typeof ReviewVerdict]

/** How a pass was started. `manual` runs never consume the auto-retry budget. */
export const ReviewTriggerSource = Object.freeze({
  auto: 'auto',
  manual: 'manual',
} as const)

/** The union of every trigger source. */
export type ReviewTriggerSource = (typeof ReviewTriggerSource)[keyof typeof ReviewTriggerSource]

/** One structured finding from a review pass. */
export interface ReviewFinding {
  severity: string
  path?: string
  line?: number
  summary: string
  detail: string
}

/** One review pass, keyed by the head commit it judged. */
export interface ReviewRun {
  id?: string
  workerId: string
  prNumber?: number
  prUrl?: string
  /** The commit this pass judged. The identity. */
  headSha: string
  /** 1-based cycle index. */
  round?: number
  status: ReviewRunStatus
  verdict?: ReviewVerdict
  triggerSource?: ReviewTriggerSource
  findings?: ReviewFinding[]
  summary?: string
  /** The **reviewer** session, not the worker's. */
  sessionId?: string
  /**
   * Recorded per run for a migration-free future multi-reviewer mode;
   * deliberately not part of the identity key.
   */
  harness?: string
  /** The real PR review the pass posted. */
  githubReviewId?: string
  createdAt?: number
  startedAt?: number
  endedAt?: number
}

/** The loop bounds. Values verified against the reference source and PRD §13. */
export const REVIEW_BOUND_DEFAULTS = Object.freeze({
  maxReviewRounds: 3,
  autoReviewFailedRetryLimit: 3,
})

/** The bounds a caller may override. */
export interface ReviewBounds {
  maxReviewRounds?: number
  autoReviewFailedRetryLimit?: number
}

/** Reports whether a verdict value is a real one (AO's `Verdict.Valid()`). */
export function isVerdict(value: string | undefined): value is ReviewVerdict {
  return value === ReviewVerdict.approved || value === ReviewVerdict.changesRequested
}

/** Reports whether a run has finished, successfully or not. */
export function isSettled(run: Pick<ReviewRun, 'status'>): boolean {
  return run.status !== ReviewRunStatus.running
}

/**
 * Every run recorded against one head, in insertion order.
 *
 * An empty `headSha` selects nothing: a pass that could not be pinned to a commit
 * must never decide a lane.
 */
export function runsForHead(
  runs: readonly ReviewRun[] | undefined | null,
  headSha: string,
): ReviewRun[] {
  if (!headSha) return []
  return (runs ?? []).filter((run) => run && run.headSha === headSha)
}

/**
 * Counts automated changes-requested cycles across successive heads.
 *
 * The cycle count is the larger of the number of distinct heads that received a
 * changes-requested verdict and the largest recorded `round`. Taking the max
 * means a run row that lost its `round` (an older record) still counts, and a
 * round number that ran ahead of the observed head list is still honored.
 */
export function changesRequestedCycles(runs: readonly ReviewRun[] | undefined | null): number {
  const heads = new Set<string>()
  let maxRound = 0
  for (const run of runs ?? []) {
    if (!run || run.verdict !== ReviewVerdict.changesRequested) continue
    if (run.headSha) heads.add(run.headSha)
    const round = typeof run.round === 'number' && Number.isFinite(run.round) ? run.round : 0
    if (round > maxRound) maxRound = round
  }
  return Math.max(heads.size, maxRound)
}

/**
 * Counts automated passes on one head that ended without producing a verdict.
 *
 * Manual runs do not count against the budget — `triggerSource` is recorded per
 * run precisely so this filter is possible (PRD §7.5, test plan). A run whose
 * source was never recorded counts as automated, matching the reference's
 * `run.Harness == harness || run.Harness == ""` leniency.
 */
export function failedAutoRuns(headRuns: readonly ReviewRun[]): number {
  let count = 0
  for (const run of headRuns) {
    if (run.status !== ReviewRunStatus.failed) continue
    if (run.triggerSource && run.triggerSource !== ReviewTriggerSource.auto) continue
    count += 1
  }
  return count
}

/** The head-scoped facts the board reducer reads. */
export function summarizeReviewRuns(input: {
  runs: readonly ReviewRun[] | undefined | null
  headSha: string
  bounds?: ReviewBounds
}): KanbanReviewRunFacts {
  const maxReviewRounds = input.bounds?.maxReviewRounds ?? REVIEW_BOUND_DEFAULTS.maxReviewRounds
  const retryLimit =
    input.bounds?.autoReviewFailedRetryLimit ?? REVIEW_BOUND_DEFAULTS.autoReviewFailedRetryLimit

  const headRuns = runsForHead(input.runs, input.headSha)
  const facts: Partial<KanbanReviewRunFacts> = {}
  for (const run of headRuns) {
    facts.present = true
    if (run.status === ReviewRunStatus.running) facts.running = true
    if (run.verdict === ReviewVerdict.changesRequested) facts.changesRequested = true
    if (isVerdict(run.verdict)) facts.outcome = true
    if (run.status === ReviewRunStatus.failed) facts.failed = true
    if (run.status === ReviewRunStatus.cancelled) facts.cancelled = true
  }
  facts.roundBudgetExhausted = changesRequestedCycles(input.runs) >= maxReviewRounds
  facts.failedRetryLimitReached = failedAutoRuns(headRuns) >= retryLimit
  return reviewRunFacts(facts)
}

/**
 * The most recent settled pass with a verdict recorded for a head *other* than
 * this one — the pass the card reports as superseded context.
 *
 * Ported from `latestCompletedRunForOtherSHA`.
 */
export function latestCompletedRunForOtherHead(
  runs: readonly ReviewRun[] | undefined | null,
  headSha: string,
): ReviewRun | undefined {
  if (!headSha) return undefined
  let latest: ReviewRun | undefined
  for (const run of runs ?? []) {
    if (!run || !run.headSha || run.headSha === headSha) continue
    if (run.status !== ReviewRunStatus.complete && run.status !== ReviewRunStatus.delivered) continue
    if (!isVerdict(run.verdict)) continue
    if (!latest || (run.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = run
  }
  return latest
}
