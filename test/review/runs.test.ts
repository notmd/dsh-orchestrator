/**
 * Head-scoped review-run facts: the two loop bounds and the stale-head exclusion.
 *
 * Acceptance criteria covered: A16 (a superseded head never decides a lane),
 * A18 (the round cap stops the loop), A20 (a judged head is not re-judged), and
 * the test plan's "manual failures do not consume the auto-retry budget".
 *
 * Note the two-field model under test: `status` is the lifecycle, `verdict` is
 * the outcome. A verdict only exists on a settled run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ReviewRun } from '../../src/review/runs.ts'
import {
  REVIEW_BOUND_DEFAULTS,
  ReviewRunStatus,
  ReviewTriggerSource,
  ReviewVerdict,
  changesRequestedCycles,
  failedAutoRuns,
  isSettled,
  isVerdict,
  latestCompletedRunForOtherHead,
  runsForHead,
  summarizeReviewRuns,
} from '../../src/review/runs.ts'

const HEAD_A = 'sha-a'
const HEAD_B = 'sha-b'
const PR = 'pr/1'

function run(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    workerId: 'wrk-1',
    prUrl: PR,
    headSha: HEAD_A,
    status: ReviewRunStatus.complete,
    verdict: ReviewVerdict.none,
    ...overrides,
  }
}

test('runsForHead: a pass for another head is excluded', () => {
  const runs = [run({ headSha: HEAD_A }), run({ headSha: HEAD_B })]
  assert.deepEqual(runsForHead(runs, HEAD_A).map((r) => r.headSha), [HEAD_A])
})

test('A16 — a pass recorded for an earlier head cannot be seen for the current one', () => {
  const runs = [run({ headSha: HEAD_A, status: ReviewRunStatus.complete, verdict: ReviewVerdict.approved })]
  const facts = summarizeReviewRuns({ runs, headSha: HEAD_B })
  assert.equal(facts.present, false, 'the superseded pass is invisible')
  assert.equal(facts.outcome, false)
  assert.equal(facts.changesRequested, false)
})

test('an empty head SHA selects nothing', () => {
  const runs = [run({ verdict: ReviewVerdict.approved })]
  const facts = summarizeReviewRuns({ runs, headSha: '' })
  assert.equal(facts.present, false)
  assert.equal(runsForHead(runs, '').length, 0)
})

test("the aggregation carries the reference's shape: present/running/outcome/failed/cancelled", () => {
  const cases: ReadonlyArray<
    readonly [string, Partial<ReviewRun>, Record<string, boolean>]
  > = [
    [
      'a settled pass with no verdict is present but has no outcome',
      { status: ReviewRunStatus.complete, verdict: ReviewVerdict.none },
      { present: true, outcome: false },
    ],
    [
      'a running pass is present and running',
      { status: ReviewRunStatus.running },
      { present: true, running: true, outcome: false },
    ],
    [
      'an approving pass has an outcome',
      { status: ReviewRunStatus.complete, verdict: ReviewVerdict.approved },
      { present: true, outcome: true, changesRequested: false },
    ],
    [
      'a delivered approving pass also has an outcome',
      { status: ReviewRunStatus.delivered, verdict: ReviewVerdict.approved },
      { present: true, outcome: true },
    ],
    [
      'a changes-requested pass has an outcome and asked for changes',
      { status: ReviewRunStatus.complete, verdict: ReviewVerdict.changesRequested },
      { present: true, outcome: true, changesRequested: true },
    ],
    [
      'a failed pass is present without an outcome',
      { status: ReviewRunStatus.failed },
      { present: true, failed: true, outcome: false },
    ],
    [
      'a cancelled pass is present',
      { status: ReviewRunStatus.cancelled },
      { present: true, cancelled: true, outcome: false },
    ],
  ]
  for (const [name, overrides, expected] of cases) {
    const facts = summarizeReviewRuns({ runs: [run(overrides)], headSha: HEAD_A })
    for (const [key, value] of Object.entries(expected)) {
      assert.equal((facts as unknown as Record<string, unknown>)[key], value, `${name}: ${key}`)
    }
  }
})

test('a retry after a failure supersedes nothing: the facts aggregate over the head', () => {
  // The reference aggregates with `||=`, so a failed first pass and a running
  // retry on the same head read as present+failed+running at once. That is
  // deliberate: the card can say "Review failed" while a retry is in flight.
  const runs = [
    run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.auto }),
    run({ status: ReviewRunStatus.running, triggerSource: ReviewTriggerSource.auto }),
  ]
  const facts = summarizeReviewRuns({ runs, headSha: HEAD_A })
  assert.equal(facts.failed, true)
  assert.equal(facts.running, true)
  assert.equal(facts.outcome, false)
})

test('isVerdict accepts exactly the two real verdicts', () => {
  assert.ok(isVerdict(ReviewVerdict.approved))
  assert.ok(isVerdict(ReviewVerdict.changesRequested))
  assert.ok(!isVerdict(ReviewVerdict.none))
  assert.ok(!isVerdict(undefined))
  assert.ok(!isVerdict('failed'))
  assert.ok(!isVerdict('queued'))
})

test('isSettled: only a running pass is unsettled', () => {
  assert.ok(!isSettled({ status: ReviewRunStatus.running }))
  for (const status of [
    ReviewRunStatus.complete,
    ReviewRunStatus.delivered,
    ReviewRunStatus.failed,
    ReviewRunStatus.cancelled,
  ]) {
    assert.ok(isSettled({ status }), status)
  }
})

test('changesRequestedCycles counts heads, so a re-judged head is one cycle', () => {
  // A20: a changes-requested verdict on head H does not produce a second cycle on
  // H, however many sweep ticks elapse.
  const runs = [
    run({ verdict: ReviewVerdict.changesRequested }),
    run({ status: ReviewRunStatus.failed }),
    run({ verdict: ReviewVerdict.changesRequested }),
  ]
  assert.equal(changesRequestedCycles(runs), 1)
})

test('changesRequestedCycles counts successive heads', () => {
  const runs = [HEAD_A, HEAD_B, 'sha-c'].map((headSha) =>
    run({ headSha, verdict: ReviewVerdict.changesRequested }),
  )
  assert.equal(changesRequestedCycles(runs), 3)
})

test('changesRequestedCycles honors a recorded round that ran ahead of observed heads', () => {
  // An older run row can lose its head SHA while keeping its round number; the
  // cycle count must not silently reset.
  const runs = [run({ headSha: '', round: 3, verdict: ReviewVerdict.changesRequested })]
  assert.equal(changesRequestedCycles(runs), 3)
})

test('changesRequestedCycles ignores approving passes', () => {
  assert.equal(changesRequestedCycles([run({ verdict: ReviewVerdict.approved })]), 0)
})

test('A18 — the round budget trips at maxReviewRounds', async (t) => {
  const cycle = (i: number): ReviewRun => run({ headSha: `sha-${i}`, round: i, verdict: ReviewVerdict.changesRequested })

  await t.test('two cycles of three is not exhausted', () => {
    const facts = summarizeReviewRuns({ runs: [cycle(1), cycle(2)], headSha: 'sha-2' })
    assert.equal(facts.roundBudgetExhausted, false)
  })

  await t.test('three cycles of three is exhausted', () => {
    const facts = summarizeReviewRuns({ runs: [cycle(1), cycle(2), cycle(3)], headSha: 'sha-3' })
    assert.equal(facts.roundBudgetExhausted, true)
  })

  await t.test('a configured bound of one trips immediately', () => {
    const facts = summarizeReviewRuns({
      runs: [cycle(1)],
      headSha: 'sha-1',
      bounds: { maxReviewRounds: 1 },
    })
    assert.equal(facts.roundBudgetExhausted, true)
  })

  await t.test('the default bound is 3, as the PRD states', () => {
    assert.equal(REVIEW_BOUND_DEFAULTS.maxReviewRounds, 3)
  })
})

test('failedAutoRuns counts automated failures only', () => {
  const runs = [
    run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.auto }),
    run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.manual }),
    run({ status: ReviewRunStatus.failed }),
    run({ status: ReviewRunStatus.running, triggerSource: ReviewTriggerSource.auto }),
  ]
  // 'auto' and the legacy missing source both count; 'manual' does not.
  assert.equal(failedAutoRuns(runs), 2)
})

test('A18 — the failed-retry limit trips per head, and manual runs do not spend it', async (t) => {
  const autoFail = run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.auto })
  const manualFail = run({ status: ReviewRunStatus.failed, triggerSource: ReviewTriggerSource.manual })

  await t.test('three automated failures on the head reach the limit', () => {
    const facts = summarizeReviewRuns({ runs: [autoFail, autoFail, autoFail], headSha: HEAD_A })
    assert.equal(facts.failedRetryLimitReached, true)
    assert.equal(facts.failed, true)
    assert.equal(facts.outcome, false)
  })

  await t.test('two automated failures and any number of manual ones do not', () => {
    const facts = summarizeReviewRuns({
      runs: [autoFail, autoFail, manualFail, manualFail, manualFail],
      headSha: HEAD_A,
    })
    assert.equal(facts.failedRetryLimitReached, false)
  })

  await t.test("failures on another head do not spend this head's budget", () => {
    const facts = summarizeReviewRuns({
      runs: [autoFail, run({ ...autoFail, headSha: HEAD_B })],
      headSha: HEAD_A,
    })
    assert.equal(facts.failedRetryLimitReached, false)
  })

  await t.test('the default retry limit is 3, as the PRD states', () => {
    assert.equal(REVIEW_BOUND_DEFAULTS.autoReviewFailedRetryLimit, 3)
  })
})

test('summarizeReviewRuns produces reducer-shaped facts with no missing fields', () => {
  const facts = summarizeReviewRuns({ runs: [], headSha: HEAD_A })
  for (const key of [
    'present',
    'running',
    'changesRequested',
    'outcome',
    'failed',
    'cancelled',
    'roundBudgetExhausted',
    'failedRetryLimitReached',
  ]) {
    assert.equal(typeof (facts as unknown as Record<string, unknown>)[key], 'boolean', `${key} must be a boolean`)
  }
})

test('latestCompletedRunForOtherHead: only a settled, judged pass for another head counts', async (t) => {
  const judged = run({ headSha: HEAD_B, status: ReviewRunStatus.complete, verdict: ReviewVerdict.approved })

  await t.test('a judged pass on another head is found', () => {
    assert.equal(latestCompletedRunForOtherHead([judged], HEAD_A)?.headSha, HEAD_B)
  })

  await t.test('a pass on the same head is not "another head"', () => {
    assert.equal(latestCompletedRunForOtherHead([judged], HEAD_B), undefined)
  })

  await t.test('a running pass on another head is not settled, so it does not count', () => {
    const runs = [run({ headSha: HEAD_B, status: ReviewRunStatus.running })]
    assert.equal(latestCompletedRunForOtherHead(runs, HEAD_A), undefined)
  })

  await t.test('a verdict-less pass does not count', () => {
    const runs = [run({ headSha: HEAD_B, status: ReviewRunStatus.failed })]
    assert.equal(latestCompletedRunForOtherHead(runs, HEAD_A), undefined)
  })

  await t.test('the newest judged pass wins', () => {
    const older = run({ headSha: 'sha-old', verdict: ReviewVerdict.approved, createdAt: 1 })
    const newer = run({ headSha: 'sha-new', verdict: ReviewVerdict.changesRequested, createdAt: 2 })
    assert.equal(latestCompletedRunForOtherHead([newer, older], HEAD_A)?.headSha, 'sha-new')
  })

  await t.test('an empty target head finds nothing', () => {
    assert.equal(latestCompletedRunForOtherHead([judged], ''), undefined)
  })
})
