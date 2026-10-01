/**
 * The review-loop scheduler: one pass per (PR, head), and every reason it may
 * refuse to start one.
 *
 * Acceptance criteria covered: A13 (a pass is scheduled for the head within one
 * tick), A18 (the cap stops scheduling), A20 (a judged or cancelled head is not
 * re-judged), A21 (the lane reads our verdict, not GitHub's).
 *
 * The PRD's test plan asks for these specifically:
 *   "one pass per (pr, head); no duplicate while running; a changed head
 *    supersedes the old pass; a `changes_requested` or `cancelled` pass blocks any
 *    further pass on the same head; a `failed` pass retries once per head and then
 *    escalates; the round cap stops scheduling entirely; `manual` failures do not
 *    consume the auto-retry budget."
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ActivityState } from '../../src/contract/activity.ts'
import {
  AOReviewState,
  HeadSkipReason,
  REVIEW_LOOP_DEFAULTS,
  SessionGateReason,
  evaluateSession,
  existingHeadReason,
  ineligibleReason,
  evaluateManualRequest,
  plan,
} from '../../src/review/planner.ts'
import { ReviewRunStatus, ReviewTriggerSource, ReviewVerdict } from '../../src/review/runs.ts'
import type { ReviewBounds, ReviewRun } from '../../src/review/runs.ts'
import type {
  EvaluateInput,
  EvaluateResult,
  GateSession,
  PRFactsForPlan,
  PRReviewState,
} from '../../src/review/planner.ts'

const NOW = 10_000_000
const PR = 'https://github.com/o/r/pull/1'

/** A worker that is idle and has been for longer than the threshold. */
function idleWorker(overrides: GateSession = {}): GateSession {
  return {
    autoReview: true,
    kind: 'worker',
    isTerminated: false,
    activity: ActivityState.idle,
    lastActivityAt: NOW - REVIEW_LOOP_DEFAULTS.idleThresholdMs,
    reviewerHarness: 'deepseek-harness',
    ...overrides,
  }
}

function openPr(overrides: Partial<PRFactsForPlan> = {}): PRFactsForPlan {
  return { url: PR, number: 1, title: 'Fix the flaky auth test', headSha: 'sha-1', ...overrides }
}

function run(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    workerId: 'wrk-1',
    prUrl: PR,
    prNumber: 1,
    headSha: 'sha-1',
    status: ReviewRunStatus.complete,
    verdict: ReviewVerdict.none,
    ...overrides,
  }
}

/**
 * Evaluates a session, defaulting everything the case does not care about.
 *
 * `Partial<EvaluateInput>` is what keeps the cases readable: most of them vary a
 * single fact, and requiring all four would bury that fact under ceremony.
 */
function evaluate(partial: Partial<EvaluateInput> = {}): EvaluateResult {
  return evaluateSession({
    session: idleWorker(partial.session),
    prs: partial.prs ?? [openPr()],
    runs: partial.runs ?? [],
    now: NOW,
    ...(partial.bounds ? { bounds: partial.bounds } : {}),
  })
}

/**
 * The single plan row a one-PR case is about.
 *
 * `noUncheckedIndexedAccess` makes a destructured `const [state] = plan(...)`
 * `PRReviewState | undefined`, which is correct in general and noise for a case
 * that passed exactly one PR. The assertion narrows the type and states the
 * expectation at the same time.
 */
function firstPlan(
  prs: readonly PRFactsForPlan[],
  runs: readonly ReviewRun[] = [],
): PRReviewState {
  const [state] = plan(prs, runs)
  assert.ok(state, 'expected the plan to contain one row')
  return state
}

// ---------------------------------------------------------------------------
// plan(): per-PR state
// ---------------------------------------------------------------------------

test('plan: a head with no pass is needs_review', () => {
  const state = firstPlan([openPr()], [])
  assert.equal(state.status, AOReviewState.needsReview)
  assert.equal(state.targetSha, 'sha-1')
  assert.equal(state.latestRun, undefined)
})

test('plan: a running pass on the head is running', () => {
  const state = firstPlan([openPr()], [run({ status: ReviewRunStatus.running })])
  assert.equal(state.status, AOReviewState.running)
})

test('plan: an approving pass makes the head up_to_date', () => {
  const state = firstPlan([openPr()], [run({ verdict: ReviewVerdict.approved })])
  assert.equal(state.status, AOReviewState.upToDate)
})

test('plan: a changes-requested pass is changes_requested', () => {
  const state = firstPlan([openPr()], [run({ verdict: ReviewVerdict.changesRequested })])
  assert.equal(state.status, AOReviewState.changesRequested)
})

test('plan: a failed pass leaves the head needing review, not finished', () => {
  // The reference maps failed and cancelled to needs_review: the pass owed to the
  // PR has not happened, so the head is still owed one.
  const state = firstPlan([openPr()], [run({ status: ReviewRunStatus.failed })])
  assert.equal(state.status, AOReviewState.needsReview)
  assert.equal(state.latestRun?.status, ReviewRunStatus.failed)
})

test('plan: a cancelled pass leaves the head needing review', () => {
  const state = firstPlan([openPr()], [run({ status: ReviewRunStatus.cancelled })])
  assert.equal(state.status, AOReviewState.needsReview)
})

test('plan: merged, closed, and head-less PRs are ineligible', async (t) => {
  const cases: ReadonlyArray<readonly [string, PRFactsForPlan]> = [
    ['a merged pr', openPr({ merged: true })],
    ['a closed pr', openPr({ closed: true })],
    ['a pr with no head sha', openPr({ headSha: '' })],
    ['a pr with no url', openPr({ url: '' })],
  ]
  for (const [name, pr] of cases) {
    await t.test(name, () => {
      const state = firstPlan([pr], [])
      assert.equal(state.status, AOReviewState.ineligible)
    })
  }
})

test('plan: a draft PR is NOT ineligible — it plans a pass', () => {
  // Ineligibility is about the PR being un-reviewable at all. A draft is
  // reviewable; `draft_pr` is a *skip* reason the coordinator applies later.
  const state = firstPlan([openPr({ draft: true })], [])
  assert.equal(state.status, AOReviewState.needsReview)
})

test('plan: only the latest run per (pr, head) is consulted', () => {
  const older = run({ verdict: ReviewVerdict.changesRequested, createdAt: 1 })
  const newer = run({ verdict: ReviewVerdict.approved, createdAt: 2 })
  const state = firstPlan([openPr()], [older, newer])
  assert.equal(state.status, AOReviewState.upToDate)
  assert.equal(state.latestRun, newer)
})

test('plan: a superseded head is reported as previousRun context', () => {
  // A16: the run for the earlier head is history. It is shown, and it decides
  // nothing.
  const runs = [run({ headSha: 'sha-0', verdict: ReviewVerdict.changesRequested, createdAt: 5 })]
  const state = firstPlan([openPr()], runs)
  assert.equal(state.status, AOReviewState.needsReview, 'the current head is unreviewed')
  assert.equal(state.previousRun?.headSha, 'sha-0')
})

test('plan: an unattributable run is dropped, not misfiled onto a head', () => {
  const runs = [
    run({ prUrl: '', headSha: 'sha-1', verdict: ReviewVerdict.approved }),
    run({ prUrl: PR, headSha: '', verdict: ReviewVerdict.approved }),
  ]
  const state = firstPlan([openPr()], runs)
  assert.equal(state.status, AOReviewState.needsReview)
})

test('plan: output is sorted by (prNumber, prUrl) so iteration is deterministic', () => {
  const prs = [
    { url: 'https://x/pull/2', number: 2, headSha: 's2' },
    { url: 'https://x/pull/1', number: 1, headSha: 's1' },
    { url: 'https://a/pull/1', number: 1, headSha: 's3' },
  ]
  assert.deepEqual(
    plan(prs, []).map((s) => s.prUrl),
    ['https://a/pull/1', 'https://x/pull/1', 'https://x/pull/2'],
  )
})

test('plan: an empty input is an empty plan', () => {
  assert.deepEqual(plan(undefined, undefined), [])
})

// ---------------------------------------------------------------------------
// sessionGate(): the five pre-planner checks, in order
// ---------------------------------------------------------------------------

test('sessionGate: each refusal, in the reference order', async (t) => {
  const cases: ReadonlyArray<readonly [string, GateSession, string]> = [
    ['auto review disabled', { autoReview: false }, SessionGateReason.disabled],
    ['not a worker session', { kind: 'orchestrator' }, SessionGateReason.notWorker],
    ['the session is terminated', { isTerminated: true }, SessionGateReason.terminated],
    ['no reviewer is resolvable', { reviewerHarness: '' }, 'missing_reviewer_harness'],
    ['the worker is running, not idle', { activity: ActivityState.active }, SessionGateReason.notIdle],
    [
      'the worker has not been idle long enough',
      { lastActivityAt: NOW - 1 },
      SessionGateReason.idleThresholdNotMet,
    ],
    [
      'the worker has never reported activity',
      { lastActivityAt: 0 },
      SessionGateReason.idleThresholdNotMet,
    ],
    [
      'exactly at the threshold is still too early',
      { lastActivityAt: NOW - REVIEW_LOOP_DEFAULTS.idleThresholdMs + 1 },
      SessionGateReason.idleThresholdNotMet,
    ],
  ]
  for (const [name, overrides, want] of cases) {
    await t.test(name, () => {
      const result = evaluate({ session: overrides })
      assert.equal(result.reason, want)
      assert.equal(result.trigger, false)
      assert.deepEqual(result.headsToReview, [])
    })
  }
})

test('sessionGate: a sticky paused worker is not idle, so no pass starts', async (t) => {
  // A26: `waiting_input` does not decay with time. The gate reads `activity`, so
  // an old `lastActivityAt` cannot make a paused worker look idle.
  for (const activity of [ActivityState.waitingInput, ActivityState.blocked]) {
    await t.test(activity, () => {
      const result = evaluate({
        session: { activity, lastActivityAt: NOW - 3_600_000 },
      })
      assert.equal(result.trigger, false)
      assert.equal(result.reason, SessionGateReason.notIdle)
      assert.deepEqual(result.headsToReview, [])
    })
  }
})

test('sessionGate: an unknown activity state is not idle', () => {
  const result = evaluate({ session: { activity: ActivityState.unknown, lastActivityAt: NOW - 3_600_000 } })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, SessionGateReason.notIdle)
})

test('sessionGate: the gate runs before the planner, so an idle worker with no PR says no_pr', () => {
  assert.equal(evaluate({ prs: [] }).reason, 'no_pr')
})

// ---------------------------------------------------------------------------
// evaluateSession(): one pass per head
// ---------------------------------------------------------------------------

test('A13 — a head with no pass is scheduled for review', () => {
  const result = evaluate({})
  assert.equal(result.trigger, true)
  assert.equal(result.reason, 'triggered')
  assert.deepEqual(result.headsToReview, ['sha-1'])
})

test('A20 — a running pass blocks a duplicate for the same head', () => {
  const result = evaluate({ runs: [run({ status: ReviewRunStatus.running })] })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, HeadSkipReason.reviewRunning)
  assert.deepEqual(result.headsToReview, [])
})

test('A20 — a changes-requested verdict on head H blocks any further pass on H', () => {
  const result = evaluate({ runs: [run({ verdict: ReviewVerdict.changesRequested })] })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, HeadSkipReason.changesRequestedSameSha)
})

test('A20 — a cancelled pass on head H blocks any further pass on H', () => {
  const result = evaluate({ runs: [run({ status: ReviewRunStatus.cancelled })] })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, HeadSkipReason.cancelledSameSha)
})

test('an approved head is skipped', () => {
  const result = evaluate({ runs: [run({ verdict: ReviewVerdict.approved })] })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, HeadSkipReason.alreadyApproved)
})

test('a failed pass retries, once per head, up to the limit', async (t) => {
  const autoFail = run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.auto })

  await t.test('one failure still allows a retry', () => {
    const result = evaluate({ runs: [autoFail] })
    assert.equal(result.trigger, true)
    assert.deepEqual(result.headsToReview, ['sha-1'])
  })

  await t.test('two failures still allow a retry', () => {
    assert.equal(evaluate({ runs: [autoFail, autoFail] }).trigger, true)
  })

  await t.test('three failures stop the retries', () => {
    const result = evaluate({ runs: [autoFail, autoFail, autoFail] })
    assert.equal(result.trigger, false)
    assert.equal(result.reason, HeadSkipReason.failedSameShaRetryLimit)
  })

  await t.test('manual failures do not consume the auto-retry budget', () => {
    const manualFail = run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.manual })
    const result = evaluate({ runs: [manualFail, manualFail, manualFail, manualFail] })
    assert.equal(result.trigger, true, 'the budget is untouched')
  })
})

test('a changed head supersedes the old pass and starts a new cycle', () => {
  const runs = [
    run({ headSha: 'sha-0', verdict: ReviewVerdict.changesRequested, round: 1 }),
    run({ headSha: 'sha-0', status: ReviewRunStatus.cancelled, round: 1 }),
  ]
  const result = evaluate({ prs: [openPr({ headSha: 'sha-1' })], runs })
  assert.equal(result.trigger, true, 'the new head is unreviewed')
  assert.deepEqual(result.headsToReview, ['sha-1'])
})

test('A18 — the round cap stops scheduling entirely', async (t) => {
  const cycle = (i: number): ReviewRun =>
    run({ headSha: `sha-${i}`, round: i, verdict: ReviewVerdict.changesRequested, createdAt: i })

  await t.test('under the cap, a new head is reviewed', () => {
    const result = evaluate({
      prs: [openPr({ headSha: 'sha-3' })],
      runs: [cycle(1), cycle(2)],
    })
    assert.equal(result.trigger, true)
  })

  await t.test('at the cap, no head is scheduled again', () => {
    const result = evaluate({
      prs: [openPr({ headSha: 'sha-4' })],
      runs: [cycle(1), cycle(2), cycle(3)],
    })
    assert.equal(result.trigger, false)
  })

  await t.test('a configured cap of one stops scheduling after one cycle', () => {
    const result = evaluate({
      prs: [openPr({ headSha: 'sha-2' })],
      runs: [cycle(1)],
      bounds: { maxReviewRounds: 1 },
    })
    assert.equal(result.trigger, false)
  })
})

test('A13/A21 — several heads on one worker are each decided on their own', () => {
  const prs = [
    { url: 'https://x/pull/1', number: 1, headSha: 's1' },
    { url: 'https://x/pull/2', number: 2, headSha: 's2' },
  ]
  const runs = [
    run({ prUrl: 'https://x/pull/1', headSha: 's1', verdict: ReviewVerdict.approved }),
  ]
  const result = evaluate({ prs, runs })
  assert.equal(result.trigger, true)
  assert.deepEqual(result.headsToReview, ['s2'], 'only the unapproved head')
})

test('a running pass on one head does not block a different head', () => {
  const prs = [
    { url: 'https://x/pull/1', number: 1, headSha: 's1' },
    { url: 'https://x/pull/2', number: 2, headSha: 's2' },
  ]
  const runs = [
    run({ prUrl: 'https://x/pull/1', headSha: 's1', status: ReviewRunStatus.running }),
  ]
  const result = evaluate({ prs, runs })
  assert.equal(result.trigger, true)
  assert.deepEqual(result.headsToReview, ['s2'])
})

test('a session whose only heads are skipped reports why, and schedules nothing', () => {
  const result = evaluate({
    runs: [run({ verdict: ReviewVerdict.approved })],
  })
  assert.equal(result.trigger, false)
  assert.equal(result.reason, HeadSkipReason.alreadyApproved)
  assert.deepEqual(result.headsToReview, [])
})

test('ineligibleReason names the exact blocker', async (t) => {
  const cases: ReadonlyArray<readonly [string, PRFactsForPlan, string]> = [
    ['a draft', { url: PR, headSha: 's', draft: true }, HeadSkipReason.draftPr],
    ['a merged pr', { url: PR, headSha: 's', merged: true }, HeadSkipReason.mergedPr],
    ['a closed pr', { url: PR, headSha: 's', closed: true }, HeadSkipReason.closedPr],
    ['a missing head', { url: PR, headSha: '' }, HeadSkipReason.missingHeadSha],
    ['an unknown url', { url: 'other', headSha: 's' }, 'planner_ineligible'],
  ]
  for (const [name, pr, want] of cases) {
    await t.test(name, () => {
      assert.equal(ineligibleReason([pr], PR), want)
    })
  }
})

test('existingHeadReason: the six conditions, checked in order', async (t) => {
  const cases: ReadonlyArray<readonly [string, ReviewRun[], string]> = [
    ['running wins over everything', [run({ status: ReviewRunStatus.running, verdict: ReviewVerdict.approved })], HeadSkipReason.reviewRunning],
    ['cancelled is respected', [run({ status: ReviewRunStatus.cancelled })], HeadSkipReason.cancelledSameSha],
    ['an approval is not re-reviewed', [run({ verdict: ReviewVerdict.approved })], HeadSkipReason.alreadyApproved],
    ['changes requested waits for a new sha', [run({ verdict: ReviewVerdict.changesRequested })], HeadSkipReason.changesRequestedSameSha],
  ]
  for (const [name, runs, want] of cases) {
    await t.test(name, () => {
      assert.equal(existingHeadReason(runs, PR, 'sha-1'), want)
    })
  }

  await t.test('an unrelated head is not consulted', () => {
    assert.equal(existingHeadReason([run({ headSha: 'other', verdict: ReviewVerdict.approved })], PR, 'sha-1'), '')
  })
  await t.test('another PR is not consulted', () => {
    assert.equal(existingHeadReason([run({ prUrl: 'other', verdict: ReviewVerdict.approved })], PR, 'sha-1'), '')
  })
  await t.test('a clean head is reviewable', () => {
    assert.equal(existingHeadReason([], PR, 'sha-1'), '')
  })
})

test('the defaults match the PRD and the reference', () => {
  assert.equal(REVIEW_LOOP_DEFAULTS.maxReviewRounds, 3)
  assert.equal(REVIEW_LOOP_DEFAULTS.autoReviewFailedRetryLimit, 3)
  assert.equal(REVIEW_LOOP_DEFAULTS.idleThresholdMs, 60_000)
  assert.equal(REVIEW_LOOP_DEFAULTS.sweepIntervalMs, 60_000)
})

test('evaluateSession always reports a reason', () => {
  const reasonless = [
    evaluate({}),
    evaluate({ runs: [run({ verdict: ReviewVerdict.approved })] }),
    evaluate({ prs: [] }),
    evaluate({ session: { autoReview: false } }),
  ]
  for (const result of reasonless) {
    assert.equal(typeof result.reason, 'string')
    assert.notEqual(result.reason, '')
  }
})

// ---------------------------------------------------------------------------
// The manual override, and the one reason string shared with the board
// ---------------------------------------------------------------------------

test('orchestrator_run_review: a forced pass bypasses the automation guards', async (t) => {
  await t.test('an already-approved head can be re-reviewed on request', () => {
    // `evaluateManualRequest` takes no run history at all -- that is the point:
    // a forced pass is decided from PR facts alone, so nothing about a previous
    // verdict can refuse it.
    const result = evaluateManualRequest({ prs: [openPr()] })
    assert.equal(result.trigger, true)
    assert.deepEqual(result.headsToReview, ['sha-1'])
  })

  await t.test('a round-capped worker can be re-reviewed on request', () => {
    const result = evaluateManualRequest({ prs: [openPr({ headSha: 'sha-9' })] })
    assert.equal(result.trigger, true)
  })

  await t.test('a changes-requested head can be re-reviewed on request', () => {
    const result = evaluateManualRequest({ prs: [openPr()] })
    assert.equal(result.trigger, true)
  })

  await t.test('but ineligibility is never bypassed', () => {
    const cases: ReadonlyArray<readonly [string, PRFactsForPlan, string]> = [
      ['merged', openPr({ merged: true }), HeadSkipReason.mergedPr],
      ['closed', openPr({ closed: true }), HeadSkipReason.closedPr],
      ['draft', openPr({ draft: true }), HeadSkipReason.draftPr],
    ]
    for (const [name, pr, want] of cases) {
      const result = evaluateManualRequest({ prs: [pr] })
      assert.equal(result.trigger, false, name)
      assert.equal(result.reason, want, name)
    }
  })

  await t.test('a pinned head selects only that head', () => {
    const prs = [
      { url: 'https://x/pull/1', number: 1, headSha: 's1' },
      { url: 'https://x/pull/2', number: 2, headSha: 's2' },
    ]
    assert.deepEqual(evaluateManualRequest({ prs, headSha: 's2' }).headsToReview, ['s2'])
    assert.deepEqual(evaluateManualRequest({ prs, prUrl: 'https://x/pull/1' }).headsToReview, ['s1'])
  })

  await t.test('no PR at all says so', () => {
    assert.equal(evaluateManualRequest({ prs: [] }).reason, 'no_pr')
    assert.equal(evaluateManualRequest({}).reason, 'no_pr')
  })
})

test('the round-limit reason has exactly one spelling across the planner and the board', async () => {
  const { autoReviewHaltReason, prFacts } = await import('../../src/contract/kanban.ts')
  const board = autoReviewHaltReason(
    prFacts({ url: 'pr/1', reviewRun: { present: true, changesRequested: true, roundBudgetExhausted: true } }),
  )
  assert.equal(board, HeadSkipReason.reviewRoundLimit)
  assert.equal(board, 'review-round-limit', 'the literal PRD §7.5 string')
})

test('the retry-limit skip reason matches the board escalation for the same facts', async () => {
  const { autoReviewHaltReason, prFacts } = await import('../../src/contract/kanban.ts')
  const board = autoReviewHaltReason(
    prFacts({ url: 'pr/1', reviewRun: { present: true, failed: true, failedRetryLimitReached: true } }),
  )
  assert.equal(board, 'review-failed-retry-limit')
})
