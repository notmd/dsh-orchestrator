/**
 * Head-scoped review-run facts: the two loop bounds and the stale-head exclusion.
 *
 * Acceptance criteria covered: A16 (a superseded head never decides a lane),
 * A18 (the round cap stops the loop), A20 (a judged head is not re-judged), and
 * the test plan's "manual failures do not consume the auto-retry budget".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REVIEW_BOUND_DEFAULTS,
  ReviewRunState,
  changesRequestedCycles,
  failedAutoRuns,
  isVerdict,
  runsForHead,
  summarizeReviewRuns,
} from '../../src/review/runs.js'

const HEAD_A = 'sha-a'
const HEAD_B = 'sha-b'

function run(overrides) {
  return { workerId: 'wrk-1', headSha: HEAD_A, status: ReviewRunState.queued, ...overrides }
}

test('runsForHead: a pass for another head is excluded', () => {
  const runs = [run({ headSha: HEAD_A }), run({ headSha: HEAD_B })]
  assert.deepEqual(runsForHead(runs, HEAD_A).map((r) => r.headSha), [HEAD_A])
})

test('A16 — a pass recorded for an earlier head cannot be seen for the current one', () => {
  const runs = [
    run({ headSha: HEAD_A, status: ReviewRunState.approved, verdict: 'approved' }),
  ]
  const facts = summarizeReviewRuns({ runs, headSha: HEAD_B })
  assert.equal(facts.present, false, 'the superseded pass is invisible')
  assert.equal(facts.outcome, false)
  assert.equal(facts.changesRequested, false)
})

test('an empty head SHA selects nothing', () => {
  const runs = [run({ headSha: HEAD_A, status: ReviewRunState.approved, verdict: 'approved' })]
  const facts = summarizeReviewRuns({ runs, headSha: '' })
  assert.equal(facts.present, false)
  assert.equal(runsForHead(runs, '').length, 0)
})

test('the aggregation carries AO\'s shape: present/running/outcome/failed/cancelled', () => {
  const cases = [
    ['a queued pass is present but has no outcome', { status: ReviewRunState.queued }, { present: true }],
    ['a running pass is present and running', { status: ReviewRunState.running }, { present: true, running: true }],
    [
      'an approving pass has an outcome',
      { status: ReviewRunState.approved, verdict: 'approved' },
      { present: true, outcome: true },
    ],
    [
      'a changes-requested pass has an outcome and asked for changes',
      { status: ReviewRunState.changesRequested, verdict: 'changes_requested' },
      { present: true, outcome: true, changesRequested: true },
    ],
    [
      'a failed pass is present without an outcome',
      { status: ReviewRunState.failed },
      { present: true, failed: true },
    ],
    [
      'a cancelled pass is present',
      { status: ReviewRunState.cancelled },
      { present: true, cancelled: true },
    ],
  ]
  for (const [name, overrides, expected] of cases) {
    const facts = summarizeReviewRuns({ runs: [run(overrides)], headSha: HEAD_A })
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(facts[key], value, `${name}: ${key}`)
    }
  }
})

test('a retry after a failure supersedes nothing: the facts aggregate over the head', () => {
  // AO aggregates with `||=`, so a failed first pass and a running retry on the
  // same head read as present+failed+running at once. That is deliberate: the
  // card can say "Review failed" while a retry is in flight.
  const runs = [
    run({ status: ReviewRunState.failed, triggerSource: 'auto' }),
    run({ status: ReviewRunState.running, triggerSource: 'auto' }),
  ]
  const facts = summarizeReviewRuns({ runs, headSha: HEAD_A })
  assert.equal(facts.failed, true)
  assert.equal(facts.running, true)
  assert.equal(facts.outcome, false)
})

test('isVerdict accepts exactly the two real verdicts', () => {
  assert.ok(isVerdict('approved'))
  assert.ok(isVerdict('changes_requested'))
  assert.ok(!isVerdict(undefined))
  assert.ok(!isVerdict(''))
  assert.ok(!isVerdict('failed'))
  assert.ok(!isVerdict('queued'))
})

test('changesRequestedCycles counts heads, so a re-judged head is one cycle', () => {
  // A20: a changes-requested verdict on head H does not produce a second cycle on
  // H, however many sweep ticks elapse.
  const runs = [
    run({ headSha: HEAD_A, status: ReviewRunState.changesRequested, verdict: 'changes_requested' }),
    run({ headSha: HEAD_A, status: ReviewRunState.failed }),
    run({ headSha: HEAD_A, status: ReviewRunState.changesRequested, verdict: 'changes_requested' }),
  ]
  assert.equal(changesRequestedCycles(runs), 1)
})

test('changesRequestedCycles counts successive heads', () => {
  const runs = [HEAD_A, HEAD_B, 'sha-c'].map((headSha) =>
    run({ headSha, status: ReviewRunState.changesRequested, verdict: 'changes_requested' }),
  )
  assert.equal(changesRequestedCycles(runs), 3)
})

test('changesRequestedCycles honors a recorded round that ran ahead of observed heads', () => {
  // An older run row can lose its head SHA while keeping its round number; the
  // cycle count must not silently reset.
  const runs = [
    run({ headSha: '', round: 3, status: ReviewRunState.changesRequested, verdict: 'changes_requested' }),
  ]
  assert.equal(changesRequestedCycles(runs), 3)
})

test('changesRequestedCycles ignores approving passes', () => {
  const runs = [run({ status: ReviewRunState.approved, verdict: 'approved' })]
  assert.equal(changesRequestedCycles(runs), 0)
})

test('A18 — the round budget trips at maxReviewRounds', async (t) => {
  const cycle = (i) =>
    run({
      headSha: `sha-${i}`,
      round: i,
      status: ReviewRunState.changesRequested,
      verdict: 'changes_requested',
    })

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
    run({ status: ReviewRunState.failed, triggerSource: 'auto' }),
    run({ status: ReviewRunState.failed, triggerSource: 'manual' }),
    run({ status: ReviewRunState.failed }),
    run({ status: ReviewRunState.running, triggerSource: 'auto' }),
  ]
  // 'auto' and the legacy missing source both count; 'manual' does not.
  assert.equal(failedAutoRuns(runs), 2)
})

test('A18 — the failed-retry limit trips per head, and manual runs do not spend it', async (t) => {
  const autoFail = run({ status: ReviewRunState.failed, triggerSource: 'auto' })
  const manualFail = run({ status: ReviewRunState.failed, triggerSource: 'manual' })

  await t.test('three automated failures on the head reach the limit', () => {
    const facts = summarizeReviewRuns({
      runs: [autoFail, autoFail, autoFail],
      headSha: HEAD_A,
    })
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

  await t.test('failures on another head do not spend this head\'s budget', () => {
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
    assert.equal(typeof facts[key], 'boolean', `${key} must be a boolean`)
  }
})
