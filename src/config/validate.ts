/**
 * Plugin and per-repo configuration: defaults, validation, and the loud
 * standing-rules loader.
 *
 * This module is deliberately free of the schema library so the rules it encodes
 * are unit-testable without a DSH profile. `./config.ts` is the thin adapter that
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
  readonly key: string
  readonly problem: string

  constructor(key: string, problem: string) {
    super(`${key}: ${problem}`)
    this.name = 'ConfigError'
    this.key = key
    this.problem = problem
  }
}

/** The webhook block of the plugin config. */
export interface WebhookConfig {
  enabled: boolean
  secretEnv: string
}

/** The allowed values of `planGate`. */
export const PLAN_GATES = Object.freeze(['auto', 'notify', 'block'] as const)

/** How far the plan gate may hold a worker before it implements. */
export type PlanGate = (typeof PLAN_GATES)[number]

/**
 * The fully-populated plugin config.
 *
 * Declared as an interface rather than inferred from {@link PLUGIN_DEFAULTS}, so
 * the fields widen to `number` / `boolean` / `string` instead of freezing to the
 * literal values of the defaults. Inferring literal types would make
 * `normalizePluginConfig({ maxConcurrentWorkers: 4 })` a type error, which is
 * exactly backwards: overriding a default is the whole point of the object.
 */
export interface PluginConfig {
  defaultRepo: string
  pollIntervalMs: number
  maxConcurrentWorkers: number
  workerPermissionPreset: string
  workerAgentPreset: string
  planGate: PlanGate
  autoInjectReview: boolean
  autoInjectCI: boolean
  autoReview: boolean
  // --- review loop bounds (values verified against the reference source) ---
  maxReviewRounds: number
  /** How many times a HUMAN review may be routed to one worker per commit (M4). */
  reviewMaxNudge: number
  autoReviewFailedRetryLimit: number
  reviewSweepIntervalMs: number
  reviewIdleThresholdMs: number
  noSignalGraceMs: number
  /** A human must approve before the card reaches Ready. Our divergence. */
  requireHumanApprovalBeforeReady: boolean
  // --- worker report outbox (values verified against the reference source) ---
  reportBatchFallbackMs: number
  reportSettlementWindowMs: number
  reportInterruptWindowMs: number
  maxReportCharacters: number
  reviewerPermissionPreset: string
  reviewerAgentPreset: string
  draftPrs: boolean
  prBodyTemplate: string
  hideWorktreeWorkspaces: boolean
  webhook: WebhookConfig
}

/**
 * Plugin-wide defaults.
 *
 * Every value here is either the PRD's stated default (§13) or, where the PRD
 * says the value was verified against the reference source, that verified
 * constant. `autoReview` and `autoInjectReview` — the two flags that make the
 * requested flow happen — default on, so an unconfigured install reviews every
 * PR head and routes the findings back to the worker.
 *
 * `requireHumanApprovalBeforeReady` is the exception, and the user overruled the
 * PRD on it: see the field's own note below.
 */
export const PLUGIN_DEFAULTS: Readonly<PluginConfig> = Object.freeze({
  defaultRepo: '',
  pollIntervalMs: 30_000,
  maxConcurrentWorkers: 2,
  /**
   * Full access, because a worker's own workflow cannot complete without it.
   *
   * A linked git worktree keeps no git data of its own: `.git` in the worktree is a
   * one-line `gitdir:` pointer into the PARENT repo's `.git/worktrees/<name>`. Under
   * `workspace-write` the sandbox root is the worktree, so the index, refs and objects
   * git must write are all outside it — `git add`, `git commit` and `git push` are
   * refused, the worker escalates, and `approval: ask` stalls it on a prompt no one is
   * there to answer. The pipeline this plugin exists to run cannot finish that way, so
   * the default is the boundary that works. Per project via
   * `workerPermissionPreset` in the settings page.
   */
  workerPermissionPreset: 'danger-full-access',
  workerAgentPreset: 'standard',
  planGate: 'notify',
  autoInjectReview: true,
  autoInjectCI: true,
  /** Our reviewer runs on every PR head. The requested feature; on by default. */
  autoReview: true,
  maxReviewRounds: 3,
  reviewMaxNudge: 3,
  autoReviewFailedRetryLimit: 3,
  reviewSweepIntervalMs: 60_000,
  reviewIdleThresholdMs: 60_000,
  noSignalGraceMs: 90_000,
  /**
   * No human gate by default — Agent Orchestrator's own behaviour.
   *
   * This is the PRD's invited divergence (§7.6 row 6, A17, D3) and it shipped ON,
   * because the requested flow says "human review will be after that" and an
   * auto-approved, mergeable PR would otherwise reach `Ready` with nobody having
   * looked at it. **The user asked for the default to be OFF**, so an unconfigured
   * install now behaves exactly like AO: our own pass approving a mergeable PR is
   * enough to reach `Ready`.
   *
   * Nothing about the capability changed — the row is still in the reducer, and a
   * profile (or the plugin settings page) that sets this to `true` gets the gate
   * back for its own deployment. What changed is which behaviour is the surprise:
   * a deployment that wants a person in the loop now has to ask for one.
   *
   * Recorded, because the difference is invisible from the board: a card reaching
   * `Ready` on mergeability alone used to mean the gate had been defeated, and now
   * it is simply the default. §7.6's row order makes that visible in the code, and
   * `orchestrator_config` prints the flag with a `(default)`/`(overridden)` marker
   * so the tool output says which one is in force.
   */
  requireHumanApprovalBeforeReady: false,
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

/** What a caller may supply to override the plugin defaults. */
export type PluginConfigInput = Partial<Omit<PluginConfig, 'webhook'>> & {
  webhook?: Partial<WebhookConfig>
}

/**
 * The fully-populated per-repo config.
 *
 * The things that genuinely vary per repository live on the `Repo` record rather
 * than in the plugin config, modelled on the reference's `ProjectConfig` — which
 * the PRD calls "the accumulated answer to what did we actually need to configure
 * per repo".
 */
export interface RepoConfig {
  defaultBranch: string
  sessionPrefix: string
  /** The Verify stage contract (PRD §8.1). */
  verifyCommands: readonly string[]
  /** Commands to run after worktree creation. */
  postCreate: readonly string[]
  env: Readonly<Record<string, string>>
  agentRules: string
  agentRulesFile: string
  orchestratorRules: string
  /** Per-repo override of the plugin's `autoReview`. */
  autoReview: boolean | undefined
  reviewerAgentPreset: string
  disabled: boolean
}

/** Per-repo defaults. */
export const REPO_CONFIG_DEFAULTS: Readonly<RepoConfig> = Object.freeze({
  defaultBranch: 'main',
  sessionPrefix: '',
  verifyCommands: Object.freeze([]) as readonly string[],
  postCreate: Object.freeze([]) as readonly string[],
  env: Object.freeze({}) as Readonly<Record<string, string>>,
  agentRules: '',
  agentRulesFile: '',
  orchestratorRules: '',
  autoReview: undefined,
  reviewerAgentPreset: '',
  disabled: false,
})

/** What a caller may supply to override the per-repo defaults. */
export type RepoConfigInput = Partial<RepoConfig>

/** Keys whose value must be a positive integer of milliseconds. */
const POSITIVE_INT_KEYS = [
  'pollIntervalMs',
  'maxReviewRounds',
  'reviewMaxNudge',
  'autoReviewFailedRetryLimit',
  'reviewSweepIntervalMs',
  'reviewIdleThresholdMs',
  'noSignalGraceMs',
  'reportBatchFallbackMs',
  'reportSettlementWindowMs',
  'reportInterruptWindowMs',
  'maxReportCharacters',
] as const

const BOOLEAN_KEYS = [
  'autoInjectReview',
  'autoInjectCI',
  'autoReview',
  'requireHumanApprovalBeforeReady',
  'draftPrs',
  'hideWorktreeWorkspaces',
] as const

const NON_EMPTY_STRING_KEYS = [
  'workerPermissionPreset',
  'workerAgentPreset',
  'reviewerPermissionPreset',
  'reviewerAgentPreset',
  'prBodyTemplate',
] as const

/**
 * Fills the plugin config with its defaults and validates it.
 *
 * Validation is deliberately explicit rather than delegated, so the error names
 * the key and the problem in the user's own vocabulary instead of a schema path.
 */
export function normalizePluginConfig(raw: PluginConfigInput = {}): PluginConfig {
  // `webhook` is destructured out of the spread so the merged object keeps
  // `PluginConfig`'s exact shape instead of inheriting the input's
  // `webhook?: Partial<WebhookConfig>`. It is rebuilt field by field below, and
  // the values are still *not* coerced — a non-boolean `enabled` survives to the
  // validation further down and is rejected there, which is where the
  // user-facing error belongs.
  const { webhook: webhookInput, ...rest } = raw
  const config: PluginConfig = { ...PLUGIN_DEFAULTS, ...stripUndefined(rest) }
  const webhook = webhookInput ?? {}
  config.webhook = {
    enabled: webhook.enabled ?? PLUGIN_DEFAULTS.webhook.enabled,
    secretEnv: webhook.secretEnv ?? PLUGIN_DEFAULTS.webhook.secretEnv,
  }

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
  if (!(PLAN_GATES as readonly string[]).includes(config.planGate)) {
    throw new ConfigError(
      'planGate',
      `must be one of ${PLAN_GATES.join(' | ')}, got ${JSON.stringify(config.planGate)}`,
    )
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
  return config
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined) out[key] = entry
  }
  return out as T
}

/** Fills a per-repo config with its defaults. */
export function normalizeRepoConfig(raw: RepoConfigInput = {}): RepoConfig {
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
 */
export function resolveRepoRelativeFile(rootPath: string, rel: string): string {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new ConfigError('agentRulesFile', 'the repository path is required')
  }
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new ConfigError('agentRulesFile', 'must be repo-relative and must not escape the project root')
  }
  const trimmed = rel.trim()
  const escaped = 'must be repo-relative and must not escape the project root'

  if (
    isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\')
  ) {
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

/** The reader the rules loader uses; injectable so failure paths are testable. */
export type RulesReader = (path: string, encoding: 'utf8') => string

/**
 * Loads a worker's standing rules from inline config plus an optional rules file.
 *
 * Ported from `buildProjectRules`. Inline rules come first, then the file's
 * contents, joined by a blank line — the order matters, because a repo file is
 * the more specific instruction.
 *
 * A missing or unreadable file is a **hard error**: see the module comment.
 */
export function loadAgentRules(
  input: {
    rootPath?: string
    agentRules?: string
    agentRulesFile?: string
    readFile?: RulesReader
  } = {},
): string {
  const parts: string[] = []
  const inline = (input.agentRules ?? '').trim()
  if (inline !== '') parts.push(inline)

  const rel = (input.agentRulesFile ?? '').trim()
  if (rel !== '') {
    const path = resolveRepoRelativeFile(input.rootPath ?? '', rel)
    const read: RulesReader = input.readFile ?? (readFileSync as unknown as RulesReader)
    let data: string
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
 * The permission presets a worker and a reviewer run under.
 *
 * Named separately because the worker's preset is the first line of defence for
 * R7 ("worker edits outside its worktree"): the preset is an enforced boundary,
 * and the worktree-scoped `cwd` is the second.
 */
export function resolvePermissionPresets(input: {
  pluginConfig?: PluginConfigInput
  repoConfig?: RepoConfigInput
} = {}): {
  workerPermissionPreset: string
  reviewerPermissionPreset: string
  repoDisabled: boolean
} {
  const plugin = normalizePluginConfig(input.pluginConfig)
  const repo = normalizeRepoConfig(input.repoConfig)
  return {
    workerPermissionPreset: plugin.workerPermissionPreset,
    reviewerPermissionPreset: plugin.reviewerPermissionPreset,
    repoDisabled: repo.disabled,
  }
}
