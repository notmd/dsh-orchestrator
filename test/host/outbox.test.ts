/**
 * Delivering the outbox.
 *
 * The two properties worth defending: **a retry cannot double-deliver** (reports
 * are claimed before the send), and **a report survives an absent orchestrator
 * session** (nothing is claimed when there is nowhere to send it). A23 depends on
 * the second; a tick depends on the first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deliverPendingReports, pendingReportCount } from '../../src/host/outbox-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { ReportState } from '../../src/domain/reports.ts'
import type { Report } from '../../src/domain/reports.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'

const NOW = 10_000_000

/** A store with one worker, one issue with a source session, and the given reports. */
async function outbox(reports: Array<Partial<Report>>, options: { sourceSessionId?: string | null } = {}) {
  const store = createMemoryFactStore()
  const sourceSessionId = options.sourceSessionId === undefined ? 'session-orchestrator' : options.sourceSessionId
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/r' })
  await store.issues.put('iss-1', {
    id: 'iss-1',
    number: 1,
    repoId: 'repo-1',
    title: 'Fix it',
    state: 'in_progress',
    workerId: 'wrk-1',
    ...(sourceSessionId ? { sourceSessionId } : {}),
    createdAt: 1,
    updatedAt: 1,
  })
  await store.workers.put('wrk-1', {
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'dsho-wrk-1',
    phase: WorkerPhase.awaitingHuman,
    phaseHistory: [],
    lastSignalAt: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  for (const [index, report] of reports.entries()) {
    await store.reports.put(`rpt-${index}`, {
      id: `rpt-${index}`,
      workerId: 'wrk-1',
      issueId: 'iss-1',
      note: `note ${index}`,
      outputs: [],
      createdAt: NOW - 1,
      ...report,
    })
  }
  const delivered: unknown[] = []
  const sent: Array<{ sessionId: string; message: unknown }> = []
  const agents: { get(id: string): { followup(message: unknown): void } | undefined } = {
    get(id: string) {
      return {
        followup(message: unknown) {
          delivered.push(message)
          sent.push({ sessionId: id, message })
        },
      }
    },
  }
  return {
    raw: store,
    delivered,
    sent,
    deps: {
      store: lazyFactStore(async () => store),
      agents,
      userMessage: (text: string) => ({ content: [{ type: 'text', text }] }),
      now: () => NOW,
    },
  }
}

test('a needs_input report is delivered into the session that created the issue', async () => {
  const { deps, sent, delivered } = await outbox([
    { state: ReportState.needsInput, note: 'which branch should I target?' },
  ])
  const outcome = await deliverPendingReports(deps)

  assert.equal(outcome.delivered.length, 1)
  assert.equal(outcome.delivered[0]!.sessionId, 'session-orchestrator')
  assert.equal(outcome.delivered[0]!.reason, 'needs-input')
  assert.equal(sent.length, 1)
  const message = delivered[0] as { content: Array<{ text: string }> }
  assert.match(message.content[0]!.text, /needs_input: which branch should I target\?/)
})

test('a delivered report is claimed, so a second pass does not send it again', async () => {
  const { deps, sent } = await outbox([{ state: ReportState.needsInput, note: 'q' }])
  await deliverPendingReports(deps)
  const second = await deliverPendingReports(deps)
  assert.equal(sent.length, 1, 'delivered once')
  assert.deepEqual(second.delivered, [])
  assert.equal(await pendingReportCount(await deps.store.get()), 0)
})

test('a checkpoint inside its window is held, and nothing is sent', async () => {
  const { deps, sent } = await outbox([{ state: ReportState.checkpoint, note: 'halfway' }])
  const outcome = await deliverPendingReports(deps)
  assert.deepEqual(outcome.delivered, [])
  assert.equal(outcome.held, 1)
  assert.equal(sent.length, 0)
  assert.equal(await pendingReportCount(await deps.store.get()), 1, 'still pending')
})

test('A23: with no orchestrator session the reports persist rather than being lost', async () => {
  // Nothing is claimed when there is nowhere to send it, which is what makes
  // "delivered when it reopens" true.
  const { deps, raw } = await outbox([{ state: ReportState.needsInput, note: 'q' }], {
    sourceSessionId: null,
  })
  const outcome = await deliverPendingReports(deps)
  assert.deepEqual(outcome.delivered, [])
  assert.equal(outcome.unreachable.length, 1)
  assert.equal(await pendingReportCount(raw), 1, 'still pending, not claimed')
})

test('a session the registry cannot reach is unreachable, not an error', async () => {
  // The difference matters: this is a normal state after a restart, not a fault.
  const { deps, raw } = await outbox([{ state: ReportState.needsInput, note: 'q' }])
  deps.agents = { get: () => undefined }
  const outcome = await deliverPendingReports(deps)
  assert.equal(outcome.unreachable.length, 1)
  assert.deepEqual(outcome.errors, [])
  assert.equal(await pendingReportCount(raw), 1)
})

test('a failed send releases the claim so the next tick retries', async () => {
  // Claiming after sending would double-deliver whenever a send succeeded but its
  // bookkeeping did not; claiming before and releasing on failure loses nothing.
  const { deps, raw } = await outbox([{ state: ReportState.needsInput, note: 'q' }])
  deps.agents = {
    get: () => ({
      followup() {
        throw new Error('session closed')
      },
    }),
  }
  const outcome = await deliverPendingReports(deps)
  assert.equal(outcome.delivered.length, 0)
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!.message, /session closed/)
  assert.equal(await pendingReportCount(raw), 1, 'the claim was released')
})

test('one worker failing does not stop another', async () => {
  // A single stuck worker must not silence the whole board.
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/r' })
  for (const index of [1, 2]) {
    await store.issues.put(`iss-${index}`, {
      id: `iss-${index}`,
      number: index,
      repoId: 'repo-1',
      title: 't',
      state: 'in_progress',
      workerId: `wrk-${index}`,
      sourceSessionId: `session-${index}`,
      createdAt: 1,
      updatedAt: 1,
    })
    await store.workers.put(`wrk-${index}`, {
      id: `wrk-${index}`,
      issueId: `iss-${index}`,
      sessionId: `dsho-wrk-${index}`,
      phase: WorkerPhase.awaitingHuman,
      phaseHistory: [],
      lastSignalAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await store.reports.put(`rpt-${index}`, {
      id: `rpt-${index}`,
      workerId: `wrk-${index}`,
      issueId: `iss-${index}`,
      state: ReportState.needsInput,
      note: 'q',
      outputs: [],
      createdAt: NOW - 1,
    })
  }
  const sent: string[] = []
  const outcome = await deliverPendingReports({
    store: lazyFactStore(async () => store),
    agents: {
      get(id) {
        return {
          followup() {
            if (id === 'session-1') throw new Error('first worker failed')
            sent.push(id)
          },
        }
      },
    },
    userMessage: (text: string) => text,
    now: () => NOW,
  })
  assert.deepEqual(sent, ['session-2'], 'the second worker still got its report')
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.delivered.length, 1)
})

test('a store failure is reported, not thrown at the caller', async () => {
  const outcome = await deliverPendingReports({
    store: lazyFactStore(async () => {
      throw new Error('backend offline')
    }),
    agents: { get: () => undefined },
    userMessage: (text: string) => text,
  })
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!.message, /backend offline/)
})

test('a batch of several reports is one message, not three', async () => {
  // The whole point of the outbox: three reports during one task are one
  // interruption, not three.
  // All three past the fallback window, so all three are due: the checkpoints
  // would otherwise be correctly held, and the batch would be one report.
  const { deps, sent, delivered } = await outbox([
    { state: ReportState.needsInput, note: 'one', createdAt: NOW - 3_600_003 },
    { state: ReportState.checkpoint, note: 'two', createdAt: NOW - 3_600_002 },
    { state: ReportState.checkpoint, note: 'three', createdAt: NOW - 3_600_001 },
  ])
  await deliverPendingReports(deps)
  assert.equal(sent.length, 1, 'one delivery')
  const message = delivered[0] as { content: Array<{ text: string }> }
  assert.match(message.content[0]!.text, /^3 reports:/)
  assert.match(message.content[0]!.text, /needs_input: one/)
})
