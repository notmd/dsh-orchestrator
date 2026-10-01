/**
 * The board reducer's truth table.
 *
 * PORTED from Agent Orchestrator `backend/pkg/contract/kanban_test.go`
 * (commit 53ba1e8, Apache-2.0). See NOTICE.
 *
 * The point of porting AO's own cases rather than writing fresh ones is that a
 * porting bug cannot hide behind a rewrite: every case below asserts the same
 * column and display status the Go test asserts. Note that **none of these cases
 * set `requireHumanApprovalBeforeReady`**, so they all run in AO's exact
 * configuration (the flag defaults to false) — which is what proves the two
 * documented divergences are opt-in. The divergence's own tests live in
 * `kanban-divergence.test.js`.
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
import type { KanbanSessionFacts, SessionFactsInput } from '../../src/contract/status.ts'
import type { KanbanPRFactsInput } from '../../src/contract/kanban.ts'

/** Asserts only the stage-one placement, exactly as AO's `deriveColumn` does. */
function deriveColumn(
  session: SessionFactsInput,
  prs?: readonly KanbanPRFactsInput[] | undefined,
): KanbanColumn {
  return deriveKanbanPresentation(sessionFacts(session), (prs ?? []).map(prFacts), 0, 0).column
}

function sessionAt(activity: string): KanbanSessionFacts {
  return sessionFacts({ activity })
}

const TEST_GRACE = 90_000
/** Matches AO's `time.Unix(3600, 0)`. */
const TEST_NOW = 3_600_000
const SILENT = { hasSignal: false, signalExpected: true, lastActivityAt: 0 }

test('deriveKanbanColumn: session-level rules', async (t) => {
  const cases = [
    {
      name: 'terminated archives even with a live pr',
      session: { isTerminated: true },
      prs: [{ url: 'pr/1' }],
      want: KanbanColumn.archive,
    },
    {
      name: 'no pr is still building',
      session: {},
      prs: undefined,
      want: KanbanColumn.building,
    },
  ]
  for (const tc of cases) {
    await t.test(tc.name, () => {
      assert.equal(deriveColumn(tc.session, tc.prs), tc.want)
    })
  }
})

test('deriveKanbanColumn: single PR', async (t) => {
  const cases: ReadonlyArray<{
    name: string
    session?: SessionFactsInput
    pr: KanbanPRFactsInput
    want: KanbanColumn
  }> = [
    { name: 'draft is validation work', pr: { url: 'pr/1', draft: true }, want: KanbanColumn.validating },
    { name: 'merged is ready', pr: { url: 'pr/1', merged: true }, want: KanbanColumn.ready },
    { name: 'closed without merge is ready', pr: { url: 'pr/1', closed: true }, want: KanbanColumn.ready },
    {
      name: 'closed draft is still ready',
      pr: { url: 'pr/1', closed: true, draft: true },
      want: KanbanColumn.ready,
    },
    {
      name: 'mergeable is ready',
      pr: { url: 'pr/1', mergeability: 'mergeable' },
      want: KanbanColumn.ready,
    },
    {
      name: 'human approval is ready',
      pr: {
        url: 'pr/1',
        review: 'approved',
        mergeability: 'blocked',
        externalReview: { approved: true },
      },
      want: KanbanColumn.ready,
    },
    {
      name: "our own approval alone is not ready",
      pr: {
        url: 'pr/1',
        review: 'approved',
        mergeability: 'blocked',
        reviewRun: { present: true },
      },
      want: KanbanColumn.needsReview,
    },
    {
      name: 'review pass on the current head is validating',
      pr: { url: 'pr/1', reviewRun: { present: true, running: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'addressing our own changes request is validating',
      session: { autoInjectReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, changesRequested: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'human changes request stays person-owned even with auto-inject on',
      session: { autoInjectReview: true },
      pr: {
        url: 'pr/1',
        review: 'changes_requested',
        externalReview: { changesRequested: true },
        reviewRun: { present: true },
      },
      want: KanbanColumn.needsReview,
    },
    {
      name: 'fixing ci is validating',
      session: { autoInjectCI: true },
      pr: { url: 'pr/1', ci: 'failing', reviewRun: { present: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'failing ci with injection off hands the loop to a person',
      session: {},
      pr: { url: 'pr/1', ci: 'failing', reviewRun: { present: true } },
      want: KanbanColumn.needsReview,
    },
    {
      name: 'auto review owns an unreviewed head',
      session: { autoReview: true },
      pr: { url: 'pr/1' },
      want: KanbanColumn.validating,
    },
    {
      name: 'auto review off hands an unreviewed head to a person',
      session: {},
      pr: { url: 'pr/1' },
      want: KanbanColumn.needsReview,
    },
    {
      name: 'auto review hands the loop over once its pass approved this head',
      session: { autoReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, outcome: true } },
      want: KanbanColumn.needsReview,
    },
    {
      name: 'auto review keeps a changes-requested head, even without auto-inject',
      session: { autoReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, outcome: true, changesRequested: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'auto-inject still keeps the loop moving on a changes-requested head',
      session: { autoReview: true, autoInjectReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, outcome: true, changesRequested: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'without auto review, a changes-requested pass hands off to a person',
      session: {},
      pr: { url: 'pr/1', reviewRun: { present: true, outcome: true, changesRequested: true } },
      want: KanbanColumn.needsReview,
    },
    {
      name: 'auto review keeps a mergeable pr validating until its pass approves',
      session: { autoReview: true },
      pr: {
        url: 'pr/1',
        mergeability: 'mergeable',
        reviewRun: { present: true, outcome: true, changesRequested: true },
      },
      want: KanbanColumn.validating,
    },
    {
      name: 'auto review keeps a mergeable pr validating after its pass fails',
      session: { autoReview: true },
      pr: { url: 'pr/1', mergeability: 'mergeable', reviewRun: { present: true, failed: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'human approval releases a failed auto review',
      session: { autoReview: true },
      pr: {
        url: 'pr/1',
        review: 'approved',
        externalReview: { approved: true },
        reviewRun: { present: true, failed: true },
      },
      want: KanbanColumn.ready,
    },
    {
      name: 'auto review still owns a head whose pass failed',
      session: { autoReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, failed: true } },
      want: KanbanColumn.validating,
    },
    {
      name: 'auto review still owns a head whose pass was cancelled',
      session: { autoReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, cancelled: true } },
      want: KanbanColumn.validating,
    },
  ]
  for (const tc of cases) {
    await t.test(tc.name, () => {
      assert.equal(deriveColumn(tc.session ?? {}, [tc.pr]), tc.want)
    })
  }
})

// A run recorded for an earlier head is dropped before the reducer sees it, so
// the PR reads as an unreviewed head and the review-feedback loop restarts: we
// take the next turn with auto review on, a person takes it with it off.
test('deriveKanbanColumn: a stale review run starts a new cycle', () => {
  const pr = { url: 'pr/1' }
  assert.equal(
    deriveColumn({ autoReview: true }, [pr]),
    KanbanColumn.validating,
    'auto review on',
  )
  assert.equal(deriveColumn({}, [pr]), KanbanColumn.needsReview, 'auto review off')
})

test('deriveKanbanColumn: multiple PRs', async (t) => {
  const older = Date.UTC(2026, 0, 1, 0, 0, 0)
  const newer = older + 3_600_000

  await t.test('a merged pr never hides a live one', () => {
    const got = deriveColumn({ autoReview: true }, [
      { url: 'pr/merged', merged: true, updatedAt: newer },
      { url: 'pr/live', updatedAt: older },
    ])
    assert.equal(got, KanbanColumn.validating)
  })

  await t.test('terminal prs decide once nothing is live', () => {
    const got = deriveColumn({}, [
      { url: 'pr/merged', merged: true, updatedAt: newer },
      { url: 'pr/closed', closed: true, updatedAt: older },
    ])
    assert.equal(got, KanbanColumn.ready)
  })

  await t.test('the most actionable live pr wins', () => {
    const got = deriveColumn({}, [
      { url: 'pr/validating', draft: true, updatedAt: newer },
      { url: 'pr/needs-review', updatedAt: older },
    ])
    assert.equal(got, KanbanColumn.needsReview)
  })

  await t.test('ties break on the newest pr then on url', () => {
    const prs = [
      { url: 'pr/b', draft: true, updatedAt: older },
      { url: 'pr/a', draft: true, updatedAt: older },
    ]
    const first = deriveColumn({}, prs)
    const second = deriveColumn({}, [prs[1]!, prs[0]!])
    assert.equal(first, second, 'order-independent')
    assert.equal(first, KanbanColumn.validating)
  })
})

test('deriveKanbanPresentation: building', async (t) => {
  const cases: ReadonlyArray<readonly [string, KanbanSessionFacts, DisplayStatus]> = [
    ['active worker is working', sessionAt('active'), DisplayStatus.working],
    ['blocked worker is blocked', sessionAt('blocked'), DisplayStatus.blocked],
    ['a worker waiting on input is blocked', sessionAt('waiting_input'), DisplayStatus.blocked],
    ['exited worker has exited', sessionAt('exited'), DisplayStatus.exited],
    ['a silent worker past the grace period has no signal', sessionFacts(SILENT), DisplayStatus.noSignal],
    ['an idle worker is awaiting its pr', sessionAt('idle'), DisplayStatus.awaitingPr],
  ]
  for (const [name, session, want] of cases) {
    await t.test(name, () => {
      const got = deriveKanbanPresentation(session, null, TEST_NOW, TEST_GRACE)
      assert.equal(got.column, KanbanColumn.building)
      assert.equal(got.displayStatus, want)
    })
  }
})

test('deriveKanbanPresentation: single PR', async (t) => {
  const cases = [
    // Validating: the plugin-driven loop.
    {
      name: 'a draft with nothing else to say is a draft',
      pr: { url: 'pr/1', draft: true },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.draft,
    },
    {
      name: 'a blocked worker outranks the loop it was running',
      session: { activity: 'blocked', autoInjectCI: true },
      pr: { url: 'pr/1', ci: 'failing' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.blocked,
    },
    {
      name: 'an exited worker outranks the loop it was running',
      session: { activity: 'exited', autoInjectCI: true },
      pr: { url: 'pr/1', ci: 'failing' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.exited,
    },
    {
      name: 'failing ci with auto-fix on and worker active is being fixed',
      session: { activity: 'active', autoInjectCI: true },
      pr: { url: 'pr/1', ci: 'failing' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.fixingCI,
    },
    {
      name: 'failing ci with auto-fix on but worker idle says ci failing',
      session: { autoInjectCI: true },
      pr: { url: 'pr/1', ci: 'failing' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.ciFailing,
    },
    {
      name: 'failing ci on a draft with auto-fix off says ci failing',
      pr: { url: 'pr/1', draft: true, ci: 'failing' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.ciFailing,
    },
    {
      name: 'a changes request with auto-inject on and worker active is being addressed',
      session: { activity: 'active', autoInjectReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, changesRequested: true } },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.addressingComments,
    },
    {
      name: 'a changes request with auto-inject on but worker idle needs review',
      session: { autoInjectReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, changesRequested: true } },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.needsReview,
    },
    {
      name: 'a silent worker past grace has no signal',
      session: sessionFacts({ ...SILENT, autoInjectCI: true }),
      pr: { url: 'pr/1', ci: 'failing' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.noSignal,
    },
    {
      name: 'a changes request with auto-inject off needs review',
      pr: { url: 'pr/1', draft: true, reviewRun: { present: true, changesRequested: true } },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.needsReview,
    },
    {
      name: 'auto review with no pass on this head has one scheduled',
      session: { autoReview: true },
      pr: { url: 'pr/1' },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.reviewScheduled,
    },
    {
      name: 'a pass in flight is reviewing',
      pr: { url: 'pr/1', reviewRun: { present: true, running: true } },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.reviewing,
    },
    {
      name: 'a failed pass remains validating and exposes the failure',
      session: { autoReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, failed: true } },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.reviewFailed,
    },
    {
      name: 'a cancelled pass leaves the review pending',
      session: { autoReview: true },
      pr: { url: 'pr/1', reviewRun: { present: true, cancelled: true } },
      wantColumn: KanbanColumn.validating,
      want: DisplayStatus.reviewPending,
    },

    // In review: the loop seen from the person's side.
    {
      name: 'an open pr nobody is handling needs a human review',
      pr: { url: 'pr/1' },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.needsHumanReview,
    },
    {
      name: 'a blocked worker outranks an open review',
      session: { activity: 'blocked' },
      pr: { url: 'pr/1' },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.blocked,
    },
    {
      name: 'an exited worker outranks an open review',
      session: { activity: 'exited' },
      pr: { url: 'pr/1' },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.exited,
    },
    {
      name: 'a silent worker past grace has no signal while in review',
      session: sessionFacts(SILENT),
      pr: { url: 'pr/1' },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.noSignal,
    },
    {
      name: 'failing ci nobody is fixing says ci failing',
      pr: { url: 'pr/1', ci: 'failing' },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.ciFailing,
    },
    {
      name: 'external comments with auto-inject off are commented',
      pr: { url: 'pr/1', externalReview: { comments: true } },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.commented,
    },
    {
      name: 'external comments with auto-inject on and worker active are being addressed',
      session: { activity: 'active', autoInjectReview: true },
      pr: { url: 'pr/1', externalReview: { comments: true } },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.addressingComments,
    },
    {
      name: 'external comments with auto-inject on but worker idle are commented',
      session: { autoInjectReview: true },
      pr: { url: 'pr/1', externalReview: { comments: true } },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.commented,
    },
    {
      name: 'an external changes request nobody is addressing requests changes',
      pr: {
        url: 'pr/1',
        review: 'changes_requested',
        externalReview: { changesRequested: true },
      },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.changesRequested,
    },
    {
      name: 'an external changes request with auto-inject on and worker active stays in review while being addressed',
      session: { activity: 'active', autoInjectReview: true },
      pr: {
        url: 'pr/1',
        review: 'changes_requested',
        externalReview: { changesRequested: true },
      },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.addressingComments,
    },
    {
      name: 'an external changes request with auto-inject on but worker idle requests changes',
      session: { autoInjectReview: true },
      pr: {
        url: 'pr/1',
        review: 'changes_requested',
        externalReview: { changesRequested: true },
      },
      wantColumn: KanbanColumn.needsReview,
      want: DisplayStatus.changesRequested,
    },

    // Ready: how the pr landed, or what stands between it and the button.
    {
      name: 'a mergeable pr is mergeable',
      pr: { url: 'pr/1', mergeability: 'mergeable' },
      wantColumn: KanbanColumn.ready,
      want: DisplayStatus.mergeable,
    },
    {
      name: 'an approved pr that is not mergeable is approved',
      pr: {
        url: 'pr/1',
        review: 'approved',
        mergeability: 'blocked',
        externalReview: { approved: true },
      },
      wantColumn: KanbanColumn.ready,
      want: DisplayStatus.approved,
    },
    {
      name: 'an approved pr blocked by checks says ci failing',
      pr: {
        url: 'pr/1',
        review: 'approved',
        mergeability: 'blocked',
        ci: 'failing',
        externalReview: { approved: true },
      },
      wantColumn: KanbanColumn.ready,
      want: DisplayStatus.ciFailing,
    },
    {
      name: 'a merged pr is merged',
      pr: { url: 'pr/1', merged: true },
      wantColumn: KanbanColumn.ready,
      want: DisplayStatus.merged,
    },
    {
      name: 'a closed pr closed without merging',
      pr: { url: 'pr/1', closed: true },
      wantColumn: KanbanColumn.ready,
      want: DisplayStatus.closed,
    },
    {
      name: 'a merged pr reports the merge, not its stale merge readiness',
      pr: { url: 'pr/1', merged: true, mergeability: 'mergeable' },
      wantColumn: KanbanColumn.ready,
      want: DisplayStatus.merged,
    },
  ]
  for (const tc of cases) {
    await t.test(tc.name, () => {
      const got = deriveKanbanPresentation(
        sessionFacts(tc.session ?? {}),
        [prFacts(tc.pr)],
        TEST_NOW,
        TEST_GRACE,
      )
      assert.equal(got.column, tc.wantColumn, 'column')
      assert.equal(got.displayStatus, tc.want, 'display status')
    })
  }
})

test('deriveKanbanPresentation: terminated archives', () => {
  const got = deriveKanbanPresentation(
    sessionFacts({ isTerminated: true, activity: 'active' }),
    [prFacts({ url: 'pr/1', merged: true })],
    TEST_NOW,
    TEST_GRACE,
  )
  assert.deepEqual(got, { column: KanbanColumn.archive, displayStatus: DisplayStatus.terminated })
})

// A pass recorded for an earlier commit is filtered out before the reducer sees
// it, so the head it left behind reads as unreviewed rather than as a finished
// review.
test('deriveKanbanPresentation: a pass for an earlier head leaves the head unreviewed', () => {
  const got = deriveKanbanPresentation(
    sessionFacts({ autoReview: true }),
    [prFacts({ url: 'pr/1' })],
    TEST_NOW,
    TEST_GRACE,
  )
  assert.equal(got.displayStatus, DisplayStatus.reviewScheduled)
})

test('deriveKanbanPresentation: the display status speaks for the chosen PR', async (t) => {
  const older = 100_000
  const newer = 200_000

  await t.test('a merged pr does not hide live work', () => {
    const got = deriveKanbanPresentation(
      sessionFacts({ activity: 'active', autoInjectCI: true }),
      [
        prFacts({ url: 'pr/1', merged: true, updatedAt: newer }),
        prFacts({ url: 'pr/2', ci: 'failing', updatedAt: older }),
      ],
      TEST_NOW,
      TEST_GRACE,
    )
    assert.deepEqual(got, {
      column: KanbanColumn.validating,
      displayStatus: DisplayStatus.fixingCI,
    })
  })

  await t.test('only terminal prs report the best landing', () => {
    const got = deriveKanbanPresentation(
      sessionFacts({}),
      [
        prFacts({ url: 'pr/1', closed: true, updatedAt: older }),
        prFacts({ url: 'pr/2', merged: true, updatedAt: newer }),
      ],
      TEST_NOW,
      TEST_GRACE,
    )
    assert.deepEqual(got, {
      column: KanbanColumn.ready,
      displayStatus: DisplayStatus.merged,
    })
  })

  await t.test('a pr keeps the card out of building whatever the worker is doing', () => {
    const got = deriveKanbanPresentation(
      sessionAt('active'),
      [prFacts({ url: 'pr/1' })],
      TEST_NOW,
      TEST_GRACE,
    )
    assert.notEqual(got.column, KanbanColumn.building)
    assert.notEqual(got.displayStatus, DisplayStatus.working)
  })
})
