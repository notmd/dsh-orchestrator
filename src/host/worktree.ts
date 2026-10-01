/**
 * The worktree manager — per-issue isolation.
 *
 * PRD §9 states the mechanical constraint plainly, and it is worth restating
 * because it drives the whole design: **a session's `cwd` *is* its workspace
 * path** (Appendix A4 — `attachSession` rejects any session whose cwd does not
 * resolve to the workspace's own path). So a per-issue `git worktree` is not a
 * convenience, it is the only way to give concurrent workers separate trees:
 * each worktree becomes its own DSH Workspace, and each worker session is born
 * pointing at one.
 *
 * ## Why a `git worktree` and not a clone
 *
 * A linked worktree shares the repository's object store and, crucially,
 * `.git/config` with the human checkout. That is what makes it cheap, and it is
 * also the hazard the worker contract has to name: a worker must not
 * `git remote add/set-url/remove` or write repo config with `git config --local`,
 * because those writes land in the *user's* checkout. The worker contract carries
 * that warning verbatim from the reference (PRD §12.4).
 *
 * ## The command seam
 *
 * Every git call goes through an injected {@link RunCommand} rather than touching
 * `ctx.shell` or `ctx.subprocess` directly. Two reasons: the argv construction and
 * the porcelain parsing are the parts worth testing, and they should not need a
 * live host to test; and the host surface this plugin depends on stays visible in
 * one place instead of being spread across modules.
 *
 * ## Paths are canonicalized, and that is not a nicety
 *
 * `git worktree list` reports **realpath-resolved** paths. On macOS `/tmp` and
 * `/var` are symlinks, so a repository given as `/var/folders/…` is reported by
 * git as `/private/var/folders/…`. Comparing those two textually compares
 * different strings for the same directory, and every comparison in this module
 * is load-bearing: idempotence, `remove`, and `pruneAll` would each quietly do
 * nothing while reporting success.
 *
 * A real-git integration test caught exactly that — the unit tests could not,
 * because a fake git returns whatever the test author expected. So root, worktree
 * root, and every incoming path are canonicalized here.
 *
 * @module dsho/host/worktree
 */

import { realpathSync } from 'node:fs'

/**
 * Resolves a path to its real location, falling back to a tidied copy.
 *
 * The fallback matters: this runs on paths that may not exist yet (a worktree
 * root before the first add), and a missing path must not throw here — the
 * creating call is the one that should report that.
 */
export function canonicalize(path: string): string {
  const trimmed = path.replace(/\/+$/, '') || '/'
  try {
    return realpathSync(trimmed)
  } catch {
    return trimmed
  }
}

/** One finished command. */
export interface CommandResult {
  /** `null` when the process was killed by a signal rather than exiting. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the executor capped stdout, so parsing must not trust completeness. */
  truncated?: boolean
  timedOut?: boolean
}

/** Runs one command to completion. Supplied by the host adapter. */
export type RunCommand = (
  argv: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>

/** A failure from git, carrying enough of its output to be actionable. */
export class GitCommandError extends Error {
  readonly argv: readonly string[]
  readonly result: CommandResult

  constructor(argv: readonly string[], result: CommandResult) {
    const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').split('\n')[0]
    super(`git ${argv.slice(1).join(' ')} failed (exit ${result.exitCode}): ${detail}`)
    this.name = 'GitCommandError'
    this.argv = argv
    this.result = result
  }
}

/**
 * The default branch namespace.
 *
 * PRD §7.3 writes the worker branch as `dsho/issue-<n>-<slug>`; PRD §13.1 shows
 * `sessionPrefix` feeding `dsho/<prefix>/issue-<n>/root`. Those are two different
 * shapes, and this module implements the first as the default and inserts the
 * prefix as a middle segment (`dsho/<prefix>/issue-<n>-<slug>`) so a configured
 * prefix namespaces the same way without changing the issue segment. **The
 * conflict is unresolved in the PRD** and is recorded in STATUS.md.
 */
export const BRANCH_NAMESPACE = 'dsho'

/** The default worktree root, relative to the repository root. */
export const DEFAULT_WORKTREE_ROOT = '.dsho/worktrees'

/**
 * Longest slug this module will produce, in characters.
 *
 * Branches are a filesystem path component inside `.git`, and directory names
 * are capped on macOS at 255 bytes. 48 leaves ample room for the namespace, the
 * issue number, and the prefix while keeping the acceptance criteria's
 * `issue-<n>-<slug>` readable.
 */
export const MAX_SLUG_LENGTH = 48

/**
 * Turns arbitrary issue text into a safe path and branch segment.
 *
 * Deliberately strict, because the output is used as **both** a git branch
 * component and a directory name. Everything outside `[a-z0-9]` collapses to a
 * single dash, which makes traversal (`..`, `/`), ref-format violations, and
 * shell metacharacters impossible by construction rather than by escaping — and
 * escaping is where this kind of code usually goes wrong.
 *
 * A title with no usable characters still yields `issue`, so the caller never
 * has to handle an empty segment.
 */
export function slugify(title: string, maxLength = MAX_SLUG_LENGTH): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const bounded = slug.slice(0, maxLength).replace(/-+$/g, '')
  return bounded === '' ? 'issue' : bounded
}

/** The branch a worker for `issueNumber` works on. */
export function branchName(options: {
  issueNumber: number
  title: string
  prefix?: string
}): string {
  if (!Number.isInteger(options.issueNumber) || options.issueNumber < 1) {
    throw new Error(`branchName: issueNumber must be a positive integer, got ${options.issueNumber}`)
  }
  const slug = slugify(options.title)
  const prefix = slugify(options.prefix ?? '')
  const segments = [BRANCH_NAMESPACE]
  // `slugify('')` returns 'issue', so an absent prefix must be checked here
  // rather than inferred from the slug.
  if ((options.prefix ?? '').trim() !== '') segments.push(prefix)
  segments.push(`issue-${options.issueNumber}-${slug}`)
  return segments.join('/')
}

/** The on-disk directory name for an issue's worktree. */
export function worktreeDirectoryName(issueNumber: number, title: string): string {
  return `issue-${issueNumber}-${slugify(title)}`
}

/** The absolute worktree path for an issue. */
export function worktreePath(options: {
  rootPath: string
  issueNumber: number
  title: string
  worktreeRoot?: string
}): string {
  const root = (options.worktreeRoot ?? '').trim() || DEFAULT_WORKTREE_ROOT
  const base = root.startsWith('/') ? root.replace(/\/+$/, '') : `${options.rootPath.replace(/\/+$/, '')}/${root.replace(/^\/+/, '')}`
  return `${base}/${worktreeDirectoryName(options.issueNumber, options.title)}`
}

/** One `git worktree list --porcelain` entry. */
export interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  bare?: boolean
  detached?: boolean
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * Exported and tested because the format is whitespace-sensitive and the failure
 * mode is silent: a mis-parse would make cleanup remove the wrong worktree, or
 * none at all while reporting success.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '') continue
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length) }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) {
      // `refs/heads/dsho/issue-3-slug` -> `dsho/issue-3-slug`
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'bare') current.bare = true
    else if (line === 'detached') current.detached = true
  }
  if (current) entries.push(current)
  return entries
}

/** Reports whether a directory is inside a git work tree. */
export async function isGitRepository(run: RunCommand, path: string): Promise<boolean> {
  const result = await run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: path })
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

/**
 * Reports whether a path is ignored, using `git check-ignore`.
 *
 * Used to enforce R4's "`.dsho/` gitignored" requirement. A repository whose
 * worktree root is *not* ignored would commit every worker's tree into the
 * user's history, so `orchestrator_repo_connect` should refuse it and say why.
 */
export async function isIgnored(run: RunCommand, rootPath: string, path: string): Promise<boolean> {
  const result = await run(['git', 'check-ignore', '--quiet', path], { cwd: rootPath })
  // `check-ignore` exits 0 when ignored and 1 when not; 128 means git itself
  // failed (not a repository, bad path), which must not read as "ignored".
  return result.exitCode === 0
}

/** Manages the worktrees for one repository. */
export class WorktreeManager {
  readonly #run: RunCommand
  readonly #rootPath: string
  readonly #worktreeRoot: string
  readonly #timeoutMs: number

  constructor(options: {
    run: RunCommand
    /** Absolute path to the human checkout that owns the repository. */
    rootPath: string
    worktreeRoot?: string
    /** Deadline for every git call. Bounded work is an NFR, not a preference. */
    timeoutMs?: number
  }) {
    if (!options.rootPath || !options.rootPath.startsWith('/')) {
      throw new Error('WorktreeManager: rootPath must be an absolute path')
    }
    this.#run = options.run
    this.#rootPath = canonicalize(options.rootPath)
    this.#worktreeRoot = (options.worktreeRoot ?? '').trim() || DEFAULT_WORKTREE_ROOT
    this.#timeoutMs = options.timeoutMs ?? 60_000
  }

  get rootPath(): string {
    return this.#rootPath
  }

  /** The absolute path where this repository's worktrees live. */
  get worktreeRoot(): string {
    return this.#worktreeRoot.startsWith('/')
      ? canonicalize(this.#worktreeRoot)
      : canonicalize(`${this.#rootPath}/${this.#worktreeRoot.replace(/^\/+/, '')}`)
  }

  /** Git argv, for testing and for error messages. */
  git(args: readonly string[], cwd?: string): Promise<CommandResult> {
    return this.#run(['git', ...args], { cwd: cwd ?? this.#rootPath, timeoutMs: this.#timeoutMs })
  }

  /** Git argv that must succeed. Throws {@link GitCommandError} otherwise. */
  async #must(args: readonly string[], cwd?: string): Promise<CommandResult> {
    const argv = ['git', ...args]
    const result = await this.#run(argv, { cwd: cwd ?? this.#rootPath, timeoutMs: this.#timeoutMs })
    if (result.exitCode !== 0) throw new GitCommandError(argv, result)
    return result
  }

  /** The path a worker for this issue would use. */
  pathFor(issueNumber: number, title: string): string {
    return worktreePath({
      rootPath: this.#rootPath,
      issueNumber,
      title,
      worktreeRoot: this.worktreeRoot,
    })
  }

  /** Reports whether the repository's worktree root is gitignored. */
  isWorktreeRootIgnored(): Promise<boolean> {
    return isIgnored(this.#run, this.#rootPath, `${this.#worktreeRoot}/`)
  }

  /** Every worktree git knows about, including the human checkout. */
  async list(): Promise<WorktreeEntry[]> {
    const result = await this.#must(['worktree', 'list', '--porcelain'])
    // git already reports real paths; canonicalizing is belt-and-braces so a
    // comparison against a caller-supplied path cannot diverge on a symlink.
    return parseWorktreeList(result.stdout).map((entry) => ({
      ...entry,
      path: canonicalize(entry.path),
    }))
  }

  /** Whether a branch already exists. */
  async branchExists(branch: string): Promise<boolean> {
    const result = await this.#run(
      ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { cwd: this.#rootPath, timeoutMs: this.#timeoutMs },
    )
    return result.exitCode === 0
  }

  /**
   * Creates the worktree and its branch.
   *
   * `-b <branch>` creates the branch as part of the add, which is one git call
   * instead of two and cannot leave a branch with no worktree behind. An existing
   * branch is attached instead of re-created, so a retry after a partial failure
   * resumes rather than failing on "branch already exists".
   *
   * Returns the absolute path, which is what the caller needs: it becomes the
   * worker's `cwd` and therefore its DSH Workspace.
   */
  async create(options: {
    issueNumber: number
    title: string
    baseBranch?: string
  }): Promise<{ path: string; branch: string; created: boolean }> {
    const branch = branchName({ issueNumber: options.issueNumber, title: options.title })
    const path = canonicalize(this.pathFor(options.issueNumber, options.title))

    const existing = await this.list()
    if (existing.some((entry) => entry.path === path)) {
      return { path, branch, created: false }
    }

    const base = options.baseBranch
    if (await this.branchExists(branch)) {
      await this.#must(['worktree', 'add', path, branch])
    } else {
      await this.#must([
        'worktree',
        'add',
        '-b',
        branch,
        path,
        ...(base ? [base] : []),
      ])
    }
    return { path, branch, created: true }
  }

  /**
   * Removes a worktree.
   *
   * `--force` is deliberate: a worker that left uncommitted changes, or that is
   * still running, would otherwise make removal fail and strand the directory.
   * The caller removes worktrees only when the work is archived or abandoned, so
   * discarding the tree at that point is the intent, not an accident.
   *
   * A worktree git does not know about is not an error: the goal is "this path is
   * gone", and it already is.
   */
  async remove(path: string): Promise<{ removed: boolean }> {
    const target = canonicalize(path)
    const existing = await this.list()
    if (!existing.some((entry) => entry.path === target)) {
      return { removed: false }
    }
    await this.#must(['worktree', 'remove', '--force', target])
    return { removed: true }
  }

  /**
   * Removes every worktree under this repository's worktree root.
   *
   * Scoped to the configured root on purpose: it must never be able to remove the
   * human's own checkout, which is the first entry in every `worktree list`.
   */
  async pruneAll(): Promise<{ removed: string[] }> {
    const root = `${this.worktreeRoot}/`
    const existing = await this.list()
    const removed: string[] = []
    for (const entry of existing) {
      if (!entry.path.startsWith(root)) continue
      await this.#must(['worktree', 'remove', '--force', entry.path])
      removed.push(entry.path)
    }
    return { removed }
  }

  /** Runs `git worktree prune`, clearing metadata for worktrees deleted on disk. */
  async pruneMetadata(): Promise<void> {
    await this.#must(['worktree', 'prune'])
  }
}
