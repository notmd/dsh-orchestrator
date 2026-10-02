/**
 * The worker phase axis: the transition guard, the terminal watermark, and the
 * paused-worker protection.
 *
 * §12 of `docs/agent-orchestrator-task-state-transitions.md` is the spec these
 * pin:
 *
 *   - §12.2 — `setPhase` must not accept any transition; the reference's pattern is
 *     a domain-level `ValidTransition(from, to)` plus "terminal is terminal".
 *   - §12.3 — one stated precedence for the three terminal representations.
 *   - §12.4 — `isSticky`/`needsInput` must stop being exported-but-unused, by
 *     giving a paused worker the "not aged by a clock" protection they promise.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ActivityState, isSticky, needsInput } from '../../src/contract/activity.ts'
import {
  PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  WorkerPhase,
  declaredActivity,
  isPausedWorker,
  isTerminalPhase,
  isValidPhaseTransition,
  normalizeWorker,
  setPhase,
  InvalidPhaseTransitionError,
} from '../../src/domain/workers.ts'
import type { Worker } from '../../src/domain/workers.ts'

const NOW = 1_700_000_000_000
const ALL_PHASES: readonly WorkerPhase[] = Object.values(WorkerPhase)
const NON_TERMINAL: readonly WorkerPhase[] = ALL_PHASES.filter((phase) => !isTerminalPhase(phase))

function worker(overrides: Partial<Worker> = {}): Worker {
  return normalizeWorker({
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'ses-1',
    branch: 'dsho/issue-1',
    worktreePath: '/tmp/wt',
    workspaceId: 'ws',
    phase: WorkerPhase.queued,
    phaseHistory: [],
    lastSignalAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

test('every phase has a row, so a new phase cannot be added without a transition list', () => {
  for (const phase of ALL_PHASES) {
    assert.ok(
      Object.hasOwn(PHASE_TRANSITIONS, phase),
      `${phase} has no PHASE_TRANSITIONS entry`,
    )
  }
  assert.equal(Object.keys(PHASE_TRANSITIONS).length, ALL_PHASES.length)
})

test('a terminal phase has no outgoing transitions at all', () => {
  for (const phase of TERMINAL_PHASES) {
    assert.deepEqual(
      [...PHASE_TRANSITIONS[phase]],
      [],
      `${phase} is terminal, so nothing may follow it`,
    )
  }
})

test('the PRD §8 edges are legal, including the backward ones', () => {
  const legal: ReadonlyArray<readonly [WorkerPhase, WorkerPhase]> = [
    // Forward ladder.
    [WorkerPhase.queued, WorkerPhase.planning],
    [WorkerPhase.planning, WorkerPhase.implementing],
    [WorkerPhase.implementing, WorkerPhase.verifying],
    [WorkerPhase.verifying, WorkerPhase.selfReviewing],
    [WorkerPhase.selfReviewing, WorkerPhase.shipping],
    [WorkerPhase.shipping, WorkerPhase.awaitingAutoReview],
    [WorkerPhase.shipping, WorkerPhase.awaitingHuman],
    [WorkerPhase.awaitingAutoReview, WorkerPhase.addressingFeedback],
    [WorkerPhase.awaitingAutoReview, WorkerPhase.awaitingHuman],
    [WorkerPhase.awaitingAutoReview, WorkerPhase.mergeReady],
    [WorkerPhase.awaitingAutoReview, WorkerPhase.failed],
    [WorkerPhase.awaitingAutoReview, WorkerPhase.closed],
    [WorkerPhase.awaitingHuman, WorkerPhase.addressingFeedback],
    [WorkerPhase.awaitingHuman, WorkerPhase.mergeReady],
    [WorkerPhase.mergeReady, WorkerPhase.merged],
    [WorkerPhase.mergeReady, WorkerPhase.awaitingHuman],
    // Backward edges the PRD names, one at a time.
    [WorkerPhase.verifying, WorkerPhase.implementing],
    [WorkerPhase.selfReviewing, WorkerPhase.implementing],
    [WorkerPhase.addressingFeedback, WorkerPhase.implementing],
  ]
  for (const [from, to] of legal) {
    assert.ok(isValidPhaseTransition(from, to), `${from} -> ${to} should be legal`)
  }
})

test('a worker may skip a stage it never reported', () => {
  // A report is a checkpoint. A worker that goes straight to `self_reviewing` did not
  // thereby do something illegal, and refusing it would make the pipeline lie about
  // where the work is.
  assert.ok(isValidPhaseTransition(WorkerPhase.queued, WorkerPhase.selfReviewing))
  assert.ok(isValidPhaseTransition(WorkerPhase.queued, WorkerPhase.shipping))
  assert.ok(isValidPhaseTransition(WorkerPhase.planning, WorkerPhase.shipping))
})

test('merge_ready is reachable from every non-terminal phase, because it is derived', () => {
  // It is decided from provider facts by the merge-readiness sweep, not declared by
  // the worker, so a reattached worker whose PR is already mergeable must not be stuck
  // wherever its last checkpoint left it.
  for (const phase of NON_TERMINAL) {
    if (phase === WorkerPhase.mergeReady) continue // already there; not a transition
    assert.ok(
      isValidPhaseTransition(phase, WorkerPhase.mergeReady),
      `${phase} -> merge_ready should be legal`,
    )
  }
})

test('the imposed outcomes are reachable from every live phase, and live only in ONE place', () => {
  // A person can merge, close, or stop a worker mid-stage, and a reviewer can fail one,
  // from wherever the worker happens to be. Those four are therefore not enumerated per
  // row — one home for the rule, so the rows cannot drift apart from each other.
  const imposed: readonly WorkerPhase[] = [
    WorkerPhase.merged,
    WorkerPhase.closed,
    WorkerPhase.failed,
    WorkerPhase.abandoned,
  ]
  for (const from of NON_TERMINAL) {
    for (const to of imposed) {
      assert.ok(isValidPhaseTransition(from, to), `${from} -> ${to} should be legal`)
    }
  }
  for (const from of ALL_PHASES) {
    for (const to of imposed) {
      assert.equal(
        (PHASE_TRANSITIONS[from] ?? []).includes(to),
        false,
        `${to} must not be repeated in the ${from} row`,
      )
    }
  }
})

test('backward moves are enumerated, not general', () => {
  // The whole point of §12.2: these are representable today and must not be.
  const illegal: ReadonlyArray<readonly [WorkerPhase, WorkerPhase]> = [
    [WorkerPhase.merged, WorkerPhase.implementing],
    [WorkerPhase.merged, WorkerPhase.queued],
    [WorkerPhase.closed, WorkerPhase.shipping],
    [WorkerPhase.failed, WorkerPhase.implementing],
    [WorkerPhase.abandoned, WorkerPhase.planning],
    // No general "go backwards": shipping does not return to planning.
    [WorkerPhase.shipping, WorkerPhase.planning],
    [WorkerPhase.awaitingAutoReview, WorkerPhase.planning],
    [WorkerPhase.mergeReady, WorkerPhase.shipping],
  ]
  for (const [from, to] of illegal) {
    assert.equal(isValidPhaseTransition(from, to), false, `${from} -> ${to} must be illegal`)
  }
})

test('a phase is not a transition to itself', () => {
  for (const phase of ALL_PHASES) {
    assert.equal(isValidPhaseTransition(phase, phase), false, `${phase} -> ${phase}`)
  }
})

// ---------------------------------------------------------------------------
// Enforcement at the writer
// ---------------------------------------------------------------------------

test('setPhase is a no-op for the phase the worker already has', () => {
  const current = worker({ phase: WorkerPhase.implementing })
  assert.equal(setPhase(current, WorkerPhase.implementing, 'again', NOW), current)
})

test('setPhase refuses a post-terminal write and names the edge', () => {
  const finished = worker({ phase: WorkerPhase.merged, endedAt: NOW - 1_000 })
  assert.throws(
    () => setPhase(finished, WorkerPhase.implementing, 'still working', NOW),
    (error: unknown) => {
      assert.ok(error instanceof InvalidPhaseTransitionError)
      assert.equal(error.from, WorkerPhase.merged)
      assert.equal(error.to, WorkerPhase.implementing)
      assert.match(error.message, /terminal/)
      return true
    },
  )
})

test('setPhase appends to the audit trail and moves lastSignalAt for a legal edge', () => {
  const before = worker({ phase: WorkerPhase.shipping, lastSignalAt: NOW - 5_000 })
  const after = setPhase(before, WorkerPhase.awaitingAutoReview, 'reviewer scheduled', NOW)
  assert.equal(after.phase, WorkerPhase.awaitingAutoReview)
  assert.equal(after.lastSignalAt, NOW)
  assert.equal(after.updatedAt, NOW)
  assert.deepEqual(after.phaseHistory, [{ phase: WorkerPhase.awaitingAutoReview, at: NOW, summary: 'reviewer scheduled' }])
  assert.equal(after.endedAt, undefined, 'a non-terminal phase carries no watermark')
})

test('§12.3 — endedAt is stamped by setPhase and only for a terminal phase', () => {
  const shipping = worker({ phase: WorkerPhase.shipping })
  const merged = setPhase(shipping, WorkerPhase.merged, 'pull request merged', NOW)
  assert.equal(merged.endedAt, NOW)
  // Rule 1 of the precedence on `isTerminalPhase`: the phase is the authority, and the
  // board derives its `isTerminated` fact from exactly this call.
  assert.equal(isTerminalPhase(merged.phase), true)
  assert.equal(isTerminalPhase(shipping.phase), false)
  assert.equal(shipping.endedAt, undefined)
})

test('§12.3 — a stale endedAt on a live phase does not read as terminated', () => {
  // Rule 2: the watermark never decides anything. Only a hand-edited record can produce this
  // pair — the table forbids a phase leaving a terminal state — and the phase still wins.
  const odd = worker({ phase: WorkerPhase.implementing, endedAt: NOW - 10_000 })
  assert.equal(isTerminalPhase(odd.phase), false)
})

test('§12.1 — a paused worker that resumes is not refused its stage declaration', () => {
  // The regression this pins: `awaiting_human` originally allowed NO forward edge, so a worker
  // that reported `needs_input`, was answered, and went back to work had its next stage
  // declaration refused — and sat paused for the rest of the task.
  for (const target of [
    WorkerPhase.planning,
    WorkerPhase.implementing,
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.mergeReady,
  ]) {
    assert.ok(isValidPhaseTransition(WorkerPhase.awaitingHuman, target), `awaiting_human -> ${target}`)
  }
  const paused = worker({ phase: WorkerPhase.awaitingHuman, pendingQuestion: { text: 'which branch?', at: NOW } })
  const resumed = setPhase(paused, WorkerPhase.implementing, 'answered, implementing', NOW)
  assert.equal(resumed.phase, WorkerPhase.implementing)
})

test('§12.1 — every phase the producers need is reachable from the spawn phase', () => {
  // The gap the teardown found was that production wrote only a handful of phases.
  // The declared stages and the producer-driven ones must all be enterable from
  // `queued`, which is the only phase a worker is created in.
  for (const target of [
    WorkerPhase.planning,
    WorkerPhase.implementing,
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
    WorkerPhase.failed,
    WorkerPhase.abandoned,
    WorkerPhase.merged,
    WorkerPhase.closed,
  ]) {
    assert.ok(isValidPhaseTransition(WorkerPhase.queued, target), `queued -> ${target}`)
  }
})

// ---------------------------------------------------------------------------
// §12.4 — the paused-worker protection
// ---------------------------------------------------------------------------

test('declaredActivity reads the protocol fact, through the ported predicates', () => {
  assert.equal(declaredActivity(worker({ phase: WorkerPhase.implementing })), undefined)
  assert.equal(
    declaredActivity(worker({ pendingQuestion: { text: 'which branch?', at: NOW } })),
    ActivityState.waitingInput,
  )
  assert.equal(declaredActivity(worker({ phase: WorkerPhase.awaitingHuman })), ActivityState.blocked)
  // The declared values are exactly the ones the predicates claim.
  assert.ok(needsInput(ActivityState.waitingInput))
  assert.ok(needsInput(ActivityState.blocked))
  assert.ok(isSticky(ActivityState.waitingInput))
  assert.ok(isSticky(ActivityState.blocked))
})

test('§12.4 / R20 — a paused worker is sticky and no clock may demote it', () => {
  assert.ok(isPausedWorker(worker({ pendingQuestion: { text: 'which branch?', at: NOW } })))
  assert.ok(isPausedWorker(worker({ phase: WorkerPhase.awaitingHuman })))
  // And nothing else is: an idle worker after a completed turn is demotable.
  assert.equal(isPausedWorker(worker({ phase: WorkerPhase.implementing })), false)
  assert.equal(isPausedWorker(worker({ phase: WorkerPhase.queued })), false)
  assert.equal(isPausedWorker(worker({ phase: WorkerPhase.merged })), false)
})
