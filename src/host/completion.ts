/**
 * Finishing a worker whose pull request has landed (A7).
 *
 * The flow's last step: a merged pull request described a worker whose work is done,
 * so the worker is terminated, its issue is released, and its worktree is cleaned up
 * — the point at which R4's disk bound is actually collected.
 *
 * ## A terminal transition requires a SUCCESSFUL observation (R13)
 *
 * `isTerminalPr` returns false for an unfetched snapshot, and this module never
 * bypasses it. The dangerous failure is not "no data" — it is a failed observation
 * whose empty payload *reads* as `CLOSED`, which would terminate a live worker and
 * delete its worktree. So an observation that did not succeed cannot finish anything,
 * however the snapshot looks.
 *
 * ## Merged and closed are not the same outcome
 *
 * A merge means the work landed; a close without merge means it was abandoned. They
 * release the issue differently — `done` versus `cancelled` — because the queue is
 * read by a person and conflating them hides abandoned work.
 *
 * @module dsho/host/completion
 */

import { normalizeIssue, releaseWorker } from '../domain/issues.ts'
import { WorkerPhase, isTerminalPhase, normalizeWorker, setPhase } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { isTerminalPr } from '../domain/pr-snapshot.ts'
import type { PrSnapshot } from '../domain/pr-snapshot.ts'
import { cleanupWorkerWorktree } from './worktree-cleanup.ts'
import type { CleanupOutcome } from './worktree-cleanup.ts'
import type { RunCommand } from './worktree.ts'
import type { LazyFactStore } from './store.ts'

/** What completion needs. */
export interface CompletionDeps {
  store: LazyFactStore
  run: RunCommand
  now?: () => number
}

/** What one completion did. */
export interface CompletionOutcome {
  workerId: string
  completed: boolean
  /** `merged` | `closed`, or why nothing happened. */
  reason: string
  issueId?: string
  cleanup?: CleanupOutcome
}

/**
 * Finishes one worker, if its pull request has landed.
 *
 * Idempotent: a worker already in a terminal phase is left alone, so a sweep that
 * runs every poll does not re-release the issue or re-run cleanup.
 */
export async function completeWorker(
  deps: CompletionDeps,
  worker: Worker,
  snapshot: PrSnapshot | undefined,
): Promise<CompletionOutcome> {
  if (isTerminalPhase(worker.phase)) {
    return { workerId: worker.id, completed: false, reason: 'already-terminal' }
  }
  // R13: an unfetched snapshot cannot finish anything, however it reads.
  if (!snapshot || !isTerminalPr(snapshot)) {
    return { workerId: worker.id, completed: false, reason: 'not-terminal' }
  }

  const at = (deps.now ?? Date.now)()
  const merged = snapshot.state === 'MERGED'
  const store = await deps.store.get()

  await store.workers.put(worker.id, setPhase(worker, merged ? WorkerPhase.merged : WorkerPhase.closed, merged ? 'pull request merged' : 'pull request closed without merge', at))

  let issueId: string | undefined
  const issueStored = await store.issues.get(worker.issueId)
  if (issueStored !== undefined) {
    const issue = normalizeIssue(issueStored)
    issueId = issue.id
    await store.issues.put(issue.id, releaseWorker(issue, merged ? 'done' : 'cancelled', at))
  }

  // The work is finished, so its tree is collected -- this is where R4's bound is
  // actually paid. A cleanup failure is reported, never thrown: the completion the
  // user is waiting for must not be rolled back by a git problem.
  const issueRepoId = issueStored !== undefined ? normalizeIssue(issueStored).repoId : ''
  const owner = (await store.repos.list()).find(
    (candidate) =>
      typeof candidate === 'object' && candidate !== null && (candidate as { id?: unknown }).id === issueRepoId,
  ) as { rootPath?: unknown } | undefined
  const cleanup = await cleanupWorkerWorktree(
    { store: deps.store, run: deps.run },
    worker,
    typeof owner?.rootPath === 'string' ? owner.rootPath : '',
  )

  return { workerId: worker.id, completed: true, reason: merged ? 'merged' : 'closed', ...(issueId ? { issueId } : {}), cleanup }
}

/**
 * Finishes every worker whose stored snapshot is terminal.
 *
 * A sweep, not a hook on the observer's return value, because the observer's job is
 * to record facts — a completion is a *decision*, and separating them keeps the
 * observer from having side effects a reader would not expect.
 */
export async function sweepCompletions(deps: CompletionDeps): Promise<CompletionOutcome[]> {
  const outcomes: CompletionOutcome[] = []
  let store
  try {
    store = await deps.store.get()
  } catch {
    return outcomes
  }

  for (const worker of (await store.workers.list()).map(normalizeWorker)) {
    try {
      const snapshot = (await store.prSnapshots.get(worker.id)) as PrSnapshot | undefined
      const outcome = await completeWorker(deps, worker, snapshot)
      if (outcome.completed) outcomes.push(outcome)
    } catch {
      // One worker's completion must not stop the others.
    }
  }
  return outcomes
}
