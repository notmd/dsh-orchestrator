/**
 * Live handles, and the two tools that need one.
 *
 * The property worth defending here is what unload does **not** do: A9 says
 * unloading leaves sessions and worktrees intact, so disposing every handle —
 * which "stops/drains, unregisters, removes the session" — would destroy exactly
 * what must survive. It looks like a leak to anyone who has not read A9.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLiveWorkers } from '../../src/host/handle-registry.ts'
import type { LiveWorker } from '../../src/host/handle-registry.ts'
import { messageWorkerForTool, stopWorkerForTool } from '../../src/host/workers-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'
import type { AgentLike, AgentHandle, Disposable } from '../../src/host/spawn.ts'

function fakeHandle(): { handle: AgentHandle; readonly followups: unknown[]; readonly cancels: unknown[] } {
  const followups: unknown[] = []
  const cancels: unknown[] = []
  const agent: AgentLike = {
    session: { id: 's' },
    followup(message) {
      followups.push(message)
    },
    cancel(cause) {
      cancels.push(cause)
    },
  }
  return {
    handle: { agent, async dispose() {} },
    get followups() {
      return followups
    },
    get cancels() {
      return cancels
    },
  }
}

function entry(workerId: string): LiveWorker & { readonly disposed: number } {
  const fake = fakeHandle()
  let disposed = 0
  const scope: Disposable = {
    dispose() {
      disposed += 1
    },
  }
  const worker: LiveWorker = {
    workerId,
    sessionId: `dsho-${workerId}`,
    handle: { ...fake.handle, async dispose() { disposed += 1 } },
    scope,
  }
  return Object.assign(worker, {
    get disposed() {
      return disposed
    },
  })
}

test('a registered worker is found by id and by session', () => {
  const live = createLiveWorkers()
  live.register(entry('wrk-1'))
  assert.equal(live.byWorker('wrk-1')?.workerId, 'wrk-1')
  assert.equal(live.bySession('dsho-wrk-1')?.workerId, 'wrk-1')
  assert.equal(live.byWorker('wrk-2'), undefined)
  assert.equal(live.size(), 1)
})

test('clear drops references and disposes NOTHING', () => {
  // A9. Disposing a handle removes its session; unloading must not.
  const live = createLiveWorkers()
  const first = entry('wrk-1')
  live.register(first)
  live.clear()
  assert.equal(live.size(), 0, 'the references are gone')
  assert.equal(first.disposed, 0, 'the session and its scope are untouched')
})

test('forget drops one reference and touches nothing else', () => {
  const live = createLiveWorkers()
  const first = entry('wrk-1')
  live.register(first)
  live.register(entry('wrk-2'))
  live.forget('wrk-1')
  assert.equal(live.size(), 1)
  assert.equal(live.byWorker('wrk-2')?.workerId, 'wrk-2')
  assert.equal(first.disposed, 0)
})

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

async function workerDeps(live = createLiveWorkers()) {
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'dsho-wrk-1',
    branch: 'b',
    worktreePath: '/p',
    workspaceId: 'w',
    phase: WorkerPhase.awaitingHuman,
    phaseHistory: [],
    pendingQuestion: { text: 'which branch?', at: 1 },
    lastSignalAt: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  return {
    store: lazyFactStore(async () => store),
    raw: store,
    live,
    run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never,
    spawn: { userMessage: (text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }) } as never,
    config: {} as never,
  }
}

test('a message is queued as a followup turn, not as context or a steer', async () => {
  // followup queues an ordinary turn and wakes the driver. inject would sit until
  // other input arrived; steer needs a running turn to steer.
  const live = createLiveWorkers()
  const handle = fakeHandle()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: handle.handle })
  const deps = await workerDeps(live)

  const text = await messageWorkerForTool(deps as never, { workerId: 'wrk-1', message: 'please also handle the empty list' })
  assert.match(text, /Queued a follow-up turn for wrk-1/)
  assert.equal(handle.followups.length, 1)
  const message = handle.followups[0] as { content: Array<{ text: string }> }
  assert.equal(message.content[0]!.text, 'please also handle the empty list')
})

test('answering a worker clears its pending question', async () => {
  const live = createLiveWorkers()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: fakeHandle().handle })
  const deps = await workerDeps(live)
  await messageWorkerForTool(deps as never, { workerId: 'wrk-1', message: 'target main' })
  const stored = (await deps.raw.workers.get('wrk-1')) as { pendingQuestion?: unknown; lastSignalAt: number }
  assert.equal(stored.pendingQuestion, undefined, 'the person has answered')
  assert.ok(stored.lastSignalAt > 1, 'and that is a sign of life')
})

test('an empty message is refused rather than waking the worker with nothing', async () => {
  const live = createLiveWorkers()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: fakeHandle().handle })
  const deps = await workerDeps(live)
  assert.match(await messageWorkerForTool(deps as never, { workerId: 'wrk-1', message: '   ' }), /message is required/)
})

test('a worker with no live handle says why, and that its session survives', async () => {
  // After a restart the handle is gone but the session is not: the honest message
  // distinguishes "cannot from here" from "no longer exists".
  const deps = await workerDeps()
  const text = await messageWorkerForTool(deps as never, { workerId: 'wrk-1', message: 'hi' })
  assert.match(text, /No live handle for wrk-1/)
  assert.match(text, /session is durable and still exists/)
})

test('stop cancels the turn with the real cause shape and leaves the session', async () => {
  const live = createLiveWorkers()
  const handle = fakeHandle()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: handle.handle })
  const deps = await workerDeps(live)

  const text = await stopWorkerForTool(deps as never, { workerId: 'wrk-1', reason: 'superseded' })
  assert.match(text, /Stopped wrk-1's active turn/)
  assert.match(text, /session is untouched/)
  // `{ kind: 'user' }` exactly: only the `hook` cause carries a reason, so a reason
  // field here would be invented.
  assert.deepEqual(handle.cancels, [{ kind: 'user' }])
})

test('stop with no live handle says there is no turn to stop', async () => {
  const deps = await workerDeps()
  assert.match(await stopWorkerForTool(deps as never, { workerId: 'wrk-1' }), /no turn to stop/)
})
