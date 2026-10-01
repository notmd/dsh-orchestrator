/**
 * Worktree cleanup on archive (§9.3, R4).
 *
 * R4's disk bound is only real if cleanup actually runs: a worker's tree is a full
 * checkout, and an archived worker whose tree survives leaves the bound to a
 * cleanup that never happens.
 *
 * ## Why this is its own module
 *
 * `workers-service` imports `issues-service`, so the reverse edge would be a cycle.
 * Cleanup depends on neither: it needs the command seam and the worker record, and
 * both callers can reach it.
 *
 * ## Removal is deliberately quiet
 *
 * A failed removal is **reported, never thrown**. By the time a worker is archived
 * its work is finished or abandoned, and a git failure while cleaning up must not
 * undo the archive the user asked for — nor hide it, which is why the failure comes
 * back in the result instead of being swallowed.
 *
 * @module dsho/host/worktree-cleanup
 */

import { normalizeWorker } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { WorktreeManager } from './worktree.ts'
import type { RunCommand } from './worktree.ts'
import type { LazyFactStore } from './store.ts'

/** What cleanup needs. */
export interface CleanupDeps {
  store: LazyFactStore
  run: RunCommand
}

/** What one cleanup did. */
export interface CleanupOutcome {
  workerId: string
  worktreePath: string
  removed: boolean
  /** Set when the removal failed; the archive still stands. */
  error?: string
}

/**
 * Removes a worker's worktree, given the checkout that owns it.
 *
 * The repository root is looked up from the worker's issue, because a worktree path
 * alone does not say which repository's `.git` owns it — and running `git worktree
 * remove` from the wrong root would target the wrong worktree list.
 */
export async function cleanupWorkerWorktree(
  deps: CleanupDeps,
  worker: Worker,
  repoRoot: string,
): Promise<CleanupOutcome> {
  const outcome: CleanupOutcome = {
    workerId: worker.id,
    worktreePath: worker.worktreePath,
    removed: false,
  }
  if (!worker.worktreePath || !repoRoot) {
    outcome.error = 'no worktree path or repository root to clean'
    return outcome
  }
  try {
    const manager = new WorktreeManager({ run: deps.run, rootPath: repoRoot })
    const result = await manager.remove(worker.worktreePath)
    outcome.removed = result.removed
    return outcome
  } catch (error) {
    // Reported, not thrown: the archive the user asked for must survive a cleanup
    // failure, and the failure must not vanish either.
    outcome.error = error instanceof Error ? error.message : String(error)
    return outcome
  }
}

/**
 * Cleans up every worktree whose worker has been released.
 *
 * A sweep rather than a hook on one code path, because there are several ways a
 * worker becomes finished — the issue is marked done or cancelled, or the session
 * ends. A sweep catches all of them, and is idempotent: removing an absent worktree
 * is not an error.
 */
export async function cleanupReleasedWorktrees(deps: CleanupDeps): Promise<CleanupOutcome[]> {
  const outcomes: CleanupOutcome[] = []
  let store
  try {
    store = await deps.store.get()
  } catch {
    return outcomes
  }

  const workers = (await store.workers.list()).map(normalizeWorker)
  const issues = (await store.issues.list()) as Array<{ id?: unknown; state?: unknown; repoId?: unknown }>
  const repos = (await store.repos.list()) as Array<{ id?: unknown; rootPath?: unknown }>

  for (const worker of workers) {
    if (!worker.worktreePath) continue
    const issue = issues.find((candidate) => candidate.id === worker.issueId)
    // Only a released issue: `open` and `in_progress` work still needs its tree.
    if (issue?.state !== 'done' && issue?.state !== 'cancelled') continue
    const repo = repos.find((candidate) => candidate.id === issue.repoId)
    const rootPath = typeof repo?.rootPath === 'string' ? repo.rootPath : ''
    outcomes.push(await cleanupWorkerWorktree(deps, worker, rootPath))
  }
  return outcomes
}
