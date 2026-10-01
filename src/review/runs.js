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
 *   - a per-head plan status ({@link module:dsho/review/planner.AOReviewState}),
 *     which is what the board and the API report; and
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

import { reviewRunFacts } from '../contract/kanban.js'

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
})

/** The outcome of a pass. An empty verdict means the pass produced none. */
export const ReviewVerdict = Object.freeze({
  none: '',
  approved: 'approved',
  changesRequested: 'changes_requested',
})

/** How a pass was started. `manual` runs never consume the auto-retry budget. */
export const ReviewTriggerSource = Object.freeze({
  auto: 'auto',
  manual: 'manual',
})

/**
 * @typedef {object} ReviewRun
 * @property {string} [id]
 * @property {string} workerId
 * @property {number} [prNumber]
 * @property {string} [prUrl]
 * @property {string} headSha          The commit this pass judged. The identity.
 * @property {number} [round]          1-based cycle index.
 * @property {string} status           {@link ReviewRunStatus} value.
 * @property {string} [verdict]        {@link ReviewVerdict} value.
 * @property {string} [triggerSource]  {@link ReviewTriggerSource} value.
 * @property {object[]} [findings]
 * @property {string} [summary]
 * @property {string} [sessionId]      The **reviewer** session, not the worker's.
 * @property {string} [harness]        Recorded per run for a migration-free
 *   future multi-reviewer mode; deliberately not part of the identity key.
 * @property {string} [githubReviewId] The real PR review the pass posted.
 * @property {number} [createdAt]
 * @property {number} [startedAt]
 * @property {number} [endedAt]
 */

/**
 * The default loop bounds. Values verified against the reference source and
 * restated in PRD §13.
 */
export const REVIEW_BOUND_DEFAULTS = Object.freeze({
  maxReviewRounds: 3,
  autoReviewFailedRetryLimit: 3,
})

/** Reports whether a verdict value is a real one (AO's `Verdict.Valid()`). */
export function isVerdict(value) {
  return value === ReviewVerdict.approved || value === ReviewVerdict.changesRequested
}

/** Reports whether a run has finished, successfully or not. */
export function isSettled(run) {
  return run.status !== ReviewRunStatus.running
}

/**
 * Every run recorded against one head, in insertion order.
 *
 * An empty `headSha` selects nothing: a pass that could not be pinned to a commit
 * must never decide a lane.
 *
 * @param {ReviewRun[]|undefined|null} runs
 * @param {string} headSha
 * @returns {ReviewRun[]}
 */
export function runsForHead(runs, headSha) {
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
 *
 * @param {ReviewRun[]|undefined|null} runs
 * @returns {number}
 */
export function changesRequestedCycles(runs) {
  const heads = new Set()
  let maxRound = 0
  for (const run of runs ?? []) {
    if (!run || run.verdict !== ReviewVerdict.changesRequested) continue
    if (run.headSha) heads.add(run.headSha)
    const round = Number.isFinite(run.round) ? /** @type {number} */ (run.round) : 0
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
 *
 * @param {ReviewRun[]} headRuns
 * @returns {number}
 */
export function failedAutoRuns(headRuns) {
  let count = 0
  for (const run of headRuns) {
    if (run.status !== ReviewRunStatus.failed) continue
    if (run.triggerSource && run.triggerSource !== ReviewTriggerSource.auto) continue
    count += 1
  }
  return count
}

/**
 * Builds the head-scoped facts the board reducer reads.
 *
 * @param {object} input
 * @param {ReviewRun[]|undefined|null} input.runs  Every run for this worker.
 * @param {string} input.headSha                   The PR's current head.
 * @param {object} [input.bounds]                  {@link REVIEW_BOUND_DEFAULTS}.
 * @returns {import('../contract/kanban.js').KanbanReviewRunFacts}
 */
export function summarizeReviewRuns({ runs, headSha, bounds }) {
  const maxReviewRounds = bounds?.maxReviewRounds ?? REVIEW_BOUND_DEFAULTS.maxReviewRounds
  const retryLimit = bounds?.autoReviewFailedRetryLimit ?? REVIEW_BOUND_DEFAULTS.autoReviewFailedRetryLimit

  const headRuns = runsForHead(runs, headSha)
  /** @type {Partial<import('../contract/kanban.js').KanbanReviewRunFacts>} */
  const facts = {}
  for (const run of headRuns) {
    facts.present = true
    if (run.status === ReviewRunStatus.running) facts.running = true
    if (run.verdict === ReviewVerdict.changesRequested) facts.changesRequested = true
    if (isVerdict(run.verdict)) facts.outcome = true
    if (run.status === ReviewRunStatus.failed) facts.failed = true
    if (run.status === ReviewRunStatus.cancelled) facts.cancelled = true
  }
  facts.roundBudgetExhausted = changesRequestedCycles(runs) >= maxReviewRounds
  facts.failedRetryLimitReached = failedAutoRuns(headRuns) >= retryLimit
  return reviewRunFacts(facts)
}

/**
 * The most recent settled pass with a verdict recorded for a head *other* than
 * this one — the pass the card reports as superseded context.
 *
 * Ported from `latestCompletedRunForOtherSHA`.
 *
 * @param {ReviewRun[]|undefined|null} runs
 * @param {string} headSha
 * @returns {ReviewRun|undefined}
 */
export function latestCompletedRunForOtherHead(runs, headSha) {
  if (!headSha) return undefined
  /** @type {ReviewRun|undefined} */
  let latest
  for (const run of runs ?? []) {
    if (!run || !run.headSha || run.headSha === headSha) continue
    if (run.status !== ReviewRunStatus.complete && run.status !== ReviewRunStatus.delivered) continue
    if (!isVerdict(run.verdict)) continue
    if (!latest || (run.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = run
  }
  return latest
}
