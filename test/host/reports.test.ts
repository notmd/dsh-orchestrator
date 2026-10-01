/**
 * The report outbox and the worker protocol.
 *
 * The delivery policy is the interesting part, because it encodes a tension: a
 * worker's reports must not interrupt the orchestrator once per report, but a
 * worker blocked on a person must not wait for a batch that may never come. Every
 * test here is one side of that.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OUTBOX_DEFAULTS, planDelivery, renderDelivery, renderReport } from '../../src/host/report-outbox.ts'
import { MAX_REPORT_CHARACTERS, ReportState, truncateNote } from '../../src/domain/reports.ts'
import type { Report } from '../../src/domain/reports.ts'
import { findWorkerBySession, reportForTool } from '../../src/host/reports-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'

const NOW = 10_000_000

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: `rpt-${Math.random().toString(36).slice(2, 10)}`,
    workerId: 'wrk-1',
    issueId: 'iss-1',
    note: 'a note',
    outputs: [],
    createdAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Delivery policy
// ---------------------------------------------------------------------------

test('nothing pending plans nothing', () => {
  assert.deepEqual(planDelivery({ reports: [], now: NOW }), {
    deliver: [],
    hold: [],
    reason: 'nothing-pending',
  })
})

test('an already-delivered report is never re-planned', () => {
  // Delivery is the outbox's; re-delivering would duplicate into the session.
  const plan = planDelivery({
    reports: [report({ deliveredAt: NOW - 1 })],
    now: NOW,
  })
  assert.equal(plan.reason, 'nothing-pending')
})

test('needs_input is delivered immediately — it is what the board exists to surface', () => {
  const plan = planDelivery({
    reports: [report({ state: ReportState.needsInput, note: 'which branch should I target?' })],
    now: NOW,
  })
  assert.equal(plan.deliver.length, 1)
  assert.equal(plan.reason, 'needs-input')
})

test('a checkpoint is held, not delivered', () => {
  const plan = planDelivery({ reports: [report({ state: ReportState.checkpoint })], now: NOW })
  assert.deepEqual(plan.deliver, [])
  assert.equal(plan.hold.length, 1)
  assert.equal(plan.reason, 'awaiting-window')
})

test('a done report opens the settlement window, so a straggler joins the batch', () => {
  const done = report({ state: ReportState.done, createdAt: NOW })
  const straggler = report({ state: ReportState.checkpoint, createdAt: NOW + 1_000 })

  // Inside the window: held, because the straggler may still be coming.
  const early = planDelivery({ reports: [done, straggler], now: NOW + 1_000 })
  assert.deepEqual(early.deliver, [])
  assert.equal(early.reason, 'awaiting-window')

  // After it: both go, in order.
  const late = planDelivery({
    reports: [done, straggler],
    now: NOW + OUTBOX_DEFAULTS.settlementWindowMs,
  })
  assert.deepEqual(
    late.deliver.map((entry) => entry.state),
    [ReportState.done, ReportState.checkpoint],
  )
  assert.equal(late.reason, 'settled')
})

test('a stuck report interrupts, but only once per interrupt window', () => {
  // Otherwise a worker in a loop floods the orchestrator's session, which is the
  // same failure the reference's `sessionguard` exists to prevent.
  const first = planDelivery({ reports: [report({ state: ReportState.stuck })], now: NOW })
  assert.equal(first.deliver.length, 1)
  assert.equal(first.reason, 'interrupt')

  const tooSoon = planDelivery({
    reports: [report({ state: ReportState.stuck })],
    now: NOW,
    lastInterruptAt: NOW - 1_000,
  })
  assert.deepEqual(tooSoon.deliver, [])
  assert.equal(tooSoon.hold.length, 1)

  const later = planDelivery({
    reports: [report({ state: ReportState.stuck })],
    now: NOW,
    lastInterruptAt: NOW - OUTBOX_DEFAULTS.interruptWindowMs,
  })
  assert.equal(later.deliver.length, 1)
})

test('only one stuck interrupts per pass, even when several are pending', () => {
  const plan = planDelivery({
    reports: [report({ state: ReportState.stuck, createdAt: 1 }), report({ state: ReportState.stuck, createdAt: 2 })],
    now: NOW,
  })
  assert.equal(plan.deliver.length, 1)
  assert.equal(plan.hold.length, 1)
})

test('a held batch is delivered by the fallback window, however quiet the worker is', () => {
  // A batch must never be held forever: without this a checkpoint from a worker
  // that then went idle would sit in storage unseen.
  const old = report({ state: ReportState.checkpoint, createdAt: NOW - OUTBOX_DEFAULTS.batchFallbackMs })
  const plan = planDelivery({ reports: [old], now: NOW })
  assert.equal(plan.deliver.length, 1)
  assert.equal(plan.reason, 'fallback')
})

test('delivery is ordered oldest first, so a batch reads as a sequence', () => {
  const plan = planDelivery({
    reports: [
      report({ state: ReportState.needsInput, createdAt: 3, note: 'third' }),
      report({ state: ReportState.checkpoint, createdAt: 1, note: 'first' }),
      report({ state: ReportState.checkpoint, createdAt: 2, note: 'second' }),
    ],
    now: NOW + OUTBOX_DEFAULTS.batchFallbackMs,
  })
  assert.deepEqual(plan.deliver.map((entry) => entry.note), ['first', 'second', 'third'])
})

test('every window is configurable', () => {
  const checkpoint = report({ state: ReportState.checkpoint, createdAt: NOW - 500 })
  assert.deepEqual(planDelivery({ reports: [checkpoint], now: NOW }).deliver, [])
  assert.equal(
    planDelivery({ reports: [checkpoint], now: NOW, bounds: { batchFallbackMs: 100 } }).deliver.length,
    1,
  )
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('a single report renders as itself', () => {
  assert.equal(renderDelivery([report({ state: ReportState.done, note: 'finished' })]), '[wrk-1] done: finished')
})

test('a batch is grouped, so a reader can tell it from a single report', () => {
  const text = renderDelivery([
    report({ state: ReportState.checkpoint, note: 'one' }),
    report({ state: ReportState.needsInput, note: 'two' }),
  ])
  assert.match(text, /^2 reports:/)
  assert.match(text, /needs_input: two/)
})

test('outputs are listed under their report', () => {
  const text = renderReport(
    report({ state: ReportState.checkpoint, note: 'n', outputs: [{ kind: 'artifact', ref: 'docs/a.md' }] }),
  )
  assert.match(text, /artifact: docs\/a\.md/)
})

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

test('a long note is shortened and MARKED, never silently cut', () => {
  // A silent cut makes a clipped sentence look like the whole message.
  const { note, truncated } = truncateNote('x'.repeat(5_000))
  assert.equal(truncated, true)
  assert.equal(note.length, MAX_REPORT_CHARACTERS)
  assert.match(note, /\[truncated\]/)
})

test('a note that fits is untouched', () => {
  assert.deepEqual(truncateNote('short'), { note: 'short', truncated: false })
})

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

async function reportingWorker() {
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'dsho-wrk-1',
    branch: 'dsho/issue-1-x',
    worktreePath: '/repos/r1/.dsho/worktrees/issue-1-x',
    workspaceId: 'ws-1',
    phase: WorkerPhase.implementing,
    phaseHistory: [],
    lastSignalAt: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  return { store: lazyFactStore(async () => store), raw: store }
}

test('a session that is not a worker cannot report', async () => {
  // Identity is the caller's session, never an argument: a worker that supplied its
  // own id could report on another's behalf and the board would show one worker's
  // progress against another's card.
  const deps = await reportingWorker()
  const text = await reportForTool(deps, { state: 'checkpoint', note: 'x' }, 'someone-else')
  assert.match(text, /No worker is registered for session someone-else/)
})

test('no caller session at all is refused rather than guessed', async () => {
  const deps = await reportingWorker()
  assert.match(await reportForTool(deps, { note: 'x' }, undefined), /no session was available/)
})

test('checkpoint records a report and leaves the phase alone', async () => {
  const deps = await reportingWorker()
  const text = await reportForTool(deps, { state: 'checkpoint', note: 'halfway' }, 'dsho-wrk-1')
  assert.match(text, /Recorded checkpoint for wrk-1/)
  assert.equal((await deps.raw.reports.list()).length, 1)
  const worker = (await deps.raw.workers.get('wrk-1')) as { phase: string }
  assert.equal(worker.phase, WorkerPhase.implementing, 'a checkpoint says nothing about the phase')
})

test('needs_input moves the worker to awaiting_human', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'needs_input', note: 'which branch?' }, 'dsho-wrk-1')
  const worker = (await deps.raw.workers.get('wrk-1')) as { phase: string; lastSignalAt: number }
  assert.equal(worker.phase, WorkerPhase.awaitingHuman)
  assert.ok(worker.lastSignalAt > 1, 'a report is a sign of life')
})

test('done moves the worker to shipping', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'done', note: 'finished' }, 'dsho-wrk-1')
  assert.equal(((await deps.raw.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.shipping)
})

test('pr_created binds the pull request, which the observer and review loop key on', async () => {
  const deps = await reportingWorker()
  await reportForTool(
    deps,
    {
      note: 'opened',
      outputs: [{ kind: 'pr_created' as never, ref: 'https://github.com/acme/widgets/pull/42' }],
    },
    'dsho-wrk-1',
  )
  const worker = (await deps.raw.workers.get('wrk-1')) as { pr?: { number: number; url: string } }
  assert.equal(worker.pr?.number, 42)
  assert.match(worker.pr?.url ?? '', /pull\/42/)
})

test('a report with neither a state nor an output is refused', async () => {
  const deps = await reportingWorker()
  assert.match(await reportForTool(deps, { note: 'nothing' }, 'dsho-wrk-1'), /needs a `state`, an `outputs` entry/)
  assert.equal((await deps.raw.reports.list()).length, 0)
})

test('a bad state or output is refused before anything is stored', async () => {
  const deps = await reportingWorker()
  assert.match(await reportForTool(deps, { state: 'vibing' as never }, 'dsho-wrk-1'), /must be one of/)
  assert.match(
    await reportForTool(deps, { outputs: [{ kind: 'nope' as never, ref: 'x' }] }, 'dsho-wrk-1'),
    /must be one of/,
  )
  assert.match(
    await reportForTool(deps, { outputs: [{ kind: 'artifact' as never, ref: '  ' }] }, 'dsho-wrk-1'),
    /non-empty/,
  )
  assert.equal((await deps.raw.reports.list()).length, 0)
})

test('a report is never a session event, and never rewrites the worktree', async () => {
  // Appendix A3.6: a plugin must not append events with a new `type`, because a
  // reader would then refuse to reopen the session.
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'checkpoint', note: 'x' }, 'dsho-wrk-1')
  const stored = (await deps.raw.reports.list())[0] as Report
  assert.equal(stored.workerId, 'wrk-1')
  assert.equal(stored.issueId, 'iss-1')
  assert.equal(stored.deliveredAt, undefined, 'undelivered until the outbox says so')
})

test('findWorkerBySession resolves the caller', async () => {
  const deps = await reportingWorker()
  const worker = await findWorkerBySession(await deps.store.get(), 'dsho-wrk-1')
  assert.equal(worker?.id, 'wrk-1')
  assert.equal(await findWorkerBySession(await deps.store.get(), 'nope'), undefined)
})
