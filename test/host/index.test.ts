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
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

/** A `ctx` that records what was registered and honours `effect` disposal. */
function fakeContext(): HostContext & {
  readonly registered: ToolDescriptor<never, unknown>[]
  readonly effects: string[]
  disposeAll(): void
} {
  const registered: ToolDescriptor<never, unknown>[] = []
  const effects: string[] = []
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
    tools: {
      register(tool) {
        registered.push(tool as ToolDescriptor<never, unknown>)
        return () => {
          const index = registered.indexOf(tool as ToolDescriptor<never, unknown>)
          if (index >= 0) registered.splice(index, 1)
        }
      },
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
  assert.deepEqual([...inject], ['tools', 'subprocess', 'storageDomain'])
})

test('apply registers the orchestrator tools and returns the resolved config', () => {
  const ctx = fakeContext()
  const config = apply(ctx, {})
  assert.equal(ctx.registered.length, 2)
  assert.equal(ctx.registered[0]!.name, 'orchestrator_config')
  assert.equal(ctx.registered[1]!.name, 'orchestrator_repo_connect')
  assert.equal(config.autoReview, true, 'the requested flow is on by default')
})

test('apply owns every registration through ctx.effect, so unload disposes it', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.deepEqual(ctx.effects, ['dsh-orchestrator: orchestrator tools'])
  assert.equal(ctx.registered.length, 2)
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
  })
  const names = tools.map((tool) => tool.name)
  assert.deepEqual(names, ['orchestrator_config', 'orchestrator_repo_connect'])
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
