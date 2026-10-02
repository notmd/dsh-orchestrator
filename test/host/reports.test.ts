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
import { MAX_REPORT_CHARACTERS, REPORT_STAGES, ReportState, truncateNote } from '../../src/domain/reports.ts'
import type { Report } from '../../src/domain/reports.ts'
import { findWorkerBySession, reportForTool } from '../../src/host/reports-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase, isBlockedWorker, normalizeWorker } from '../../src/domain/workers.ts'

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

test('a report with neither a state, a stage, nor an output is refused', async () => {
  const deps = await reportingWorker()
  assert.match(
    await reportForTool(deps, { note: 'nothing' }, 'dsho-wrk-1'),
    /needs a `state`, a `stage`, an `outputs` entry/,
  )
  assert.equal((await deps.raw.reports.list()).length, 0)
})

// ---------------------------------------------------------------------------
// §12.1 — the declared stage, which is what makes the pipeline phases reachable
// ---------------------------------------------------------------------------

test('a declared stage moves the phase, for every stage the worker may declare', async () => {
  for (const stage of REPORT_STAGES) {
    const deps = await reportingWorker()
    // From the spawn phase, which is the only phase a worker is created in, every
    // declarable stage must be enterable -- that is the gap §12.1 names.
    const stored = (await deps.raw.workers.get('wrk-1')) as Record<string, unknown>
    await deps.raw.workers.put('wrk-1', { ...stored, phase: WorkerPhase.queued, phaseHistory: [] })
    await reportForTool(deps, { stage, note: 'checkpoint' }, 'dsho-wrk-1')
    const worker = (await deps.raw.workers.get('wrk-1')) as { phase: string; phaseHistory: Array<{ phase: string }> }
    assert.equal(worker.phase, stage, `stage ${stage} should land in the same phase`)
    assert.equal(worker.phaseHistory.at(-1)?.phase, stage, 'and it is audited')
  }
})

test('a declared stage cannot walk the pipeline backwards', async () => {
  // `implementing -> planning` is exactly the class of write §12.2 is about: it is
  // representable, it is nonsense, and nothing used to stop it.
  const deps = await reportingWorker()
  const reply = await reportForTool(deps, { stage: 'planning', note: 'actually, first…' }, 'dsho-wrk-1')
  assert.match(reply, /not a legal transition/)
  assert.equal(((await deps.raw.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.implementing)
})

test('the stage is recorded on the report, so the trail explains the phase', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { stage: 'verifying', note: 'ran the suite' }, 'dsho-wrk-1')
  const stored = (await deps.raw.reports.list())[0] as Report
  assert.equal(stored.stage, 'verifying')
})

test('a person blocking outranks the stage the worker also names', async () => {
  // The card must show `Needs you`; the guardrails key on the blockage, not on where
  // in the pipeline the worker happened to be standing.
  const deps = await reportingWorker()
  await reportForTool(deps, { stage: 'implementing', state: 'needs_input', note: 'which branch?' }, 'dsho-wrk-1')
  assert.equal(((await deps.raw.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.awaitingHuman)
})

test('§12.4 / R9 — a paused report RECORDS the question, and resuming clears it', async () => {
  // The field had no producer at all: nothing in production wrote `pendingQuestion`, so the
  // fact R9 says the protocol carries could not be reached by any real worker.
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'needs_input', note: 'which branch should I target?' }, 'dsho-wrk-1')
  const paused = (await deps.raw.workers.get('wrk-1')) as {
    pendingQuestion?: { text: string; at: number }
  }
  assert.equal(paused.pendingQuestion?.text, 'which branch should I target?')
  assert.ok(isBlockedWorker(normalizeWorker(paused)), 'and the R14 gate sees it')

  // Any later report means the worker resumed — including one that only attaches an output,
  // which is what makes this a live fact rather than a latch nobody clears.
  await reportForTool(deps, { outputs: [{ kind: 'artifact' as never, ref: 'notes.md' }] }, 'dsho-wrk-1')
  const resumed = (await deps.raw.workers.get('wrk-1')) as { pendingQuestion?: unknown }
  assert.equal(resumed.pendingQuestion, undefined)
})

test('a stuck report is a pause too, and carries its note as the question', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'stuck', note: 'I cannot choose the migration order' }, 'dsho-wrk-1')
  const worker = (await deps.raw.workers.get('wrk-1')) as {
    phase: string
    pendingQuestion?: { text: string }
  }
  assert.equal(worker.phase, WorkerPhase.awaitingHuman)
  assert.equal(worker.pendingQuestion?.text, 'I cannot choose the migration order')
})

test('a pause with no note still records a question, so the card can render one', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'needs_input' }, 'dsho-wrk-1')
  assert.equal(
    ((await deps.raw.workers.get('wrk-1')) as { pendingQuestion?: { text: string } }).pendingQuestion?.text,
    'waiting on a person',
  )
})

test('a plain checkpoint does not record a pause', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { state: 'checkpoint', note: 'halfway' }, 'dsho-wrk-1')
  assert.equal(((await deps.raw.workers.get('wrk-1')) as { pendingQuestion?: unknown }).pendingQuestion, undefined)
})

test('a bad stage is refused before anything is stored', async () => {
  const deps = await reportingWorker()
  assert.match(await reportForTool(deps, { stage: 'vibing' as never }, 'dsho-wrk-1'), /must be one of/)
  assert.equal((await deps.raw.reports.list()).length, 0)
})

test('re-declaring the stage a worker is already in is routine, not a refusal', async () => {
  const deps = await reportingWorker()
  await reportForTool(deps, { stage: 'implementing' }, 'dsho-wrk-1')
  const reply = await reportForTool(deps, { stage: 'implementing', note: 'still going' }, 'dsho-wrk-1')
  assert.doesNotMatch(reply, /not a legal transition/)
  assert.equal(((await deps.raw.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.implementing)
})

test('a report from a finished worker is recorded but does not resurrect the card', async () => {
  // The session outlives the record, so this is a real case rather than a defensive
  // one. The report is kept; the phase stays terminal; and the worker is told why.
  const deps = await reportingWorker()
  const stored = (await deps.raw.workers.get('wrk-1')) as Record<string, unknown>
  await deps.raw.workers.put('wrk-1', {
    ...stored,
    phase: WorkerPhase.merged,
    phaseHistory: [{ phase: WorkerPhase.merged, at: 1, summary: 'merged' }],
  })
  const reply = await reportForTool(deps, { stage: 'implementing', note: 'one more thing' }, 'dsho-wrk-1')
  assert.match(reply, /not a legal transition/)
  assert.equal((await deps.raw.workers.get('wrk-1') as { phase: string }).phase, WorkerPhase.merged)
  assert.equal((await deps.raw.reports.list()).length, 1, 'the report is still recorded')
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


// ---------------------------------------------------------------------------
// maxReportCharacters is OBEYED, not merely offered
// ---------------------------------------------------------------------------

test('the configured bound is used, not the module default', () => {
  // The setting existed, was validated, and was IGNORED: `truncateNote(note)` always
  // used the module's own constant, so a user who lowered `maxReportCharacters` got the
  // default anyway. A setting that is offered and then not applied is worse than no
  // setting, because the user believes they configured something.
  const long = 'x'.repeat(500)
  const tight = truncateNote(long, 60)
  assert.equal(tight.truncated, true)
  assert.ok(tight.note.length <= 60, `expected <= 60, got ${tight.note.length}`)
  assert.ok(tight.note.length < truncateNote(long).note.length, 'tighter than the default')
})

test('a caller with no config still gets the default, not an unlimited note', () => {
  // `undefined` must mean "the default", not "no limit" -- the opposite reading would
  // silently uncap every report from a host that did not pass the setting.
  const long = 'x'.repeat(50_000)
  assert.deepEqual(truncateNote(long, undefined), truncateNote(long), 'identical to the default call')
  assert.equal(truncateNote(long, undefined).truncated, true, 'still bounded')
})

test('a nonsensical bound falls back rather than disabling the cap', () => {
  // Longer than the DEFAULT too, so "fell back to the default" is distinguishable from
  // "the cap was disabled" -- a shorter note would pass either way.
  const long = 'x'.repeat(50_000)
  for (const bad of [0, -1, Number.NaN]) {
    assert.equal(truncateNote(long, bad).truncated, true, `bound ${bad} must not mean unlimited`)
  }
})

test('a short note is untouched, whatever the bound', () => {
  assert.deepEqual(truncateNote('short', 10), { note: 'short', truncated: false })
})

test('the report tool passes the configured bound through', async () => {
  // The end-to-end half: the constant was correctable and the CALL was not passing
  // anything, which is where the setting was lost.
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 'dsho-wrk-1', branch: 'b', worktreePath: '/p', workspaceId: 'w',
    phase: 'implementing', phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  } as never)
  const reply = await reportForTool(
    { store: lazyFactStore(async () => store), now: () => 50, maxReportCharacters: 40 } as never,
    { state: 'checkpoint' as never, note: 'y'.repeat(400) },
    'dsho-wrk-1',
  )
  assert.ok(!/y{100}/.test(reply), 'the reply does not carry the untruncated note')
  const stored = (await store.reports.list())[0] as { note: string; truncated?: boolean }
  assert.ok(stored.note.length <= 40, `stored ${stored.note.length} characters`)
  assert.equal(stored.truncated, true)
})
