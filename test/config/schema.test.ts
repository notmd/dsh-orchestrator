/**
 * The row's Config: the four properties the settings page depends on.
 *
 * This module exists to publish the plugin's settings to the Web UI, and every way it can
 * fail is silent — a field missing from the schema is a row that is simply not there, a lost
 * `.volatile()` marker is a row whose edit never reaches the running plugin, and a default
 * that disagrees with `PLUGIN_DEFAULTS` is a page that shows one number while the plugin runs
 * on another. None of those throws. So each is asserted here against the thing it must agree
 * with rather than against a copy of itself.
 *
 * The last group is about the mechanism: schemastery turns a volatile field into a live
 * reference, and `livePluginConfig` has to read through it. That was measured on the
 * installed schemastery, and it is where an earlier version of this code went wrong — it
 * sniffed the object's shape, did not unwrap, and surfaced as
 * `maxReviewRounds: must be a positive integer, got {}`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, CONFIG_ENTRY_ID, livePluginConfig, volatileFields } from '../../src/config/schema.ts'
import { PLUGIN_DEFAULTS } from '../../src/config/validate.ts'

/** The schema's field table, with the two facts these tests read off it. */
function fields(): Record<string, { default?: unknown; type?: string; volatile?: boolean }> {
  const dict = (Config as unknown as { dict: Record<string, { meta?: { default?: unknown; volatile?: boolean }; type?: string }> }).dict
  const out: Record<string, { default?: unknown; type?: string; volatile?: boolean }> = {}
  for (const [name, field] of Object.entries(dict)) {
    out[name] = { default: field.meta?.default, type: field.type, volatile: field.meta?.volatile === true }
  }
  return out
}

/** A config the way the Loader resolves it: every field present, volatile ones live. */
function resolved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const result = (Config as unknown as { '~standard': { validate(value: unknown): { value?: unknown; issues?: unknown } } })['~standard'].validate(overrides)
  assert.equal(result.issues, undefined, `the schema accepted ${JSON.stringify(overrides)}`)
  return result.value as Record<string, unknown>
}

/** Write into a live reference, the way the settings service does. */
function write(ref: unknown, value: unknown): void {
  const symbol = Object.getOwnPropertySymbols(ref as object)[0]
  assert.ok(symbol, 'the reference carries its write method under a symbol')
  ;(ref as Record<symbol, (next: unknown) => void>)[symbol]!(value)
}

test('the schema covers every field of the plugin config, and nothing else', () => {
  // Both directions. A field the plugin reads but the schema omits is invisible to the
  // settings service; a field the schema invents is a row nobody reads.
  assert.deepEqual(Object.keys(fields()).sort(), Object.keys(PLUGIN_DEFAULTS).sort())
})

test('every default is the plugin default, not a second copy of it', () => {
  const schema = fields()
  for (const [key, value] of Object.entries(PLUGIN_DEFAULTS)) {
    if (typeof value !== 'object' || value === null) assert.deepEqual(schema[key]?.default, value, `${key} default`)
  }
  // `webhook` is the one nested object, and normalizePluginConfig rebuilds it field by field.
  const webhook = (Config as unknown as { dict: Record<string, { dict: Record<string, { meta?: { default?: unknown } }> }> }).dict.webhook!
  assert.deepEqual(
    Object.fromEntries(Object.entries(webhook.dict).map(([name, field]) => [name, field.meta?.default])),
    PLUGIN_DEFAULTS.webhook,
  )
})

test('the row config a profile ships (an empty object) resolves to every default', () => {
  // `cordis.patch.yml` inserts the row with `config: {}`. If the schema did not fill a field,
  // the settings document would carry that field as absent and the page would render a blank.
  const config = resolved()
  for (const key of Object.keys(PLUGIN_DEFAULTS)) assert.ok(key in config, `${key} is resolved`)
})

test('exactly the fields the running plugin re-reads are marked volatile', () => {
  // The list is deliberate, and the exclusions are the point:
  //
  //   - `defaultRepo`, `pollIntervalMs` and `reviewSweepIntervalMs` are read ONCE, at
  //     activation — a working directory, and two `setInterval` periods. A live edit would
  //     change a number the running plugin never looks at again.
  //   - `planGate` and `webhook` are validated and reported, but nothing branches on them yet.
  //
  // So this assertion is a decision, and it fails when a field is added to either side of it
  // without the decision being made again.
  assert.deepEqual(volatileFields().sort(), [
    'autoInjectCI',
    'autoInjectReview',
    'autoReview',
    'autoReviewFailedRetryLimit',
    'draftPrs',
    'hideWorktreeWorkspaces',
    'maxConcurrentWorkers',
    'maxReportCharacters',
    'maxReviewRounds',
    'noSignalGraceMs',
    'prBodyTemplate',
    'reportBatchFallbackMs',
    'reportInterruptWindowMs',
    'reportSettlementWindowMs',
    'requireHumanApprovalBeforeReady',
    'reviewIdleThresholdMs',
    'reviewMaxNudge',
    'reviewerAgentPreset',
    'reviewerPermissionPreset',
    'workerAgentPreset',
    'workerPermissionPreset',
  ])
  // And the two sets are complementary: nothing is volatile by accident.
  const ordinary = Object.keys(PLUGIN_DEFAULTS).filter((field) => !volatileFields().includes(field))
  assert.deepEqual(ordinary.sort(), ['defaultRepo', 'planGate', 'pollIntervalMs', 'reviewSweepIntervalMs', 'webhook'])
})

test('the settings namespace is the profile entry id, not the package name', () => {
  // The Settings service addresses a form by ENTRY id; the Plugins page dispatches by PACKAGE
  // name. They are different strings, and this file owns the first while the client owns both.
  assert.equal(CONFIG_ENTRY_ID, 'orchestrator')
})

test('a volatile field reads live, through the reference schemastery builds', () => {
  const config = resolved()
  const live = livePluginConfig(config)
  assert.equal(live.maxConcurrentWorkers, PLUGIN_DEFAULTS.maxConcurrentWorkers, 'resolved, not a reference')

  // One write into the reference the running config already holds -- this is what the
  // settings service does for a volatile field, and the value must follow immediately.
  write(config.maxConcurrentWorkers, 7)
  write(config.autoReview, false)
  write(config.workerAgentPreset, 'careful')
  assert.equal(live.maxConcurrentWorkers, 7)
  assert.equal(live.autoReview, false)
  assert.equal(live.workerAgentPreset, 'careful')
  assert.equal(typeof live.maxConcurrentWorkers, 'number', 'the getter hands back the value, not the reference')
})

test('an ordinary field is not live, because the plugin reads it once anyway', () => {
  const config = resolved()
  const live = livePluginConfig(config)
  // `pollIntervalMs` is deliberately NOT volatile: its reference does not exist, so the value
  // the timers were built with is the value the object carries.
  assert.equal(typeof live.pollIntervalMs, 'number')
  assert.equal(live.pollIntervalMs, PLUGIN_DEFAULTS.pollIntervalMs)
})

test('a plain config still normalizes, because tests and hosts both call apply without references', () => {
  const live = livePluginConfig({ maxConcurrentWorkers: 4 })
  assert.equal(live.maxConcurrentWorkers, 4)
  assert.equal(live.autoReview, PLUGIN_DEFAULTS.autoReview)
  // And no argument at all is the same contract `apply(ctx)` always had.
  assert.equal(livePluginConfig().pollIntervalMs, PLUGIN_DEFAULTS.pollIntervalMs)
})

test('a reference holding nonsense falls back rather than handing a sweep a value it would crash on', () => {
  const config = resolved()
  const live = livePluginConfig(config)
  // The Loader validates every volatile write against this schema, so this cannot happen by
  // the book. A value that arrives anyway must not reach a comparison or a truncation as a
  // string: the normalized value is the answer, and it is the one the user last saw.
  write(config.maxConcurrentWorkers, 'lots')
  write(config.maxReportCharacters, Number.NaN)
  write(config.autoReview, null)
  assert.equal(live.maxConcurrentWorkers, PLUGIN_DEFAULTS.maxConcurrentWorkers)
  assert.equal(live.maxReportCharacters, PLUGIN_DEFAULTS.maxReportCharacters)
  assert.equal(live.autoReview, PLUGIN_DEFAULTS.autoReview)
})

test('the schema really validates, so a bad volatile write is refused before it becomes one', () => {
  // `resolveConfig` calls `Config["~standard"].validate` on every volatile-only update, which
  // is why the fallback above is a backstop and not the mechanism.
  const standard = (Config as unknown as { '~standard': { validate(value: unknown): { issues?: unknown } } })['~standard']
  assert.notEqual(standard.validate({ maxReviewRounds: 0 }).issues, undefined, 'a floor of one')
  assert.notEqual(standard.validate({ autoReview: 'yes' }).issues, undefined, 'a switch is a boolean')
  assert.equal(standard.validate({ prBodyTemplate: 'default' }).issues, undefined)
})
