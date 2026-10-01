/**
 * Starting a worker — the moment issue → session → branch becomes real.
 *
 * This is where three layers that were each verified separately meet:
 * `WorktreeManager` (verified against real git), `spawnWorker` (verified against
 * the real host in M0 spike 2), and the issue record. The ordering is chosen so
 * that **every failure leaves nothing behind**:
 *
 *   1. Resolve and validate the issue, and refuse if it already has a worker —
 *      before creating anything.
 *   2. Create the worktree. It is the only step with an on-disk side effect, and it
 *      happens before the session so that the session's `cwd` can point at it (a
 *      session's cwd *is* its workspace, Appendix A4).
 *   3. Spawn the session.
 *   4. Only then bind the worker to the issue.
 *
 * **A failed spawn removes the worktree it just made.** Without that, every failed
 * spawn strands a full working tree, and R4's disk bound is only enforced by
 * cleanup that never runs.
 *
 * @module dsho/host/workers-service
 */

import { newId } from '../domain/ids.ts'
import { IssueState, assignWorker, normalizeIssue } from '../domain/issues.ts'
import type { Issue } from '../domain/issues.ts'
import { WorkerPhase, workerSessionTitle } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { createIssueForTool } from './issues-service.ts'
import type { IssueToolDeps } from './issues-service.ts'
import { spawnWorker } from './spawn.ts'
import type { SpawnDeps } from './spawn.ts'
import { createMemoryFactStore } from './store.ts'
import { WorktreeManager } from './worktree.ts'
import { workerTaskMessage, workerSystemPrompt } from '../domain/worker-contract.ts'
import type { PluginConfig } from '../config/validate.ts'
import type { LazyFactStore } from './store.ts'
import type { RunCommand } from './worktree.ts'

/** Everything `orchestrator_worker_start` needs. */
export interface WorkerToolDeps extends IssueToolDeps {
  run: RunCommand
  /** The recipe's dependencies, injected so the flow is testable. */
  spawn: SpawnDeps
  config: PluginConfig
  now?: () => number
  /** The DSH Workspace id for a worktree path. */
  workspaceIdFor?: (path: string) => string
}

function storageFailure(error: unknown): string {
  return (
    'The plugin could not open its storage, so no worker could be started.\n\n' +
    `Storage error: ${error instanceof Error ? error.message : String(error)}`
  )
}

/** Finds the issue, or reports why it could not. */
async function findIssue(
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  issueId: string,
): Promise<{ issue: Issue } | { message: string }> {
  const stored = await store.issues.get(issueId)
  if (stored === undefined) {
    const known = (await store.issues.list()).map(normalizeIssue)
    return {
      message:
        `No issue with id ${JSON.stringify(issueId)}. ` +
        (known.length > 0 ? `Known: ${known.map((issue) => issue.id).join(', ')}.` : 'There are no issues yet.'),
    }
  }
  return { issue: normalizeIssue(stored) }
}

/**
 * `orchestrator_worker_start`.
 *
 * Accepts either an existing `issueId`, or a `title` (+`description`) for an
 * ad-hoc task — the PRD's "direct task" secondary flow (AO's "New task"). The
 * ad-hoc form creates the issue first, so there is exactly one path afterwards.
 */
export async function startWorkerForTool(
  deps: WorkerToolDeps,
  args: { issueId?: string; title?: string; description?: string; repoId?: string },
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }

  let issue: Issue
  if (args.issueId && args.issueId.trim() !== '') {
    const found = await findIssue(store, args.issueId.trim())
    if ('message' in found) return found.message
    issue = found.issue
  } else if (args.title && args.title.trim() !== '') {
    const created = await createIssueForTool(deps, {
      title: args.title,
      ...(args.description ? { body: args.description } : {}),
      ...(args.repoId ? { repoId: args.repoId } : {}),
    })
    const id = /\b(iss-[A-Z0-9]{26})\b/.exec(created)?.[1]
    if (!id) return created
    const found = await findIssue(store, id)
    if ('message' in found) return created
    issue = found.issue
  } else {
    return 'Give either an `issueId` to work, or a `title` for an ad-hoc task.'
  }

  if (issue.workerId) {
    return (
      `${issue.id} is already worked by ${issue.workerId}. ` +
      'Message that worker, or stop it first — one issue has one worker at a time.'
    )
  }
  if (issue.state === IssueState.done || issue.state === IssueState.cancelled) {
    return `${issue.id} is ${issue.state}, so there is nothing to work. Reopen it first.`
  }

  const repos = (await store.repos.list()) as Array<{ id?: unknown; rootPath?: unknown; defaultBranch?: unknown; verifyCommands?: unknown }>
  const repo = repos.find((candidate) => candidate.id === issue.repoId)
  if (!repo || typeof repo.rootPath !== 'string') {
    return (
      `The repository ${issue.repoId} this issue belongs to is not connected, so no worktree can be ` +
      'created. Call `orchestrator_repo_connect` first.'
    )
  }
  const repoRoot = repo.rootPath
  const defaultBranch = typeof repo.defaultBranch === 'string' ? repo.defaultBranch : ''
  const verifyCommands = Array.isArray(repo.verifyCommands)
    ? repo.verifyCommands.filter((c): c is string => typeof c === 'string')
    : []

  const now = deps.now ?? Date.now
  const worktrees = new WorktreeManager({ run: deps.run, rootPath: repoRoot })

  // 2. The worktree first: it is the only on-disk side effect, and the session's
  //    cwd has to point at it.
  let created: { path: string; branch: string; created: boolean }
  try {
    created = await worktrees.create({
      issueNumber: issue.number || 1,
      title: issue.title,
      ...(defaultBranch ? { baseBranch: defaultBranch } : {}),
    })
  } catch (error) {
    return `Could not create a worktree for ${issue.id}: ${error instanceof Error ? error.message : String(error)}`
  }

  // 3. Spawn the session.
  const workerId = newId('wrk', now())
  const sessionId = `dsho-${workerId}`
  const title = workerSessionTitle(issue.number, issue.title)
  let spawned
  try {
    spawned = await spawnWorker(deps.spawn, {
      sessionId,
      worktreePath: created.path,
      title,
      prompt: `${workerSystemPrompt('')}\n\n---\n\n${workerTaskMessage({
        issueId: issue.id,
        title: issue.title,
        body: issue.body,
        repoRoot,
        branch: created.branch,
        verifyCommands,
      })}`,
      permissionPreset: deps.config.workerPermissionPreset,
      agentPreset: deps.config.workerAgentPreset,
    })
  } catch (error) {
    // A failed spawn must not strand the tree it just made; R4's disk bound is
    // only real if cleanup actually runs.
    const removal = await worktrees.remove(created.path).catch(() => ({ removed: false }))
    void removal
    return (
      `Could not start a worker for ${issue.id}: ${error instanceof Error ? error.message : String(error)}\n\n` +
      `The worktree at ${created.path} was removed, so nothing was left behind.`
    )
  }

  // 4. Only now bind the worker to the issue.
  const at = now()
  const worker: Worker = {
    id: workerId,
    issueId: issue.id,
    sessionId,
    branch: created.branch,
    worktreePath: created.path,
    workspaceId: deps.workspaceIdFor ? deps.workspaceIdFor(created.path) : '',
    phase: WorkerPhase.queued,
    phaseHistory: [{ phase: WorkerPhase.queued, at, summary: 'worker spawned' }],
    lastSignalAt: at,
    createdAt: at,
    updatedAt: at,
  }
  await store.workers.put(worker.id, worker)
  const bound = assignWorker(issue, worker.id, at)
  await store.issues.put(bound.id, bound)

  return [
    `Started ${worker.id} on ${issue.id}`,
    '',
    `  session:  ${sessionId}`,
    `  title:    ${title}`,
    `  branch:   ${created.branch}`,
    `  worktree: ${created.path}`,
    `  phase:    ${worker.phase}`,
    '',
    'The session is a normal DSH session: open it to watch or steer the worker directly.',
    'It reports progress through `orchestrator_report`.',
  ].join('\n')
}

/** Used by tests and by a host without storage, so nothing here needs a real one. */
export { createMemoryFactStore }
