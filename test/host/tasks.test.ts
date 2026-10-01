/**
 * The new-task flow: a brief, a provisional title, and the worker that improves it.
 *
 * Four properties carry this feature, and each is a way it could be wrong while looking
 * right:
 *
 *   - the card has a NAME the moment the task exists, before anything has been asked of a
 *     model -- otherwise the feature is a spinner with extra steps;
 *   - the refinement is registered BEFORE the spawn, because the worker is told to name the
 *     task as its first instruction and a later registration would race the call it exists
 *     to authorise;
 *   - the replacement is compare-and-swap against the provisional title, so a person who
 *     renamed the card is never overwritten;
 *   - it is ONE-SHOT and it EXPIRES, so a worker cannot keep renaming its own card and a
 *     title is never replaced minutes later out of nowhere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizePluginConfig } from '../../src/config/validate.ts'
import { createTaskRefinements } from '../../src/host/task-refinements.ts'
import { createTaskWithWorker, setTaskTitleForTool } from '../../src/host/tasks-service.ts'
import { handleTaskCreate, MAX_TASK_BRIEF_CHARS, TASKS_ROUTE_PATH } from '../../src/host/tasks-route.ts'
import { createLiveWorkers } from '../../src/host/handle-registry.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { UNTITLED_TASK } from '../../src/domain/task-title.ts'
import type { SpawnDeps } from '../../src/host/spawn.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

function result(stdout = '', exitCode = 0): CommandResult {
  return { exitCode, stdout, stderr: '' }
}

/** A git that answers the worktree calls, recording argv. */
function worktreeGit(): RunCommand {
  const existing = new Map<string, string>()
  return async (argv) => {
    const joined = argv.join(' ')
    if (joined.startsWith('git worktree list')) {
      return result(
        [...existing].map(([path, branch]) => `worktree ${path}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/${branch}\n`).join('\n'),
      )
    }
    if (joined.startsWith('git show-ref')) return result('', 1)
    if (joined.startsWith('git worktree add')) {
      const withBranch = argv[3] === '-b'
      const path = withBranch ? argv[5]! : argv[3]!
      existing.set(path, argv[4]!)
      return result()
    }
    if (joined.startsWith('git worktree remove')) {
      existing.delete(argv[argv.length - 1]!)
      return result()
    }
    return result()
  }
}

/** A spawn recipe that records what it was asked for. */
function fakeSpawn(): { deps: SpawnDeps; sessions: string[]; titles: string[]; prompts: string[] } {
  const sessions: string[] = []
  const titles: string[] = []
  const prompts: string[] = []
  const deps: SpawnDeps = {
    permissionPresets: { resolve: () => undefined, set() {} },
    agentPresets: {
      async resolve() {
        return { id: 'standard' }
      },
      async acquireScope() {
        return { dispose() {} }
      },
      async mount() {},
    },
    workspaceRegistry: {
      async create(path) {
        return { path, async attachSession() {} }
      },
    },
    sessionTitle: { rename(_session, title) { titles.push(title) } },
    agents: {
      async create(options) {
        sessions.push(options.sessionId)
        return {
          agent: {
            session: { id: options.sessionId },
            followup(message: { content: Array<{ text: string }> }) {
              prompts.push(message.content.map((block) => block.text).join('\n'))
            },
          },
          async dispose() {},
        }
      },
    },
    userMessage: (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
  return { deps, sessions, titles, prompts }
}

async function taskDeps(options: { config?: Record<string, unknown> } = {}) {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/repos/r1', defaultBranch: 'main', verifyCommands: [] })
  const spawn = fakeSpawn()
  const refinements = createTaskRefinements()
  const live = createLiveWorkers()
  const deps = {
    store: lazyFactStore(async () => store),
    run: worktreeGit(),
    spawn: spawn.deps,
    config: normalizePluginConfig(options.config ?? {}),
    refinements,
    live,
    now: () => 10_000,
  }
  return { deps, store, spawn, refinements }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('an expectation is claimed once, and never twice', () => {
  // One-shot is the whole design: a worker that could keep renaming its card would fight
  // anyone who edited the title by hand, and the board would flicker.
  let clock = 0
  const refinements = createTaskRefinements({ now: () => clock })
  assert.equal(refinements.expect('iss-1', 'Provisional'), 'accepted')
  assert.equal(refinements.claim('iss-1')?.provisional, 'Provisional')
  assert.equal(refinements.claim('iss-1'), undefined, 'the second call finds nothing pending')
})

test('an expectation expires, so a title does not change minutes later', () => {
  let clock = 0
  const refinements = createTaskRefinements({ now: () => clock, timeoutMs: 60_000 })
  refinements.expect('iss-1', 'Provisional')
  clock = 59_999
  assert.equal(refinements.pending(), 1)
  clock = 60_000
  assert.equal(refinements.pending(), 0, 'the deadline is inclusive')
  assert.equal(refinements.claim('iss-1'), undefined)
})

test('at the cap an expectation is DROPPED, not queued', () => {
  // The reference's decision, and the right one: cosmetic work must never accumulate.
  const refinements = createTaskRefinements({ limit: 2 })
  assert.equal(refinements.expect('iss-1', 'a'), 'accepted')
  assert.equal(refinements.expect('iss-2', 'b'), 'accepted')
  assert.equal(refinements.expect('iss-3', 'c'), 'at-capacity')
  assert.equal(refinements.pending(), 2)
  // A task that is already waiting keeps its ONE slot rather than consuming a second.
  assert.equal(refinements.expect('iss-1', 'a again'), 'replaced')
  assert.equal(refinements.pending(), 2)
})

test('sweep reports how many waits ended', () => {
  let clock = 0
  const refinements = createTaskRefinements({ now: () => clock, timeoutMs: 10 })
  refinements.expect('iss-1', 'a')
  refinements.expect('iss-2', 'b')
  clock = 10
  assert.equal(refinements.sweep(), 2)
  assert.equal(refinements.sweep(), 0)
})

// ---------------------------------------------------------------------------
// Creating a task
// ---------------------------------------------------------------------------

test('a task is named from its brief before any model is asked', async () => {
  const { deps, store, spawn } = await taskDeps()
  const outcome = await createTaskWithWorker(deps, { brief: '  Fix the flaky\n\n  auth test  ' })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.title, 'Fix the flaky auth test')
  assert.equal(outcome.started, true)
  assert.equal(outcome.refining, true)
  assert.ok(outcome.workerId, 'a worker was started on it')

  const issue = (await store.issues.get(outcome.issueId!)) as { title: string; body: string; state: string }
  assert.equal(issue.title, 'Fix the flaky auth test', 'the provisional title is durable')
  assert.equal(issue.body, 'Fix the flaky\n\n  auth test', 'and the brief is the task context')
  assert.equal(issue.state, 'in_progress')

  // The worker was told to name it, ONCE, and told it is not extra work.
  assert.match(spawn.prompts[0]!, /## Name this task/)
  assert.match(spawn.prompts[0]!, /orchestrator_task_title/)
  assert.match(spawn.prompts[0]!, /exactly/)
  assert.equal(deps.refinements?.pending(), 1, 'the wait is registered')
})

test('the worker\'s title replaces the provisional one, and only once', async () => {
  const { deps, spawn } = await taskDeps()
  const outcome = await createTaskWithWorker(deps, { brief: 'make the login page not lose your session on refresh' })
  const sessionId = spawn.sessions[0]!

  const first = await setTaskTitleForTool(deps, { title: '## Fix session loss on refresh' }, sessionId)
  assert.match(first, /is now titled "Fix session loss on refresh"/)

  const issue = (await deps.store.get()).issues.get(outcome.issueId!) as Promise<{ title: string }>
  assert.equal((await issue).title, 'Fix session loss on refresh')
  // The reference renames the SESSION too, and a sidebar row still reading the raw brief is
  // the visible half of the feature.
  assert.deepEqual(spawn.titles, [
    '#1 make the login page not lose your session on refresh',
    '#1 Fix session loss on refresh',
  ], 'the spawn title, then the refined one')

  const second = await setTaskTitleForTool(deps, { title: 'Again' }, sessionId)
  assert.match(second, /No title refinement is pending/)
  assert.equal(spawn.titles.length, 2, 'and nothing was renamed twice')
})

test('a title a person already edited is never overwritten', async () => {
  const { deps, store, spawn } = await taskDeps()
  const outcome = await createTaskWithWorker(deps, { brief: 'raw brief words here' })
  // The compare-and-swap exists for exactly this: the person renamed the card while the
  // worker was reading its brief.
  const issue = (await store.issues.get(outcome.issueId!)) as { title: string }
  await store.issues.put(outcome.issueId!, { ...issue, title: 'The name I chose' })

  const text = await setTaskTitleForTool(deps, { title: 'The model\'s name' }, spawn.sessions[0]!)
  assert.match(text, /already titled "The name I chose"/)
  assert.equal(((await store.issues.get(outcome.issueId!)) as { title: string }).title, 'The name I chose')
})

test('a title with no letter or digit is refused, and the provisional one stands', async () => {
  const { deps, store, spawn } = await taskDeps()
  const outcome = await createTaskWithWorker(deps, { brief: 'Do the thing' })
  const text = await setTaskTitleForTool(deps, { title: '###' }, spawn.sessions[0]!)
  assert.match(text, /at least one letter or a digit/)
  assert.equal(((await store.issues.get(outcome.issueId!)) as { title: string }).title, 'Do the thing')
})

test('only the worker whose task is waiting can name it', async () => {
  const { deps } = await taskDeps()
  await createTaskWithWorker(deps, { brief: 'Do the thing' })
  assert.match(await setTaskTitleForTool(deps, { title: 'Anything' }, 'dsho-wrk-somebody-else'), /No worker is registered/)
  assert.match(await setTaskTitleForTool(deps, { title: 'Anything' }, undefined), /no session was available/)
})

test('a brief that names nothing is allowed, and is never refined', async () => {
  // The reference\'s promptless worker: a person can open a worker and instruct it later.
  const { deps, store, spawn } = await taskDeps()
  const outcome = await createTaskWithWorker(deps, { brief: '   ' })
  assert.equal(outcome.title, UNTITLED_TASK)
  assert.equal(outcome.refining, false)
  assert.equal(deps.refinements?.pending(), 0)
  assert.ok(!/## Name this task/.test(spawn.prompts[0]!), 'and the worker is not asked to name it')
  const issue = (await store.issues.get(outcome.issueId!)) as { title: string }
  assert.equal(issue.title, UNTITLED_TASK)
})

test('a task queued at capacity is not waited on', async () => {
  // The queued worker is started later by the slot sweep, through a path that never asks for
  // a title. Leaving the wait registered would let a rename land against a task whose worker
  // never heard the request.
  const { deps, refinements } = await taskDeps({ config: { maxConcurrentWorkers: 1 } })
  const first = await createTaskWithWorker(deps, { brief: 'First task' })
  const queued = await createTaskWithWorker(deps, { brief: 'Second task' })
  assert.equal(queued.ok, true)
  assert.equal(queued.started, false, 'it is queued, which is not a failure')
  assert.equal(queued.refining, false)
  assert.match(queued.message, /QUEUED/)
  // The RUNNING task keeps its wait; the queued one's was released.
  assert.equal(refinements.claim(queued.issueId!), undefined)
  assert.equal(refinements.claim(first.issueId!)?.provisional, 'First task')
})

test('a task with no connected repository is refused with the fix', async () => {
  const { deps, store } = await taskDeps()
  await store.repos.delete('repo-1')
  const outcome = await createTaskWithWorker(deps, { brief: 'Do the thing' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.message, /repo_connect/)
  assert.deepEqual(await store.issues.list(), [], 'and nothing was recorded')
})

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function fakeResponse() {
  const out: FakeResponse = { status: 0, headers: {}, body: '' }
  return {
    out,
    response: {
      writeHead(status: number, headers?: Record<string, string>) {
        out.status = status
        out.headers = headers ?? {}
      },
      end(body?: string) {
        out.body = body ?? ''
      },
    },
  }
}

/** A request whose body arrives on a microtask, exactly as a socket delivers one. */
function fakeRequest(options: { method?: string; url?: string; body?: string }) {
  const listeners = new Map<string, Array<(argument?: unknown) => void>>()
  const request = {
    method: options.method ?? 'POST',
    url: options.url ?? TASKS_ROUTE_PATH,
    on(event: 'data' | 'end' | 'error', listener: (argument?: unknown) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return request
    },
    destroy() {},
  }
  const emit = (event: string, argument?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(argument)
  }
  if (options.body !== undefined) {
    queueMicrotask(() => {
      emit('data', options.body)
      emit('end')
    })
  }
  return request
}

test('the route creates the task and answers 202, because the naming is still in flight', async () => {
  const { deps, store } = await taskDeps()
  const { response, out } = fakeResponse()
  await handleTaskCreate(deps, fakeRequest({ body: JSON.stringify({ repoId: 'repo-1', brief: 'Fix the flaky auth test' }) }), response)

  assert.equal(out.status, 202)
  assert.equal(out.headers['cache-control'], 'no-store')
  const body = JSON.parse(out.body) as { ok?: boolean; title?: string; issueId?: string; refining?: boolean }
  assert.equal(body.ok, true)
  assert.equal(body.title, 'Fix the flaky auth test')
  assert.equal(body.refining, true)
  assert.ok(await store.issues.get(body.issueId!))
})

test('the route refuses a brief past the reference\'s prompt cap', async () => {
  const { deps } = await taskDeps()
  const { response, out } = fakeResponse()
  await handleTaskCreate(
    deps,
    fakeRequest({ body: JSON.stringify({ repoId: 'repo-1', brief: 'x'.repeat(MAX_TASK_BRIEF_CHARS + 1) }) }),
    response,
  )
  assert.equal(out.status, 413)
  assert.match((JSON.parse(out.body) as { error: string }).error, /brief-too-long/)
})

test('the route refuses a body that is not JSON, and one that is oversized', async () => {
  const { deps } = await taskDeps()
  const broken = fakeResponse()
  await handleTaskCreate(deps, fakeRequest({ body: '{oh no' }), broken.response)
  assert.equal(broken.out.status, 400)
  assert.match(broken.out.body, /invalid-json/)

  // The byte bound is checked BEFORE the parse, so a hostile client cannot make the host
  // buffer without limit.
  const huge = fakeResponse()
  await handleTaskCreate(
    deps,
    fakeRequest({ body: JSON.stringify({ brief: 'x'.repeat(200 * 1024) }) }),
    huge.response,
  )
  assert.equal(huge.out.status, 413)
})

test('the route answers a refusal from the host as a 400 with its own words', async () => {
  const { deps, store } = await taskDeps()
  await store.repos.delete('repo-1')
  const { response, out } = fakeResponse()
  await handleTaskCreate(deps, fakeRequest({ body: JSON.stringify({ brief: 'Do the thing' }) }), response)
  assert.equal(out.status, 400)
  const body = JSON.parse(out.body) as { ok?: boolean; message?: string }
  assert.equal(body.ok, false)
  assert.match(body.message!, /No repository is connected/)
})
