/**
 * The per-project settings: what the settings page reads and writes.
 *
 * This is the **operative** per-project configuration, and it is deliberately a
 * small subset of `RepoConfig` in `../config/validate.ts`. The rule that decided
 * the subset is the one this project keeps relearning: **a setting nothing reads
 * is worse than no setting at all.** Every field here is consumed by acting code,
 * and each says where:
 *
 * | Setting | Read by |
 * |---|---|
 * | `defaultBranch` | `workers-service` (the worktree's base) and `reviewer-service` (the PR's base) |
 * | `sessionPrefix` | `WorktreeManager.create` → `branchName`, as the branch's namespace segment |
 * | `intakeEnabled` | `fillSlots`, which auto-spawns workers for queued issues |
 * | `workerAgentPreset` | the spawn recipe, as the worker session's agent preset |
 * | `workerPermissionPreset` | `workers-service`, as the sandbox/approval boundary a worker is created under |
 * | `autoReview` | `startReviewPass`, as the per-repo override of the plugin default |
 *
 * The remaining `RepoConfig` fields (`verifyCommands` excepted, which lives on the
 * `Repo` record) are *not* re-exposed here. `postCreate`, `env`, `agentRules*` and
 * `orchestratorRules` are real PRD §13.1 requirements whose consumers are the spawn
 * path's later stages; wiring a text box to a field nothing reads would make the
 * page lie about what it controls.
 *
 * ## Live reads, not a cached copy
 *
 * Settings are stored **on the `Repo` record**, which is where the reference keeps
 * them too, and where `reviewer-service` already looked for `autoReview` before this
 * module existed. Nothing caches them: a settings change is visible to the next
 * spawn, the next review pass and the next board build, with no reload and no second
 * copy to keep in step.
 *
 * ## Patch semantics, and why `null` is not `false`
 *
 * `autoReview` is a *tri-state*: `true`, `false`, or "inherit the plugin default".
 * The page can only express that honestly if the wire format distinguishes the third
 * state, so a patch writes `null` to clear the override and a boolean to set it. An
 * earlier shape made `undefined` mean "unchanged", which silently collapsed "clear
 * this override" into "leave it alone" — the one edit a user makes when they want a
 * repo to follow the plugin again.
 *
 * @module dsho/host/repo-settings
 */

/**
 * A per-project setting the user must fix. Names the key and the problem, in the
 * user's own vocabulary rather than a schema path — the same contract
 * {@link import('../config/validate.ts').ConfigError} keeps.
 */
export class ProjectSettingsError extends Error {
  readonly key: string
  readonly problem: string

  constructor(key: string, problem: string) {
    super(`${key}: ${problem}`)
    this.name = 'ProjectSettingsError'
    this.key = key
    this.problem = problem
  }
}

/**
 * One project's settings.
 *
 * `defaultBranch: ''` and `workerAgentPreset: ''` both mean "no opinion": an empty
 * branch lets git base the worktree on the checkout's own HEAD, and an empty preset
 * falls back to the plugin's `workerAgentPreset`. Both are real, reachable states —
 * a repo connected before `gh repo view` could report a default branch reads exactly
 * like this, and it must not become an error on the next read.
 */
export interface ProjectSettings {
  /** Base for worktrees and pull requests. Empty means "let git decide". */
  defaultBranch: string
  /** Branch-namespace segment: `dsho/<prefix>/issue-<n>-<slug>`. */
  sessionPrefix: string
  /** Whether queued issues in this project are auto-started. */
  intakeEnabled: boolean
  /** The agent preset this project's workers run as. Empty = the plugin default. */
  workerAgentPreset: string
  /**
   * The PERMISSION preset this project's workers run under. Empty = the plugin default.
   *
   * Per project because the right answer is a property of the repository, not the install:
   * a throwaway sandbox repo and a monorepo with production credentials in `.env` should not
   * be forced to share one boundary.
   *
   * The plugin default is `danger-full-access`, and that is not laziness. A worker commits
   * and pushes, and a **linked git worktree keeps no git data of its own** — its `.git` is a
   * one-line `gitdir:` pointer into the PARENT repository's `.git/worktrees/<name>`. Under
   * `workspace-write` the index, refs and objects are all outside the sandbox root, so
   * `git add`, `git commit` and `git push` are refused and the worker stalls on an approval
   * prompt that no one is there to answer. The stages this plugin exists to run cannot
   * complete under a worktree-scoped sandbox, so the honest default is the one that works;
   * a project that wants a tighter boundary sets it here.
   */
  workerPermissionPreset: string
  /**
   * The agent preset this project's REVIEWER runs as. Empty = the plugin default.
   *
   * PRD §13.1 requires this per repo -- "a heavy repo can use a stricter reviewer" -- and
   * the reference stores it per project for the same reason. Until this field existed the
   * per-repo `RepoConfig.reviewerAgentPreset` was validated and read by nothing, so the
   * only reviewer preset an install could have was the plugin's.
   */
  reviewerAgentPreset: string
  /** Per-project override of the plugin's `autoReview`. `undefined` = inherit. */
  autoReview: boolean | undefined
}

/** The keys the settings page owns, in the order the page renders them. */
export const PROJECT_SETTINGS_KEYS = Object.freeze([
  'defaultBranch',
  'sessionPrefix',
  'intakeEnabled',
  'workerAgentPreset',
  'workerPermissionPreset',
  'reviewerAgentPreset',
  'autoReview',
] as const)

/** One settings key. */
export type ProjectSettingsKey = (typeof PROJECT_SETTINGS_KEYS)[number]

/**
 * Per-project defaults.
 *
 * `intakeEnabled` defaults **true** because that is the behaviour the plugin already
 * had: `fillSlots` started queued work with no per-repo switch at all. Defaulting it
 * false would silently stop queued work in every existing install on upgrade, which
 * is precisely the kind of change a settings page must never cause by being added.
 */
export const PROJECT_SETTINGS_DEFAULTS: Readonly<ProjectSettings> = Object.freeze({
  defaultBranch: '',
  sessionPrefix: '',
  intakeEnabled: true,
  workerAgentPreset: '',
  workerPermissionPreset: '',
  reviewerAgentPreset: '',
  autoReview: undefined,
})

/**
 * Reads the settings off a stored record, filling the defaults.
 *
 * This is the real validator, not a schema: a record written before these fields
 * existed reads as the defaults, which is how a record predating a field is supposed
 * to behave. A strict schema would *reject* that record instead, and make every
 * future field addition a migration — the reasoning `./schemas.ts` states for the
 * tables, applied to one record's fields.
 */
export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const record = asRecord(raw)
  return {
    defaultBranch: asString(record.defaultBranch, PROJECT_SETTINGS_DEFAULTS.defaultBranch),
    sessionPrefix: asString(record.sessionPrefix, PROJECT_SETTINGS_DEFAULTS.sessionPrefix),
    intakeEnabled:
      typeof record.intakeEnabled === 'boolean' ? record.intakeEnabled : PROJECT_SETTINGS_DEFAULTS.intakeEnabled,
    workerAgentPreset: asString(record.workerAgentPreset, PROJECT_SETTINGS_DEFAULTS.workerAgentPreset),
    workerPermissionPreset: asString(
      record.workerPermissionPreset,
      PROJECT_SETTINGS_DEFAULTS.workerPermissionPreset,
    ),
    reviewerAgentPreset: asString(record.reviewerAgentPreset, PROJECT_SETTINGS_DEFAULTS.reviewerAgentPreset),
    autoReview: typeof record.autoReview === 'boolean' ? record.autoReview : undefined,
  }
}

/** A stored or supplied settings object, without assuming its shape. */
function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function asString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback
}

/**
 * A patch, as the settings route receives it.
 *
 * Every value is `unknown` on purpose: the route's body is user input, and the
 * point of this module is to decide what is acceptable rather than to trust a cast.
 */
export type ProjectSettingsPatch = Partial<Record<ProjectSettingsKey, unknown>>

/**
 * Applies a validated patch to the current settings.
 *
 * Three rules, each of which is a bug that would otherwise ship:
 *
 *   - **an unknown key is refused**, not ignored. A page that sends `sessionprefix`
 *     would otherwise report success while changing nothing.
 *   - **a present key is written, `null` included.** `null` clears a tri-state
 *     (`autoReview` → inherit); it never means "leave it alone".
 *   - **nothing is coerced.** `'true'` is not `true`, and `5` is not a branch. A
 *     silent coercion is how a switch ends up unable to be turned off.
 *
 * @throws {ProjectSettingsError} naming the offending key.
 */
export function applyProjectSettingsPatch(current: ProjectSettings, patch: unknown): ProjectSettings {
  const record = asRecord(patch)
  const next: ProjectSettings = { ...normalizeProjectSettings(current) }

  for (const key of Object.keys(record)) {
    if (!(PROJECT_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new ProjectSettingsError(key, `is not a project setting (known: ${PROJECT_SETTINGS_KEYS.join(', ')})`)
    }
  }

  if ('defaultBranch' in record) next.defaultBranch = validateBranch(record.defaultBranch)
  if ('sessionPrefix' in record) next.sessionPrefix = validatePrefix(record.sessionPrefix)
  if ('intakeEnabled' in record) next.intakeEnabled = validateBoolean('intakeEnabled', record.intakeEnabled)
  if ('workerAgentPreset' in record) next.workerAgentPreset = validatePreset('workerAgentPreset', record.workerAgentPreset)
  if ('workerPermissionPreset' in record) {
    next.workerPermissionPreset = validatePreset('workerPermissionPreset', record.workerPermissionPreset)
  }
  if ('reviewerAgentPreset' in record) next.reviewerAgentPreset = validatePreset('reviewerAgentPreset', record.reviewerAgentPreset)
  if ('autoReview' in record) next.autoReview = validateOverride('autoReview', record.autoReview)

  return next
}

/**
 * A branch name, or empty for "let git decide".
 *
 * The rules are git's own ref-format rules, restricted to what a base branch can
 * legitimately be. `..` is refused because it is a revision *range* in git, and a
 * range where a branch is expected resolves to something surprising rather than to
 * an error.
 */
function validateBranch(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw !== 'string') {
    throw new ProjectSettingsError('defaultBranch', `must be a string, got ${JSON.stringify(raw)}`)
  }
  const value = raw.trim()
  if (value === '') return ''
  if (value.includes('..')) {
    throw new ProjectSettingsError('defaultBranch', 'must not contain "..", which git reads as a revision range')
  }
  if (!/^(?![-/])[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/.test(value) || value.includes('//')) {
    throw new ProjectSettingsError(
      'defaultBranch',
      `must be a branch name (letters, digits, ".", "_", "-" and "/"), or empty to detect it — got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

/**
 * A branch-namespace segment.
 *
 * Constrained to lowercase letters, digits and dashes because the value is inserted
 * into a branch name **and** a filesystem path by `branchName`. Accepting uppercase
 * or spaces would make `dsho/<prefix>/issue-3-…` a branch whose name depends on how
 * `slugify` happens to fold it, and a setting whose effect is invisible on the page
 * is worse than one that is refused with a message.
 */
function validatePrefix(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw !== 'string') {
    throw new ProjectSettingsError('sessionPrefix', `must be a string, got ${JSON.stringify(raw)}`)
  }
  const value = raw.trim()
  if (value === '') return ''
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new ProjectSettingsError(
      'sessionPrefix',
      `must be lowercase letters, digits and dashes (it becomes a branch segment), or empty — got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

function validateBoolean(key: ProjectSettingsKey, raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throw new ProjectSettingsError(key, `must be a boolean, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/**
 * A preset name, or empty for "use the plugin default".
 *
 * No host catalogue is read here, and that is deliberate: the settings page must work in a
 * profile whose preset service is absent, the resolution already fails loudly at spawn, and
 * a validator that could disagree with the host about which names exist would be a second
 * source of truth for someone else's registry.
 */
function validatePreset(key: ProjectSettingsKey, raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw !== 'string') {
    throw new ProjectSettingsError(key, `must be a string, got ${JSON.stringify(raw)}`)
  }
  return raw.trim()
}

/**
 * The tri-state. `null` clears the override; a boolean sets it.
 *
 * Both `null` and a boolean are accepted, and anything else is refused — including
 * `undefined`, which would make "clear it" indistinguishable from "no edit" if it
 * were allowed to pass.
 */
function validateOverride(key: ProjectSettingsKey, raw: unknown): boolean | undefined {
  if (raw === null) return undefined
  if (typeof raw !== 'boolean') {
    throw new ProjectSettingsError(key, `must be true, false, or null to inherit, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/**
 * The project settings as the wire format carries them.
 *
 * `autoReview` is serialized as `null` for "inherit" rather than being dropped, so a
 * client that round-trips a payload it read cannot turn an inherit into a missing
 * key that means something else.
 */
export function serializeProjectSettings(settings: ProjectSettings): Record<string, unknown> {
  const normalized = normalizeProjectSettings(settings)
  return {
    defaultBranch: normalized.defaultBranch,
    sessionPrefix: normalized.sessionPrefix,
    intakeEnabled: normalized.intakeEnabled,
    workerAgentPreset: normalized.workerAgentPreset,
    workerPermissionPreset: normalized.workerPermissionPreset,
    reviewerAgentPreset: normalized.reviewerAgentPreset,
    autoReview: normalized.autoReview ?? null,
  }
}
