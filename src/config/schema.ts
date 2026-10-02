/**
 * The row's `Config` — what makes this plugin configurable from the Web UI.
 *
 * ## Why the schema exists at all
 *
 * The plugin has always been configurable: `cordis.patch.yml` inserts the row with a
 * `config:` block and `./validate.ts` validates it. What was missing is the *surface*.
 * DSH's Settings service projects one form per profile entry, and it does so by reading
 * the entry's exported `Config` and keeping only the fields marked `.volatile()`
 * (`@deepseek-ai/dsh-settings/lib/index.js`: `volatileForm(schema)`, then
 * `if (form === undefined) return []`). Without a `Config` export the entry is simply
 * absent from the settings document, which is why the plugin's page on the Plugins page
 * showed nothing to configure.
 *
 * So this module is the *only* thing that publishes the plugin's settings to the UI, and
 * the volatile marker is load-bearing twice over:
 *
 *   - it decides what the page may edit at all, and
 *   - it decides *how* an edit lands. A volatile-only change is committed into the running
 *     fiber's config references instead of remounting the plugin
 *     (`cordis-plugin-loader`'s `_commitVolatile`), so a field earns the marker only when
 *     the plugin really does read it again after loading — the rule the schema comment
 *     below states field by field.
 *
 * ## Defaults are not restated here
 *
 * Every default is read from {@link PLUGIN_DEFAULTS}. A schema with its own copy of
 * `30_000` would be a second answer to "what is the poll interval", and the two would
 * drift the first time one moved. `test/config/schema.test.ts` asserts the two agree and
 * that the schema covers every field of `PluginConfig`, so a field added later cannot be
 * silently absent from the UI.
 *
 * @module dsho/config/schema
 */

import z from '@deepseek-ai/schemastery'
import { PLUGIN_DEFAULTS, normalizePluginConfig } from './validate.ts'
import type { PluginConfig, PluginConfigInput } from './validate.ts'

/**
 * The profile entry id, and therefore the settings namespace.
 *
 * `cordis.patch.yml` inserts the row as `orchestrator`, and the Settings service addresses
 * a namespace by entry id. It is spelled once here and read by the client through its own
 * mirror of it (`CONFIG_ENTRY_ID`), with a test pinning the two together — a typo on
 * either side is a page that waits for a namespace nobody serves.
 */
export const CONFIG_ENTRY_ID = 'orchestrator'

/**
 * The rule the volatile markers below follow.
 *
 * The test is not "is this a nice setting" but "does the running plugin read it again".
 * Every marked field is read from the live config on each use — by a sweep tick, a spawn, a
 * board build or a tool call — because `apply` hands the sweep services one config object
 * and each reads a field when it needs it. {@link livePluginConfig} is what makes that
 * object follow the entry's live values.
 *
 * Everything else on `PluginConfig` stays ordinary, and the two reasons are different:
 *
 *   - **read once at activation.** `pollIntervalMs` and `reviewSweepIntervalMs` pass into
 *     `setInterval` when the plugin loads, so a "live" edit would move a number the running
 *     timers never look at again. `defaultRepo` names the working directory the command
 *     seam was built with. Offering these would be a control that does nothing.
 *   - **not wired to anything yet.** `planGate` and the `webhook` block are validated and
 *     reported by `orchestrator_status`, but no code branches on them (plan gating and
 *     webhook ingress are unbuilt), so a page that could change them would be lying about
 *     what the plugin does.
 *
 * They remain editable the ordinary way — the profile's `cordis.patch.yml` or the Cordis
 * configuration files — and the page says so, because a settings page whose omissions are
 * unexplained reads as a bug.
 */

/**
 * The row's config schema.
 *
 * Types and defaults, plus a floor on the numbers whose semantic is "at least one". The
 * *semantic* rules stay in `./validate.ts` (`normalizePluginConfig`), which is the
 * authority the host calls at activation and the route calls on a patch: this schema is
 * the UI's contract, not a second validator, so it deliberately does not re-encode the
 * `planGate` enum or the integer-only rules. Where the two would disagree, validation
 * wins and the plugin refuses to activate loudly — which is the property the project wants
 * for a hand-edited patch.
 */
export const Config = z.object({
  defaultRepo: z.string().default(PLUGIN_DEFAULTS.defaultRepo),
  pollIntervalMs: z.number().min(1).default(PLUGIN_DEFAULTS.pollIntervalMs),
  maxConcurrentWorkers: z.number().min(1).default(PLUGIN_DEFAULTS.maxConcurrentWorkers).volatile(),
  workerPermissionPreset: z.string().default(PLUGIN_DEFAULTS.workerPermissionPreset).volatile(),
  workerAgentPreset: z.string().default(PLUGIN_DEFAULTS.workerAgentPreset).volatile(),
  planGate: z.string().default(PLUGIN_DEFAULTS.planGate),
  autoInjectReview: z.boolean().default(PLUGIN_DEFAULTS.autoInjectReview).volatile(),
  autoInjectCI: z.boolean().default(PLUGIN_DEFAULTS.autoInjectCI).volatile(),
  autoReview: z.boolean().default(PLUGIN_DEFAULTS.autoReview).volatile(),
  maxReviewRounds: z.number().min(1).default(PLUGIN_DEFAULTS.maxReviewRounds).volatile(),
  reviewMaxNudge: z.number().min(1).default(PLUGIN_DEFAULTS.reviewMaxNudge).volatile(),
  autoReviewFailedRetryLimit: z
    .number()
    .min(1)
    .default(PLUGIN_DEFAULTS.autoReviewFailedRetryLimit)
    .volatile(),
  reviewSweepIntervalMs: z.number().min(1).default(PLUGIN_DEFAULTS.reviewSweepIntervalMs),
  reviewIdleThresholdMs: z.number().min(1).default(PLUGIN_DEFAULTS.reviewIdleThresholdMs).volatile(),
  noSignalGraceMs: z.number().min(1).default(PLUGIN_DEFAULTS.noSignalGraceMs).volatile(),
  requireHumanApprovalBeforeReady: z.boolean().default(PLUGIN_DEFAULTS.requireHumanApprovalBeforeReady).volatile(),
  reportBatchFallbackMs: z.number().min(1).default(PLUGIN_DEFAULTS.reportBatchFallbackMs).volatile(),
  reportSettlementWindowMs: z.number().min(1).default(PLUGIN_DEFAULTS.reportSettlementWindowMs).volatile(),
  reportInterruptWindowMs: z.number().min(1).default(PLUGIN_DEFAULTS.reportInterruptWindowMs).volatile(),
  maxReportCharacters: z.number().min(1).default(PLUGIN_DEFAULTS.maxReportCharacters).volatile(),
  reviewerPermissionPreset: z.string().default(PLUGIN_DEFAULTS.reviewerPermissionPreset).volatile(),
  reviewerAgentPreset: z.string().default(PLUGIN_DEFAULTS.reviewerAgentPreset).volatile(),
  draftPrs: z.boolean().default(PLUGIN_DEFAULTS.draftPrs).volatile(),
  prBodyTemplate: z.string().default(PLUGIN_DEFAULTS.prBodyTemplate).volatile(),
  hideWorktreeWorkspaces: z.boolean().default(PLUGIN_DEFAULTS.hideWorktreeWorkspaces).volatile(),
  webhook: z.object({
    enabled: z.boolean().default(PLUGIN_DEFAULTS.webhook.enabled),
    secretEnv: z.string().default(PLUGIN_DEFAULTS.webhook.secretEnv),
  }),
})

/** The shape of one field's schema, as this module needs it. Structural on purpose. */
interface FieldSchema {
  meta?: { volatile?: boolean }
}

/** The object part of a schema: the field table the volatile marker is read off. */
interface ObjectSchema {
  dict?: Record<string, FieldSchema>
}

/**
 * The fields the schema marks volatile, in declaration order.
 *
 * Read off the schema rather than off {@link LIVE_FIELDS} so the marker stays the single
 * source of truth for what the page may edit: if a field is dropped from the schema, or
 * loses its marker, the client's ledger and the page's rows follow without a second list to
 * keep in step. `test/config/schema.test.ts` asserts the two agree.
 */
export function volatileFields(schema: ObjectSchema = Config as ObjectSchema): string[] {
  return Object.entries(schema.dict ?? {})
    .filter(([, field]) => field.meta?.volatile === true)
    .map(([name]) => name)
}

/**
 * One of the live config references a volatile field holds.
 *
 * A field marked `.volatile()` does not resolve to its value: **schemastery itself** turns
 * it into an observable at validation time, so the object the Loader hands `apply` carries
 * `{ get, [write] }` where the schema said "volatile" (measured: `Config['~standard']
 * .validate({}).value.maxReviewRounds` is an object with a `get` function and a symbol-keyed
 * write). A live edit writes into that same reference — `cosmokit`'s `updateVolatile`, driven
 * by `cordis-plugin-loader`'s `_commitVolatile` — so reading `.get()` at each use is what
 * makes an edit visible without a reload. `dsh-bash-local` consumes its own volatile config
 * exactly this way (`this.config.timeoutMs.get()` per command), which is the shipped pattern
 * this module follows.
 */
interface VolatileRef {
  get(): unknown
}

/**
 * Whether a value is one of those references.
 *
 * The question is asked *per volatile field*, using the schema's own marker, rather than by
 * sniffing the object. That is deliberate: the reference carries an ENUMERABLE `get`
 * property, so "an object whose only key is a getter" is not a usable test — an earlier
 * version used exactly that and silently failed to unwrap, which surfaced as
 * `maxReviewRounds: must be a positive integer, got {}`. Reading the schema we wrote is
 * both simpler and impossible to get subtly wrong.
 */
function asRef(value: unknown): VolatileRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return typeof (value as { get?: unknown }).get === 'function' ? (value as VolatileRef) : undefined
}

/** Each volatile field's live reference, for a config the Loader has just resolved. */
function volatileRefs(raw: unknown): Map<string, VolatileRef> {
  const refs = new Map<string, VolatileRef>()
  if (typeof raw !== 'object' || raw === null) return refs
  const fields = raw as Record<string, unknown>
  for (const field of volatileFields()) {
    const ref = asRef(fields[field])
    if (ref !== undefined) refs.set(field, ref)
  }
  return refs
}

/**
 * The plain config underneath the live references.
 *
 * Reconstructed rather than copied so `normalizePluginConfig` — which compares and coerces
 * real values — never has to know about the loader's references. The copy is shallow and the
 * `get()` calls are driven by the schema's volatile markers, because every volatile field in
 * this config is a top-level scalar; the nested `webhook` block is ordinary and is carried
 * across as a plain object, which is the shape `normalizePluginConfig` rebuilds.
 */
function unwrapVolatile(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  const fields = raw as Record<string, unknown>
  for (const field of volatileFields()) {
    const ref = asRef(fields[field])
    if (ref !== undefined) out[field] = ref.get()
  }
  return out
}

/**
 * The config `apply` should run on: normalized, with the live fields following the entry.
 *
 * The returned object is the one the services already hold and read fields off, so every
 * consumer sees an edit with no wiring of its own. Each live field becomes a getter over
 * the loader's reference; a reference whose value is not the type the field has (the loader
 * validates every volatile write against this schema, so this cannot normally happen) falls
 * back to the value normalization produced, rather than handing a sweep a value it would
 * crash on.
 *
 * With no references — `apply(ctx)` in a test, or a host that resolved no volatile field —
 * the result is exactly what `normalizePluginConfig` has always returned.
 */
export function livePluginConfig(raw?: PluginConfigInput | unknown): PluginConfig {
  const resolved = normalizePluginConfig(unwrapVolatile(raw) as PluginConfigInput)
  const refs = volatileRefs(raw)
  if (refs.size === 0) return resolved

  const target = resolved as unknown as Record<string, unknown>
  for (const [field, ref] of refs) {
    const fallback = target[field]
    Object.defineProperty(target, field, {
      enumerable: true,
      configurable: true,
      get: () => liveValue(ref, fallback),
    })
  }
  return resolved
}

/**
 * One live read, guarded by the type normalization produced.
 *
 * A `number` field must read a finite number and a `string` field a string; anything else
 * is the fallback. Booleans need no extra guard beyond `typeof`, which is the check that
 * catches a `null` reference (still an `object`, but not a boolean).
 */
function liveValue(ref: VolatileRef, fallback: unknown): unknown {
  const candidate = ref.get()
  if (typeof candidate !== typeof fallback) return fallback
  if (typeof candidate === 'number' && !Number.isFinite(candidate)) return fallback
  return candidate
}
