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
import { fillSlots, messageWorkerForTool, startWorkerForTool, stopWorkerForTool } from '../../src/host/workers-service.ts'
import type { RunCommand } from '../../src/host/worktree.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase, isTerminalPhase, normalizeWorker } from '../../src/domain/workers.ts'
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
  await store.issues.put('iss-1', {
    id: 'iss-1', number: 1, repoId: 'repo-1', title: 'Task', state: 'in_progress',
    workerId: 'wrk-1', createdAt: 1, updatedAt: 1,
  })
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


test('stopping releases the issue, so the work is not stranded', async () => {
  // Without this the issue stays in_progress with a live workerId: nothing can
  // re-work it and its worktree is never collected. That is what the earlier version
  // of this tool produced, and it is the failure the release closes.
  const live = createLiveWorkers()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: fakeHandle().handle })
  const deps = await workerDeps(live)

  const text = await stopWorkerForTool(deps as never, { workerId: 'wrk-1', reason: 'superseded' })
  assert.match(text, /back in the queue as `open`/)
  assert.match(text, /worktree at \/p was kept/)

  const issue = (await deps.raw.issues.get('iss-1')) as { state: string; workerId?: string }
  assert.equal(issue.state, 'open', 'free for another worker')
  assert.equal(issue.workerId, undefined, 'and no longer bound to the stopped one')
  assert.equal(live.byWorker('wrk-1'), undefined, 'the handle is forgotten')
})

test('stopping finishes the WORKER RECORD, which is what frees its slot', async () => {
  // The complement of the test below, and the reason it needed one. The worktree is kept
  // (stopping is not abandoning the WORK), but the record is finished: the issue is requeued
  // for a different worker, so this one can never act again — and while its phase stayed live
  // it held a concurrency slot it could not use.
  //
  // That is not hypothetical. The web profile's cordis.patch.yml carries a note from when the
  // queue wedged: "capacity counts workers 'not in merged|closed|abandoned|failed', and
  // NOTHING but a merged or closed PR moves a worker to a terminal phase -- orchestrator_worker_stop
  // only cancels the turn and requeues the issue ... and no code ever writes 'abandoned'. So a
  // worker whose turn ends without a PR holds a slot forever, and at the default cap of 2
  // exactly two of them wedge the queue with no operator release valve." Raising the cap was
  // the workaround; this is the fix.
  const live = createLiveWorkers()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: fakeHandle().handle })
  const deps = await workerDeps(live)

  await stopWorkerForTool(deps as never, { workerId: 'wrk-1', reason: 'superseded' })

  const worker = normalizeWorker(await deps.raw.workers.get('wrk-1'))
  assert.equal(worker.phase, WorkerPhase.abandoned)
  assert.ok(isTerminalPhase(worker.phase), 'terminal, so it no longer counts against the cap')
  assert.equal(worker.phaseHistory.at(-1)?.summary, 'superseded', 'and the operator\'s reason is the audit line')
  assert.equal(worker.endedAt !== undefined, true, 'the watermark is stamped with the phase')
})

test('stopping keeps the worktree, because stopping is not abandoning', async () => {
  // The branch and any uncommitted changes are still the worker\'s, and re-working
  // the issue reuses the same canonical path. Collection belongs to release -- done,
  // cancelled, or a merged pull request.
  const live = createLiveWorkers()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: fakeHandle().handle })
  const deps = await workerDeps(live)
  const text = await stopWorkerForTool(deps as never, { workerId: 'wrk-1' })
  assert.match(text, /was kept/)
  assert.ok(!/removed/i.test(text), 'nothing was removed')
})

test('a stop whose release fails still reports the stop', async () => {
  // The turn was already cancelled. Pretending the stop did not happen would invite a
  // second stop that cancels nothing.
  const live = createLiveWorkers()
  const handle = fakeHandle()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: handle.handle })
  const deps = await workerDeps(live)
  const broken = { ...deps, store: lazyFactStore(async () => { throw new Error('backend offline') }) } as never

  const text = await stopWorkerForTool(broken, { workerId: 'wrk-1' })
  assert.match(text, /Stopped wrk-1's active turn/)
  assert.match(text, /could not be released/)
  assert.match(text, /backend offline/)
  assert.deepEqual(handle.cancels, [{ kind: 'user' }], 'the turn was still cancelled')
})


// ---------------------------------------------------------------------------
// The concurrency cap (M5)
// ---------------------------------------------------------------------------

test('over the cap, work is QUEUED rather than refused', async () => {
  // `maxConcurrentWorkers` was validated, displayed by orchestrator_config, and never
  // applied -- so the plugin started unbounded workers, each with its own worktree (a
  // full checkout), session, and model spend. A cap that is advertised and not applied
  // is worse than none: the operator has configured a bound they believe holds.
  const store = createMemoryFactStore()
  for (const index of [1, 2]) {
    await store.workers.put(`wrk-${index}`, {
      id: `wrk-${index}`, issueId: `iss-${index}`, sessionId: `dsho-wrk-${index}`, branch: `b${index}`,
      worktreePath: `/p/${index}`, workspaceId: 'w', phase: WorkerPhase.implementing, phaseHistory: [],
      lastSignalAt: 1, createdAt: 1, updatedAt: 1,
    })
  }
  // An explicit issue, because the cap is checked once the issue is resolved -- you
  // cannot queue work that cannot be filed, so a title with no repository still reports
  // the repository problem first.
  await store.issues.put('iss-queue', {
    id: 'iss-queue', number: 9, repoId: 'repo-1', title: 'One more', state: 'open', createdAt: 1, updatedAt: 1,
  })
  const text = await startWorkerForTool(depsFor(store, 2), { issueId: 'iss-queue' })

  assert.match(text, /At capacity: 2 of 2 workers are active/)
  assert.match(text, /iss-queue is QUEUED at position 1/)
  assert.match(text, /wrk-1/, 'the reply names what is holding the slots')
  assert.match(text, /orchestrator_worker_stop/, 'and how to free one')
  assert.equal((await store.workers.list()).length, 2, 'nothing was started')

  // And the request is RECORDED, so the caller does not have to remember it.
  const queued = (await store.issues.get('iss-queue')) as { pendingWorker?: boolean }
  assert.equal(queued.pendingWorker, true, 'the intent to work is what is queued')
})

test('a TERMINAL worker does not occupy a slot', async () => {
  // The bound is about resources, and a finished worker's worktree has been released.
  const store = createMemoryFactStore()
  await store.workers.put('wrk-done', {
    id: 'wrk-done', issueId: 'iss-0', sessionId: 'dsho-wrk-done', branch: 'b', worktreePath: '/p/0',
    workspaceId: 'w', phase: WorkerPhase.merged, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-live', {
    id: 'wrk-live', issueId: 'iss-1', sessionId: 'dsho-wrk-live', branch: 'b', worktreePath: '/p/1',
    workspaceId: 'w', phase: WorkerPhase.implementing, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  await store.issues.put('iss-1', {
    id: 'iss-1', number: 2, repoId: 'repo-1', title: 'One more', state: 'open', createdAt: 1, updatedAt: 1,
  })
  const text = await startWorkerForTool(depsFor(store, 2), { issueId: 'iss-1' })
  assert.ok(!/QUEUED/.test(text), `a released worker frees its slot, got: ${text}`)
  assert.ok(!/At capacity/.test(text), text)
})

test('the cap is read from config, not hard-coded', async () => {
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 's', branch: 'b', worktreePath: '/p', workspaceId: 'w',
    phase: WorkerPhase.implementing, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  await store.issues.put('iss-x', {
    id: 'iss-x', number: 3, repoId: 'repo-1', title: 'x', state: 'open', createdAt: 1, updatedAt: 1,
  })
  await store.issues.put('iss-y', {
    id: 'iss-y', number: 4, repoId: 'repo-1', title: 'y', state: 'open', createdAt: 2, updatedAt: 2,
  })
  assert.match(await startWorkerForTool(depsFor(store, 1), { issueId: 'iss-x' }), /At capacity: 1 of 1/)
  assert.ok(!/At capacity/.test(await startWorkerForTool(depsFor(store, 2), { issueId: 'iss-y' })))
})

/** The minimum the cap check needs; it runs before anything is spawned. */
function depsFor(store: ReturnType<typeof createMemoryFactStore>, maxConcurrentWorkers: number) {
  return {
    store: lazyFactStore(async () => store),
    config: normalizePluginConfig({ maxConcurrentWorkers }),
    spawn: {} as never,
    run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as RunCommand,
  } as never
}


// ---------------------------------------------------------------------------
// The slot filler (M5)
// ---------------------------------------------------------------------------

test('the filler does nothing while the cap is full, and R7: nothing hungry', async () => {
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-0', sessionId: 's', branch: 'b', worktreePath: '/p', workspaceId: 'w',
    phase: WorkerPhase.implementing, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  await store.issues.put('iss-q', {
    id: 'iss-q', number: 5, repoId: 'repo-1', title: 'Waiting', state: 'open',
    pendingWorker: true, createdAt: 1, updatedAt: 1,
  })
  const full = await fillSlots(depsFor(store, 1))
  assert.deepEqual(full, { started: [], active: 1 }, 'a full cap starts nothing')
  assert.equal(((await store.issues.get('iss-q')) as { pendingWorker?: boolean }).pendingWorker, true, 'and the request survives')

  // An ordinary `open` issue is NOT queued work: merely creating an issue must never
  // cause a worker to appear.
  const store2 = createMemoryFactStore()
  await store2.issues.put('iss-plain', {
    id: 'iss-plain', number: 6, repoId: 'repo-1', title: 'Just recorded', state: 'open', createdAt: 1, updatedAt: 1,
  })
  assert.deepEqual((await fillSlots(depsFor(store2, 2))).started, [], 'an open issue without the intent flag waits')
})

test('a failed start clears the flag, so a sweep does not retry forever', async () => {
  // The alternative -- leaving it set -- turns one broken spawn into a start attempt on
  // every tick, forever, each one creating a worktree and a session before failing.
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/r', owner: 'acme', name: 'widgets' })
  await store.issues.put('iss-q', {
    id: 'iss-q', number: 7, repoId: 'repo-1', title: 'Waiting', state: 'open',
    pendingWorker: true, createdAt: 1, updatedAt: 1,
  })
  // The spawn seam is empty, so the attempt fails after the flag is cleared.
  const outcome = await fillSlots(depsFor(store, 2))
  assert.deepEqual(outcome.started, [], 'nothing started')
  assert.equal(((await store.issues.get('iss-q')) as { pendingWorker?: boolean }).pendingWorker, false, 'marked as tried')
})

test('the filler contains a storage failure', async () => {
  const outcome = await fillSlots({
    store: lazyFactStore(async () => { throw new Error('offline') }),
    config: normalizePluginConfig(),
  } as never)
  assert.deepEqual(outcome, { started: [], active: 0 })
})
