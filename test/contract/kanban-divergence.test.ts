/**
 * Tests for the two **deliberate divergences** from Agent Orchestrator.
 *
 * Everything here is opt-in: both divergences are gated on
 * `requireHumanApprovalBeforeReady`, whose default in the shipped config is now
 * `false` — the user overruled the PRD on that default, so an unconfigured install
 * behaves exactly like AO and a deployment that wants the gate asks for it. Every
 * case is still asserted in **both** flag states, because the PRD's test plan
 * requires exactly that, and the default's own behaviour is pinned separately
 * below (see "the shipped default") so flipping it again cannot pass unnoticed.
 *
 *   "row 6 (`requireHumanApprovalBeforeReady`) fires only after our pass
 *    approves, and never before; and the row-6 behaviour is asserted in both flag
 *    states so the documented divergence from AO cannot regress silently."
 *
 * The flag-off assertions matter as much as the flag-on ones: they are what pins
 * "flag off means AO's exact behaviour".
 *
 * Acceptance criteria covered: A17 (human gate), A18 (round-cap escalation).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DisplayStatus,
  KanbanColumn,
  deriveKanbanPresentation,
  prFacts,
} from '../../src/contract/kanban.ts'
import { sessionFacts } from '../../src/contract/status.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import type {
  KanbanDerivation,
  KanbanPRFactsInput,
  KanbanReviewRunFacts,
} from '../../src/contract/kanban.ts'
import type { SessionFactsInput } from '../../src/contract/status.ts'

const NOW = 3_600_000
const GRACE = 90_000

function derive(session: SessionFactsInput, pr: KanbanPRFactsInput): KanbanDerivation {
  return deriveKanbanPresentation(sessionFacts(session), [prFacts(pr)], NOW, GRACE)
}

/** A PR whose automated pass approved this head and which is ready to merge. */
const APPROVED_BY_US_AND_MERGEABLE = {
  url: 'pr/1',
  mergeability: 'mergeable',
  reviewRun: { present: true, outcome: true },
}

// ---------------------------------------------------------------------------
// The SHIPPED default — which is now AO's behaviour.
// ---------------------------------------------------------------------------

/**
 * The default is a decision in its own right, and the one a person meets first.
 *
 * The reducer tests above pass the flag explicitly, so without this the two states are
 * covered while the DEFAULT is not: flipping it back to `true` would leave every test green.
 * The config comes from `normalizePluginConfig()` — the same call the plugin makes at
 * activation — so this reads the shipped default rather than restating it.
 */
test('the shipped default lets an auto-approved mergeable PR reach Ready with no human', () => {
  const config = normalizePluginConfig()
  assert.equal(config.requireHumanApprovalBeforeReady, false, 'the gate is off unless asked for')
  const got = derive(
    {
      autoReview: config.autoReview,
      requireHumanApprovalBeforeReady: config.requireHumanApprovalBeforeReady,
    },
    APPROVED_BY_US_AND_MERGEABLE,
  )
  // AO's exact behaviour: row 6 does not exist for an unconfigured install.
  assert.equal(got.column, KanbanColumn.ready)
  assert.equal(got.displayStatus, DisplayStatus.mergeable)
})

// ---------------------------------------------------------------------------
// Row 6 — the guaranteed human gate before Ready.
// ---------------------------------------------------------------------------

test('row 6: A17 — an auto-review-approved mergeable PR waits for a human', async (t) => {
  await t.test('flag on: lands in In review / Needs human review, not Ready', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      APPROVED_BY_US_AND_MERGEABLE,
    )
    assert.equal(got.column, KanbanColumn.needsReview)
    assert.equal(got.displayStatus, DisplayStatus.needsHumanReview)
  })

  await t.test('flag off: reaches Ready on mergeability alone, as AO does', () => {
    const got = derive({ autoReview: true }, APPROVED_BY_US_AND_MERGEABLE)
    assert.equal(got.column, KanbanColumn.ready)
    assert.equal(got.displayStatus, DisplayStatus.mergeable)
  })
})

test('row 6 fires only after our pass approves this head, never before', async (t) => {
  // Every "our pass has not approved" shape, with the flag on. None may reach
  // needs_review through row 6; all must stay in Validating while the loop is
  // still alive.
  const notApproved: ReadonlyArray<readonly [string, Partial<KanbanReviewRunFacts>]> = [
    ['no pass recorded for this head', { present: false }],
    ['a pass is still running', { present: true, running: true }],
    ['a pass requested changes', { present: true, outcome: true, changesRequested: true }],
    ['a pass failed without a verdict', { present: true, failed: true }],
    ['a pass was cancelled', { present: true, cancelled: true }],
  ]
  for (const [name, reviewRun] of notApproved) {
    await t.test(name, () => {
      const got = derive(
        { autoReview: true, requireHumanApprovalBeforeReady: true },
        { url: 'pr/1', reviewRun },
      )
      assert.equal(got.column, KanbanColumn.validating)
      assert.notEqual(got.displayStatus, DisplayStatus.needsHumanReview)
    })
  }
})

test('row 6 yields to a real human signal', async (t) => {
  await t.test('a surviving human approval reaches Ready even with the flag on', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      {
        ...APPROVED_BY_US_AND_MERGEABLE,
        review: 'approved',
        externalReview: { approved: true },
      },
    )
    assert.equal(got.column, KanbanColumn.ready)
    assert.equal(got.displayStatus, DisplayStatus.mergeable)
  })

  await t.test('a human approval the aggregate has not caught up with still reaches Ready', () => {
    // GitHub's aggregate `reviewDecision` can lag a real approval (a dismissed
    // review, an approval on an older commit). If row 6 re-tested the aggregate
    // instead of the surviving external approval, this real human approval would
    // be downgraded to `Needs human review` — the exact bug the guard avoids.
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      {
        ...APPROVED_BY_US_AND_MERGEABLE,
        review: 'review_required',
        externalReview: { approved: true },
      },
    )
    assert.equal(got.column, KanbanColumn.ready)
  })

  await t.test('a merge beats the gate outright', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      { ...APPROVED_BY_US_AND_MERGEABLE, merged: true },
    )
    assert.equal(got.column, KanbanColumn.ready)
    assert.equal(got.displayStatus, DisplayStatus.merged)
  })

  await t.test('a human close beats the gate outright', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      { ...APPROVED_BY_US_AND_MERGEABLE, closed: true },
    )
    assert.equal(got.column, KanbanColumn.ready)
    assert.equal(got.displayStatus, DisplayStatus.closed)
  })
})

test('row 6 is scoped to the flag, not to autoReview', async (t) => {
  await t.test('flag on without autoReview still gates our own approval', () => {
    // Without autoReview our pass can only have run because a human forced it
    // (`orchestrator_run_review`). The gate is about human review, not about how
    // the pass was scheduled, so it still applies.
    const got = derive({ requireHumanApprovalBeforeReady: true }, APPROVED_BY_US_AND_MERGEABLE)
    assert.equal(got.column, KanbanColumn.needsReview)
    assert.equal(got.displayStatus, DisplayStatus.needsHumanReview)
  })

  await t.test('neither flag and no autoReview: plain mergeability wins, as AO does', () => {
    const got = derive({}, APPROVED_BY_US_AND_MERGEABLE)
    assert.equal(got.column, KanbanColumn.ready)
  })
})

// ---------------------------------------------------------------------------
// Row 5b — the escalation release, and why it must outrank the auto-inject row.
// ---------------------------------------------------------------------------

/** A PR whose round budget ran out while auto-inject was on. */
const ROUND_CAP_HIT_WITH_AUTO_INJECT = {
  url: 'pr/1',
  mergeability: 'mergeable',
  reviewRun: {
    present: true,
    outcome: true,
    changesRequested: true,
    roundBudgetExhausted: true,
  },
}

test('row 5b: A18 — a stopped loop is released from Validating', async (t) => {
  await t.test('flag on, round cap hit: In review / Needs human review', () => {
    const got = derive(
      { autoReview: true, autoInjectReview: true, requireHumanApprovalBeforeReady: true },
      ROUND_CAP_HIT_WITH_AUTO_INJECT,
    )
    assert.equal(got.column, KanbanColumn.needsReview)
    assert.equal(got.displayStatus, DisplayStatus.needsHumanReview)
  })

  await t.test('the escalation reason is reported so the card can say why', () => {
    const got = derive(
      { autoReview: true, autoInjectReview: true, requireHumanApprovalBeforeReady: true },
      ROUND_CAP_HIT_WITH_AUTO_INJECT,
    )
    assert.equal(got.escalationReason, 'review-round-limit')
  })

  await t.test('the release outranks auto-inject, which would otherwise claim the loop', () => {
    // This is the case that makes the placement of row 5b load-bearing. With the
    // flag on, the auto-inject row would return `Validating` and the card would
    // claim a loop that has stopped. The release must win.
    const withAutoInject = derive(
      { autoReview: true, autoInjectReview: true, requireHumanApprovalBeforeReady: true },
      ROUND_CAP_HIT_WITH_AUTO_INJECT,
    )
    const autoInjectWouldSay = derive(
      { autoReview: true, autoInjectReview: true },
      { ...ROUND_CAP_HIT_WITH_AUTO_INJECT, reviewRun: { ...ROUND_CAP_HIT_WITH_AUTO_INJECT.reviewRun, roundBudgetExhausted: false } },
    )
    assert.equal(autoInjectWouldSay.column, KanbanColumn.validating, 'sanity: the loop is alive here')
    assert.notEqual(withAutoInject.column, KanbanColumn.validating, 'the stopped loop is not claimed')
  })

  await t.test('the release outranks mergeability, which would otherwise reach Ready', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      ROUND_CAP_HIT_WITH_AUTO_INJECT,
    )
    assert.notEqual(got.column, KanbanColumn.ready, 'A18 forbids Ready here')
    assert.equal(got.column, KanbanColumn.needsReview)
  })

  await t.test('a live loop still owns the PR, so the release does not fire early', () => {
    const got = derive(
      { autoReview: true, autoInjectReview: true, requireHumanApprovalBeforeReady: true },
      {
        ...ROUND_CAP_HIT_WITH_AUTO_INJECT,
        reviewRun: { ...ROUND_CAP_HIT_WITH_AUTO_INJECT.reviewRun, roundBudgetExhausted: false },
      },
    )
    assert.equal(got.column, KanbanColumn.validating)
    assert.equal(got.escalationReason, undefined)
  })

  await t.test('flag off restores AO: the PR stays in Validating', () => {
    const got = derive(
      { autoReview: true, autoInjectReview: true },
      ROUND_CAP_HIT_WITH_AUTO_INJECT,
    )
    assert.equal(got.column, KanbanColumn.validating)
  })
})

test('row 5b: the failed-retry limit is the same escalation one level down', async (t) => {
  const retryLimitReached = {
    url: 'pr/1',
    mergeability: 'mergeable',
    reviewRun: { present: true, failed: true, failedRetryLimitReached: true },
  }

  await t.test('flag on: released to Needs human review, not left on "Review failed"', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      retryLimitReached,
    )
    assert.equal(got.column, KanbanColumn.needsReview)
    assert.equal(got.displayStatus, DisplayStatus.needsHumanReview)
    assert.equal(got.escalationReason, 'review-failed-retry-limit')
  })

  await t.test('flag off restores AO: still Validating / Review failed', () => {
    const got = derive({ autoReview: true }, retryLimitReached)
    assert.equal(got.column, KanbanColumn.validating)
    assert.equal(got.displayStatus, DisplayStatus.reviewFailed)
  })

  await t.test('retries remaining keeps the PR in Validating', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      { url: 'pr/1', reviewRun: { present: true, failed: true } },
    )
    assert.equal(got.column, KanbanColumn.validating)
    assert.equal(got.displayStatus, DisplayStatus.reviewFailed)
  })
})

test('the round-limit release never fires for a pass that already approved', async (t) => {
  await t.test('a later head approved after the budget was spent still gates, not escalates', () => {
    const got = derive(
      { autoReview: true, requireHumanApprovalBeforeReady: true },
      {
        url: 'pr/1',
        mergeability: 'mergeable',
        reviewRun: {
          present: true,
          outcome: true,
          roundBudgetExhausted: true,
        },
      },
    )
    // `approvedByUs` is true, so row 5b is skipped and row 6 takes over: the
    // card still needs a human, but for the ordinary reason, not escalation.
    assert.equal(got.column, KanbanColumn.needsReview)
    assert.equal(got.displayStatus, DisplayStatus.needsHumanReview)
    assert.equal(got.escalationReason, undefined)
  })
})

test('a terminated session archives regardless of the gate', () => {
  const got = derive(
    { isTerminated: true, autoReview: true, requireHumanApprovalBeforeReady: true },
    ROUND_CAP_HIT_WITH_AUTO_INJECT,
  )
  assert.deepEqual(got, {
    column: KanbanColumn.archive,
    displayStatus: DisplayStatus.terminated,
  })
})
