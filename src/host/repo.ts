/**
 * Connecting a repository.
 *
 * This is `orchestrator_repo_connect`'s substance, and it is the gate every other
 * tool depends on: nothing can be spawned, observed, or reviewed until a
 * repository is registered. So the whole value here is **preflight** — finding out
 * that `gh` is missing, or that the worktree root is not ignored, *before* a
 * worker is spawned against it rather than during.
 *
 * Three checks, in the order that fails fastest and most cheaply:
 *
 *   1. **Is it a git work tree?** (R3) Refusing here costs one command.
 *   2. **Is the worktree root gitignored?** (R4) If it is not, every worker's tree
 *      lands in the user's history — and the user finds out at their next commit,
 *      which is far too late. A warning would be the wrong shape: the fix is one
 *      line in `.gitignore`, and the consequence of ignoring it is a polluted
 *      repository.
 *   3. **Is `gh` installed and authenticated, and what is this repo?** (R3) This is
 *      where the exact prerequisite gets named, because "authentication failed" and
 *      "you have not installed `gh`" have different fixes.
 *
 * Every failure carries `describeFailure`'s message, so the tool's output is
 * actionable rather than a status code.
 *
 * @module dsho/host/repo
 */

import { isIgnored, isGitRepository } from './worktree.ts'
import type { RunCommand } from './worktree.ts'
import { authStatusArgv, repoViewArgv } from '../github/argv.ts'
import { classifyCommandFailure, describeFailure } from './exec.ts'
import type { FailureKind } from './exec.ts'
import { newId } from '../domain/ids.ts'
import { normalizeProjectSettings } from './repo-settings.ts'
import type { ProjectSettings } from './repo-settings.ts'

/**
 * A connected repository (PRD §7.2).
 *
 * Per-repo settings live here rather than in the plugin config, because they are
 * the things that genuinely differ between repositories — the reference's own
 * accumulated answer to that question (`ProjectConfig`).
 *
 * The settings are **flattened onto the record** rather than nested under a
 * `settings` key, and that is not cosmetic: `reviewer-service` already read
 * `repo.autoReview` off the record before a settings page existed, so nesting would
 * have forced every reader to learn a second shape. A stored record whose fields are
 * simply absent reads as the defaults, which is how an install that predates this
 * page keeps working — see {@link normalizeRepo}.
 */
export interface Repo extends ProjectSettings {
  id: string
  /** `owner/name`, from `gh repo view`. */
  owner: string
  name: string
  /** The local checkout registered as a DSH Workspace. */
  rootPath: string
  /** The Verify stage contract (PRD §8.1). Ours; the reference has no equivalent. */
  verifyCommands: readonly string[]
  /** Default `<rootPath>/.dsho/worktrees`. */
  worktreeRoot: string
  createdAt: number
  /**
   * A `gh repo view` fact, not a setting: whether the default branch was detected.
   *
   * Kept apart from `defaultBranch` so the settings page can warn about an
   * *undetected* branch without inventing a second branch field, and so a user who
   * has typed a branch keeps it even when the next connection cannot detect one.
   */
  defaultBranchDetected: boolean
}

/**
 * Reads a stored record as a `Repo`, filling every field that may be absent.
 *
 * The same job `normalizeIssue` and `normalizeWorker` do, for the same reason: the
 * durable record is the older of the two shapes in every upgrade, and a reader that
 * returns `undefined` for a field the record never had makes the *caller* decide.
 * Here the caller is a settings page, and `undefined` on a switch renders as "off" —
 * which would silently stop intake for every project connected before this page
 * shipped.
 */
export function normalizeRepo(raw: unknown): Repo {
  const record =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const settings = normalizeProjectSettings(record)
  return {
    ...settings,
    id: typeof record.id === 'string' ? record.id : '',
    owner: typeof record.owner === 'string' ? record.owner : '',
    name: typeof record.name === 'string' ? record.name : '',
    rootPath: typeof record.rootPath === 'string' ? record.rootPath : '',
    verifyCommands: Array.isArray(record.verifyCommands)
      ? record.verifyCommands.filter((command): command is string => typeof command === 'string')
      : [],
    worktreeRoot: typeof record.worktreeRoot === 'string' ? record.worktreeRoot : DEFAULT_WORKTREE_ROOT,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    // Derived when absent: an empty branch means detection did not happen, and a
    // non-empty one on an old record came from `gh repo view`, which is the only
    // thing that ever wrote it.
    defaultBranchDetected:
      typeof record.defaultBranchDetected === 'boolean'
        ? record.defaultBranchDetected
        : typeof record.defaultBranch === 'string' && record.defaultBranch !== '',
  }
}

/** A successful connection. */
export interface RepoConnected {
  ok: true
  repo: Repo
  /** Non-fatal observations worth showing the user. */
  notes: string[]
}

/** A refused connection, with a message that names the fix. */
export interface RepoRefused {
  ok: false
  /** A stable code, for tests and for the tool's structured output. */
  reason: string
  message: string
  kind?: string
}

/** A connection attempt's outcome. */
export type RepoConnectResult = RepoConnected | RepoRefused

/** Why a connection was refused. */
export const RepoRefusal = Object.freeze({
  notARepository: 'not-a-git-repository',
  worktreeRootNotIgnored: 'worktree-root-not-ignored',
  ghMissing: 'gh-missing',
  ghUnauthenticated: 'gh-unauthenticated',
  ghFailed: 'gh-failed',
  badRepoView: 'bad-repo-view',
  missingPath: 'missing-path',
})

/** The default worktree root, relative to the checkout. */
export const DEFAULT_WORKTREE_ROOT = '.dsho/worktrees'

/**
 * Runs the preflight and builds the `Repo` record.
 *
 * Note what it does **not** do: it does not create the worktree root, and it does
 * not write anything. Persistence is the caller's, because the same record is
 * needed by a read-only path (`orchestrator_repo_connect` can be called to
 * *inspect* a connection) and a function that always writes cannot serve both.
 */
export async function connectRepo(options: {
  run: RunCommand
  /** Absolute path to the local checkout. */
  rootPath: string
  worktreeRoot?: string
  verifyCommands?: readonly string[]
  /**
   * The record already stored for this checkout, when there is one.
   *
   * A reconnect is a **refresh**, not a reset: it re-reads the repository identity
   * and keeps every setting the user chose. Without this, re-running
   * `orchestrator_repo_connect` — which the tool's own description invites — would
   * silently wipe the branch prefix, the auto-review override and the intake switch,
   * and the page would be the only place the loss was invisible.
   */
  previous?: unknown
  /** Injected so the record's id is stable in tests. */
  id?: string
  now?: number
}): Promise<RepoConnectResult> {
  const rootPath = options.rootPath?.trim()
  if (!rootPath) {
    return {
      ok: false,
      reason: RepoRefusal.missingPath,
      message: 'A repository path is required. Pass the absolute path to a local checkout.',
    }
  }

  const worktreeRoot = (options.worktreeRoot ?? '').trim() || DEFAULT_WORKTREE_ROOT

  if (!(await isGitRepository(options.run, rootPath))) {
    return {
      ok: false,
      reason: RepoRefusal.notARepository,
      message: `${rootPath} is not inside a git work tree. Point the plugin at a checkout, not at a parent directory.`,
    }
  }

  // R4. Not a warning: an unignored worktree root commits every worker's tree into
  // the user's history, and they would find out at their next commit.
  if (!(await isIgnored(options.run, rootPath, `${worktreeRoot}/`))) {
    return {
      ok: false,
      reason: RepoRefusal.worktreeRootNotIgnored,
      message:
        `${worktreeRoot}/ is not gitignored, so worker worktrees would be committed to this ` +
        `repository. Add a line to .gitignore containing \`${worktreeRoot}/\` and retry.`,
    }
  }

  const auth = await options.run(authStatusArgv(), { cwd: rootPath })
  if (auth.exitCode !== 0) {
    const failure = classifyCommandFailure(auth)
    if (failure.kind === 'not-installed') {
      return {
        ok: false,
        reason: RepoRefusal.ghMissing,
        kind: failure.kind,
        message: describeFailure(failure.kind, authStatusArgv()),
      }
    }
    // `gh auth status` exits non-zero when simply not logged in, so the exit code
    // is the answer and the text is only for the human -- never parsed.
    return {
      ok: false,
      reason: RepoRefusal.ghUnauthenticated,
      kind: failure.kind,
      message:
        `\`gh\` is not authenticated for ${rootPath}. Run \`gh auth login\`, or set ` +
        'GITHUB_TOKEN / AO_GITHUB_TOKEN. The plugin reads GitHub only through `gh`.',
    }
  }

  // No repository argument: `gh repo view` with none resolves the checkout it runs
  // in, while `gh repo view .` resolves `<owner>/.` and fails.
  const view = await options.run(repoViewArgv(), { cwd: rootPath })
  if (view.exitCode !== 0) {
    const failure = classifyCommandFailure(view)
    return {
      ok: false,
      reason: RepoRefusal.ghFailed,
      kind: failure.kind,
      message: describeFailure(failure.kind, repoViewArgv()),
    }
  }

  let parsed: { nameWithOwner?: unknown; defaultBranchRef?: { name?: unknown } }
  try {
    parsed = JSON.parse(view.stdout) as typeof parsed
  } catch {
    return {
      ok: false,
      reason: RepoRefusal.badRepoView,
      message: 'Could not read the repository identity: `gh repo view` did not return JSON.',
    }
  }

  const nameWithOwner = typeof parsed.nameWithOwner === 'string' ? parsed.nameWithOwner : ''
  const [owner, name] = nameWithOwner.split('/')
  if (!owner || !name) {
    return {
      ok: false,
      reason: RepoRefusal.badRepoView,
      message: `Could not read the repository identity from \`gh repo view\`: ${JSON.stringify(nameWithOwner)}`,
    }
  }

  const branchName = typeof parsed.defaultBranchRef?.name === 'string' ? parsed.defaultBranchRef.name : ''
  const notes: string[] = []
  if (!branchName) {
    notes.push('The default branch could not be read; set defaultBranch explicitly before spawning.')
  }

  const now = options.now ?? Date.now()
  // The user's settings survive a reconnect; only the facts this function reads are
  // refreshed. `defaultBranch` is the one field that belongs to both: detection fills
  // it in, and a user who typed a branch keeps it.
  const previous = normalizeProjectSettings(options.previous)
  const previousRecord =
    typeof options.previous === 'object' && options.previous !== null
      ? (options.previous as { id?: unknown; createdAt?: unknown })
      : {}
  return {
    ok: true,
    notes,
    repo: {
      ...previous,
      id: options.id ?? (typeof previousRecord.id === 'string' && previousRecord.id ? previousRecord.id : newId('repo', now)),
      owner,
      name,
      rootPath,
      defaultBranch: branchName || previous.defaultBranch,
      verifyCommands: options.verifyCommands ?? [],
      worktreeRoot,
      createdAt: typeof previousRecord.createdAt === 'number' ? previousRecord.createdAt : now,
      defaultBranchDetected: branchName !== '',
    },
  }
}

/** Renders a connection result as the text the model reads. */
export function describeRepoConnect(result: RepoConnectResult): string {
  if (!result.ok) {
    return [
      'Repository not connected.',
      '',
      `Reason: ${result.reason}${result.kind ? ` (${result.kind})` : ''}`,
      '',
      result.message,
    ].join('\n')
  }
  const { repo, notes } = result
  return [
    `Connected ${repo.owner}/${repo.name}`,
    '',
    `  id: ${repo.id}`,
    `  root: ${repo.rootPath}`,
    `  default branch: ${repo.defaultBranch || '(unknown)'}`,
    `  worktree root: ${repo.worktreeRoot}/ (gitignored)`,
    `  verify commands: ${repo.verifyCommands.length > 0 ? repo.verifyCommands.join(' && ') : '(none configured)'}`,
    '',
    ...(notes.length > 0 ? ['Notes:', ...notes.map((note) => `  ${note}`), ''] : []),
    'Workers for this repository will each get their own git worktree under the worktree root.',
  ].join('\n')
}

/** A failure kind this module can surface, for callers that branch on it. */
export type RepoFailureKind = (typeof FailureKind)[keyof typeof FailureKind]
