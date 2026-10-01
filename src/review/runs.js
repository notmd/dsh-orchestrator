/**
 * Head-scoped review-run facts.
 *
 * `ReviewRun` records are keyed by the head commit they judged. This module turns
 * a PR's raw run history into the two derived objects the board reducer reads:
 *
 *   1. `KanbanReviewRunFacts` — a summary of our passes against the PR's
 *      *current* head only. A pass against a superseded head is retained for
 *      history and excluded here, which is what makes the loop safe when the
 *      worker pushes mid-review (PRD §7.5, A16).
 *   2. the two loop bounds, which are DSHO-only because AO has no round cap:
 *      `roundBudgetExhausted` (cycles across successive heads) and
 *      `failedRetryLimitReached` (verdict-less passes on this head).
 *
 * The aggregation shape is ported from Agent Orchestrator
 * `backend/internal/service/session/kanban.go` -> `toContractKanbanPRFacts`, and
 * the retry-limit rule from `backend/internal/autoreview/coordinator.go` ->
 * `existingHeadReason`. See NOTICE.
 *
 * @module dsho/review/runs
 */

import { reviewRunFacts } from '../contract/kanban.js'

/** Run lifecycle states. */
export const ReviewRunState = Object.freeze({
  queued: 'queued',
  running: 'running',
  approved: 'approved',
  changesRequested: 'changes_requested',
  failed: 'failed',
  cancelled: 'cancelled',
})

/** Sentinel used by older AO rows whose trigger source was not recorded. */
const TRIGGER_AUTO = 'auto'

/**
 * @typedef {object} ReviewRun
 * @property {string} [id]
 * @property {string} workerId
 * @property {number} [prNumber]
 * @property {string} [prUrl]
 * @property {string} headSha          The commit this pass judged. The identity.
 * @property {number} [round]          1-based cycle index.
 * @property {string} status           {@link ReviewRunState} value.
 * @property {'auto'|'manual'} [triggerSource]
 * @property {string} [verdict]        `approved` | `changes_requested` | undefined.
 * @property {object[]} [findings]
 * @property {string} [summary]
 * @property {string} [sessionId]      The **reviewer** session, not the worker's.
 * @property {string} [harness]        Recorded for a migration-free future.
 * @property {number} [startedAt]
 * @property {number} [endedAt]
 */

/**
 * The default loop bounds. Values verified against the AO source and restated in
 * PRD §13.
 */
export const REVIEW_BOUND_DEFAULTS = Object.freeze({
  maxReviewRounds: 3,
  autoReviewFailedRetryLimit: 3,
})

/** Reports whether a verdict value is a real one (AO's `Verdict.Valid()`). */
export function isVerdict(value) {
  return value === ReviewRunState.approved || value === ReviewRunState.changesRequested
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
    if (!run || run.verdict !== ReviewRunState.changesRequested) continue
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
 * run precisely so this filter is possible (PRD §7.5, test plan).
 *
 * @param {ReviewRun[]} headRuns
 * @returns {number}
 */
export function failedAutoRuns(headRuns) {
  let count = 0
  for (const run of headRuns) {
    if (run.status !== ReviewRunState.failed) continue
    // AO treats a missing harness/source as eligible: `run.Harness == harness ||
    // run.Harness == ""`. Same treatment for the trigger source.
    if (run.triggerSource && run.triggerSource !== TRIGGER_AUTO) continue
    count += 1
  }
  return count
}

/**
 * Builds the head-scoped facts the board reducer reads.
 *
 * @param {object} input
 * @param {ReviewRun[]|undefined|null} input.runs     Every run for this worker.
 * @param {string} input.headSha                      The PR's current head.
 * @param {object} [input.bounds]                     {@link REVIEW_BOUND_DEFAULTS}.
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
    if (run.status === ReviewRunState.running) facts.running = true
    if (run.verdict === ReviewRunState.changesRequested) facts.changesRequested = true
    if (isVerdict(run.verdict)) facts.outcome = true
    if (run.status === ReviewRunState.failed) facts.failed = true
    if (run.status === ReviewRunState.cancelled) facts.cancelled = true
  }
  facts.roundBudgetExhausted = changesRequestedCycles(runs) >= maxReviewRounds
  facts.failedRetryLimitReached = failedAutoRuns(headRuns) >= retryLimit
  return reviewRunFacts(facts)
}

/**
 * The most recent run recorded for a head *other* than this one — the pass the
 * card reports as superseded context.
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
    if (run.status !== 'complete' && run.status !== 'delivered') continue
    if (!isVerdict(run.verdict)) continue
    if (!latest || (run.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = run
  }
  return latest
}
