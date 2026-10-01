/**
 * The worker spawner.
 *
 * The recipe's *order* and its *rollback discipline* are the substance here: a
 * spawn that half-succeeds leaves a live agent, an orphaned workspace, or a leaked
 * preset lease, and none of those are visible until they hurt. So the tests assert
 * the call sequence, not just the returned value.
 *
 * Acceptance criteria touched: A2 (a worker session exists with its own cwd and
 * branch), A9 (unloading leaves sessions intact, so creation must be owned).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { spawnWorker } from '../../src/host/spawn.ts'
import type { AgentHandle, Disposable, SpawnDeps, WorkerMessage, WorkspaceLike } from '../../src/host/spawn.ts'

interface Harness {
  deps: SpawnDeps
  /** Every host call, in order, as `service.method`. */
  readonly calls: string[]
  readonly warnings: string[]
  setAttachFails(error: Error): void
  setCreateFails(error: Error): void
  setDisposeFails(error: Error): void
  setScopeReleaseFails(error: Error): void
  readonly disposed: number
  readonly scopeDisposed: number
  readonly prompted: unknown[]
}

function harness(): Harness {
  const calls: string[] = []
  const warnings: string[] = []
  const prompted: unknown[] = []
  let attachError: Error | undefined
  let createError: Error | undefined
  let disposeError: Error | undefined
  let scopeError: Error | undefined
  let disposed = 0
  let scopeDisposed = 0

  const message: WorkerMessage = { content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user' } }

  const deps: SpawnDeps = {
    permissionPresets: {
      resolve(name) {
        calls.push('permissionPresets.resolve')
        if (name === 'nope') throw new Error(`unknown permission preset ${name}`)
        return { name }
      },
      set() {
        calls.push('permissionPresets.set')
      },
    },
    agentPresets: {
      async resolve(name) {
        calls.push('agentPresets.resolve')
        return { id: `preset:${name}` }
      },
      async acquireScope(id) {
        calls.push('agentPresets.acquireScope')
        return {
          async dispose() {
            calls.push('scope.dispose')
            scopeDisposed += 1
            if (scopeError) throw scopeError
          },
        } satisfies Disposable
      },
      async mount() {
        calls.push('agentPresets.mount')
      },
    },
    workspaceRegistry: {
      async create(path, title) {
        calls.push('workspaceRegistry.create')
        return {
          path,
          title,
          async attachSession() {
            calls.push('workspace.attachSession')
            if (attachError) throw attachError
          },
        } as WorkspaceLike
      },
    },
    sessionTitle: {
      rename() {
        calls.push('sessionTitle.rename')
      },
    },
    agents: {
      async create(options) {
        calls.push('agents.create')
        if (createError) throw createError
        await options.setup({})
        const handle: AgentHandle = {
          agent: {
            session: { id: options.sessionId },
            followup(m) {
              calls.push('agent.followup')
              prompted.push(m)
            },
          },
          async dispose() {
            calls.push('agent.dispose')
            disposed += 1
            if (disposeError) throw disposeError
          },
        }
        return handle
      },
    },
    userMessage(text) {
      calls.push('userMessage')
      return { ...message, content: [{ type: 'text', text }] }
    },
    logger: {
      warn(m) {
        warnings.push(m)
      },
    },
  }

  return {
    deps,
    calls,
    warnings,
    setAttachFails(e) {
      attachError = e
    },
    setCreateFails(e) {
      createError = e
    },
    setDisposeFails(e) {
      disposeError = e
    },
    setScopeReleaseFails(e) {
      scopeError = e
    },
    get disposed() {
      return disposed
    },
    get scopeDisposed() {
      return scopeDisposed
    },
    get prompted() {
      return prompted
    },
  }
}

const REQUEST = {
  sessionId: 'sess-1',
  worktreePath: '/repo/.dsho/worktrees/issue-3',
  title: '#3 Fix the flaky auth test',
  prompt: 'You are an implementation worker…',
  permissionPreset: 'workspace-write',
  agentPreset: 'standard',
}

test('the recipe runs in the reference order', async () => {
  const h = harness()
  const worker = await spawnWorker(h.deps, REQUEST)
  assert.deepEqual(h.calls, [
    // 1. validate before any await
    'permissionPresets.resolve',
    // 2. resolve and lease the agent preset
    'agentPresets.resolve',
    'agentPresets.acquireScope',
    // 4. the workspace must exist before the session points at it
    'workspaceRegistry.create',
    // 5. create the agent, which mounts the preset in its setup
    'agents.create',
    'agentPresets.mount',
    // 6. publish in order: attach, permission, title
    'workspace.attachSession',
    'permissionPresets.set',
    'sessionTitle.rename',
    // 7. then wake it
    'userMessage',
    'agent.followup',
  ])
  assert.equal(worker.sessionId, 'sess-1')
  assert.equal(worker.title, REQUEST.title)
})

test('the prompt is admitted with followup, not inject or steer', async () => {
  const h = harness()
  await spawnWorker(h.deps, REQUEST)
  // `followup` queues an ordinary turn and wakes the driver. `inject` would sit
  // until other input arrived; `steer` needs a running turn to steer.
  assert.ok(h.calls.includes('agent.followup'))
  assert.equal(h.prompted.length, 1)
  const message = h.prompted[0] as WorkerMessage
  assert.equal(message.content[0]!.text, REQUEST.prompt)
})

test('the session cwd is the workspace path the registry canonicalized', async () => {
  const h = harness()
  let seenCwd: string | undefined
  const original = h.deps.agents.create.bind(h.deps.agents)
  h.deps.agents.create = async (options) => {
    seenCwd = options.meta.cwd
    return original(options)
  }
  const worker = await spawnWorker(h.deps, REQUEST)
  assert.equal(seenCwd, worker.worktreePath)
  assert.equal(worker.worktreePath, REQUEST.worktreePath)
})

test('an unknown permission preset fails before anything is created', async () => {
  const h = harness()
  await assert.rejects(
    () => spawnWorker(h.deps, { ...REQUEST, permissionPreset: 'nope' }),
    /unknown permission preset/,
  )
  assert.deepEqual(h.calls, ['permissionPresets.resolve'], 'nothing else was attempted')
})

test('a failed agent creation releases the scope and leaves no workspace behind', async () => {
  const h = harness()
  const boom = new Error('create failed')
  h.setCreateFails(boom)
  await assert.rejects(() => spawnWorker(h.deps, REQUEST), boom)
  assert.equal(h.scopeDisposed, 1, 'the preset lease is released')
  assert.equal(h.disposed, 0, 'there is no agent to dispose')
})

test('a failed attach disposes the agent rather than leaking it', async () => {
  const h = harness()
  const boom = new Error('attach failed')
  h.setAttachFails(boom)
  await assert.rejects(() => spawnWorker(h.deps, REQUEST), boom)
  assert.equal(h.disposed, 1)
  assert.equal(h.scopeDisposed, 1)
  assert.ok(
    !h.calls.includes('agent.followup'),
    'a worker that could not be published is never woken',
  )
  assert.ok(!h.calls.includes('sessionTitle.rename'), 'the title is set only after publishing')
})

test('the original error survives a rollback failure', async () => {
  // The reference logs a rollback failure "without replacing the original error".
  // The cause the user can act on is the first one.
  const h = harness()
  const boom = new Error('attach failed')
  h.setAttachFails(boom)
  h.setDisposeFails(new Error('dispose also failed'))
  h.setScopeReleaseFails(new Error('scope release also failed'))
  await assert.rejects(() => spawnWorker(h.deps, REQUEST), (error) => {
    assert.equal(error, boom, 'the original error is what propagates')
    return true
  })
  assert.equal(h.warnings.length, 2, 'both rollback failures are reported, not swallowed')
})

test('an aborted request stops before creating the agent', async () => {
  const h = harness()
  const controller = new AbortController()
  const original = h.deps.agentPresets.acquireScope.bind(h.deps.agentPresets)
  h.deps.agentPresets.acquireScope = async (id) => {
    const scope = await original(id)
    // Abort at the first boundary after the lease, which is where the reference
    // checks too.
    controller.abort()
    return scope
  }
  await assert.rejects(() => spawnWorker(h.deps, { ...REQUEST, signal: controller.signal }))
  assert.ok(!h.calls.includes('workspaceRegistry.create'), 'aborted before the workspace')
  assert.equal(h.scopeDisposed, 1, 'the lease taken before the abort is released')
})

test('a spawn that is aborted by the caller throws an abort error', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => spawnWorker(h.deps, { ...REQUEST, signal: controller.signal }))
})

test('the preset scope is handed to the caller, not released on return', async () => {
  // The reference disposes the lease when the triggering function returns, which
  // cannot be right for a worker that must outlive it. We hand it back instead.
  // Flagged for confirmation in M0 spike 2.
  const h = harness()
  const worker = await spawnWorker(h.deps, REQUEST)
  assert.equal(h.scopeDisposed, 0, 'the worker keeps its lease')
  assert.ok(worker.scope)
  await worker.scope!.dispose()
  assert.equal(h.scopeDisposed, 1)
})

test('the agent preset name is resolved to its id before it is mounted', async () => {
  const h = harness()
  const mounted: string[] = []
  h.deps.agentPresets.mount = async (_ctx, id) => {
    mounted.push(id)
  }
  await spawnWorker(h.deps, REQUEST)
  assert.deepEqual(mounted, ['preset:standard'], 'the id is mounted, not the name')
})

test('agentOptions are passed only when the caller supplied them', async () => {
  const h = harness()
  const seen: unknown[] = []
  const original = h.deps.agents.create.bind(h.deps.agents)
  h.deps.agents.create = async (options) => {
    seen.push(options.agentOptions)
    return original(options)
  }
  await spawnWorker(h.deps, REQUEST)
  await spawnWorker(h.deps, { ...REQUEST, agentOptions: { provider: 'deepseek' } })
  assert.deepEqual(seen, [undefined, { provider: 'deepseek' }])
})


// ---------------------------------------------------------------------------
// hideWorktreeWorkspaces (R2)
// ---------------------------------------------------------------------------

test('R2: hiding a worker from the sidebar means SKIPPING THE ATTACH, not hiding it', async () => {
  // The mechanism is what made this look unimplementable: the workspace registry offers no
  // way to hide an entry (`create(path, title)`, `list()`), so a search for a hiding API
  // finds nothing. The PRD is specific instead: "keeps worker workspaces out of the repo\'s
  // session grouping by NOT ATTACHING them".
  const hidden = harness()
  const worker = await spawnWorker(hidden.deps, { ...REQUEST, hideFromWorkspace: true })
  assert.ok(
    !hidden.calls.includes('workspace.attachSession'),
    `attachSession must be skipped, got: ${hidden.calls.join(', ')}`,
  )
  assert.equal(worker.worktreePath, REQUEST.worktreePath, 'the session still works in its worktree')
  assert.ok(hidden.calls.includes('agents.create'), 'and the worker is still spawned')

  // The default is attach, because the PRD names the cost: without it the worker has no
  // DSH workspace grouping and the board is the only way to reach it.
  const attached = harness()
  await spawnWorker(attached.deps, REQUEST)
  assert.ok(attached.calls.includes('workspace.attachSession'))
})
