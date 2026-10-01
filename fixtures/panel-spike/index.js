/**
 * M0 spike — host half.
 *
 * The point of this file is not what it does (nothing) but that it exists and
 * activates: it proves a **third-party** host bundle is accepted by the loader
 * and that its `dsh.client` half is discovered and served to the browser.
 *
 * `inject` is deliberately empty. The spike must not depend on any service, or a
 * failure would be ambiguous between "the bundle was rejected" and "a service was
 * missing".
 */

export const name = 'panel-spike'

export function apply(ctx) {
  // Register one trivial effect so the plugin has real lifecycle ownership and
  // its disposal path is exercised. `ctx.effect` is the documented registration
  // form: a plugin registers inside `apply` and returns its cleanup.
  ctx.effect(() => {
    globalThis.__DSH_PANEL_SPIKE_HOST__ = true
    return () => {
      delete globalThis.__DSH_PANEL_SPIKE_HOST__
    }
  })
}
