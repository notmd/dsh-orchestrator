/**
 * G4 — per-thread review resolution.
 *
 * The finding: `comments: external.length > 0 && external.every(r => r.state === 'COMMENTED')`
 * is a reading of *reviews*, not of *discussions*. A reviewer who submits
 * `CHANGES_REQUESTED` **and** `COMMENTED` makes `comments` false, so a card can read
 * `Changes requested` while unanswered line comments sit on the same PR; and because no
 * resolution is tracked, a discussion a person already resolved keeps counting as outstanding
 * feedback until the next head.
 *
 * Both halves are pinned here: the *fact* is now computed independently (and from thread
 * state), and the routing loop stops re-nudging a worker about a finished discussion. The
 * failure direction is deliberate throughout — every uncertainty routes, because routing a
 * resolved comment is wasteful while dropping a person's is the failure that matters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePrView } from '../../src/domain/pr-snapshot.ts'
import type { PrReviewComment, PrReviewThread, PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import { actionableFeedback } from '../../src/host/feedback-service.ts'
import { externalReviewSummary } from '../../src/host/board-service.ts'

const NOW = 1_700_000_000_000

interface SnapshotInput {
  reviews?: unknown[]
  reviewComments?: PrReviewComment[]
  reviewThreads?: PrReviewThread[]
}

function snapshot(input: SnapshotInput = {}): PrSnapshot {
  const base = parsePrView(
    { number: 42, url: 'pr/42', state: 'OPEN', reviews: input.reviews ?? [], comments: [] },
    NOW,
  )
  if (input.reviewComments) base.reviewComments = input.reviewComments
  if (input.reviewThreads) base.reviewThreads = input.reviewThreads
  return base
}

function comment(overrides: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    id: 'PRRC_1',
    restId: '1001',
    reviewId: '',
    author: 'person',
    body: 'this line needs a guard',
    path: 'src/a.ts',
    line: 12,
    createdAt: '2026-10-01T00:00:00Z',
    isBot: false,
    ...overrides,
  }
}

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return { id: 'T1', isResolved: false, isOutdated: false, commentRestIds: ['1001'], ...overrides }
}

// ---------------------------------------------------------------------------
// Routing: a resolved thread is not outstanding feedback
// ---------------------------------------------------------------------------

test('an inline comment in a resolved thread is not routed to the worker', () => {
  const resolved = snapshot({ reviewComments: [comment()], reviewThreads: [thread({ isResolved: true })] })
  assert.deepEqual(actionableFeedback(resolved, []), [], 'the discussion is finished')
})

test('the same comment IS routed while its thread is unresolved', () => {
  const open = snapshot({ reviewComments: [comment()], reviewThreads: [thread()] })
  const items = actionableFeedback(open, [])
  assert.equal(items.length, 1)
  assert.equal(items[0]?.kind, 'comment')
  assert.equal(items[0]?.path, 'src/a.ts', 'with its location, because "this" is meaningless without it')
})

test('no thread data routes — the fail-open direction', () => {
  // A snapshot fetched before threads existed, or a comment the thread list did not carry:
  // absence is "resolution unknown", never "resolved".
  const unknown = snapshot({ reviewComments: [comment()] })
  assert.equal(actionableFeedback(unknown, []).length, 1)
  assert.equal(actionableFeedback(unknown, [], new Set()).length, 1)
})

test('resolution is matched on the REST id space, which is the only shared one', () => {
  // The thread carries `databaseId` values; `restId` is where they can be compared. A
  // thread whose ids belong to a DIFFERENT comment must not silence this one.
  const other = snapshot({ reviewComments: [comment()], reviewThreads: [thread({ isResolved: true, commentRestIds: ['9999'] })] })
  assert.equal(actionableFeedback(other, []).length, 1)
})

test('our own reviews and thread roots are still never routed', () => {
  // Unchanged from the port, and asserted here because the resolution check sits beside it:
  // a regression in either direction would re-send our own findings to the worker.
  const ours = new Set(['R1'])
  const reply = snapshot({
    reviewComments: [comment({ id: 'PRRC_2', restId: '1002', reviewId: 'R1', inReplyToId: '1001' })],
    reviewThreads: [thread()],
  })
  assert.deepEqual(actionableFeedback(reply, [], ours), [])
})

// ---------------------------------------------------------------------------
// The board fact: two independent readings
// ---------------------------------------------------------------------------

test('changes-requested and outstanding comments can BOTH be true', () => {
  // The exact case the finding names. Under the old rule the second fact was suppressed by the
  // first, so unanswered line comments were invisible to the card.
  const both = snapshot({
    reviews: [
      { id: 'R1', state: 'CHANGES_REQUESTED', author: { login: 'person', __typename: 'User' } },
      { id: 'R2', state: 'COMMENTED', author: { login: 'person', __typename: 'User' } },
    ],
    reviewComments: [comment()],
    reviewThreads: [thread()],
  })
  const facts = externalReviewSummary(both, new Set())
  assert.equal(facts.changesRequested, true)
  assert.equal(facts.comments, true, 'the line comments are still sitting there unanswered')
})

test('a resolved discussion stops counting as outstanding', () => {
  const resolved = snapshot({
    reviewComments: [comment()],
    reviewThreads: [thread({ isResolved: true })],
  })
  assert.equal(externalReviewSummary(resolved, new Set()).comments, false)
})

test('a substantive review body still counts, because a review body has no thread to resolve', () => {
  const withBody = snapshot({
    reviews: [{ id: 'R1', state: 'COMMENTED', author: { login: 'person', __typename: 'User' }, body: 'two things' }],
  })
  assert.equal(externalReviewSummary(withBody, new Set()).comments, true)
})

test('a COMMENTED review counts even with an empty body, because its text may be on unfetched inline comments', () => {
  // A review submitted from clicked lines has an empty body and its text on the inline
  // comments. Requiring a body would drop a person\'s line comments entirely on a snapshot we
  // cannot prove had none.
  const bodyless = snapshot({
    reviews: [{ id: 'R1', state: 'COMMENTED', author: { login: 'person', __typename: 'User' } }],
  })
  assert.equal(externalReviewSummary(bodyless, new Set()).comments, true)
})

test('our own reviews never count as a person\'s', () => {
  const mine = snapshot({
    reviews: [{ id: 'PRR_ours', state: 'CHANGES_REQUESTED', author: { login: 'me', __typename: 'User' } }],
  })
  const facts = externalReviewSummary(mine, new Set(['PRR_ours']))
  assert.equal(facts.changesRequested, false)
  assert.equal(facts.approved, false)
})

test('a bot comment is not a request for work', () => {
  const bot = snapshot({ reviewComments: [comment({ isBot: true })], reviewThreads: [thread()] })
  assert.equal(externalReviewSummary(bot, new Set()).comments, false)
})
