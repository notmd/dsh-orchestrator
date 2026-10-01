/**
 * The slice of the Cordis host `Context` this plugin uses.
 *
 * **Why this is declared structurally rather than imported.** The package is
 * installed into a profile as a symlink, so `@deepseek-ai/cordis` would not
 * resolve from this package's real path (see `./tool.ts` for the full
 * explanation, and the version-skew half of it). Declaring only what is used has
 * a second benefit: the plugin's host-plane footprint is readable in one file,
 * and a test can supply a fake `ctx` without a live profile.
 *
 * Only services this plugin actually calls appear here. Adding one should be a
 * deliberate act, because each is a peer dependency in the DSH sense.
 *
 * @module dsho/host/context
 */

import type { ToolDescriptor } from './tool.ts'
import type { SubprocessLike } from './exec.ts'
import type { DomainFacilityLike } from './store.ts'
import type { SpawnServices } from './spawn-deps.ts'

/** The tool registry, as far as this plugin is concerned. */
export interface ToolRegistryLike {
  /**
   * Adds a tool. Returns a disposer that removes it.
   *
   * The registry feeds each tool's schema into system-prompt assembly, so
   * registering is enough to make a tool visible to the model.
   */
  register(tool: ToolDescriptor<never, unknown> | ToolDescriptor<Record<string, unknown>, unknown>): () => void
}

/**
 * The host `Context` slice this plugin uses.
 *
 * `effect` is how every registration is owned: it runs the callback and returns
 * its cleanup, so unloading the plugin disposes exactly what it added. A plugin
 * that registers outside `effect` leaks on unload, which is why the rule is
 * stated at the type level here.
 */
export interface HostContext extends SpawnServices {
  tools: ToolRegistryLike
  /**
   * The subprocess capability seam, for git and `gh`.
   *
   * Required rather than optional, and listed in `inject`: a plugin that cannot
   * shell out cannot do its job, so the honest outcome is to stay inactive until
   * the service exists — which is what `inject` achieves — rather than to activate
   * and fail at the first tool call.
   */
  subprocess: SubprocessLike
  /**
   * Host-side structured storage, for the board's records. Same reasoning.
   *
   * `ctx.storageDomain` is the `DomainFacility` itself; `ctx.storage.domain` is the
   * same object reached through the form hub. The facility is preferred because it
   * is the direct key, so nothing has to know the hub's shape.
   */
  storageDomain: DomainFacilityLike
  effect(callback: () => (() => void) | void, label?: string): () => void
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void }
}

/**
 * Runs `callback` under `ctx.effect` when the context provides one, and directly
 * otherwise.
 *
 * The fallback exists so the host half can be exercised against a fake `ctx` in
 * tests. In a live host the effect is always present, and the immediate-return
 * path is never taken.
 */
export function own(ctx: HostContext, callback: () => (() => void) | void, label: string): void {
  if (typeof ctx.effect === 'function') {
    ctx.effect(callback, label)
    return
  }
  callback()
}
