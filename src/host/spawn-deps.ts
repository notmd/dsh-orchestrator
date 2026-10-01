/**
 * Adapts the host context to the spawn recipe's dependencies.
 *
 * `./spawn.ts` takes its dependencies as a parameter so the recipe is testable
 * without a host. This is the other half: the single place that binds them to the
 * real services, so the binding is reviewable rather than spread through the entry.
 *
 * The five services are the ones `dsh-webhook` uses for exactly this job, and the
 * shapes here are transcribed from its `session.ts`. They are declared structurally
 * because the package installs as a symlink and cannot resolve `@deepseek-ai/*`
 * (see `./tool.ts`).
 *
 * @module dsho/host/spawn-deps
 */

import type { AgentHandle, Disposable, SpawnDeps, WorkspaceLike } from './spawn.ts'

/** The five services a spawn needs, as this plugin uses them. */
export interface SpawnServices {
  agents: {
    /**
     * The live-agent lookup: `AgentRegistry.get(id)`.
     *
     * The registry is **this same service**, not a second one — `AgentRegistry` is the
     * class behind `ctx.agents`. An earlier version reached for `ctx.agentRegistry`,
     * which does not exist, and cordis refused it at the first outbox tick.
     */
    get(id: string): { followup(message: unknown): void } | undefined
    create(options: {
      sessionId: string
      signal?: AbortSignal
      meta: { cwd: string; agentPreset: string }
      agentOptions?: unknown
      setup: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandle>
  }
  agentPresets: {
    resolve(name: string): Promise<{ id: string }>
    acquireScope(id: string): Promise<Disposable>
    mount(agentCtx: unknown, id: string): Promise<void>
  }
  permissionPresets: {
    resolve(name: string): unknown
    set(session: unknown, name: string): void
  }
  workspaceRegistry: {
    create(path: string, title?: string): Promise<WorkspaceLike>
    /**
     * Removes a REGISTRATION; the directory and every session log are retained.
     *
     * OPTIONAL on purpose: a caller that only ever creates should not have to implement
     * removal, and a fake that does not offer it should still typecheck. Adding it as
     * required rippled into four unrelated fakes for no benefit.
     */
    delete?(id: string): Promise<boolean>
  }
  sessionTitle: {
    rename(session: unknown, title: string): unknown
  }
}

/**
 * Binds the recipe to real services.
 *
 * The message source is `{ kind: 'user' }` — a core source kind — rather than a
 * producer-specific one. A custom kind needs a package that augments
 * `MessageSourceMap`, which this plugin cannot import; the honest alternative would
 * be a DSH package of its own. Recorded in STATUS.md as an open item.
 */
export function createSpawnDeps(services: SpawnServices): SpawnDeps {
  return {
    agents: {
      create: (options) => services.agents.create(options),
    },
    agentPresets: {
      resolve: (name) => services.agentPresets.resolve(name),
      acquireScope: (id) => services.agentPresets.acquireScope(id),
      mount: (agentCtx, id) => services.agentPresets.mount(agentCtx, id),
    },
    permissionPresets: {
      resolve: (name) => services.permissionPresets.resolve(name),
      set: (session, name) => services.permissionPresets.set(session, name),
    },
    workspaceRegistry: {
      create: (path, title) => services.workspaceRegistry.create(path, title),
      // Removing the REGISTRATION, which retains the directory and every session log.
      // Registered here because the real service has it (`Workspace.delete`) and a caller
      // that makes a workspace it does not need must be able to unmake it.
      // Forwarded only when the host actually exposes it, so a registry without removal
      // leaves the entry absent rather than present and throwing.
      ...(typeof services.workspaceRegistry.delete === 'function'
        ? { delete: (id: string) => services.workspaceRegistry.delete!(id) }
        : {}),
    },
    sessionTitle: {
      rename: (session, title) => services.sessionTitle.rename(session, title),
    },
    userMessage: (text) => ({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  }
}
