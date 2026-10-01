/**
 * Plugin and per-repo configuration: defaults, validation, and the loud
 * standing-rules loader.
 *
 * This module is deliberately free of the schema library so the rules it encodes
 * are unit-testable without a DSH profile. `./config.js` is the thin adapter that
 * turns the same defaults and validators into the row's schemastery `Config`.
 *
 * The `agentRulesFile` handling is ported from Agent Orchestrator
 * `backend/internal/session_manager/prompt.go` (`buildProjectRules`,
 * `projectRelativeFile`). See NOTICE.
 *
 * The reference's own words on why a missing file is fatal:
 *
 *   "Missing/unreadable files are returned as errors so spawn can fail with a
 *    clear config problem instead of silently dropping standing rules."
 *
 * A rule the user wrote and the worker never received is worse than a failed
 * spawn, so this is one of the few places the plugin refuses to start work.
 *
 * @module dsho/config/validate
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, posix, sep, win32 } from 'node:path'

/** A configuration problem the user must fix. Always names the offending key. */
export class ConfigError extends Error {
  /**
   * @param {string} key
   * @param {string} problem
   */
  constructor(key, problem) {
    super(`${key}: ${problem}`)
    this.name = 'ConfigError'
    this.key = key
    this.problem = problem
  }
}

/**
 * Plugin-wide defaults.
 *
 * Every value here is either the PRD's stated default (§13) or, where the PRD
 * says the value was verified against the reference source, that verified
 * constant. The three flags that define the requested flow — `autoReview`,
 * `autoInjectReview`, `requireHumanApprovalBeforeReady` — all default to the
 * requested behaviour, so an unconfigured install does the right thing.
 */
export const PLUGIN_DEFAULTS = Object.freeze({
  defaultRepo: '',
  pollIntervalMs: 30_000,
  maxConcurrentWorkers: 2,
  workerPermissionPreset: 'workspace-write',
  workerAgentPreset: 'standard',
  /** `auto` | `notify` | `block` */
  planGate: 'notify',
  autoInjectReview: true,
  autoInjectCI: true,
  /** Our reviewer runs on every PR head. The requested feature; on by default. */
  autoReview: true,
  // --- review loop bounds (values verified against the reference source) ---
  maxReviewRounds: 3,
  autoReviewFailedRetryLimit: 3,
  reviewSweepIntervalMs: 60_000,
  reviewIdleThresholdMs: 60_000,
  noSignalGraceMs: 90_000,
  /** A human must approve before the card reaches Ready. Our divergence. */
  requireHumanApprovalBeforeReady: true,
  // --- worker report outbox (values verified against the reference source) ---
  reportBatchFallbackMs: 3_600_000,
  reportSettlementWindowMs: 300_000,
  reportInterruptWindowMs: 180_000,
  maxReportCharacters: 1_000,
  reviewerPermissionPreset: 'read-only',
  reviewerAgentPreset: 'standard',
  draftPrs: false,
  prBodyTemplate: 'default',
  hideWorktreeWorkspaces: false,
  webhook: Object.freeze({
    enabled: false,
    secretEnv: 'DSH_ORCHESTRATOR_WEBHOOK_SECRET',
  }),
})

/**
 * Per-repo defaults.
 *
 * The things that genuinely vary per repository live on the `Repo` record rather
 * than in the plugin config, modelled on the reference's `ProjectConfig` — which
 * the PRD calls "the accumulated answer to what did we actually need to configure
 * per repo".
 */
export const REPO_CONFIG_DEFAULTS = Object.freeze({
  defaultBranch: 'main',
  sessionPrefix: '',
  verifyCommands: Object.freeze([]),
  postCreate: Object.freeze([]),
  env: Object.freeze({}),
  agentRules: '',
  agentRulesFile: '',
  orchestratorRules: '',
  /** Per-repo override of the plugin's `autoReview`. */
  autoReview: undefined,
  reviewerAgentPreset: '',
  disabled: false,
})

/** The allowed values of `planGate`. */
export const PLAN_GATES = Object.freeze(['auto', 'notify', 'block'])

/** Keys whose value must be a positive integer of milliseconds. */
const POSITIVE_INT_KEYS = Object.freeze([
  'pollIntervalMs',
  'maxReviewRounds',
  'autoReviewFailedRetryLimit',
  'reviewSweepIntervalMs',
  'reviewIdleThresholdMs',
  'noSignalGraceMs',
  'reportBatchFallbackMs',
  'reportSettlementWindowMs',
  'reportInterruptWindowMs',
  'maxReportCharacters',
])

const BOOLEAN_KEYS = Object.freeze([
  'autoInjectReview',
  'autoInjectCI',
  'autoReview',
  'requireHumanApprovalBeforeReady',
  'draftPrs',
  'hideWorktreeWorkspaces',
])

const NON_EMPTY_STRING_KEYS = Object.freeze([
  'workerPermissionPreset',
  'workerAgentPreset',
  'reviewerPermissionPreset',
  'reviewerAgentPreset',
  'prBodyTemplate',
])

/**
 * Fills the plugin config with its defaults and validates it.
 *
 * Validation is deliberately explicit rather than delegated, so the error names
 * the key and the problem in the user's own vocabulary instead of a schema path.
 *
 * @param {object} [raw]
 * @returns {object} A new, fully-populated config.
 */
export function normalizePluginConfig(raw = {}) {
  const config = { ...PLUGIN_DEFAULTS, ...stripUndefined(raw) }
  config.webhook = { ...PLUGIN_DEFAULTS.webhook, ...stripUndefined(raw.webhook ?? {}) }

  for (const key of POSITIVE_INT_KEYS) {
    const value = config[key]
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(key, `must be a positive integer, got ${JSON.stringify(value)}`)
    }
  }
  if (!Number.isInteger(config.maxConcurrentWorkers) || config.maxConcurrentWorkers < 1) {
    throw new ConfigError(
      'maxConcurrentWorkers',
      `must be an integer >= 1, got ${JSON.stringify(config.maxConcurrentWorkers)}`,
    )
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof config[key] !== 'boolean') {
      throw new ConfigError(key, `must be a boolean, got ${JSON.stringify(config[key])}`)
    }
  }
  for (const key of NON_EMPTY_STRING_KEYS) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      throw new ConfigError(key, `must be a non-empty string, got ${JSON.stringify(config[key])}`)
    }
  }
  if (!PLAN_GATES.includes(config.planGate)) {
    throw new ConfigError('planGate', `must be one of ${PLAN_GATES.join(' | ')}, got ${JSON.stringify(config.planGate)}`)
  }
  // `defaultRepo` is deliberately allowed to be empty: an install may connect
  // repositories explicitly through `orchestrator_repo_connect` instead of
  // naming one up front. It must still be a string when given.
  if (typeof config.defaultRepo !== 'string') {
    throw new ConfigError('defaultRepo', `must be a string, got ${JSON.stringify(config.defaultRepo)}`)
  }
  if (typeof config.webhook.enabled !== 'boolean') {
    throw new ConfigError('webhook.enabled', 'must be a boolean')
  }
  if (typeof config.webhook.secretEnv !== 'string' || config.webhook.secretEnv.trim() === '') {
    throw new ConfigError('webhook.secretEnv', 'must be a non-empty string')
  }
  if (!Number.isInteger(config.maxReportCharacters) || config.maxReportCharacters < 1) {
    throw new ConfigError('maxReportCharacters', 'must be a positive integer')
  }
  return config
}

function stripUndefined(value) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined) out[key] = entry
  }
  return out
}

/**
 * Fills a per-repo config with its defaults.
 *
 * @param {object} [raw]
 * @returns {object}
 */
export function normalizeRepoConfig(raw = {}) {
  const config = { ...REPO_CONFIG_DEFAULTS, ...stripUndefined(raw) }
  if (!Array.isArray(config.verifyCommands)) {
    throw new ConfigError('verifyCommands', 'must be an array of command strings')
  }
  for (const [index, command] of config.verifyCommands.entries()) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new ConfigError(`verifyCommands[${index}]`, 'must be a non-empty string')
    }
  }
  if (!Array.isArray(config.postCreate)) {
    throw new ConfigError('postCreate', 'must be an array of command strings')
  }
  if (config.autoReview !== undefined && typeof config.autoReview !== 'boolean') {
    throw new ConfigError('autoReview', 'must be a boolean when set')
  }
  if (typeof config.disabled !== 'boolean') {
    throw new ConfigError('disabled', 'must be a boolean')
  }
  return config
}

/**
 * Resolves a repo-relative config path, refusing anything that could escape the
 * repository root.
 *
 * Ported from `projectRelativeFile`. Rejected, with the same message the
 * reference uses:
 *
 *   - an absolute path, including a Windows drive or UNC form;
 *   - a path that is `.` or `..`, or that starts with `../`;
 *   - **any `..` segment anywhere in the path.**
 *
 * That last point is a deliberate **tightening** of the reference, which cleans
 * the path first and therefore accepts `a/../b` because nothing escaping
 * survives the clean. A31 says a path containing `..` must fail, so the raw input
 * is checked before it is normalized. The cost is that a harmless-but-confusing
 * `a/../b` is rejected with a clear message; the benefit is that the acceptance
 * criterion is met by construction rather than by an argument about path algebra.
 *
 * @param {string} rootPath Absolute repository root.
 * @param {string} rel      The configured, repo-relative path.
 * @returns {string} The absolute path to read.
 */
export function resolveRepoRelativeFile(rootPath, rel) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new ConfigError('agentRulesFile', 'the repository path is required')
  }
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new ConfigError('agentRulesFile', 'must be repo-relative and must not escape the project root')
  }
  const trimmed = rel.trim()
  const escaped = 'must be repo-relative and must not escape the project root'

  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new ConfigError('agentRulesFile', escaped)
  }

  const slashPath = trimmed.split(sep).join('/').split('\\').join('/')
  if (slashPath.split('/').includes('..')) {
    throw new ConfigError('agentRulesFile', escaped)
  }

  const clean = posix.normalize(slashPath)
  if (clean === '.' || clean === '..' || clean.startsWith('../')) {
    throw new ConfigError('agentRulesFile', escaped)
  }
  if (clean.split('/').includes('..')) {
    throw new ConfigError('agentRulesFile', escaped)
  }

  return join(rootPath, normalize(clean))
}

/**
 * Loads a worker's standing rules from inline config plus an optional rules file.
 *
 * Ported from `buildProjectRules`. Inline rules come first, then the file's
 * contents, joined by a blank line — the order matters, because a repo file is
 * the more specific instruction.
 *
 * A missing or unreadable file is a **hard error**: see the module comment.
 *
 * @param {object} input
 * @param {string} [input.rootPath]        Absolute repository root.
 * @param {string} [input.agentRules]      Inline standing rules.
 * @param {string} [input.agentRulesFile]  Repo-relative path to a rules file.
 * @param {(path: string, encoding: string) => string} [input.readFile]
 *   Injected reader, so the failure paths are testable without touching disk.
 * @returns {string} The combined rules, possibly empty.
 */
export function loadAgentRules({ rootPath, agentRules, agentRulesFile, readFile } = {}) {
  const parts = []
  const inline = (agentRules ?? '').trim()
  if (inline !== '') parts.push(inline)

  const rel = (agentRulesFile ?? '').trim()
  if (rel !== '') {
    const path = resolveRepoRelativeFile(rootPath ?? '', rel)
    const read = readFile ?? readFileSync
    let data
    try {
      data = read(path, 'utf8')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new ConfigError('agentRulesFile', `could not read ${rel} (${path}): ${message}`)
    }
    const fromFile = String(data).trim()
    if (fromFile !== '') parts.push(fromFile)
  }

  return parts.join('\n\n')
}

/**
 * The workspace sandbox a worker runs under, from the repo/plugin config.
 *
 * Named separately because it is the first line of defence for R7 ("worker edits
 * outside its worktree"): the permission preset is an enforced boundary, and the
 * worktree-scoped `cwd` is the second.
 *
 * @param {object} input
 * @param {object} [input.pluginConfig]
 * @param {object} [input.repoConfig]
 * @returns {{workerPermissionPreset: string, reviewerPermissionPreset: string}}
 */
export function resolvePermissionPresets({ pluginConfig, repoConfig } = {}) {
  const plugin = normalizePluginConfig(pluginConfig)
  const repo = normalizeRepoConfig(repoConfig)
  return {
    workerPermissionPreset: plugin.workerPermissionPreset,
    reviewerPermissionPreset: plugin.reviewerPermissionPreset,
    repoDisabled: repo.disabled,
  }
}
