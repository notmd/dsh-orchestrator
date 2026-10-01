/**
 * The host half: activation, registration, disposal, and the config tool.
 *
 * These run against a **fake `ctx`**, which is only possible because
 * `src/host/context.ts` declares the host surface structurally instead of
 * importing cordis. That is the point of it: the plugin's host-plane footprint is
 * one reviewable file, and activation is testable without a live profile.
 *
 * What this suite does *not* prove: that a real host accepts these registrations.
 * Only an install does that. See docs/verification-harness.md.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../../src/index.ts'
import { ConfigError } from '../../src/config/validate.ts'
import {
  REQUESTED_FLOW_FLAGS,
  buildOrchestratorTools,
  connectRepoForTool,
  describeConfig,
} from '../../src/host/tools.ts'
import { compileParameters, defineTool } from '../../src/host/tool.ts'
import type { HostContext } from '../../src/host/context.ts'
import type { ToolDescriptor } from '../../src/host/tool.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { createSpawnDeps } from '../../src/host/spawn-deps.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

/** A `ctx` that records what was registered and honours `effect` disposal. */
function fakeContext(): HostContext & {
  readonly registered: ToolDescriptor<never, unknown>[]
  readonly effects: string[]
  fire(event: string, ...args: unknown[]): void
  disposeAll(): void
} {
  const registered: ToolDescriptor<never, unknown>[] = []
  const effects: string[] = []
  // An event bus, so the protocol-tool restriction is testable at the boundary this
  // plugin controls: what its `agent/created` listener DOES, given a payload.
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const cleanups: Array<() => void> = []
  return {
    // The two services activation now requires. Storage is a real in-memory
    // implementation rather than a stub, so the repo_connect path is exercised
    // against working storage.
    subprocess: {
      spawn() {
        throw new Error('the activation tests do not shell out')
      },
    },
    storageDomain: {
      async open() {
        throw new Error('the activation tests do not open the domain')
      },
    },
    // The spawn recipe's five services. Stubs: these activation tests never spawn.
    agents: {
      get() {
        return undefined
      },
      async create() {
        throw new Error('the activation tests do not spawn')
      },
    },
    agentPresets: {
      async resolve() {
        return { id: 'standard' }
      },
      async acquireScope() {
        return { dispose() {} }
      },
      async mount() {},
    },
    permissionPresets: {
      resolve: () => undefined,
      set() {},
    },
    workspaceRegistry: {
      async create() {
        throw new Error('the activation tests do not spawn')
      },
      async delete() {
        return false
      },
    },
    sessionTitle: {
      rename() {},
    },
    webServer: {
      register() {
        return () => {}
      },
    },
    tools: {
      register(tool) {
        registered.push(tool as ToolDescriptor<never, unknown>)
        return () => {
          const index = registered.indexOf(tool as ToolDescriptor<never, unknown>)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return () => {}
    },
    /** Fire an event, as the host would. */
    fire(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    effect(callback, label) {
      effects.push(label ?? '(unlabelled)')
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {
        for (const fn of cleanups) fn()
      }
    },
    get registered() {
      return registered
    },
    get effects() {
      return effects
    },
    disposeAll() {
      for (const fn of cleanups) fn()
    },
  }
}

test('the plugin declares the services it cannot function without', () => {
  assert.equal(name, 'dsh-orchestrator')
  // Declared because without them the plugin should stay INACTIVE rather than
  // activate and fail at the first tool call. `storageDomain` is the facility
  // itself, which is the direct ctx key -- `ctx.storage.domain` is the same object
  // reached through the form hub.
  assert.deepEqual([...inject], [
    'tools',
    'subprocess',
    'storageDomain',
    // The spawn recipe's five, exactly as dsh-webhook uses them. Verified
    // satisfiable in the web profile: dsh-base enables storage, storage-json,
    // storage-domain, dsh-subprocess-local, and the agent/workspace services.
    'agents',
    'agentPresets',
    'permissionPresets',
    'workspaceRegistry',
    'sessionTitle',
    'webServer',
  ])
})

test('apply registers the orchestrator tools and returns the resolved config', () => {
  const ctx = fakeContext()
  const config = apply(ctx, {})
  assert.equal(ctx.registered.length, 14)
  assert.equal(ctx.registered[0]!.name, 'orchestrator_config')
  assert.equal(ctx.registered[1]!.name, 'orchestrator_repo_connect')
  assert.equal(config.autoReview, true, 'the requested flow is on by default')
})

test('apply owns every registration through ctx.effect, so unload disposes it', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.deepEqual(ctx.effects, ['dsh-orchestrator: orchestrator tools'])
  assert.equal(ctx.registered.length, 14)
  ctx.disposeAll()
  assert.deepEqual(ctx.registered, [], 'the tool is removed on disposal')
})

test('apply validates configuration loudly, before registering anything', () => {
  const ctx = fakeContext()
  assert.throws(
    () => apply(ctx, { planGate: 'whenever' } as never),
    ConfigError,
    'a bad planGate must fail activation',
  )
  assert.deepEqual(ctx.registered, [], 'nothing is registered when config is rejected')
  assert.deepEqual(ctx.effects, [], 'no effect is even opened')
})

test('apply works without a logger', () => {
  // `logger` is optional on the host context; activation must not require it.
  const ctx = fakeContext()
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('describeConfig names the three requested-flow flags and their defaults', () => {
  const config = apply(fakeContext(), {})
  const text = describeConfig(config)
  for (const flag of REQUESTED_FLOW_FLAGS) {
    assert.match(text, new RegExp(`${flag}: true \\(default\\)`), flag)
  }
  assert.match(text, /maxReviewRounds: 3/)
  assert.match(text, /reviewerPermissionPreset: read-only/)
})

test('describeConfig distinguishes an overridden flag from a defaulted one', () => {
  const config = apply(fakeContext(), { autoReview: false, maxConcurrentWorkers: 4 })
  const text = describeConfig(config)
  assert.match(text, /autoReview: false \(overridden\)/)
  assert.match(text, /autoInjectReview: true \(default\)/)
  assert.match(text, /maxConcurrentWorkers: 4/)
})

test('describeConfig explains the divergence, so the gate is never a mystery', () => {
  const text = describeConfig(apply(fakeContext(), {}))
  assert.match(text, /documented divergence/)
  assert.match(text, /Needs human review/)
})

test('describeConfig reports an unconfigured repo and a disabled webhook plainly', () => {
  const text = describeConfig(apply(fakeContext(), {}))
  assert.match(text, /defaultRepo: \(none configured\)/)
  assert.match(text, /webhook: disabled/)
})

test('the tool table stays in step with the tools actually built', () => {
  const tools = buildOrchestratorTools({
    config: apply(fakeContext(), {}),
    run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as RunCommand,
    store: lazyFactStore(async () => createMemoryFactStore()),
    spawn: createSpawnDeps(fakeContext()),
  })
  const names = tools.map((tool) => tool.name)
  assert.deepEqual(names, [
    'orchestrator_config',
    'orchestrator_repo_connect',
    'orchestrator_issue_create',
    'orchestrator_issue_list',
    'orchestrator_issue_update',
    'orchestrator_worker_start',
    'orchestrator_report',
    'orchestrator_task_title',
    'orchestrator_worker_message',
    'orchestrator_worker_stop',
    'orchestrator_review_verdict',
    'orchestrator_review_failed',
    'orchestrator_run_review',
    'orchestrator_board',
  ])
  // Every registered tool must carry a real schema, because the registry feeds it
  // to the model: a tool with empty `parameters` and no schema would be rejected
  // there rather than here.
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`)
  }
})

test('the config tool actually executes and renders text', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const tool = ctx.registered[0]!
  const value = await tool.execute({} as never, {})
  const rendered = tool.output.render({} as never, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0]!.type, 'text')
  assert.match(rendered[0]!.text, /resolved configuration/)
})

// ---------------------------------------------------------------------------
// The tool compiler — the shapes the registry consumes
// ---------------------------------------------------------------------------

test('compileParameters separates required from optional parameters', () => {
  const schema = compileParameters({
    title: { type: 'string', required: true, description: 'Issue title' },
    body: { type: 'string' },
  })
  assert.deepEqual(schema.required, ['title'])
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.title!.type, 'string')
  assert.equal(schema.properties.title!.description, 'Issue title')
})

test('compileParameters carries an enum through', () => {
  const schema = compileParameters({
    priority: { type: 'string', enum: ['high', 'normal', 'low'], required: true },
  })
  assert.deepEqual(schema.properties.priority!.enum, ['high', 'normal', 'low'])
})

test('compileParameters compiles an array of objects, required flags included', () => {
  const schema = compileParameters({
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['artifact', 'pr_created', 'pr_reviewed'], required: true },
          ref: { type: 'string', required: true },
        },
      },
    },
  })
  const items = schema.properties.outputs!.items!
  assert.equal(items.type, 'object')
  assert.deepEqual(items.required, ['kind', 'ref'])
})

test('defineTool rejects a nonsense timeout rather than accepting it', () => {
  const base = {
    name: 't',
    description: 'd',
    parameters: {},
    execute: () => 'ok',
  } as const
  assert.throws(() => defineTool({ ...base, timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => defineTool({ ...base, timeoutMs: -1 }), /timeoutMs/)
  assert.throws(() => defineTool({ ...base, timeoutMs: Number.POSITIVE_INFINITY }), /timeoutMs/)
  assert.equal(defineTool({ ...base, timeoutMs: 1_000 }).timeoutMs, 1_000)
})

test('defineTool defaults its renderer to indented JSON', async () => {
  const tool = defineTool({
    name: 't',
    description: 'd',
    parameters: {},
    execute: () => ({ a: 1 }),
  })
  const rendered = tool.output.render({} as never, await tool.execute({} as never, {}))
  assert.equal(rendered[0]!.text, '{\n  "a": 1\n}')
})

// ---------------------------------------------------------------------------
// orchestrator_repo_connect
// ---------------------------------------------------------------------------

/** A preflight that succeeds, so the tool's own logic is what is under test. */
const passingRun: RunCommand = async (argv) => {
  const joined = argv.join(' ')
  if (joined.startsWith('git rev-parse')) return { exitCode: 0, stdout: 'true\n', stderr: '' }
  if (joined.startsWith('git check-ignore')) return { exitCode: 0, stdout: '', stderr: '' }
  if (joined.startsWith('gh auth status')) return { exitCode: 0, stdout: '', stderr: '' }
  if (joined.startsWith('gh repo view')) {
    return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }), stderr: '' }
  }
  return { exitCode: 1, stdout: '', stderr: `unexpected: ${joined}` }
}

const REPO_PATH = '/Users/me/code/myrepo'

function toolOptions(overrides: { run?: RunCommand; store?: ReturnType<typeof lazyFactStore>; defaultRepo?: string } = {}) {
  return {
    config: apply(fakeContext(), { defaultRepo: overrides.defaultRepo ?? '' }),
    run: overrides.run ?? passingRun,
    store: overrides.store ?? lazyFactStore(async () => createMemoryFactStore()),
  }
}

test('repo_connect: a missing path and no defaultRepo says exactly that', async () => {
  const text = await connectRepoForTool(toolOptions(), {})
  assert.match(text, /No repository path given/)
  assert.match(text, /defaultRepo/)
})

test('repo_connect: the path comes from the argument, or from defaultRepo', async () => {
  const fromArg = await connectRepoForTool(toolOptions(), { path: REPO_PATH })
  assert.match(fromArg, /Connected acme\/widgets/)
  const fromConfig = await connectRepoForTool(toolOptions({ defaultRepo: REPO_PATH }), {})
  assert.match(fromConfig, /Connected acme\/widgets/)
})

test('repo_connect: a successful connection persists the record', async () => {
  const store = lazyFactStore(async () => createMemoryFactStore())
  await connectRepoForTool(toolOptions({ store }), { path: REPO_PATH })
  const records = await (await store.get()).repos.list()
  assert.equal(records.length, 1)
  assert.equal((records[0] as { rootPath: string }).rootPath, REPO_PATH)
})

test('repo_connect: reconnecting the same checkout is idempotent', async () => {
  // Otherwise every call mints a new repo id and orphans the issues pointing at
  // the old one.
  const store = lazyFactStore(async () => createMemoryFactStore())
  const options = toolOptions({ store })
  const first = await connectRepoForTool(options, { path: REPO_PATH })
  const second = await connectRepoForTool(options, { path: REPO_PATH })
  const records = await (await store.get()).repos.list()
  assert.equal(records.length, 1, 'one record, not two')
  const idOf = (text: string) => /id: (\S+)/.exec(text)?.[1]
  assert.equal(idOf(first), idOf(second), 'the same id is reused')
})

test('repo_connect: a different checkout gets its own record', async () => {
  const store = lazyFactStore(async () => createMemoryFactStore())
  const options = toolOptions({ store })
  await connectRepoForTool(options, { path: REPO_PATH })
  await connectRepoForTool(options, { path: '/Users/me/code/other' })
  assert.equal((await (await store.get()).repos.list()).length, 2)
})

test('repo_connect: a refused preflight persists nothing', async () => {
  const store = lazyFactStore(async () => createMemoryFactStore())
  const refusing: RunCommand = async () => ({ exitCode: 0, stdout: 'false\n', stderr: '' })
  const text = await connectRepoForTool(toolOptions({ store, run: refusing }), { path: REPO_PATH })
  assert.match(text, /Repository not connected/)
  assert.match(text, /not inside a git work tree/)
  assert.deepEqual(await (await store.get()).repos.list(), [])
})

test('repo_connect: a storage failure is reported, not swallowed', async () => {
  // A silent failure here would look like a successful registration.
  const broken = lazyFactStore(async () => {
    throw new Error('backend offline')
  })
  const text = await connectRepoForTool(toolOptions({ store: broken }), { path: REPO_PATH })
  assert.match(text, /could not open its storage/)
  assert.match(text, /backend offline/)
})

test('the lazy store retries after a failed open rather than poisoning the plugin', async () => {
  // A transient backend problem must not disable the plugin permanently, which is
  // what a cached rejection would do.
  let attempts = 0
  const store = lazyFactStore(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('transient')
    return createMemoryFactStore()
  })
  await assert.rejects(() => store.get(), /transient/)
  const opened = await store.get()
  assert.equal(attempts, 2)
  assert.equal(store.opened, true)
  await opened.repos.put('repo-1', { rootPath: REPO_PATH })
  assert.equal((await opened.repos.list()).length, 1)
})

test('the lazy store does not open on close if it was never used', async () => {
  let opened = 0
  const store = lazyFactStore(async () => {
    opened += 1
    return createMemoryFactStore()
  })
  await store.close()
  assert.equal(opened, 0, 'unload must not cause an open')
  assert.equal(store.opened, false)
})

// ---------------------------------------------------------------------------
// The issue tools
// ---------------------------------------------------------------------------

import {
  assignWorkerForTool,
  createIssueForTool,
  listIssuesForTool,
  updateIssueForTool,
} from '../../src/host/issues-service.ts'

/** A store with `count` connected repositories, ids `repo-1`, `repo-2`, … */
async function issueDeps(count = 1) {
  const store = createMemoryFactStore()
  for (let index = 1; index <= count; index += 1) {
    await store.repos.put(`repo-${index}`, { id: `repo-${index}`, rootPath: `/repos/r${index}` })
  }
  return { store: lazyFactStore(async () => store), raw: store }
}

test('issue_create: with no repository connected it says what to do first', async () => {
  const deps = await issueDeps(0)
  const text = await createIssueForTool(deps, { title: 'Fix the flaky auth test' })
  assert.match(text, /No repository is connected/)
  assert.match(text, /orchestrator_repo_connect/)
})

test('issue_create: with one repository it infers the repo, so a plain request works', async () => {
  // The PRD's flow is "create an issue to fix X" -- no repository in it at all.
  const deps = await issueDeps(1)
  const text = await createIssueForTool(deps, { title: 'Fix the flaky auth test' })
  assert.match(text, /Created iss-/)
  assert.match(text, /repo-1/)
  assert.match(text, /queued in `open`/)
  const stored = await deps.raw.issues.list()
  assert.equal(stored.length, 1)
  assert.equal((stored[0] as { title: string }).title, 'Fix the flaky auth test')
})

test('issue_create: with several repositories it asks rather than guessing', async () => {
  // Picking the wrong repository silently is how an issue ends up on the wrong board.
  const deps = await issueDeps(2)
  const text = await createIssueForTool(deps, { title: 'Fix it' })
  assert.match(text, /needs an explicit `repoId`/)
  assert.match(text, /repo-1, repo-2/)
  assert.deepEqual(await deps.raw.issues.list(), [])
})

test('issue_create: an explicit repoId may be an id or a path', async () => {
  const deps = await issueDeps(2)
  const byId = await createIssueForTool(deps, { title: 'One', repoId: 'repo-2' })
  assert.match(byId, /repo-2/)
  const byPath = await createIssueForTool(deps, { title: 'Two', repoId: '/repos/r1' })
  assert.match(byPath, /repo-1/)
  const unknown = await createIssueForTool(deps, { title: 'Three', repoId: 'nope' })
  assert.match(unknown, /No connected repository matches/)
})

test('issue_create: an unusable issue is refused before anything is stored', async () => {
  const deps = await issueDeps(1)
  const empty = await createIssueForTool(deps, { title: '   ' })
  assert.match(empty, /Could not create the issue/)
  assert.match(empty, /must not be empty/)
  const badPriority = await createIssueForTool(deps, { title: 'ok', priority: 'urgent' as never })
  assert.match(badPriority, /must be one of high \| normal \| low/)
  assert.deepEqual(await deps.raw.issues.list(), [], 'nothing was persisted')
})

test('issue_create: labels are trimmed and de-duplicated', async () => {
  const deps = await issueDeps(1)
  await createIssueForTool(deps, { title: 'Fix it', labels: [' bug ', 'bug', '', 'ci'] })
  const [stored] = await deps.raw.issues.list()
  assert.deepEqual((stored as { labels: string[] }).labels, ['bug', 'ci'])
})

test('issue_list: empty, filtered, and in queue order', async () => {
  const deps = await issueDeps(1)
  assert.match(await listIssuesForTool(deps), /No issues yet/)

  await createIssueForTool(deps, { title: 'Low', priority: 'low' })
  await createIssueForTool(deps, { title: 'High', priority: 'high' })
  await createIssueForTool(deps, { title: 'Normal', priority: 'normal' })

  const all = await listIssuesForTool(deps)
  assert.match(all, /3 issue\(s\)/)
  // Queue order: high first, then normal, then low.
  assert.ok(all.indexOf('High') < all.indexOf('Normal'), 'high before normal')
  assert.ok(all.indexOf('Normal') < all.indexOf('Low'), 'normal before low')

  const highs = await listIssuesForTool(deps, { state: 'open' })
  assert.match(highs, /3 issue\(s\)/)
  assert.match(await listIssuesForTool(deps, { repoId: 'other' }), /No issues match those filters/)
})

test('issue_list: among equal priority the oldest is first, so nothing starves', async () => {
  const raw = createMemoryFactStore()
  await raw.repos.put('repo-1', { id: 'repo-1', rootPath: '/repos/r1' })
  const deps = { store: lazyFactStore(async () => raw) }
  await createIssueForTool(deps, { title: 'First' })
  await createIssueForTool(deps, { title: 'Second' })
  const text = await listIssuesForTool(deps)
  assert.ok(text.indexOf('First') < text.indexOf('Second'))
})

test('issue_update: an unknown id lists what does exist', async () => {
  const deps = await issueDeps(1)
  assert.match(await updateIssueForTool(deps, { id: 'iss-nope' }), /No issue with id/)
  const created = await createIssueForTool(deps, { title: 'Fix it' })
  const id = /Created (\S+)/.exec(created)![1]!
  const text = await updateIssueForTool(deps, { id: 'iss-nope' })
  assert.match(text, new RegExp(id), 'the known ids are listed')
})

test('issue_update: re-sending the current values is a no-op and does not move the queue', async () => {
  // `updatedAt` must not move: a caller re-sending current values must not make the
  // issue look freshly touched.
  const deps = await issueDeps(1)
  const created = await createIssueForTool(deps, { title: 'Fix it', priority: 'high' })
  const id = /Created (\S+)/.exec(created)![1]!
  const before = (await deps.raw.issues.get(id)) as { updatedAt: number }
  const text = await updateIssueForTool(deps, { id, title: 'Fix it', priority: 'high' })
  assert.match(text, /No change to/)
  const after = (await deps.raw.issues.get(id)) as { updatedAt: number }
  assert.equal(after.updatedAt, before.updatedAt)
})

test('issue_update: a real change is persisted and reported', async () => {
  const deps = await issueDeps(1)
  const created = await createIssueForTool(deps, { title: 'Fix it' })
  const id = /Created (\S+)/.exec(created)![1]!
  const text = await updateIssueForTool(deps, { id, title: 'Fix it properly', state: 'done' })
  assert.match(text, /Updated/)
  assert.match(text, /Fix it properly/)
  const stored = (await deps.raw.issues.get(id)) as { title: string; state: string }
  assert.equal(stored.title, 'Fix it properly')
  assert.equal(stored.state, 'done')
})

test('issue_update: a bad state or priority is refused, leaving the issue alone', async () => {
  const deps = await issueDeps(1)
  const created = await createIssueForTool(deps, { title: 'Fix it' })
  const id = /Created (\S+)/.exec(created)![1]!
  assert.match(await updateIssueForTool(deps, { id, state: 'nonsense' as never }), /Could not update/)
  assert.equal(((await deps.raw.issues.get(id)) as { state: string }).state, 'open')
})

test('A2 support: at most one active worker per issue', async () => {
  // Two workers on one issue would mean two branches, two PRs, and no rule for
  // which one a card follows.
  const deps = await issueDeps(1)
  const created = await createIssueForTool(deps, { title: 'Fix it' })
  const id = /Created (\S+)/.exec(created)![1]!
  assert.match(await assignWorkerForTool(deps, { id, workerId: 'wrk-1' }), /now worked by wrk-1/)
  assert.match(await assignWorkerForTool(deps, { id, workerId: 'wrk-2' }), /already has worker wrk-1/)
  // Re-assigning the same worker is idempotent rather than an error.
  assert.match(await assignWorkerForTool(deps, { id, workerId: 'wrk-1' }), /now worked by wrk-1/)
  assert.equal(((await deps.raw.issues.get(id)) as { state: string }).state, 'in_progress')
})

test('issue tools report a storage failure instead of pretending to work', async () => {
  const broken = lazyFactStore(async () => {
    throw new Error('backend offline')
  })
  for (const text of [
    await createIssueForTool({ store: broken }, { title: 'x' }),
    await listIssuesForTool({ store: broken }),
    await updateIssueForTool({ store: broken }, { id: 'iss-1' }),
  ]) {
    assert.match(text, /could not open its storage/)
    assert.match(text, /backend offline/)
  }
})

// ---------------------------------------------------------------------------
// orchestrator_worker_start
// ---------------------------------------------------------------------------

import { startWorkerForTool } from '../../src/host/workers-service.ts'
import type { SpawnDeps } from '../../src/host/spawn.ts'

/** A git that answers the worktree calls, recording argv. */
function worktreeGit(): { run: RunCommand; readonly calls: string[][]; setAddFails(e: Error): void } {
  const calls: string[][] = []
  let addError: Error | undefined
  // Stateful, because git is: `worktree add` changes what `worktree list` reports.
  // A fake that always reported an empty list would make `remove` a silent no-op
  // and hide a missing cleanup -- which is exactly what it did the first time.
  const existing = new Map<string, string>()
  const run: RunCommand = async (argv) => {
    calls.push([...argv])
    const joined = argv.join(' ')
    if (joined.startsWith('git worktree list')) {
      const stdout = [...existing]
        .map(([path, branch]) => `worktree ${path}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/${branch}\n`)
        .join('\n')
      return { exitCode: 0, stdout, stderr: '' }
    }
    if (joined.startsWith('git show-ref')) return { exitCode: 1, stdout: '', stderr: '' }
    if (joined.startsWith('git worktree add')) {
      if (addError) return { exitCode: 1, stdout: '', stderr: addError.message }
      const withBranch = argv[3] === '-b'
      const path = withBranch ? argv[5]! : argv[3]!
      existing.set(path, withBranch ? argv[4]! : argv[4]!)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (joined.startsWith('git worktree remove')) {
      existing.delete(argv[argv.length - 1]!)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return {
    run,
    get calls() {
      return calls
    },
    setAddFails(error) {
      addError = error
    },
  }
}

/** A spawn recipe that records its request and returns a handle, or throws. */
function fakeSpawn(): {
  deps: SpawnDeps
  /** Recorded on create: the identity and the cwd the session was actually given. */
  readonly requests: Array<{ sessionId: string; worktreePath: string }>
  /** Recorded on rename: the session title. */
  readonly titles: string[]
  /** Recorded on followup: the admitted messages. */
  readonly prompted: Array<{ content: Array<{ text: string }> }>
  /** The admitted prompt as one string. */
  prompt(index?: number): string
  setFails(e: Error): void
} {
  const requests: Array<{ sessionId: string; worktreePath: string }> = []
  const titles: string[] = []
  const prompted: Array<{ content: Array<{ text: string }> }> = []
  let failure: Error | undefined
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
    sessionTitle: {
      rename(_session, title) {
        titles.push(title)
      },
    },
    agents: {
      async create(options) {
        if (failure) throw failure
        // The recipe calls create with `meta.cwd`, so this is what the session was
        // actually pointed at -- the property under test, not the hoped-for path.
        requests.push({ sessionId: options.sessionId, worktreePath: options.meta.cwd })
        const handle = {
          agent: {
            session: { id: options.sessionId },
            followup(message: { content: Array<{ text: string }> }) {
              prompted.push(message)
            },
          },
          async dispose() {},
        }
        return handle
      },
    },
    userMessage: (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
  return {
    deps,
    requests,
    titles,
    prompted,
    prompt(index = 0) {
      return prompted[index]?.content.map((block) => block.text).join('\n') ?? ''
    },
    setFails(error) {
      failure = error
    },
  }
}

async function workerDeps() {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', {
    id: 'repo-1',
    rootPath: '/repos/r1',
    defaultBranch: 'main',
    verifyCommands: ['pnpm test'],
  })
  const git = worktreeGit()
  const spawn = fakeSpawn()
  const lazy = lazyFactStore(async () => store)
  const deps = {
    store: lazy,
    run: git.run,
    spawn: spawn.deps,
    config: apply(fakeContext(), {}),
  }
  const created = await createIssueForTool({ store: lazy }, { title: 'Fix the flaky auth test' })
  const issueId = /Created (\S+)/.exec(created)![1]!
  return { deps, store, git, spawn, issueId }
}

test('worker_start: creates a worktree, spawns a session, binds the two', async () => {
  const { deps, store, git, spawn, issueId } = await workerDeps()
  const text = await startWorkerForTool(deps, { issueId })

  assert.match(text, /Started wrk-/)
  assert.match(text, new RegExp(`on ${issueId}`))
  // A2: the session is titled `#<n> <title>`.
  assert.match(text, /title:\s+#1 Fix the flaky auth test/)
  // PRD 7.3: the branch carries the issue number and a slug of the title.
  assert.match(text, /dsho\/issue-1-fix-the-flaky-auth-test/)

  // The worktree was created before the session, because the session's cwd must
  // point at it.
  const addIndex = git.calls.findIndex((argv) => argv.includes('worktree') && argv.includes('add'))
  assert.ok(addIndex >= 0, 'worktree add was called')
  assert.equal(spawn.requests.length, 1)
  assert.deepEqual(spawn.titles, ['#1 Fix the flaky auth test'])
  // The session was pointed at the worktree that was just created -- the whole
  // reason the worktree comes first.
  assert.equal(
    spawn.requests[0]!.worktreePath,
    '/repos/r1/.dsho/worktrees/issue-1-fix-the-flaky-auth-test',
  )
  // The contract is in the admitted prompt, not only in a system section.
  assert.match(spawn.prompt(), /You are an implementation worker/)
  assert.match(spawn.prompt(), /Issue context \(untrusted\)/)
  assert.equal(spawn.prompted.length, 1, 'the worker was woken exactly once')

  const worker = (await store.workers.list())[0] as { issueId: string; phase: string; branch: string }
  assert.equal(worker.issueId, issueId)
  assert.equal(worker.phase, 'queued')
  assert.equal(worker.branch, 'dsho/issue-1-fix-the-flaky-auth-test')
  const issue = (await store.issues.get(issueId)) as { workerId?: string; state: string }
  assert.ok(issue.workerId, 'the issue records its worker')
  assert.equal(issue.state, 'in_progress')
})

test('worker_start: one issue has one worker at a time', async () => {
  const { deps, issueId } = await workerDeps()
  await startWorkerForTool(deps, { issueId })
  const second = await startWorkerForTool(deps, { issueId })
  assert.match(second, /already worked by/)
  assert.match(second, /one issue has one worker at a time/)
})

test('worker_start: a finished or cancelled issue is refused', async () => {
  const { deps, store, issueId } = await workerDeps()
  await updateIssueForTool({ store: deps.store }, { id: issueId, state: 'cancelled' })
  const text = await startWorkerForTool(deps, { issueId })
  assert.match(text, /is cancelled, so there is nothing to work/)
})

test('worker_start: an ad-hoc title creates the issue first, so there is one path after', async () => {
  const { deps, store } = await workerDeps()
  const text = await startWorkerForTool(deps, { title: 'Investigate the flaky test', description: 'It fails 1 in 5.' })
  assert.match(text, /Started wrk-/)
  assert.match(text, /title:\s+#2 Investigate the flaky test/)
  const issues = await store.issues.list()
  assert.equal(issues.length, 2, 'the issue was created and then worked')
})

test('worker_start: neither an issueId nor a title says what to pass', async () => {
  const { deps } = await workerDeps()
  assert.match(await startWorkerForTool(deps, {}), /either an `issueId` to work, or a `title`/)
})

test('worker_start: an unknown issue lists what exists', async () => {
  const { deps, issueId } = await workerDeps()
  const text = await startWorkerForTool(deps, { issueId: 'iss-nope' })
  assert.match(text, /No issue with id/)
  assert.match(text, new RegExp(issueId))
})

test('worker_start: an issue whose repository is not connected is refused', async () => {
  const { deps, store, issueId } = await workerDeps()
  await store.repos.delete('repo-1')
  assert.match(await startWorkerForTool(deps, { issueId }), /is not connected/)
})

test('worker_start: a failed spawn removes the worktree it just made', async () => {
  // Without this, every failed spawn strands a full working tree, and R4's disk
  // bound is only enforced by cleanup that never runs.
  const { deps, store, git, spawn, issueId } = await workerDeps()
  spawn.setFails(new Error('model unavailable'))
  const text = await startWorkerForTool(deps, { issueId })

  assert.match(text, /Could not start a worker/)
  assert.match(text, /model unavailable/)
  assert.match(text, /was removed, so nothing was left behind/)
  assert.ok(
    git.calls.some((argv) => argv.includes('remove') && argv.includes('--force')),
    'the worktree was force-removed',
  )
  assert.deepEqual(await store.workers.list(), [], 'no worker was recorded')
  assert.equal(
    ((await store.issues.get(issueId)) as { workerId?: string }).workerId,
    undefined,
    'the issue was not bound',
  )
})

test('worker_start: a failed worktree creation never reaches the spawn', async () => {
  const { deps, git, spawn, issueId } = await workerDeps()
  git.setAddFails(new Error('fatal: invalid reference'))
  const text = await startWorkerForTool(deps, { issueId })
  assert.match(text, /Could not create a worktree/)
  assert.equal(spawn.requests.length, 0, 'no session was created')
})

test('worker_start: verify commands reach the worker', async () => {
  const { deps, spawn, issueId } = await workerDeps()
  await startWorkerForTool(deps, { issueId })
  assert.match(spawn.prompt(), /pnpm test/)
})


// ---------------------------------------------------------------------------
// Worktree cleanup on release (R4)
// ---------------------------------------------------------------------------

import { cleanupReleasedWorktrees } from '../../src/host/worktree-cleanup.ts'

/** A store with a worker whose worktree the (stateful) fake git knows about. */
async function releaseable() {
  const store = createMemoryFactStore()
  const git = worktreeGit()
  const path = '/repos/r1/.dsho/worktrees/issue-1-x'
  // Teach the fake, the way `worktree add` would.
  await git.run(['git', 'worktree', 'add', '-b', 'dsho/issue-1-x', path])
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/repos/r1' })
  await store.issues.put('iss-1', {
    id: 'iss-1', number: 1, repoId: 'repo-1', title: 'Task', state: 'in_progress',
    workerId: 'wrk-1', createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 'dsho-wrk-1', branch: 'dsho/issue-1-x',
    worktreePath: path, workspaceId: 'w', phase: 'merge_ready', phaseHistory: [],
    lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  return { store, git, path, deps: { store: lazyFactStore(async () => store), run: git.run } }
}

test('R4: marking an issue done removes its worktree, and says so', async () => {
  const { deps, git, path } = await releaseable()
  const text = await updateIssueForTool(deps, { id: 'iss-1', state: 'done' })

  assert.match(text, /Updated iss-1/)
  assert.match(text, /Removed the worktree at/)
  assert.ok(
    git.calls.some((argv) => argv.includes('remove') && argv.includes(path)),
    'the worktree was actually removed',
  )
})

test('R4: cancelling an issue removes its worktree too', async () => {
  const { deps, git } = await releaseable()
  await updateIssueForTool(deps, { id: 'iss-1', state: 'cancelled' })
  assert.ok(git.calls.some((argv) => argv.includes('remove')))
})

test('a still-open issue keeps its worktree', async () => {
  const { deps, git } = await releaseable()
  await updateIssueForTool(deps, { id: 'iss-1', priority: 'high' })
  assert.ok(!git.calls.some((argv) => argv.includes('remove')), 'nothing was removed')
})

test('a FAILED removal leaves the archive standing and reports why', async () => {
  // The archive is what the user asked for; a git failure while cleaning up must not
  // undo it -- nor hide it, which is why the reason comes back in the reply.
  const { store, path, deps, git } = await releaseable()
  // Delegates to the stateful fake for everything except `remove`, so the worktree
  // still APPEARS in `worktree list` and the removal is genuinely attempted. A fake
  // that reported an empty list would make the removal a no-op and the test would
  // pass for the wrong reason -- which is exactly what happened on the first try.
  const failing = {
    ...deps,
    run: (async (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      if (argv.includes('remove')) return { exitCode: 128, stdout: '', stderr: 'fatal: not a working tree' }
      return git.run(argv, options)
    }) as RunCommand,
  }
  const text = await updateIssueForTool(failing, { id: 'iss-1', state: 'done' })

  assert.match(text, /Updated iss-1/)
  assert.match(text, /left in place/)
  assert.match(text, /not a working tree/)
  assert.equal(((await store.issues.get('iss-1')) as { state: string }).state, 'done', 'the archive stands')
  assert.ok(path.length > 0)
})

test('a released issue with no worktree says so rather than pretending', async () => {
  const { store, deps } = await releaseable()
  const worker = (await store.workers.get('wrk-1')) as Record<string, unknown>
  delete worker.worktreePath
  await store.workers.put('wrk-1', worker)
  const text = await updateIssueForTool(deps, { id: 'iss-1', state: 'done' })
  assert.match(text, /No worktree needed removing|left in place/)
})

test('cleanupReleasedWorktrees only touches released issues, and is idempotent', async () => {
  const { deps, git, store } = await releaseable()
  assert.deepEqual(await cleanupReleasedWorktrees(deps), [], 'an in-progress issue keeps its tree')

  await updateIssueForTool(deps, { id: 'iss-1', state: 'done' })
  const second = await cleanupReleasedWorktrees(deps)
  assert.equal(second.length, 1, 'the sweep now considers it')
  assert.equal(second[0]!.removed, false, 'and finds nothing left to remove')
  assert.ok(store !== undefined && git.calls.length > 0)
})

test('cleanup contains a storage failure instead of throwing', async () => {
  const outcomes = await cleanupReleasedWorktrees({
    store: lazyFactStore(async () => {
      throw new Error('backend offline')
    }),
    run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as RunCommand,
  })
  assert.deepEqual(outcomes, [])
})


// ---------------------------------------------------------------------------
// Restriction lists (PRD §12.2)
// ---------------------------------------------------------------------------

import {
  ORCHESTRATOR_TOOL_NAMES,
  REVIEWER_TOOLS,
  USER_TOOLS,
  WORKER_TOOLS,
  restrictionFor,
  sessionKind,
} from '../../src/host/tools.ts'

test('the tool-name constant is in step with the tools actually built', () => {
  // The constant exists because `restrictionFor` must answer before anything is
  // built, and a deny-list that has drifted would silently stop protecting.
  const built = buildOrchestratorTools({
    config: apply(fakeContext(), {}),
    run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as RunCommand,
    store: lazyFactStore(async () => createMemoryFactStore()),
    spawn: createSpawnDeps(fakeContext()),
  }).map((tool) => tool.name)
  assert.deepEqual([...built].sort(), [...ORCHESTRATOR_TOOL_NAMES].sort())
})

test('the three groups partition the tools, with no overlap', () => {
  assert.equal(USER_TOOLS.length + WORKER_TOOLS.length + REVIEWER_TOOLS.length, ORCHESTRATOR_TOOL_NAMES.length)
  for (const name of WORKER_TOOLS) assert.ok(!USER_TOOLS.includes(name), name)
  for (const name of REVIEWER_TOOLS) assert.ok(!USER_TOOLS.includes(name), name)
})

test('a session id the plugin did not mint is `other`, which is the safe default', () => {
  // An unrecognised session keeps its normal tools and is denied only the protocol
  // tools. Guessing `worker` would hand a stranger the ability to report.
  assert.equal(sessionKind('dsho-wrk-01ABC'), 'worker')
  assert.equal(sessionKind('dsho-rev-01ABC'), 'reviewer')
  assert.equal(sessionKind('session-4f012493'), 'other')
  assert.equal(sessionKind(''), 'other')
  assert.equal(sessionKind(undefined), 'other')
  assert.equal(sessionKind('dsho-wrk'), 'other', 'the full prefix is required')
})

test('restriction is a DENY list, never an allow list', () => {
  // `allow` means keep only, so an allow-list for a worker would strip read, bash and
  // edit -- every tool the worker needs. The filter shape is asserted directly.
  for (const kind of ['worker', 'reviewer', 'other'] as const) {
    const filter = restrictionFor(kind)
    assert.deepEqual(Object.keys(filter), ['deny'])
    assert.ok(filter.deny.length > 0)
  }
})

test('each kind is denied the other kinds\' protocol tools, and nothing more', () => {
  const worker = restrictionFor('worker').deny
  assert.ok(!worker.includes('orchestrator_report'), 'a worker keeps its own protocol tool')
  for (const tool of REVIEWER_TOOLS) assert.ok(worker.includes(tool), tool)
  for (const tool of USER_TOOLS) assert.ok(worker.includes(tool), tool)

  const reviewer = restrictionFor('reviewer').deny
  assert.ok(!reviewer.includes('orchestrator_review_verdict'), 'a reviewer keeps its own')
  for (const tool of WORKER_TOOLS) assert.ok(reviewer.includes(tool), tool)

  const other = restrictionFor('other').deny
  assert.deepEqual([...other].sort(), [...WORKER_TOOLS, ...REVIEWER_TOOLS].sort())
  assert.ok(!other.includes('orchestrator_issue_create'), 'a user session keeps the orchestrator surface')
})

test('no restriction ever denies an ordinary tool', () => {
  // The catastrophic failure this guards: a deny-list that accidentally covered the
  // shared surface would leave a worker unable to read or edit.
  for (const kind of ['worker', 'reviewer', 'other'] as const) {
    for (const name of restrictionFor(kind).deny) {
      assert.ok(ORCHESTRATOR_TOOL_NAMES.includes(name), `${name} is not one of ours`)
    }
  }
})


// ---------------------------------------------------------------------------
// The protocol-tool restriction's WIRING (PRD §12.2)
// ---------------------------------------------------------------------------

/** A fake agent, whose scoped tool runtime records what it was asked to restrict. */
function fakeAgent(sessionId: string | undefined) {
  const applied: Array<{ deny: string[] }> = []
  const rootApplied: Array<{ deny: string[] }> = []
  const agent = {
    session: sessionId === undefined ? undefined : { id: sessionId },
    ctx: {
      tools: { restrict: (filter: { deny: string[] }) => { applied.push(filter); return () => {} } },
      effect: (cb: () => (() => void) | void) => { cb(); return () => {} },
    },
  }
  return { agent, applied, rootApplied }
}

test('§12.2: the listener reads the payload\'s agent, and denies by session kind', () => {
  // The bug this guards: the payload is `{ agent, source, signal }` and the listener read
  // it AS the agent, so every session arrived with `session: undefined`, was classified
  // `other`, and the deny-list was applied to nothing -- silently. Reading the wrong
  // object does not throw.
  const ctx = fakeContext()
  apply(ctx as never, {})

  const worker = fakeAgent('dsho-wrk-01ABC')
  ctx.fire('agent/created', { agent: worker.agent, source: { kind: 'user' } })
  assert.equal(worker.applied.length, 1, 'the worker was restricted exactly once')
  assert.ok(!worker.applied[0]!.deny.includes('orchestrator_report'), 'a worker keeps its own protocol tool')
  assert.ok(worker.applied[0]!.deny.includes('orchestrator_issue_create'), 'and loses the orchestrator surface')

  const reviewer = fakeAgent('dsho-rev-01ABC')
  ctx.fire('agent/created', { agent: reviewer.agent, source: {} })
  assert.ok(!reviewer.applied[0]!.deny.includes('orchestrator_review_verdict'), 'a reviewer keeps its own')
  assert.ok(reviewer.applied[0]!.deny.includes('orchestrator_report'))

  const user = fakeAgent('session-4f012493')
  ctx.fire('agent/created', { agent: user.agent, source: {} })
  assert.ok(user.applied[0]!.deny.includes('orchestrator_report'), 'a user session loses the protocol tools')
  assert.ok(!user.applied[0]!.deny.includes('orchestrator_issue_create'), 'and keeps the orchestrator surface')
})

test('§12.2: the restriction goes on the AGENT\'s ctx, never the root one', () => {
  // The catastrophic failure: `restrict` on a plain context is GLOBAL, so a worker's
  // restriction applied there would strip tools from every session including the user's.
  // Asserted by construction -- the fake root ctx exposes no `tools` at all, so a
  // fallback to it would throw rather than silently over-restrict.
  const ctx = fakeContext()
  assert.notEqual(
    typeof (ctx as { tools?: { restrict?: unknown } }).tools?.restrict,
    'function',
    'the root registry has no restrict, so a fallback to it would THROW rather than silently over-restrict',
  )
  assert.doesNotThrow(() => {
    apply(ctx as never, {})
    ctx.fire('agent/created', { agent: fakeAgent('dsho-wrk-01ABC').agent, source: {} })
  })
})

test('§12.2: a malformed payload restricts nothing and does not throw', () => {
  // Defensive rather than theoretical: the listener runs on every session creation, and a
  // throw there would take down whatever created the session.
  const ctx = fakeContext()
  apply(ctx as never, {})
  for (const payload of [undefined, null, {}, { agent: undefined }, { agent: {} }, 'nonsense']) {
    assert.doesNotThrow(() => ctx.fire('agent/created', payload), `payload ${JSON.stringify(payload)}`)
  }
})

test('§12.2: with no event bus the plugin still activates', () => {
  // A host without `on` must leave the plugin working, logged but not broken -- the same
  // fail-safe posture as the client half's locale read.
  const ctx = fakeContext()
  delete (ctx as { on?: unknown }).on
  assert.doesNotThrow(() => apply(ctx as never, {}))
  assert.ok(ctx.registered.length > 0, 'the tools are still registered')
})
