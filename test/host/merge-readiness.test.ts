/**
 * §12.1 — `merge_ready` has a producer, and the producer is the board.
 *
 * The teardown's gap was that `merge_ready` (like eight other phases) was declared,
 * documented in the PRD, listed in no producer, and never assigned. The fix that keeps
 * the two state axes honest: the phase is set from the **presented lane**, so the card
 * and the record can never disagree about whether the work is waiting on a merge.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizePluginConfig } from '../../src/config/validate.ts'
import type { PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import { WorkerPhase, isBlockedWorker, isValidPhaseTransition, normalizeWorker, setPhase } from '../../src/domain/workers.ts'
import type { Worker } from '../../src/domain/workers.ts'
import { reconcileMergeReadiness, sweepMergeReadiness } from '../../src/host/merge-readiness.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import type { ReviewRun } from '../../src/review/runs.ts'

const NOW = 1_700_000_000_000
const HEAD = 'a'.repeat(40)

function worker(overrides: Partial<Worker> = {}): Worker {
  return normalizeWorker({
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'ses-1',
    branch: 'dsho/issue-1-x',
    worktreePath: '/repos/r1/.dsho/worktrees/issue-1',
    workspaceId: 'ws-1',
    phase: WorkerPhase.awaitingAutoReview,
    phaseHistory: [],
    lastSignalAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    ciState: 'passing',
    headSha: HEAD,
    headRefName: 'dsho/issue-1-x',
    reviews: [],
    comments: [],
    reviewComments: [],
    lastCommentId: '',
    updatedAt: '2026-10-01T00:00:00Z',
    observedAt: NOW,
    fetched: true,
    ...overrides,
  }
}

/** One completed, approving pass for the head under review. */
function approvedRun(): ReviewRun {
  return {
    id: 'run-1',
    workerId: 'wrk-1',
    headSha: HEAD,
    status: 'complete',
    verdict: 'approved',
    findings: [],
  }
}

async function deps(config: ReturnType<typeof normalizePluginConfig>) {
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {})
  return {
    store: lazyFactStore(async () => store),
    raw: store,
    config,
    now: () => NOW,
  }
}

test('a board that reads Ready writes merge_ready — the lane decides the phase', async () => {
  // `requireHumanApprovalBeforeReady: false` restores the reference's own behaviour:
  // our pass approved and the PR is mergeable, so the lane is Ready.
  const d = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: false }))
  const before = worker()
  await d.raw.workers.put(before.id, before)

  const outcome = await reconcileMergeReadiness(d, before, snapshot(), [approvedRun()], 'a task', 1)

  assert.equal(outcome.reason, 'ready')
  assert.equal(outcome.phase, WorkerPhase.mergeReady)
  const stored = normalizeWorker(await d.raw.workers.get(before.id))
  assert.equal(stored.phase, WorkerPhase.mergeReady)
  assert.equal(stored.phaseHistory.at(-1)?.phase, WorkerPhase.mergeReady)
  assert.equal(stored.endedAt, undefined, 'merge_ready is not terminal')
})

test('the human gate holds the phase back while the lane says Needs human review', async () => {
  // D3, and the reason the phase must be derived rather than declared: with the gate
  // on, an auto-approved mergeable PR has NOT reached Ready, so it must not claim
  // merge_ready while the card says "Needs human review".
  const d = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: true }))
  const before = worker()
  await d.raw.workers.put(before.id, before)

  const outcome = await reconcileMergeReadiness(d, before, snapshot(), [approvedRun()], 'a task', 1)

  assert.equal(outcome.phase, WorkerPhase.awaitingAutoReview)
  assert.match(outcome.reason, /lane:needs_review/)
})

test('§12.3 / R13 — an unobserved or failed observation writes no phase', async () => {
  const d = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: false }))
  const before = worker()
  await d.raw.workers.put(before.id, before)

  assert.equal((await reconcileMergeReadiness(d, before, undefined, [approvedRun()], 't', 1)).reason, 'no-observation')
  const unfetched = snapshot({ fetched: false, error: 'rate-limited' })
  assert.equal((await reconcileMergeReadiness(d, before, unfetched, [approvedRun()], 't', 1)).reason, 'no-observation')
  assert.equal(normalizeWorker(await d.raw.workers.get(before.id)).phase, WorkerPhase.awaitingAutoReview)
})

test('a landed pull request is completion\'s decision, not readiness\'s', async () => {
  const d = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: false }))
  const before = worker()
  await d.raw.workers.put(before.id, before)
  const merged = snapshot({ state: 'MERGED' })
  assert.equal((await reconcileMergeReadiness(d, before, merged, [approvedRun()], 't', 1)).reason, 'terminal-pull-request')
})

test('a merge-ready worker that stops being ready is NOT moved by this sweep', async () => {
  // The exit belongs to whoever produces the work. Moving it here was tried and reverted: the
  // phase it would move to (`awaiting_human`) means "the worker asked a person for
  // something", so `isBlockedWorker` reads it as blocked — the card would claim a demand
  // nobody made, and the R14 gate would hold the very review that could unblock it.
  const d = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: false }))
  const ready = worker()
  const mergeReady = setPhase(ready, WorkerPhase.mergeReady, 'the board reads Ready', NOW - 1_000)
  await d.raw.workers.put(mergeReady.id, mergeReady)

  // The card is out of Ready (a draft, and a changes-requested round).
  const changed: ReviewRun = { ...approvedRun(), verdict: 'changes_requested' }
  const outcome = await reconcileMergeReadiness(d, mergeReady, snapshot({ isDraft: true }), [changed], 't', 1)

  assert.equal(outcome.reason, 'lane:validating')
  assert.equal(outcome.phase, WorkerPhase.mergeReady, 'untouched')
  const stored = normalizeWorker(await d.raw.workers.get(mergeReady.id))
  assert.equal(stored.phase, WorkerPhase.mergeReady)
  assert.equal(stored.phaseHistory.length, 1, 'and no phase was written')
})

test('the producers own the exit: a merge-ready worker can be moved by a real event', () => {
  // Which is only true if the edges exist. Each of these is the phase a real producer writes:
  // the reviewer service for a new pass, the feedback loop (or the reviewer's findings) for
  // work to do, and a stop.
  assert.ok(isValidPhaseTransition(WorkerPhase.mergeReady, WorkerPhase.awaitingAutoReview))
  assert.ok(isValidPhaseTransition(WorkerPhase.mergeReady, WorkerPhase.addressingFeedback))
  assert.ok(isValidPhaseTransition(WorkerPhase.mergeReady, WorkerPhase.abandoned))
  // And deliberately NOT the phase that reads as blocked.
  assert.equal(isValidPhaseTransition(WorkerPhase.mergeReady, WorkerPhase.awaitingHuman), true, 'PRD §8 names this edge…')
  assert.ok(
    !isBlockedWorker(normalizeWorker({ ...worker(), phase: WorkerPhase.mergeReady })),
    '…but a merge-ready worker is not blocked, which is why the sweep no longer writes it',
  )
})

test('the sweep only reports workers whose phase actually moved', async () => {
  const d = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: true }))
  const before = worker()
  await d.raw.workers.put(before.id, before)
  await d.raw.issues.put('iss-1', { id: 'iss-1', repoId: 'repo-1', title: 'a task', number: 1 })
  await d.raw.prSnapshots.put('wrk-1', snapshot())
  await d.raw.reviewRuns.put('run-1', approvedRun())

  const held = await sweepMergeReadiness(d)
  assert.deepEqual(held, [], 'nothing moved, so nothing is reported')

  const d2 = await deps(normalizePluginConfig({ requireHumanApprovalBeforeReady: false }))
  await d2.raw.workers.put(before.id, before)
  await d2.raw.issues.put('iss-1', { id: 'iss-1', repoId: 'repo-1', title: 'a task', number: 1 })
  await d2.raw.prSnapshots.put('wrk-1', snapshot())
  await d2.raw.reviewRuns.put('run-1', approvedRun())

  const moved = await sweepMergeReadiness(d2)
  assert.equal(moved.length, 1)
  assert.equal(moved[0]?.phase, WorkerPhase.mergeReady)
})
