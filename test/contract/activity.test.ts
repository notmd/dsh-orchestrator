/**
 * The activity model's three predicates.
 *
 * The PRD's test plan asks for these explicitly, because collapsing them is the
 * single easiest way to break the automation policy:
 *
 *   - `isSticky` resists time-demotion for `waiting_input`/`blocked` **only**
 *   - `needsInput` is true for the same two states and for **no others**
 *   - `unknown` never collapses to `idle`
 *
 * Acceptance criteria covered: A26 (a question does not decay), A27 (`unknown`
 * is honest).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVITY_STATES,
  ActivityState,
  isSticky,
  needsInput,
  normalizeActivity,
} from '../../src/contract/activity.ts'

/** Typed as plain strings so `includes(state)` accepts any ActivityState. */
const STICKY_AND_NEEDS_INPUT: readonly string[] = [ActivityState.waitingInput, ActivityState.blocked]

test('isSticky: resists time-demotion for exactly the two paused states', () => {
  for (const state of ACTIVITY_STATES) {
    assert.equal(
      isSticky(state),
      STICKY_AND_NEEDS_INPUT.includes(state),
      `isSticky(${state})`,
    )
  }
})

test('needsInput: true for exactly the two paused states', () => {
  for (const state of ACTIVITY_STATES) {
    assert.equal(
      needsInput(state),
      STICKY_AND_NEEDS_INPUT.includes(state),
      `needsInput(${state})`,
    )
  }
})

test('A27 — unknown is a distinct state and never collapses to idle', () => {
  assert.equal(normalizeActivity('unknown'), ActivityState.unknown)
  assert.notEqual(normalizeActivity('unknown'), ActivityState.idle)
  assert.notEqual(normalizeActivity(undefined), ActivityState.idle)
  assert.notEqual(normalizeActivity(null), ActivityState.idle)
  assert.notEqual(normalizeActivity(''), ActivityState.idle)
  assert.notEqual(normalizeActivity('running'), ActivityState.idle)
})

test('normalizeActivity keeps every real state', () => {
  for (const state of ACTIVITY_STATES) {
    assert.equal(normalizeActivity(state), state)
  }
})

test('A26 — the paused states are the ones a clock may not demote', () => {
  // Stated as the acceptance criterion states it: a worker that asks a question
  // and then goes quiet is still paused an hour later, and a worker genuinely
  // idle after a completed turn is idle.
  assert.ok(isSticky(ActivityState.waitingInput), 'a question does not decay')
  assert.ok(isSticky(ActivityState.blocked), 'a pending decision does not decay')
  assert.ok(!isSticky(ActivityState.idle), 'a completed turn does become idle')
  assert.ok(!isSticky(ActivityState.active), 'a running worker is simply active')
  assert.ok(!isSticky(ActivityState.exited))
  assert.ok(!isSticky(ActivityState.unknown))
})

test('stickiness and needsInput are different questions about the same two states', () => {
  // The PRD calls this out: "stickiness is about time-demotion, NeedsInput about
  // the user being the unblocker." They agree on today's enum, and this test
  // pins that they are still asked separately so a future state can differ.
  for (const state of ACTIVITY_STATES) {
    if (needsInput(state)) assert.ok(isSticky(state), `${state} needs input so must be sticky`)
  }
})
