/**
 * The per-project settings contract.
 *
 * Two classes of failure are what these tests exist for, and both are silent ones:
 *
 *   1. **An edit that reports success and changes nothing.** A patch with a mistyped key,
 *      or a value of the wrong type, must be REFUSED with the key named -- never accepted
 *      and dropped.
 *   2. **A cleared override that stays set.** `autoReview` is a tri-state, so `null`
 *      ("inherit the plugin default") has to be a write, not a no-op. The first version of
 *      this validator treated an absent value as "inherit", which made clearing the
 *      override impossible while looking like it worked.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROJECT_SETTINGS_DEFAULTS,
  ProjectSettingsError,
  applyProjectSettingsPatch,
  normalizeProjectSettings,
  serializeProjectSettings,
} from '../../src/host/repo-settings.ts'
import { normalizeRepo } from '../../src/host/repo.ts'

test('a record that predates the settings reads as the defaults', () => {
  // This is the upgrade path, and getting it wrong is not cosmetic: `undefined` on a
  // switch renders as "off", so every project connected before the settings page existed
  // would quietly stop accepting queued work.
  const settings = normalizeProjectSettings({ id: 'repo-1', owner: 'acme', name: 'widgets' })
  assert.deepEqual(settings, {
    defaultBranch: '',
    sessionPrefix: '',
    intakeEnabled: true,
    workerAgentPreset: '',
    reviewerAgentPreset: '',
    autoReview: undefined,
  })
  assert.equal(PROJECT_SETTINGS_DEFAULTS.intakeEnabled, true, 'and intake defaults ON, which is the behaviour it replaces')
})

test('a scalar or array is not a settings object', () => {
  // The storage layer rejects a non-object record, but this is also reached by the route's
  // body, where anything can arrive.
  for (const raw of [undefined, null, 42, 'nope', []]) {
    assert.deepEqual(normalizeProjectSettings(raw), normalizeProjectSettings({}))
  }
})

test('a patch writes each field, and trims it', () => {
  const next = applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, {
    defaultBranch: '  develop  ',
    sessionPrefix: ' web ',
    intakeEnabled: false,
    workerAgentPreset: '  strict  ',
    reviewerAgentPreset: '  strict-reviewer  ',
    autoReview: true,
  })
  assert.equal(next.defaultBranch, 'develop')
  assert.equal(next.sessionPrefix, 'web')
  assert.equal(next.intakeEnabled, false)
  assert.equal(next.workerAgentPreset, 'strict')
  assert.equal(next.reviewerAgentPreset, 'strict-reviewer')
  assert.equal(next.autoReview, true)
})

test('the reviewer preset is its own key, refused by name and clearable', () => {
  // Two presets, two keys: a page that sent the worker's name for the reviewer would be
  // accepted by a shared field and would quietly run the wrong agent on every pass.
  const error = refusal({ reviewerAgentPreset: true })
  assert.equal(error.key, 'reviewerAgentPreset')
  assert.match(error.problem, /must be a string/)

  const cleared = applyProjectSettingsPatch({ ...PROJECT_SETTINGS_DEFAULTS, reviewerAgentPreset: 'strict' }, { reviewerAgentPreset: '' })
  assert.equal(cleared.reviewerAgentPreset, '', 'empty means the plugin default')
  assert.equal(serializeProjectSettings(cleared).reviewerAgentPreset, '')
})

/** Runs a patch expected to fail, and returns the error so its KEY can be asserted. */
function refusal(patch: Record<string, unknown>): ProjectSettingsError {
  try {
    applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, patch)
  } catch (error) {
    assert.ok(error instanceof ProjectSettingsError, `expected a ProjectSettingsError, got ${String(error)}`)
    return error
  }
  throw new Error(`expected a refusal for ${JSON.stringify(patch)}`)
}

test('an unknown key is REFUSED, not ignored', () => {
  // The failure this prevents: a page sends `sessionprefix`, gets a 200, and the user
  // watches a value they just typed disappear.
  const error = refusal({ sessionprefix: 'web' })
  assert.equal(error.key, 'sessionprefix')
  assert.match(error.problem, /is not a project setting/)
  assert.match(error.problem, /sessionPrefix/, 'the message lists what IS settable')
  assert.match(error.problem, /reviewerAgentPreset/, 'including the reviewer preset')
})

test('nothing is coerced: the string "true" is not true', () => {
  for (const value of ['true', 1, 0, null]) {
    assert.throws(
      () => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { intakeEnabled: value }),
      /intakeEnabled: must be a boolean/,
      `${JSON.stringify(value)} must be refused`,
    )
  }
})

test('autoReview is tri-state, and null is what clears the override', () => {
  const overridden = applyProjectSettingsPatch({ ...PROJECT_SETTINGS_DEFAULTS, autoReview: true }, { autoReview: false })
  assert.equal(overridden.autoReview, false, 'a boolean overrides')

  const cleared = applyProjectSettingsPatch({ ...PROJECT_SETTINGS_DEFAULTS, autoReview: false }, { autoReview: null })
  assert.equal(cleared.autoReview, undefined, 'null inherits')

  // `undefined` must NOT be accepted as "clear": the wire cannot tell it from "no edit",
  // and a JSON body cannot even carry it.
  assert.throws(
    () => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { autoReview: undefined }),
    /autoReview: must be true, false, or null to inherit/,
  )
})

test('a branch name is validated as a branch, or accepted empty as "auto"', () => {
  const ok = (value: string): string => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { defaultBranch: value }).defaultBranch
  assert.equal(ok(''), '', 'empty means "let git decide"')
  assert.equal(ok('main'), 'main')
  assert.equal(ok('release/1.2'), 'release/1.2')
  assert.equal(ok('feature_x-9'), 'feature_x-9')

  for (const bad of ['feature branch', '-oops', '/leading', 'trailing/', 'a//b', 'main..dev', 'HEAD~1', 'a:b']) {
    assert.throws(
      () => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { defaultBranch: bad }),
      /defaultBranch: /,
      `${JSON.stringify(bad)} must be refused`,
    )
  }
  // A revision range is the one that fails QUIETLY in git rather than erroring, which is
  // why `..` has its own message.
  assert.throws(
    () => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { defaultBranch: 'main..dev' }),
    /revision range/,
  )
})

test('a session prefix must be usable as a branch segment', () => {
  const ok = (value: string): string => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { sessionPrefix: value }).sessionPrefix
  assert.equal(ok(''), '', 'empty means "no namespace"')
  assert.equal(ok('web'), 'web')
  assert.equal(ok('web-2'), 'web-2')

  for (const bad of ['Web', 'web ui', '-web', 'web/', 'web_2', 'wéb']) {
    assert.throws(
      () => applyProjectSettingsPatch(PROJECT_SETTINGS_DEFAULTS, { sessionPrefix: bad }),
      /sessionPrefix: /,
      `${JSON.stringify(bad)} must be refused rather than silently slugified`,
    )
  }
})

test('the wire format keeps "inherit" distinct from "off"', () => {
  // Serializing an inherit as a missing key would let a client that read a payload and
  // sent it back turn "follow the plugin default" into something else.
  assert.equal(serializeProjectSettings({ ...PROJECT_SETTINGS_DEFAULTS }).autoReview, null)
  assert.equal(serializeProjectSettings({ ...PROJECT_SETTINGS_DEFAULTS, autoReview: false }).autoReview, false)
  assert.equal(serializeProjectSettings({ ...PROJECT_SETTINGS_DEFAULTS, intakeEnabled: false }).intakeEnabled, false)
})

test('normalizeRepo fills identity and settings from one partial record', () => {
  const repo = normalizeRepo({ id: 'repo-1', rootPath: '/code/widgets', defaultBranch: 'main' })
  assert.equal(repo.owner, '')
  assert.equal(repo.worktreeRoot, '.dsho/worktrees')
  assert.equal(repo.defaultBranch, 'main')
  assert.equal(repo.intakeEnabled, true)
  assert.deepEqual(repo.verifyCommands, [])
  // A branch is only ever written by `gh repo view`, so a non-empty one on an old record
  // means detection happened.
  assert.equal(repo.defaultBranchDetected, true)
  assert.equal(normalizeRepo({ id: 'r' }).defaultBranchDetected, false)
})
