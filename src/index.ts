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

/** The plugin row name. Must match `cordis.patch.yml` and `package.json`. */
export const name = 'dsh-orchestrator'

/**
 * Services this plugin requires before it may activate.
 *
 * `tools` is the only hard requirement today: the orchestrator surface is the
 * plugin's whole interface to the user's session. Storage, agents, subprocess,
 * and the web server arrive with the services that need them — declaring them
 * now would keep the plugin inactive in a profile that has no use for the board
 * yet, which is a worse failure than an incomplete feature.
 */
export const inject = ['tools']

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

  own(
    ctx,
    () => {
      const disposers: Array<() => void> = []
      const tools = buildOrchestratorTools(resolved)
      for (const tool of tools) {
        disposers.push(ctx.tools.register(tool as never))
      }
      log(ctx, 'info', `${name}: registered ${tools.length} orchestrator tool(s)`)
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    `${name}: orchestrator tools`,
  )

  return resolved
}

function log(ctx: HostContext, level: 'info' | 'warn' | 'error', message: string): void {
  ctx.logger?.[level](message)
}
