/**
 * The board's read model: attention, ordering, lane grouping, and the card.
 *
 * Acceptance criteria covered: A27 (`checking`/`unknown` render honestly), A28
 * (exactly three display statuses demand attention), A29 (ordering is attention
 * first, then recency, and stable across a no-op refresh), A30 (`isTerminated`
 * gates the finished treatment and archive is not a lane).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ATTENTION_DISPLAY_STATUSES,
  AttentionZone,
  IN_PROGRESS_DISPLAY_STATUSES,
  StatusReadiness,
  archiveSheet,
  attentionZone,
  groupIntoLanes,
  isFinished,
  needsAttention,
  normalizeStatusReadiness,
  orderCards,
  presentCard,
  showStatusLoader,
} from '../../src/board/presentation.ts'
import { DisplayStatus, KANBAN_LANES, KanbanColumn } from '../../src/contract/kanban.ts'
import { SessionStatus } from '../../src/contract/status.ts'

const NOW = 10_000_000
const GRACE = 90_000

function card(overrides) {
  return { id: 'c1', sessionId: 's1', title: 'Fix the flaky auth test', updatedAt: 1, ...overrides }
}

// ---------------------------------------------------------------------------
// A28 — exactly three display statuses demand attention
// ---------------------------------------------------------------------------

test('A28 — attention is claimed by exactly Blocked, CI failing, and Changes requested', () => {
  assert.deepEqual(
    [...ATTENTION_DISPLAY_STATUSES].sort(),
    [DisplayStatus.blocked, DisplayStatus.ciFailing, DisplayStatus.changesRequested].sort(),
  )
  for (const status of ATTENTION_DISPLAY_STATUSES) {
    assert.equal(needsAttention(card({}), status), true, status)
  }
})

test('A28 — Needs human review does NOT pulse, even though it waits on the user', () => {
  assert.equal(needsAttention(card({}), DisplayStatus.needsHumanReview), false)
})

test('A28 — no other display status pulses', () => {
  const quiet = [
    DisplayStatus.working,
    DisplayStatus.exited,
    DisplayStatus.noSignal,
    DisplayStatus.awaitingPr,
    DisplayStatus.fixingCI,
    DisplayStatus.addressingComments,
    DisplayStatus.needsReview,
    DisplayStatus.reviewScheduled,
    DisplayStatus.reviewing,
    DisplayStatus.reviewFailed,
    DisplayStatus.reviewPending,
    DisplayStatus.draft,
    DisplayStatus.commented,
    DisplayStatus.mergeable,
    DisplayStatus.approved,
    DisplayStatus.merged,
    DisplayStatus.closed,
    DisplayStatus.terminated,
  ]
  for (const status of quiet) {
    assert.equal(needsAttention(card({}), status), false, status)
  }
})

test('A27 — a non-ready statusReadiness suppresses attention entirely', async (t) => {
  for (const readiness of [StatusReadiness.checking, StatusReadiness.unavailable]) {
    await t.test(readiness, () => {
      for (const status of ATTENTION_DISPLAY_STATUSES) {
        assert.equal(needsAttention(card({ statusReadiness: readiness }), status), false, status)
      }
    })
  }

  await t.test('an absent or ready readiness does not suppress', () => {
    assert.equal(needsAttention(card({}), DisplayStatus.blocked), true)
    assert.equal(needsAttention(card({ statusReadiness: 'ready' }), DisplayStatus.blocked), true)
  })

  await t.test('an unrecognized readiness normalizes to ready', () => {
    assert.equal(normalizeStatusReadiness('nonsense'), StatusReadiness.ready)
    assert.equal(normalizeStatusReadiness(undefined), StatusReadiness.ready)
  })
})

test('the reference-only statusPresentation override suppresses attention', () => {
  // Kept so a future port that starts setting it inherits the behaviour rather
  // than silently losing it.
  assert.equal(needsAttention(card({ statusPresentation: { className: 'x' } }), DisplayStatus.blocked), false)
})

test('with no displayStatus, attention falls back to the older attention zones', async (t) => {
  const action = [
    SessionStatus.needsInput,
    SessionStatus.exited,
    SessionStatus.noSignal,
    SessionStatus.ciFailed,
    SessionStatus.changesRequested,
    'unknown',
  ]
  for (const status of action) {
    await t.test(`${status} is an action zone`, () => {
      assert.equal(attentionZone(status), AttentionZone.action)
      assert.equal(needsAttention(card({ status })), true)
    })
  }

  await t.test('a directly blocked activity state is attention', () => {
    assert.equal(needsAttention(card({ status: SessionStatus.working, activity: 'blocked' })), true)
  })

  await t.test('waiting_input alone is not: it comes in via the status, not the activity', () => {
    // The reference checks `activity.state === 'blocked'` only. A waiting_input
    // worker reads `needs_input`, which is the action zone -- so the two paths
    // agree on the outcome, and this pins that the mechanism is the status.
    assert.equal(needsAttention(card({ status: SessionStatus.working, activity: 'waiting_input' })), false)
  })

  await t.test('working and idle are not attention', () => {
    assert.equal(needsAttention(card({ status: SessionStatus.working })), false)
    assert.equal(needsAttention(card({ status: SessionStatus.idle })), false)
  })

  await t.test('merge and done zones are not attention', () => {
    for (const status of [SessionStatus.merged, SessionStatus.approved, SessionStatus.mergeable, SessionStatus.terminated]) {
      assert.equal(needsAttention(card({ status })), false, status)
    }
  })
})

// ---------------------------------------------------------------------------
// A30 — the finished treatment requires isTerminated
// ---------------------------------------------------------------------------

test('A30 — merged while still live is not finished', async (t) => {
  await t.test('merged with isTerminated true is finished', () => {
    assert.equal(isFinished(card({ status: SessionStatus.merged, isTerminated: true })), true)
  })

  await t.test('merged with isTerminated false is NOT finished', () => {
    assert.equal(isFinished(card({ status: SessionStatus.merged, isTerminated: false })), false)
  })

  await t.test('merged with isTerminated absent is NOT finished', () => {
    assert.equal(isFinished(card({ status: SessionStatus.merged })), false)
  })

  await t.test('terminated is finished regardless', () => {
    assert.equal(isFinished(card({ status: SessionStatus.terminated })), true)
    assert.equal(isFinished(card({ status: SessionStatus.terminated, isTerminated: false })), true)
  })

  await t.test('nothing else is finished', () => {
    for (const status of [SessionStatus.working, SessionStatus.mergeable, SessionStatus.idle]) {
      assert.equal(isFinished(card({ status, isTerminated: true })), false, status)
    }
  })
})

// ---------------------------------------------------------------------------
// The spinner
// ---------------------------------------------------------------------------

test('the spinner appears exactly while the loop is turning the PR', () => {
  for (const status of IN_PROGRESS_DISPLAY_STATUSES) {
    assert.equal(showStatusLoader(card({}), status), true, status)
  }
  for (const status of [DisplayStatus.merged, DisplayStatus.mergeable, DisplayStatus.awaitingPr, DisplayStatus.reviewFailed]) {
    assert.equal(showStatusLoader(card({}), status), false, status)
  }
})

test('the spinner is suppressed for a finished loop, a draft, and an attention card', () => {
  assert.equal(showStatusLoader(card({}), DisplayStatus.needsHumanReview), false)
  assert.equal(showStatusLoader(card({}), DisplayStatus.draft), false)
  for (const status of ATTENTION_DISPLAY_STATUSES) {
    assert.equal(showStatusLoader(card({}), status), false, status)
  }
})

test('A27 — a checking session spins, an unavailable one does not', () => {
  // `checking` means "we are finding out", which is honest work in progress.
  // `unavailable` means "we could not find out", and a spinner would lie.
  assert.equal(showStatusLoader(card({ statusReadiness: 'checking' }), DisplayStatus.awaitingPr), true)
  assert.equal(showStatusLoader(card({ statusReadiness: 'unavailable' }), DisplayStatus.reviewing), false)
})

test('the spinner reads displayStatus, not the aggregate status (the reference bug #5081)', () => {
  // A card whose best PR is settled `Mergeable` but whose worst open PR is still
  // review-pending must not spin. `status` says review_pending here, on purpose.
  const got = showStatusLoader(
    card({ status: SessionStatus.reviewPending }),
    DisplayStatus.mergeable,
  )
  assert.equal(got, false, 'a settled card must not spin because a sibling PR is pending')
})

test('the spinner falls back to status only when displayStatus is absent', () => {
  assert.equal(showStatusLoader(card({ status: SessionStatus.reviewPending })), true)
  assert.equal(showStatusLoader(card({ status: SessionStatus.working })), false)
})

// ---------------------------------------------------------------------------
// A29 — ordering
// ---------------------------------------------------------------------------

test('A29 — attention outranks recency', () => {
  const old = card({ id: 'old', updatedAt: 1, displayStatus: DisplayStatus.blocked })
  const fresh = card({ id: 'fresh', updatedAt: 999, displayStatus: DisplayStatus.working })
  assert.deepEqual(orderCards([fresh, old]).map((c) => c.id), ['old', 'fresh'])
})

test('A29 — among equal attention, the more recent sorts first', () => {
  const a = card({ id: 'a', updatedAt: 1, displayStatus: DisplayStatus.working })
  const b = card({ id: 'b', updatedAt: 2, displayStatus: DisplayStatus.working })
  assert.deepEqual(orderCards([a, b]).map((c) => c.id), ['b', 'a'])
})

test('A29 — the order does not depend on input order, so a no-op refresh cannot reorder', () => {
  const cards = [
    card({ id: 'b', updatedAt: 5, displayStatus: DisplayStatus.working }),
    card({ id: 'a', updatedAt: 5, displayStatus: DisplayStatus.working }),
    card({ id: 'c', updatedAt: 9, displayStatus: DisplayStatus.changesRequested }),
  ]
  const first = orderCards(cards).map((c) => c.id)
  const second = orderCards([...cards].reverse()).map((c) => c.id)
  const third = orderCards([cards[1], cards[2], cards[0]]).map((c) => c.id)
  assert.deepEqual(first, second)
  assert.deepEqual(first, third)
  assert.deepEqual(first, ['c', 'a', 'b'])
})

test('A29 — the input array is not mutated', () => {
  const cards = [
    card({ id: 'a', updatedAt: 1, displayStatus: DisplayStatus.working }),
    card({ id: 'b', updatedAt: 2, displayStatus: DisplayStatus.working }),
  ]
  const before = cards.map((c) => c.id)
  orderCards(cards)
  assert.deepEqual(cards.map((c) => c.id), before)
})

test('R22 — a blocked worker flips above freshly-updated idle ones', () => {
  const idle = [1, 2, 3].map((i) => card({ id: `idle-${i}`, updatedAt: 1000 + i, displayStatus: DisplayStatus.awaitingPr }))
  const blocked = card({ id: 'blocked', updatedAt: 1, displayStatus: DisplayStatus.blocked })
  assert.equal(orderCards([...idle, blocked])[0].id, 'blocked')
})

// ---------------------------------------------------------------------------
// presentCard + lanes
// ---------------------------------------------------------------------------

test('presentCard runs the reducer and reports every derived field', () => {
  const view = presentCard(
    card({
      prs: [{ url: 'pr/1', updateAt: 0 }],
      autoReview: true,
      requireHumanApprovalBeforeReady: true,
      activity: 'idle',
    }),
    { now: NOW, noSignalGraceMs: GRACE },
  )
  assert.equal(view.column, KanbanColumn.validating)
  assert.equal(view.displayStatus, DisplayStatus.reviewScheduled)
  assert.equal(view.needsAttention, false)
  assert.equal(view.showStatusLoader, false)
  assert.equal(view.isFinished, false)
  assert.equal(view.statusReadiness, StatusReadiness.ready)
})

test('presentCard carries the round-limit escalation to the card', () => {
  const view = presentCard(
    card({
      prs: [
        {
          url: 'pr/1',
          number: 1,
          mergeability: 'mergeable',
          reviewRun: { present: true, outcome: true, changesRequested: true, roundBudgetExhausted: true },
        },
      ],
      autoReview: true,
      autoInjectReview: true,
      requireHumanApprovalBeforeReady: true,
    }),
    { now: NOW, noSignalGraceMs: GRACE },
  )
  assert.equal(view.column, KanbanColumn.needsReview)
  assert.equal(view.displayStatus, DisplayStatus.needsHumanReview)
  assert.equal(view.escalationReason, 'review-round-limit')
  assert.equal(view.showStatusLoader, false)
})

test('A27 — an unknown activity renders Awaiting PR, never Working', () => {
  const view = presentCard(card({ activity: 'unknown' }), { now: NOW, noSignalGraceMs: GRACE })
  assert.equal(view.column, KanbanColumn.building)
  assert.equal(view.displayStatus, DisplayStatus.awaitingPr)
  assert.notEqual(view.displayStatus, DisplayStatus.working)
})

test('A30 — the board is four lanes and archive is not one of them', () => {
  assert.deepEqual([...KANBAN_LANES], [
    KanbanColumn.building,
    KanbanColumn.validating,
    KanbanColumn.needsReview,
    KanbanColumn.ready,
  ])
  assert.ok(!KANBAN_LANES.includes(KanbanColumn.archive))

  const views = [
    presentCard(card({ id: 'a', activity: 'idle' }), { now: NOW, noSignalGraceMs: GRACE }),
    presentCard(card({ id: 'term', isTerminated: true }), { now: NOW, noSignalGraceMs: GRACE }),
  ]
  const lanes = groupIntoLanes(views)
  assert.deepEqual(Object.keys(lanes).sort(), [...KANBAN_LANES].sort())
  assert.equal(lanes[KanbanColumn.building].length, 1)
  assert.equal(lanes[KanbanColumn.building][0].id, 'a')
  assert.equal(lanes[KanbanColumn.archive], undefined)

  assert.deepEqual(archiveSheet(views).map((v) => v.id), ['term'])
})

test('groupIntoLanes always returns all four lanes, even when empty', () => {
  const lanes = groupIntoLanes([])
  for (const lane of KANBAN_LANES) assert.deepEqual(lanes[lane], [])
})
