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
import { OUTBOX_TICK_MS, deliverPendingReports } from './host/outbox-service.ts'
import { observeAll } from './host/observer-service.ts'
import { sweepReviewPasses } from './host/reviewer-service.ts'
import { sweepCompletions } from './host/completion.ts'
import { sweepHumanFeedback } from './host/feedback-service.ts'
import { fillSlots } from './host/workers-service.ts'
import { createBoardRoute } from './host/board-route.ts'
import { restrictionFor, sessionKind } from './host/tools.ts'
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
  'webServer',
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

      // The board's read endpoint. Registered under the same effect as the tools, so
      // unloading disposes the route rather than leaving a handler on a dead service.
      const boardDeps = {
        store,
        config: resolved,
        activityOf: (workerId: string) => {
          const status = live.byWorker(workerId)?.handle.agent.status
          return status === 'running' ? 'active' : status === 'idle' ? 'idle' : 'unknown'
        },
      }
      disposers.push(ctx.webServer.register(createBoardRoute(boardDeps)))

      // Restrict the protocol tools to the session kinds they belong to (PRD §12.2).
      //
      // Two traps, both read from the installed types rather than discovered later:
      //
      //   `restrict()` is GLOBAL on a plain context. Applied here it would strip the
      //   protocol tools from every session including the user's -- so it is only
      //   ever called through the AGENT'S OWN scoped ctx, and if that is missing the
      //   wiring does nothing at all. Failing to restrict is a small gap; restricting
      //   globally is a broken product.
      //
      //   the filter is a DENY list. `allow` means keep only, which for a worker would
      //   strip read, bash and edit.
      //
      // The listener is owned by `ctx.effect`, and each agent's restriction by that
      // agent's own effect, so both are disposed with what they belong to.
      if (typeof ctx.on === 'function') {
        ctx.on('agent/created', (raw) => {
          // The payload is `{ agent, source, signal }` -- NOT the agent itself. Reading
          // the payload as the agent yields `session: undefined` for every session, so
          // the listener runs and restricts nothing, silently. The listener is also
          // called with `this` bound to the scoped agent, which is the other way in.
          const payload = raw as {
            agent?: {
              session?: { id?: string }
              ctx?: { tools?: { restrict?(filter: { deny: string[] }): () => void }; effect?(cb: () => (() => void) | void, label?: string): () => void }
            }
          }
          const agent = payload?.agent ?? (raw as typeof payload.agent)
          if (!agent) return
          const scoped = agent.ctx
          if (typeof scoped?.tools?.restrict !== 'function') {
            log(ctx, 'warn', `${name}: an agent has no scoped tool runtime, so protocol tools were not restricted`)
            return
          }
          const kind = sessionKind(agent.session?.id)
          const filter = restrictionFor(kind)
          const apply = () => scoped.tools!.restrict!(filter)
          if (typeof scoped.effect === 'function') scoped.effect(apply, `${name}: ${kind} tool restriction`)
          else apply()
        })
      } else {
        log(ctx, 'warn', `${name}: no event bus, so protocol tools could not be restricted to their session kinds`)
      }

      // The outbox tick. Reports accumulate in storage and are delivered on their
      // own schedule (PRD §10.5), so a worker reporting three times does not
      // interrupt the orchestrator three times.
      const tick = setInterval(() => {
        void deliverPendingReports({
          store,
          agents: ctx.agents,
          userMessage: spawn.userMessage,
          bounds: {
            batchFallbackMs: resolved.reportBatchFallbackMs,
            settlementWindowMs: resolved.reportSettlementWindowMs,
            interruptWindowMs: resolved.reportInterruptWindowMs,
          },
        })
          .then((outcome) => {
            for (const error of outcome.errors) {
              log(ctx, 'warn', `${name}: delivering reports for ${error.workerId} failed: ${error.message}`)
            }
          })
          .catch((error: unknown) => {
            // A delivery pass must never take the host down.
            log(ctx, 'warn', `${name}: the report outbox pass failed: ${String(error)}`)
          })
      }, OUTBOX_TICK_MS)
      // Do not hold the process open for a delivery tick.
      tick.unref?.()

      // The PR observer. Serialised per repository inside `observeAll`, so a busy
      // board makes sequential `gh` calls rather than fanning out against one rate
      // limit. A failed observation keeps the prior snapshot (R13), so a GitHub
      // outage degrades the board to `No signal` instead of fabricating a merge.
      const observer = setInterval(() => {
        void observeAll({ store, run })
          .then((outcome) => {
            const changed = outcome.observations.filter((observation) => observation.changed)
            if (changed.length > 0) {
              log(ctx, 'info', `${name}: ${changed.length} pull request(s) changed`)
            }
          })
          .catch((error: unknown) => {
            log(ctx, 'warn', `${name}: the PR observer pass failed: ${String(error)}`)
          })
      }, resolved.pollIntervalMs)
      observer.unref?.()

      // Finishing. A merged or closed pull request describes a worker whose work is
      // done, so this terminates it, releases its issue and collects its worktree --
      // where R4's disk bound is actually paid. R13 holds: an unfetched snapshot can
      // finish nothing, however its empty payload reads.
      // A person's review reaches the worker (M4). Without it the card claims the work
      // is progressing while a human's objection sits unanswered.
      // Queued work starts when a slot frees (M5). A sweep rather than a hook on
      // worker completion, because slots free in several ways -- a merge, a close, a
      // cancellation, a stop -- and this catches all of them.
      const slots = setInterval(() => {
        void fillSlots({ run, store, spawn, config: resolved, live })
          .then((outcome) => {
            if (outcome.started.length > 0) {
              log(ctx, 'info', `${name}: started ${outcome.started.length} queued worker(s)`)
            }
          })
          .catch((error: unknown) => {
            log(ctx, 'warn', `${name}: the slot sweep failed: ${String(error)}`)
          })
      }, resolved.pollIntervalMs)
      slots.unref?.()

      const feedback = setInterval(() => {
        void sweepHumanFeedback({ store, config: resolved, live })
          .then((outcomes) => {
            if (outcomes.length > 0) {
              log(ctx, 'info', `${name}: routed human feedback to ${outcomes.length} worker(s)`)
            }
          })
          .catch((error: unknown) => {
            log(ctx, 'warn', `${name}: the feedback sweep failed: ${String(error)}`)
          })
      }, resolved.pollIntervalMs)
      feedback.unref?.()

      const completion = setInterval(() => {
        void sweepCompletions({ store, run })
          .then((outcomes) => {
            for (const outcome of outcomes) {
              log(ctx, 'info', `${name}: ${outcome.workerId} ${outcome.reason}`)
            }
          })
          .catch((error: unknown) => {
            log(ctx, 'warn', `${name}: the completion sweep failed: ${String(error)}`)
          })
      }, resolved.pollIntervalMs)
      completion.unref?.()

      // The review sweep. This is the loop that makes the requested flow happen
      // without a human: every worker whose current head has no pass gets one, and
      // the per-worker decision (one pass per head, retry limits, the round cap) is
      // the planner's, so the board and the scheduler cannot disagree.
      const reviewer = setInterval(() => {
        void sweepReviewPasses({ store, spawn, config: resolved, live })
          .then((outcome) => {
            if (outcome.scheduled.length > 0) {
              log(ctx, 'info', `${name}: scheduled ${outcome.scheduled.length} review pass(es)`)
            }
          })
          .catch((error: unknown) => {
            log(ctx, 'warn', `${name}: the review sweep failed: ${String(error)}`)
          })
      }, resolved.reviewSweepIntervalMs)
      reviewer.unref?.()
      for (const tool of tools) {
        disposers.push(ctx.tools.register(tool as never))
      }
      log(ctx, 'info', `${name}: registered ${tools.length} orchestrator tool(s)`)
      return () => {
        clearInterval(tick)
        clearInterval(observer)
        clearInterval(completion)
        clearInterval(feedback)
        clearInterval(slots)
        clearInterval(reviewer)
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
