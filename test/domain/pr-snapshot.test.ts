/**
 * G3 — mergeability, composed locally, with the reasons kept.
 *
 * The teardown's finding: we passed the provider's `mergeable`/`mergeStateStatus`
 * through untouched, so a PR the provider reports as `mergeStateStatus: BLOCKED` with
 * `mergeable: UNKNOWN` arrived with an empty mergeability. The lane came out the same by
 * a different route, so no card was *wrong* — but the reason list the reference feeds its
 * merge-readiness card was simply absent.
 *
 * The tests below pin both halves: the synthesis (a real reason becomes `BLOCKED`), and
 * the restraint (uncertainty never becomes a claim).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MERGE_BLOCKERS,
  MergeBlocker,
  mergeBlockersFromLocal,
  parsePrView,
  synthesizeMergeability,
} from '../../src/domain/pr-snapshot.ts'
import type { MergeBlockerInput } from '../../src/domain/pr-snapshot.ts'

const NOW = 1_700_000_000_000

function input(overrides: Partial<MergeBlockerInput> = {}): MergeBlockerInput {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    ciState: 'passing',
    reviewDecision: '',
    ...overrides,
  }
}

test('a clean, mergeable pull request has no blockers', () => {
  assert.deepEqual(mergeBlockersFromLocal(input()), [])
})

test('every blocker is reported, in reading order', () => {
  const blockers = mergeBlockersFromLocal(
    input({
      isDraft: true,
      mergeable: 'CONFLICTING',
      ciState: 'failing',
      reviewDecision: 'CHANGES_REQUESTED',
    }),
  )
  assert.deepEqual(blockers, [
    MergeBlocker.conflicting,
    MergeBlocker.draft,
    MergeBlocker.ciFailing,
    MergeBlocker.changesRequested,
  ])
  // The order is the order `MERGE_BLOCKERS` declares, which is the order a
  // merge-readiness card reads.
  const declared = MERGE_BLOCKERS.filter((blocker) => blockers.includes(blocker))
  assert.deepEqual(blockers, declared)
})

test('a required-but-missing review is a reason, and so is an unexplained BLOCKED', () => {
  assert.deepEqual(mergeBlockersFromLocal(input({ reviewDecision: 'REVIEW_REQUIRED' })), [
    MergeBlocker.reviewRequired,
  ])
  // The provider said blocked and no local fact explains it: say that, rather than
  // inventing a cause. A synthesized reason list must never guess.
  assert.deepEqual(
    mergeBlockersFromLocal(input({ mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED' })),
    [MergeBlocker.providerBlocked],
  )
})

test('no answer and no reason is honest uncertainty, not a blocker', () => {
  assert.deepEqual(mergeBlockersFromLocal(input({ mergeable: 'UNKNOWN', mergeStateStatus: '' })), [
    MergeBlocker.unknownState,
  ])
  assert.deepEqual(mergeBlockersFromLocal(input({ mergeable: '' })), [MergeBlocker.unknownState])
})

test('a landed pull request has nothing left to block', () => {
  for (const state of ['MERGED', 'CLOSED'] as const) {
    assert.deepEqual(
      mergeBlockersFromLocal(input({ state, isDraft: true, ciState: 'failing' })),
      [],
      state,
    )
  }
})

test('the provider stays authoritative where it gave an answer', () => {
  // Overriding a computed conflict with locally-derived confidence is how a card
  // promises a merge that then fails.
  assert.equal(synthesizeMergeability('MERGEABLE', [MergeBlocker.draft]), 'MERGEABLE')
  assert.equal(synthesizeMergeability('CONFLICTING', []), 'CONFLICTING')
})

test('a real local reason synthesizes BLOCKED, and uncertainty does not', () => {
  assert.equal(synthesizeMergeability('UNKNOWN', [MergeBlocker.ciFailing]), 'BLOCKED')
  assert.equal(synthesizeMergeability('', [MergeBlocker.draft]), 'BLOCKED')
  assert.equal(synthesizeMergeability('', [MergeBlocker.providerBlocked]), 'BLOCKED')
  assert.equal(synthesizeMergeability('UNKNOWN', [MergeBlocker.conflicting]), 'CONFLICTING')
  // "We do not know yet" must not become "you are blocked" — the same class of lie as
  // an empty payload reading as CLOSED.
  assert.equal(synthesizeMergeability('UNKNOWN', [MergeBlocker.unknownState]), 'UNKNOWN')
  assert.equal(synthesizeMergeability('UNKNOWN', []), 'UNKNOWN')
})

test('the parser composes both, so no caller has to remember to', () => {
  const blocked = parsePrView(
    {
      number: 7,
      url: 'https://example.test/pr/7',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'CHANGES_REQUESTED',
      headRefOid: 'a'.repeat(40),
      reviews: [],
      comments: [],
      statusCheckRollup: [],
    },
    NOW,
  )
  assert.equal(blocked.mergeable, 'BLOCKED', 'synthesized, because the provider had no answer')
  assert.deepEqual(blocked.mergeBlockers, [MergeBlocker.changesRequested])
})

test('the parser does not synthesize a conflict the provider denies', () => {
  const clean = parsePrView(
    {
      number: 8,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
      reviews: [],
      comments: [],
    },
    NOW,
  )
  assert.equal(clean.mergeable, 'MERGEABLE')
  assert.deepEqual(clean.mergeBlockers, [])
})
