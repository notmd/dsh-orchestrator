/**
 * DSH Orchestrator — host half.
 *
 * Turns a normal DSH session into a project control room: create issues, let
 * workers pick them up, drive them through a staged pipeline to a pull request,
 * then merge or leave review feedback and have the same worker iterate.
 *
 * **This file is the plugin entry.** It is deliberately thin: it validates
 * configuration and registers the agent-facing tools, and nothing else. The
 * services that do the work (issue queue, worker spawner, PR observer, feedback
 * router) land behind it, so that a failure at activation is always attributable
 * to registration rather than to work in progress.
 *
 * Registration discipline, which the DSH plugin practices make binding:
 *
 *   - everything is registered inside `apply()`, under `ctx.effect()`, so the
 *     disposer is returned and unloading the plugin disposes exactly what it added;
 *   - the plugin **stays inactive rather than throwing** in a profile missing a
 *     service it needs, so optional peers go in `inject` or inside
 *     `ctx.inject([...], …)`.
 *
 * See STATUS.md for what is built and what is not, and
 * docs/dsh-plugin-contract.md for the verified API surface.
 *
 * @module dsho
 */

import { normalizePluginConfig } from './config/validate.ts'
import type { PluginConfig, PluginConfigInput } from './config/validate.ts'
import type { HostContext } from './host/context.ts'
import { own } from './host/context.ts'
import { buildOrchestratorTools } from './host/tools.ts'
import { createRunCommand } from './host/exec.ts'
import { createSpawnDeps } from './host/spawn-deps.ts'
import { createLiveWorkers } from './host/handle-registry.ts'
import { lazyFactStore, openFactStore } from './host/store.ts'
import { FACT_SCHEMAS } from './host/schemas.ts'

/** The plugin row name. Must match `cordis.patch.yml` and `package.json`. */
export const name = 'dsh-orchestrator'

/**
 * Services this plugin requires before it may activate.
 *
 * `subprocess` and `storageDomain` are declared because the plugin cannot function
 * without them: every GitHub fact comes from `gh`, and every board record lives in
 * storage. Declaring them means a profile that lacks either keeps the plugin
 * **inactive** rather than activating it and failing at the first tool call — the
 * documented rule is to stay inactive rather than throw.
 *
 * `agents`, `workspaceRegistry`, `agentPresets`, `sessionTitle`,
 * `permissionPresets` and `webServer` arrive with the tools that need them: the
 * worker spawner and the board routes. Declaring them now would keep the plugin
 * inactive in a profile that has no use for the board yet.
 */
export const inject = [
  'tools',
  'subprocess',
  'storageDomain',
  // The spawn recipe's five, exactly as dsh-webhook uses them.
  'agents',
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
  'sessionTitle',
]

/**
 * Activates the plugin.
 *
 * Configuration is validated **loudly**, first, because a bad config is the one
 * class of failure the user can fix and the plugin cannot paper over. A31's
 * `agentRulesFile` rule is the same instinct one level down (fail the spawn
 * rather than silently drop the user's standing rules); its *path shape* is
 * checked by `resolveRepoRelativeFile`, which the spawner calls once the
 * repository root is known — that check needs a root, so it cannot happen here.
 *
 * @throws {ConfigError} when the row's config is unusable.
 */
export function apply(ctx: HostContext, config?: PluginConfigInput): PluginConfig {
  const resolved = normalizePluginConfig(config)

  // Built once, shared by every tool that needs them. The command seam is
  // stateless; the store is opened on first use so that activation stays
  // synchronous and a storage problem surfaces at a tool call, where the user can
  // act on it, rather than at load time where it would disable the plugin.
  const run = createRunCommand({ subprocess: ctx.subprocess, cwd: resolved.defaultRepo || process.cwd() })
  const store = lazyFactStore(() => openFactStore({ facility: ctx.storageDomain, schemas: FACT_SCHEMAS }))
  const spawn = createSpawnDeps(ctx)
  const live = createLiveWorkers()

  own(
    ctx,
    () => {
      const disposers: Array<() => void> = []
      const tools = buildOrchestratorTools({ config: resolved, run, store, spawn, live })
      for (const tool of tools) {
        disposers.push(ctx.tools.register(tool as never))
      }
      log(ctx, 'info', `${name}: registered ${tools.length} orchestrator tool(s)`)
      return () => {
        for (const dispose of disposers) dispose()
        // A9: unloading leaves sessions and worktrees INTACT. Disposing an agent
        // handle stops and removes its session, so this drops the references and
        // disposes nothing -- the sessions keep running and a reload reattaches.
        live.clear()
        // Best effort: a disposal failure must not mask the unload.
        void store.close().catch((error: unknown) => {
          log(ctx, 'warn', `${name}: releasing storage failed during unload: ${String(error)}`)
        })
      }
    },
    `${name}: orchestrator tools`,
  )

  return resolved
}

function log(ctx: HostContext, level: 'info' | 'warn' | 'error', message: string): void {
  ctx.logger?.[level](message)
}
