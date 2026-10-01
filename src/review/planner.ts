/**
 * When may an automated review pass start, and for which head?
 *
 * This is the pure decision layer behind the auto-review loop. It answers that
 * question from observed facts alone — no clock reads, no spawning, no I/O — so
 * the trigger path and the board's read path share exactly the same rules and a
 * card can never disagree with what the scheduler would do.
 *
 * PORTED from Agent Orchestrator:
 *   - `backend/internal/review/planner.go`  -> {@link plan}
 *   - `backend/internal/autoreview/coordinator.go` -> {@link sessionGate},
 *     {@link existingHeadReason}, {@link evaluateSession}
 * See NOTICE for the statement of modifications.
 *
 * The reason codes are load-bearing: they are what the plugin logs, what the
 * board surfaces, and what the tests assert. They are reproduced verbatim from
 * the reference.
 *
 * @module dsho/review/planner
 */

import { ActivityState } from '../contract/activity.ts'
import {
  REVIEW_BOUND_DEFAULTS,
  ReviewRunStatus,
  ReviewVerdict,
  changesRequestedCycles,
  isVerdict,
} from './runs.ts'
import type { ReviewBounds, ReviewRun } from './runs.ts'

/**
 * The current review state for one pull-request head. Ported from
 * `contract.AOReviewState`.
 *
 * `needsReview` is the PRD's `queued` as well as its `needs_review`: a pass that
 * is scheduled but has not started has no run row, and this is the state that
 * says so.
 */
export const AOReviewState = Object.freeze({
  needsReview: 'needs_review',
  running: 'running',
  upToDate: 'up_to_date',
  changesRequested: 'changes_requested',
  ineligible: 'ineligible',
} as const)

/** The union of every per-head review state. */
export type AOReviewState = (typeof AOReviewState)[keyof typeof AOReviewState]

/**
 * Why the automated loop may not run for a session at all. Verbatim from the
 * reference's `sessionGate` / `autoReviewSessionReason`.
 */
export const SessionGateReason = Object.freeze({
  disabled: 'disabled',
  notWorker: 'not_worker',
  terminated: 'terminated',
  notIdle: 'not_idle',
  idleThresholdNotMet: 'idle_threshold_not_met',
} as const)

/**
 * Why the loop may not run for one head. Verbatim from the reference's
 * `existingHeadReason` and `ineligibleReason`.
 */
export const HeadSkipReason = Object.freeze({
  reviewRunning: 'review_running',
  cancelledSameSha: 'cancelled_same_sha',
  alreadyApproved: 'already_approved',
  changesRequestedSameSha: 'changes_requested_same_sha',
  failedSameShaRetryLimit: 'failed_same_sha_retry_limit',
  draftPr: 'draft_pr',
  mergedPr: 'merged_pr',
  closedPr: 'closed_pr',
  missingHeadSha: 'missing_head_sha',
  /**
   * DSHO-only, and deliberately hyphenated rather than snake_cased: PRD §7.5
   * names this reason string literally, because it is rendered on the board's
   * `Needs you` badge. One concept gets one spelling.
   *
   * The reference has no equivalent: AO has no round cap, so it will re-review a
   * changes-requested PR forever.
   */
  reviewRoundLimit: 'review-round-limit',
} as const)

/** Every reason string the scheduler can report. */
export type ReasonCode =
  | (typeof SessionGateReason)[keyof typeof SessionGateReason]
  | (typeof HeadSkipReason)[keyof typeof HeadSkipReason]
  | 'missing_reviewer_harness'
  | 'no_pr'
  | 'planner_ineligible'
  | 'triggered'

/** The reference's defaults, restated so they are visible where they are used. */
export const REVIEW_LOOP_DEFAULTS: Readonly<
  Required<ReviewBounds> & { idleThresholdMs: number; sweepIntervalMs: number }
> = Object.freeze({
  /** A worker must be idle at least this long before a pass may start. */
  idleThresholdMs: 60_000,
  /** How often the sweep re-evaluates live sessions. */
  sweepIntervalMs: 60_000,
  ...REVIEW_BOUND_DEFAULTS,
})

/** The PR facts the planner reads. */
export interface PRFactsForPlan {
  url: string
  number?: number
  title?: string
  headSha: string
  merged?: boolean
  closed?: boolean
  draft?: boolean
}

/** One PR-scoped review decision for a worker session. */
export interface PRReviewState {
  prUrl: string
  prNumber: number | undefined
  title: string | undefined
  targetSha: string
  status: AOReviewState
  latestRun?: ReviewRun
  previousRun?: ReviewRun
}

/**
 * Computes per-PR review work from the currently observed PRs and existing review
 * runs. Pure, so the trigger path and the API read path cannot drift apart.
 *
 * Ported from `func Plan(prs, runs) []PRReviewState`. Two faithful details worth
 * naming: only the **latest** run per `(PR, head)` is consulted, and the output is
 * sorted by `(prNumber, prUrl)` so iteration order is deterministic.
 */
export function plan(
  prs: readonly PRFactsForPlan[] | undefined | null,
  runs: readonly ReviewRun[] | undefined | null,
): PRReviewState[] {
  const latest = latestRunsByPRAndHead(runs)
  const reviews: PRReviewState[] = []
  for (const pr of prs ?? []) {
    const review: PRReviewState = {
      prUrl: pr.url ?? '',
      prNumber: pr.number,
      title: pr.title,
      targetSha: pr.headSha ?? '',
      status: AOReviewState.needsReview,
    }
    const previous = latestCompletedRunForOtherHead(runs, review.prUrl, review.targetSha)
    if (previous) review.previousRun = previous

    if (!pr.url || !pr.headSha || pr.merged || pr.closed) {
      review.status = AOReviewState.ineligible
      const run = latest.get(headKey(review.prUrl, review.targetSha))
      if (run) review.latestRun = run
      reviews.push(review)
      continue
    }

    const run = latest.get(headKey(review.prUrl, review.targetSha))
    if (run) {
      review.latestRun = run
      if (run.status === ReviewRunStatus.running) {
        review.status = AOReviewState.running
      } else if (run.verdict === ReviewVerdict.approved) {
        review.status = AOReviewState.upToDate
      } else if (run.verdict === ReviewVerdict.changesRequested) {
        review.status = AOReviewState.changesRequested
      } else {
        // `failed`, `cancelled`, and a settled run with no verdict all read as
        // still needing review: a head we tried and could not judge still owes
        // the PR the pass auto review promised it.
        review.status = AOReviewState.needsReview
      }
    }
    reviews.push(review)
  }
  reviews.sort((a, b) => {
    const an = a.prNumber ?? 0
    const bn = b.prNumber ?? 0
    if (an !== bn) return an - bn
    return a.prUrl < b.prUrl ? -1 : a.prUrl > b.prUrl ? 1 : 0
  })
  return reviews
}

/** The `(PR, head)` key. The reference uses `\x00`; a NUL cannot appear in a URL. */
function headKey(prUrl: string, headSha: string): string {
  return `${prUrl}\x00${headSha}`
}

/**
 * The latest run per `(PR, head)`, keyed by {@link headKey}.
 *
 * Ported from `latestRunsByPRAndSHA`. Runs with no PR URL or no head are dropped:
 * an unpinned pass must never be attributed to a head.
 */
export function latestRunsByPRAndHead(
  runs: readonly ReviewRun[] | undefined | null,
): Map<string, ReviewRun> {
  const latest = new Map<string, ReviewRun>()
  for (const run of runs ?? []) {
    if (!run || !run.prUrl || !run.headSha) continue
    const key = headKey(run.prUrl, run.headSha)
    const existing = latest.get(key)
    if (!existing || (run.createdAt ?? 0) > (existing.createdAt ?? 0)) latest.set(key, run)
  }
  return latest
}

/**
 * The latest settled, judged pass recorded for a head *other* than the target.
 *
 * Ported from `latestCompletedRunForOtherSHA`.
 */
export function latestCompletedRunForOtherHead(
  runs: readonly ReviewRun[] | undefined | null,
  prUrl: string,
  targetSha: string,
): ReviewRun | undefined {
  if (!prUrl || !targetSha) return undefined
  let latest: ReviewRun | undefined
  for (const run of runs ?? []) {
    if (!run || run.prUrl !== prUrl || !run.headSha || run.headSha === targetSha) continue
    if (run.status !== ReviewRunStatus.complete && run.status !== ReviewRunStatus.delivered) continue
    if (!isVerdict(run.verdict)) continue
    if (!latest || (run.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = run
  }
  return latest
}

/** The session facts the gate reads. */
export interface GateSession {
  autoReview?: boolean
  /** `worker` for a worker session. */
  kind?: string
  isTerminated?: boolean
  /** An {@link ActivityState} value. */
  activity?: string
  /** Epoch ms. */
  lastActivityAt?: number
  /** Non-empty when a reviewer is resolvable. */
  reviewerHarness?: string
}

/**
 * The session gate. Runs **before any planner work**, in this order, because the
 * order is the reference's and the reason codes are what the user sees.
 *
 * Two consequences the PRD calls out: the reviewer never races a worker that is
 * mid-turn, and with a 1-minute sweep interval plus a 1-minute idle threshold the
 * realistic delay from "worker pushes" to "reviewer starts" is one to two
 * minutes, not 30 seconds.
 *
 * Ported from `sessionGate` / `autoReviewSessionReason`. One deliberate addition:
 * a session whose reviewer cannot be resolved is gated here as
 * `missing_reviewer_harness` rather than being discovered later, so the caller
 * cannot start a pass it has no reviewer for.
 *
 * Returns a reason code, or `''` when the gate passes.
 */
export function sessionGate(session: GateSession, now: number, idleThresholdMs: number): string {
  if (!session.autoReview) return SessionGateReason.disabled
  if (session.kind !== 'worker') return SessionGateReason.notWorker
  if (session.isTerminated) return SessionGateReason.terminated
  if (session.reviewerHarness === '') return 'missing_reviewer_harness'
  if (session.activity !== ActivityState.idle) return SessionGateReason.notIdle
  if (!session.lastActivityAt || now - session.lastActivityAt < idleThresholdMs) {
    return SessionGateReason.idleThresholdNotMet
  }
  return ''
}

/**
 * Why a head that the planner says needs review still may not be reviewed.
 *
 * Ported from `existingHeadReason`. This is the rule that stops the loop spinning
 * on one commit: a judged head is not re-judged, and a cancelled one is respected.
 *
 * Returns a reason code, or `''` when the head may be reviewed.
 */
export function existingHeadReason(
  runs: readonly ReviewRun[] | undefined | null,
  prUrl: string,
  targetSha: string,
  bounds?: ReviewBounds,
): string {
  const retryLimit =
    bounds?.autoReviewFailedRetryLimit ?? REVIEW_BOUND_DEFAULTS.autoReviewFailedRetryLimit
  let failedAutoRuns = 0
  for (const run of runs ?? []) {
    if (!run || run.prUrl !== prUrl || run.headSha !== targetSha) continue
    if (run.status === ReviewRunStatus.running) return HeadSkipReason.reviewRunning
    if (run.status === ReviewRunStatus.cancelled) return HeadSkipReason.cancelledSameSha
    if (run.verdict === ReviewVerdict.approved) return HeadSkipReason.alreadyApproved
    if (run.verdict === ReviewVerdict.changesRequested) return HeadSkipReason.changesRequestedSameSha
    if (run.status === ReviewRunStatus.failed && run.triggerSource !== 'manual') failedAutoRuns += 1
  }
  if (failedAutoRuns >= retryLimit) return HeadSkipReason.failedSameShaRetryLimit
  return ''
}

/**
 * Why a PR is ineligible for review at all.
 *
 * Ported from `ineligibleReason`.
 */
export function ineligibleReason(
  prs: readonly PRFactsForPlan[] | undefined | null,
  url: string,
): string {
  for (const pr of prs ?? []) {
    if (pr.url !== url) continue
    if (pr.draft) return HeadSkipReason.draftPr
    if (pr.merged) return HeadSkipReason.mergedPr
    if (pr.closed) return HeadSkipReason.closedPr
    if (!pr.headSha) return HeadSkipReason.missingHeadSha
    return 'planner_ineligible'
  }
  return 'planner_ineligible'
}

/** Everything {@link evaluateSession} reads. */
export interface EvaluateInput {
  session: GateSession
  prs: readonly PRFactsForPlan[] | undefined | null
  runs: readonly ReviewRun[] | undefined | null
  now: number
  bounds?: ReviewBounds & { idleThresholdMs?: number }
}

/** The scheduler's answer for one worker session. */
export interface EvaluateResult {
  /** A new pass may be started. */
  trigger: boolean
  /** Why, or why not. Always set. */
  reason: string
  /**
   * The heads a pass may start for. Empty when `trigger` is false. This is the
   * useful output: it is what the spawner iterates, and it is exactly the set the
   * gate permitted.
   */
  headsToReview: string[]
  /** Per-head state, for the board and the API. */
  plans: PRReviewState[]
}

/**
 * Evaluates one worker session against the current activity, PR, and review-run
 * facts, and reports which heads may be reviewed.
 *
 * Ported from `Coordinator.EvaluateSession`, with the reference's batching made
 * explicit: the reference asks its engine to trigger the whole session and then
 * reports why the engine reused runs. Returning the eligible *heads* directly is
 * the same decision, stated in a form the caller can act on without a second
 * round of policy questions.
 *
 * **At most one `ReviewRun` per `(prNumber, headSha)`** falls out of this: a head
 * with a running pass, an approval, a changes-requested verdict, or a cancelled
 * pass, and a head that has burned its retry budget, is never returned here.
 */
export function evaluateSession(input: EvaluateInput): EvaluateResult {
  const idleThresholdMs = input.bounds?.idleThresholdMs ?? REVIEW_LOOP_DEFAULTS.idleThresholdMs
  const gate = sessionGate(input.session, input.now, idleThresholdMs)
  if (gate) return { trigger: false, reason: gate, headsToReview: [], plans: [] }

  if (!input.prs || input.prs.length === 0) {
    return { trigger: false, reason: 'no_pr', headsToReview: [], plans: [] }
  }

  const plans = plan(input.prs, input.runs)

  // DIVERGENCE (DSHO-only). The reference has no round cap, so this check does
  // not exist in `EvaluateSession`. It must exist here as well as in the board
  // reducer, or A18's second half — "no further reviewer passes ... are
  // scheduled" — would be false: the card would stop claiming the loop while the
  // sweep kept starting passes.
  //
  // The budget counts changes-requested cycles across the worker's successive
  // heads, so it is a worker-level bound rather than a head-level one. That
  // matches the 1:1 issue:worker model, where "the loop" is the worker's loop.
  const maxReviewRounds = input.bounds?.maxReviewRounds ?? REVIEW_LOOP_DEFAULTS.maxReviewRounds
  if (changesRequestedCycles(input.runs) >= maxReviewRounds) {
    return { trigger: false, reason: HeadSkipReason.reviewRoundLimit, headsToReview: [], plans }
  }

  const headsToReview: string[] = []
  let hasRunning = false
  let reason: string = 'planner_ineligible'

  for (const state of plans) {
    switch (state.status) {
      case AOReviewState.running:
        hasRunning = true
        reason = HeadSkipReason.reviewRunning
        break
      case AOReviewState.upToDate:
        reason = HeadSkipReason.alreadyApproved
        break
      case AOReviewState.changesRequested:
        reason = HeadSkipReason.changesRequestedSameSha
        break
      case AOReviewState.ineligible:
        reason = ineligibleReason(input.prs, state.prUrl)
        break
      default: {
        const blocked = existingHeadReason(input.runs, state.prUrl, state.targetSha, input.bounds)
        if (blocked) {
          reason = blocked
          break
        }
        headsToReview.push(state.targetSha)
      }
    }
  }

  if (headsToReview.length > 0) {
    return { trigger: true, reason: 'triggered', headsToReview, plans }
  }
  // A pass already running is not a skip: the reference proceeds and reports the
  // reuse. Reporting `review_running` directly is the same observable answer.
  return {
    trigger: false,
    reason: hasRunning ? HeadSkipReason.reviewRunning : reason,
    headsToReview,
    plans,
  }
}

/**
 * Decides a user-forced pass — `orchestrator_run_review`.
 *
 * A forced pass deliberately bypasses the two guards that exist to stop
 * *automation* from spinning: the already-judged-this-head guard
 * (`already_approved`, `changes_requested_same_sha`, `cancelled_same_sha`,
 * `failed_same_sha_retry_limit`) and the round cap. It does **not** bypass
 * ineligibility: there is no diff to review on a merged, closed, or head-less PR,
 * and no point reviewing a draft the worker is still writing.
 *
 * The caller must mark the resulting run `triggerSource: 'manual'` so it does not
 * consume the auto-retry budget (PRD §7.5).
 */
export function evaluateManualRequest(input: {
  /**
   * The PRs to consider. Optional: a worker with no PRs at all is a real state,
   * and the honest answer for it is `no_pr` rather than a type error at a call
   * site that has nothing to pass.
   */
  prs?: readonly PRFactsForPlan[] | undefined | null
  prUrl?: string
  headSha?: string
}): { trigger: boolean; reason: string; headsToReview: string[] } {
  const pinned = (input.prs ?? []).filter((pr) => pr && pr.url && pr.headSha)
  const scoped = pinned.filter(
    (pr) => (!input.prUrl || pr.url === input.prUrl) && (!input.headSha || pr.headSha === input.headSha),
  )
  const reviewable = scoped.filter((pr) => !pr.merged && !pr.closed && !pr.draft)
  if (reviewable.length > 0) {
    return { trigger: true, reason: 'triggered', headsToReview: reviewable.map((pr) => pr.headSha) }
  }
  const first = scoped[0]
  const reason =
    !input.prs || input.prs.length === 0 || !first
      ? 'no_pr'
      : first.draft
        ? HeadSkipReason.draftPr
        : first.merged
          ? HeadSkipReason.mergedPr
          : HeadSkipReason.closedPr
  return { trigger: false, reason, headsToReview: [] }
}
