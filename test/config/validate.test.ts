/**
 * Configuration validation, and the standing-rules loader.
 *
 * Acceptance criteria covered: A31 — an absolute `agentRulesFile`, a path
 * containing `..`, or a missing file **fails loudly** with a config error rather
 * than starting a worker without its standing rules.
 *
 * The PRD's test plan asks for exactly this: "`agentRulesFile` rejects absolute
 * paths and any `..` segment, and a missing file fails the spawn rather than
 * silently dropping the rules."
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  ConfigError,
  PLUGIN_DEFAULTS,
  PLAN_GATES,
  REPO_CONFIG_DEFAULTS,
  loadAgentRules,
  normalizePluginConfig,
  normalizeRepoConfig,
  resolvePermissionPresets,
  resolveRepoRelativeFile,
} from '../../src/config/validate.ts'

const ROOT = '/Users/me/code/myrepo'

/** A reader that returns a fixed body, so no test touches disk. */
function readerReturning(body) {
  return () => body
}

/** A reader that fails, standing in for a missing file. */
function readerFailing(message = 'ENOENT: no such file or directory') {
  return () => {
    throw new Error(message)
  }
}

// ---------------------------------------------------------------------------
// agentRulesFile — A31
// ---------------------------------------------------------------------------

test('A31 — an absolute agentRulesFile is rejected', async (t) => {
  const absolute = [
    '/etc/passwd',
    '/Users/me/code/myrepo/AGENTS.md',
    '\\Windows\\system32\\config',
    'C:\\Users\\me\\AGENTS.md',
    'C:/Users/me/AGENTS.md',
  ]
  for (const value of absolute) {
    await t.test(value, () => {
      assert.throws(() => resolveRepoRelativeFile(ROOT, value), ConfigError)
    })
  }
})

test('A31 — any `..` segment is rejected, escaping or not', async (t) => {
  const escaping = ['..', '../AGENTS.md', '../../etc/passwd', 'docs/../../AGENTS.md', '..\\AGENTS.md']
  for (const value of escaping) {
    await t.test(value, () => {
      assert.throws(() => resolveRepoRelativeFile(ROOT, value), ConfigError)
    })
  }

  await t.test('a `..` that would not escape is still rejected, deliberately', () => {
    // The reference cleans the path first and would therefore accept `a/../b`.
    // We check the raw input, because A31 says a path containing `..` must fail.
    // The error message tells the user what to write instead.
    assert.throws(() => resolveRepoRelativeFile(ROOT, 'a/../b'), ConfigError)
  })
})

test('A31 — a missing file fails loudly, naming the key and the path', () => {
  assert.throws(
    () =>
      loadAgentRules({
        rootPath: ROOT,
        agentRulesFile: 'docs/AGENTS.md',
        readFile: readerFailing(),
      }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.key, 'agentRulesFile')
      assert.match(error.message, /docs\/AGENTS\.md/)
      assert.match(error.message, new RegExp(join(ROOT, 'docs/AGENTS.md').replaceAll('/', '\\/')))
      return true
    },
  )
})

test('a well-formed agentRulesFile resolves inside the repo root', () => {
  assert.equal(resolveRepoRelativeFile(ROOT, 'AGENTS.md'), join(ROOT, 'AGENTS.md'))
  assert.equal(resolveRepoRelativeFile(ROOT, 'docs/AGENTS.md'), join(ROOT, 'docs/AGENTS.md'))
  assert.equal(resolveRepoRelativeFile(ROOT, './docs/AGENTS.md'), join(ROOT, 'docs/AGENTS.md'))
  assert.equal(resolveRepoRelativeFile(ROOT, 'docs//AGENTS.md'), join(ROOT, 'docs/AGENTS.md'))
  assert.equal(resolveRepoRelativeFile(ROOT, 'docs\\AGENTS.md'), join(ROOT, 'docs/AGENTS.md'))
  assert.equal(resolveRepoRelativeFile(ROOT, '  docs/AGENTS.md  '), join(ROOT, 'docs/AGENTS.md'))
})

test('resolveRepoRelativeFile refuses an empty or unusable root or path', () => {
  assert.throws(() => resolveRepoRelativeFile('', 'AGENTS.md'), ConfigError)
  assert.throws(() => resolveRepoRelativeFile(ROOT, ''), ConfigError)
  assert.throws(() => resolveRepoRelativeFile(ROOT, '   '), ConfigError)
})

test('loadAgentRules: inline rules come first, then the file', () => {
  const rules = loadAgentRules({
    rootPath: ROOT,
    agentRules: 'Always run pnpm typecheck.',
    agentRulesFile: 'AGENTS.md',
    readFile: readerReturning('Prefer the repo patterns.\n'),
  })
  assert.equal(rules, 'Always run pnpm typecheck.\n\nPrefer the repo patterns.')
})

test('loadAgentRules: each source may stand alone, and empty means empty', async (t) => {
  await t.test('inline only', () => {
    assert.equal(loadAgentRules({ rootPath: ROOT, agentRules: 'Be careful.' }), 'Be careful.')
  })
  await t.test('file only', () => {
    assert.equal(
      loadAgentRules({ rootPath: ROOT, agentRulesFile: 'AGENTS.md', readFile: readerReturning('Read the docs.') }),
      'Read the docs.',
    )
  })
  await t.test('neither', () => {
    assert.equal(loadAgentRules({ rootPath: ROOT }), '')
    assert.equal(loadAgentRules({}), '')
  })
  await t.test('a whitespace-only file contributes nothing', () => {
    assert.equal(
      loadAgentRules({ rootPath: ROOT, agentRules: 'Keep it scoped.', agentRulesFile: 'AGENTS.md', readFile: readerReturning('  \n\n ') }),
      'Keep it scoped.',
    )
  })
})

test('loadAgentRules does not read at all when no file is configured', () => {
  // The reader throws on any call, so a read means the test fails.
  assert.equal(loadAgentRules({ rootPath: ROOT, readFile: readerFailing() }), '')
})

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

test('the plugin defaults are the requested behaviour out of the box', () => {
  const config = normalizePluginConfig()
  assert.equal(config.autoReview, true, 'our reviewer runs on every PR head')
  assert.equal(config.autoInjectReview, true, 'findings close the loop without you')
  assert.equal(config.requireHumanApprovalBeforeReady, true, 'a human gates Ready')
})

test('the verified constants match the PRD §13 values', () => {
  assert.equal(PLUGIN_DEFAULTS.maxReviewRounds, 3)
  assert.equal(PLUGIN_DEFAULTS.autoReviewFailedRetryLimit, 3)
  assert.equal(PLUGIN_DEFAULTS.reviewSweepIntervalMs, 60_000)
  assert.equal(PLUGIN_DEFAULTS.reviewIdleThresholdMs, 60_000)
  assert.equal(PLUGIN_DEFAULTS.noSignalGraceMs, 90_000)
  assert.equal(PLUGIN_DEFAULTS.reportBatchFallbackMs, 3_600_000)
  assert.equal(PLUGIN_DEFAULTS.reportSettlementWindowMs, 300_000)
  assert.equal(PLUGIN_DEFAULTS.reportInterruptWindowMs, 180_000)
  assert.equal(PLUGIN_DEFAULTS.maxReportCharacters, 1_000)
  assert.equal(PLUGIN_DEFAULTS.pollIntervalMs, 30_000)
  assert.equal(PLUGIN_DEFAULTS.maxConcurrentWorkers, 2)
  assert.equal(PLUGIN_DEFAULTS.workerPermissionPreset, 'workspace-write')
  assert.equal(PLUGIN_DEFAULTS.reviewerPermissionPreset, 'read-only')
  assert.equal(PLUGIN_DEFAULTS.webhook.enabled, false)
})

test('normalizePluginConfig keeps an override and defaults the rest', () => {
  const config = normalizePluginConfig({ maxConcurrentWorkers: 4, autoReview: false })
  assert.equal(config.maxConcurrentWorkers, 4)
  assert.equal(config.autoReview, false)
  assert.equal(config.maxReviewRounds, 3, 'untouched keys keep their default')
})

test('normalizePluginConfig does not mutate its input', () => {
  const raw = { autoReview: false, webhook: { enabled: true } }
  const snapshot = structuredClone(raw)
  normalizePluginConfig(raw)
  assert.deepEqual(raw, snapshot)
})

test('normalizePluginConfig rejects a bad planGate', () => {
  assert.throws(() => normalizePluginConfig({ planGate: 'sometimes' }), ConfigError)
  for (const gate of PLAN_GATES) {
    assert.equal(normalizePluginConfig({ planGate: gate }).planGate, gate)
  }
})

test('normalizePluginConfig rejects non-positive and non-integer bounds', async (t) => {
  const cases = [
    ['a zero interval', { pollIntervalMs: 0 }],
    ['a negative bound', { maxReviewRounds: -1 }],
    ['a fractional bound', { noSignalGraceMs: 1.5 }],
    ['a string bound', { reviewSweepIntervalMs: '60000' }],
    ['a bound of null', { reportInterruptWindowMs: null }],
  ]
  for (const [name, raw] of cases) {
    await t.test(name, () => {
      assert.throws(() => normalizePluginConfig(raw), ConfigError)
    })
  }

  await t.test('maxConcurrentWorkers may not be zero', () => {
    assert.throws(() => normalizePluginConfig({ maxConcurrentWorkers: 0 }), ConfigError)
  })

  await t.test('the error names the key', () => {
    assert.throws(() => normalizePluginConfig({ maxReviewRounds: 0 }), /maxReviewRounds/)
  })
})

test('normalizePluginConfig rejects a non-boolean flag', () => {
  assert.throws(() => normalizePluginConfig({ autoReview: 'yes' }), ConfigError)
  assert.throws(() => normalizePluginConfig({ requireHumanApprovalBeforeReady: 1 }), ConfigError)
})

test('normalizePluginConfig rejects an empty preset name', () => {
  assert.throws(() => normalizePluginConfig({ reviewerPermissionPreset: '' }), ConfigError)
  assert.throws(() => normalizePluginConfig({ workerPermissionPreset: '   ' }), ConfigError)
})

test('normalizePluginConfig merges a partial webhook block', () => {
  const config = normalizePluginConfig({ webhook: { enabled: true } })
  assert.equal(config.webhook.enabled, true)
  assert.equal(config.webhook.secretEnv, PLUGIN_DEFAULTS.webhook.secretEnv)
})

// ---------------------------------------------------------------------------
// Per-repo config
// ---------------------------------------------------------------------------

test('repo defaults are inert', () => {
  const repo = normalizeRepoConfig()
  assert.deepEqual(repo.verifyCommands, [])
  assert.deepEqual(repo.postCreate, [])
  assert.equal(repo.agentRules, '')
  assert.equal(repo.agentRulesFile, '')
  assert.equal(repo.disabled, false)
  assert.equal(repo.autoReview, undefined, 'unset means "inherit the plugin default"')
})

test('repo config rejects malformed command lists', () => {
  assert.throws(() => normalizeRepoConfig({ verifyCommands: 'pnpm test' }), ConfigError)
  assert.throws(() => normalizeRepoConfig({ verifyCommands: [''] }), ConfigError)
  assert.throws(() => normalizeRepoConfig({ verifyCommands: ['pnpm test', 3] }), ConfigError)
  assert.throws(() => normalizeRepoConfig({ postCreate: { install: 'pnpm i' } }), ConfigError)
})

test('repo config accepts a per-repo autoReview override in both directions', () => {
  assert.equal(normalizeRepoConfig({ autoReview: false }).autoReview, false)
  assert.equal(normalizeRepoConfig({ autoReview: true }).autoReview, true)
  assert.throws(() => normalizeRepoConfig({ autoReview: 'no' }), ConfigError)
})

test('REPO_CONFIG_DEFAULTS is not mutated by normalization', () => {
  const before = structuredClone(REPO_CONFIG_DEFAULTS)
  normalizeRepoConfig({ verifyCommands: ['pnpm test'] })
  assert.deepEqual(REPO_CONFIG_DEFAULTS, before)
})

test('resolvePermissionPresets: the worker writes, the reviewer does not', () => {
  const presets = resolvePermissionPresets({})
  assert.equal(presets.workerPermissionPreset, 'workspace-write')
  assert.equal(presets.reviewerPermissionPreset, 'read-only')
  assert.notEqual(
    presets.workerPermissionPreset,
    presets.reviewerPermissionPreset,
    'separation of duties depends on these differing',
  )
})

test('resolvePermissionPresets reports a disabled repo', () => {
  assert.equal(resolvePermissionPresets({ repoConfig: { disabled: true } }).repoDisabled, true)
  assert.equal(resolvePermissionPresets({}).repoDisabled, false)
})
