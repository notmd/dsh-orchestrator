/**
 * M0 spike 2 — can a non-`dsh-webhook` caller create a worker Session?
 *
 * **This is a spike, not product code.** It exists to answer two questions that
 * unit tests against fakes cannot (Appendix A §A10 items 2–3):
 *
 *   1. Is `ctx.agents.create()` safe for a caller that is not `dsh-webhook`? The
 *      API is public and `@deepseek-ai/dsh-webhook` is its only shipped caller, so
 *      a hidden ordering requirement would not show up until a real spawn.
 *   2. Does `workspace.attachSession()` tolerate a path that is its own workspace
 *      but sits inside a *different* repository — which is exactly what a per-issue
 *      `git worktree` is?
 *
 * It runs the real recipe from `src/host/spawn.ts` against the real services, then
 * writes the outcome to a JSON file. The file is the point: a host-side process's
 * result is otherwise invisible from outside it, and reading it needs no GUI.
 *
 * Deliberately **not** wired into `src/index.ts`. It is installed by a `--patch`
 * overlay so the spike never becomes part of the shipped plugin.
 *
 * @module dsho/spike/agent-spawn-spike
 */

import { writeFileSync } from 'node:fs'
import { spawnWorker } from '../host/spawn.ts'
import type { SpawnDeps, SpawnedWorker } from '../host/spawn.ts'

export const name = 'agent-spawn-spike'

/** Every service the recipe touches, so a missing one fails loudly at activation. */
export const inject = [
  'agents',
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
  'sessionTitle',
]

const WORKSPACE = '/tmp/dsho-spawn-spike'
const RESULT = '/tmp/dsho-spike-result.json'

interface SpikeContext {
  agents: SpawnDeps['agents']
  agentPresets: SpawnDeps['agentPresets']
  permissionPresets: SpawnDeps['permissionPresets']
  workspaceRegistry: SpawnDeps['workspaceRegistry']
  sessionTitle: SpawnDeps['sessionTitle']
}

/** Accumulates the outcome so a partial failure still says how far it got. */
const trace: Array<{ step: string; at: number; detail?: unknown }> = []

function record(step: string, detail?: unknown): void {
  trace.push({ step, at: Date.now(), ...(detail === undefined ? {} : { detail }) })
  try {
    writeFileSync(RESULT, JSON.stringify({ ok: undefined, steps: trace }, null, 2))
  } catch {
    // The spike must never take the host down over its own bookkeeping.
  }
}

export function apply(ctx: SpikeContext): void {
  void run(ctx)
}

async function run(ctx: SpikeContext): Promise<void> {
  // The prompt is deliberately trivial: the spike cares that a turn *starts*,
  // not what it produces, and a research task would burn real tokens.
  const request = {
    sessionId: `spawn-spike-${Date.now()}`,
    worktreePath: WORKSPACE,
    title: 'spawn-spike: agent.create() from a third-party caller',
    prompt: 'Reply with exactly the word READY and then stop. Do not read or write any files.',
    permissionPreset: 'read-only',
    agentPreset: 'standard',
  }

  record('begin', { sessionId: request.sessionId, workspace: WORKSPACE })

  const deps: SpawnDeps = {
    agents: {
      create: async (options) => {
        record('agents.create:enter', { sessionId: options.sessionId, cwd: options.meta.cwd })
        const handle = await ctx.agents.create(options as never)
        record('agents.create:returned', { status: handle.agent.status })
        return handle as never
      },
    },
    agentPresets: {
      resolve: async (presetName) => {
        const preset = await ctx.agentPresets.resolve(presetName)
        record('agentPresets.resolve', { id: preset.id })
        return preset
      },
      acquireScope: async (id) => {
        const scope = await ctx.agentPresets.acquireScope(id)
        record('agentPresets.acquireScope', { id })
        return scope as never
      },
      mount: async (agentCtx, id) => {
        record('agentPresets.mount:enter', { id })
        await ctx.agentPresets.mount(agentCtx as never, id)
        record('agentPresets.mount:done')
      },
    },
    permissionPresets: {
      resolve: (presetName) => {
        const spec = ctx.permissionPresets.resolve(presetName)
        record('permissionPresets.resolve', { spec: spec === undefined ? null : 'ok' })
        return spec
      },
      set: (session, presetName) => {
        ctx.permissionPresets.set(session as never, presetName)
        record('permissionPresets.set')
      },
    },
    workspaceRegistry: {
      create: async (path, title) => {
        record('workspaceRegistry.create:enter', { path })
        const workspace = await ctx.workspaceRegistry.create(path, title)
        record('workspaceRegistry.create:returned', { realPath: workspace.path })
        return {
          path: workspace.path,
          attachSession: async (sessionId) => {
            record('workspace.attachSession:enter')
            await workspace.attachSession(sessionId as never)
            record('workspace.attachSession:done')
          },
        }
      },
    },
    sessionTitle: {
      rename: (session, title) => {
        ctx.sessionTitle.rename(session as never, title)
        record('sessionTitle.rename', { title })
        return undefined
      },
    },
    userMessage: (text) => ({
      content: [{ type: 'text', text }],
      // `user` is a core source kind. A producer-specific kind would need a
      // package that augments `MessageSourceMap`, which this plugin cannot import
      // — recorded in STATUS.md as an open item.
      source: { kind: 'user' },
    }),
    logger: {
      warn: (message) => record('warn', { message }),
    },
  }

  try {
    const worker: SpawnedWorker = await spawnWorker(deps, request)
    record('spawn:succeeded', { sessionId: worker.sessionId, worktreePath: worker.worktreePath })
    // Hold the lease: the worker outlives this call. Released on unload, which is
    // the lifetime question spike 2 is also meant to settle.
    finish(true, { sessionId: worker.sessionId, worktreePath: worker.worktreePath })
  } catch (error) {
    record('spawn:failed', { message: error instanceof Error ? error.message : String(error) })
    finish(false, { message: error instanceof Error ? error.message : String(error) })
  }
}

function finish(ok: boolean, detail: Record<string, unknown>): void {
  try {
    writeFileSync(RESULT, JSON.stringify({ ok, detail, steps: trace }, null, 2))
  } catch {
    // As above: never take the host down over bookkeeping.
  }
}
