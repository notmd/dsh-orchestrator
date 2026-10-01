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
import { IssueState, assignWorker, byQueueOrder, normalizeIssue, releaseWorker } from '../domain/issues.ts'
import type { Issue } from '../domain/issues.ts'
import { WorkerPhase, isTerminalPhase, normalizeWorker, workerSessionTitle } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { createIssueForTool } from './issues-service.ts'
import { dirtyPaths } from './root-cleanliness.ts'
import type { IssueToolDeps } from './issues-service.ts'
import { spawnWorker } from './spawn.ts'
import type { SpawnDeps } from './spawn.ts'
import { createMemoryFactStore } from './store.ts'
import { WorktreeManager } from './worktree.ts'
import { workerTaskMessage, workerSystemPrompt } from '../domain/worker-contract.ts'
import type { PluginConfig } from '../config/validate.ts'
import type { LiveWorkers } from './handle-registry.ts'
import type { LazyFactStore } from './store.ts'
import type { RunCommand } from './worktree.ts'

/** Everything `orchestrator_worker_start` needs. */
export interface WorkerToolDeps extends IssueToolDeps {
  run: RunCommand
  /**
   * The live handles. Optional because a caller that only starts workers does not
   * need one, and because a host without them still lists and records correctly.
   */
  live?: LiveWorkers
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

  // THE CONCURRENCY CAP (M5). Over the cap this QUEUES the request rather than
  // refusing it: the orchestrator asked for this work, and dropping the request makes
  // the caller responsible for remembering it. The issue is marked `pendingWorker` and
  // `fillSlots` starts it when a slot frees.
  //
  // The flag is explicit rather than inferred from `open`, because merely CREATING an
  // issue must never cause a worker to appear -- the intent to work is what is queued.
  // Counted from the STORE, not a live registry: a worker whose session died still
  // occupies a worktree until it is released, and the bound is about resources.
  const active = (await store.workers.list()).map(normalizeWorker).filter((c) => !isTerminalPhase(c.phase))
  if (active.length >= deps.config.maxConcurrentWorkers) {
    const queued = { ...issue, pendingWorker: true, updatedAt: deps.now ? deps.now() : Date.now() }
    await store.issues.put(queued.id, queued)
    const waiting = (await store.issues.list())
      .map(normalizeIssue)
      .filter((candidate) => candidate.pendingWorker === true && candidate.state === IssueState.open)
      .sort(byQueueOrder)
    const position = waiting.findIndex((candidate) => candidate.id === queued.id) + 1
    return [
      `At capacity: ${active.length} of ${deps.config.maxConcurrentWorkers} workers are active.`,
      `${issue.id} is QUEUED at position ${position} and starts when a slot frees.`,
      '',
      ...active.slice(0, 8).map((candidate) => `  ${candidate.id}  ${candidate.phase}`),
      '',
      'Stop a worker (`orchestrator_worker_stop` releases its issue) or raise `maxConcurrentWorkers`.',
    ].join('\n')
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

  // R7's baseline, taken BEFORE the worker can touch anything. Captured here rather
  // than at connect time, because the human's own edits between connecting and starting
  // are legitimate and must not be blamed on the worker.
  const rootDirtyAtStart = await dirtyPaths(deps.run, repoRoot)

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
        // Two settings the plugin cannot obey on the worker's behalf: it never opens the
        // pull request itself, so `draftPrs` and `prBodyTemplate` are only real if the
        // worker is told. Until this existed both were validated and reached no one.
        draftPrs: deps.config.draftPrs,
        ...(deps.config.prBodyTemplate ? { prBodyTemplate: deps.config.prBodyTemplate } : {}),
      })}`,
      hideFromWorkspace: deps.config.hideWorktreeWorkspaces,
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
    rootDirtyAtStart,
    phase: WorkerPhase.queued,
    phaseHistory: [{ phase: WorkerPhase.queued, at, summary: 'worker spawned' }],
    lastSignalAt: at,
    createdAt: at,
    updatedAt: at,
  }
  await store.workers.put(worker.id, worker)
  const bound = assignWorker(issue, worker.id, at)
  await store.issues.put(bound.id, bound)
  // Retain the handle so the worker can later be messaged or stopped. Kept in
  // memory only: the durable spine is the session id, and a handle does not survive
  // a restart (see `./handle-registry.ts`).
  deps.live?.register({ workerId: worker.id, sessionId, handle: spawned.handle, ...(spawned.scope ? { scope: spawned.scope } : {}) })

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

/**
 * Sends a follow-up turn to a worker (`orchestrator_worker_message`).
 *
 * `followup()` rather than `steer()` or `inject()`: it queues an ordinary turn and
 * wakes the driver, which is what "here is feedback, act on it" means. `inject()`
 * would sit until other input arrived; `steer()` is consumed at the next step
 * boundary of a *running* turn, which may not exist.
 */
export async function messageWorkerForTool(
  deps: WorkerToolDeps,
  args: { workerId: string; message: string },
): Promise<string> {
  const text = (args.message ?? '').trim()
  if (text === '') return 'A message is required — an empty follow-up would wake the worker with nothing to do.'

  const live = deps.live?.byWorker(args.workerId)
  if (!live) {
    // Not an error the caller can fix by retrying: after a restart the handle is
    // gone and the worker has to be reattached first.
    return (
      `No live handle for ${args.workerId}, so it cannot be messaged from here.\n\n` +
      'The worker\'s session is durable and still exists — a handle is only available for workers ' +
      'spawned in this process. Reattach the worker to message it.'
    )
  }
  live.handle.agent.followup(deps.spawn.userMessage(text))

  try {
    const store = await deps.store.get()
    const stored = await store.workers.get(args.workerId)
    if (stored !== undefined) {
      const worker = normalizeWorker(stored)
      const at = (deps.now ?? Date.now)()
      // A message is a sign of life in the other direction, and it clears a pending
      // question: the person has answered.
      const next: Worker = { ...worker, lastSignalAt: at, updatedAt: at }
      delete next.pendingQuestion
      await store.workers.put(next.id, next)
    }
  } catch {
    // The message was queued; failing to record that must not look like the message
    // failed, or the caller would send it twice.
  }
  return `Queued a follow-up turn for ${args.workerId}.`
}

/**
 * Stops a worker's active turn (`orchestrator_worker_stop`).
 *
 * Cancels the **turn**, not the session: PRD §12.1 says "cancel a worker's active
 * turn", and A9 says unloading leaves sessions intact. Terminating a session is the
 * user's act, not a tool call.
 *
 * It also **releases the issue back to the queue**, which is the part that is easy to
 * forget and expensive to omit: without it the issue stays `in_progress` with a live
 * `workerId`, so nothing can re-work it and its worktree is never collected --- a
 * stranded worker, which is what the earlier version of this function produced.
 *
 * The worktree is deliberately **kept**. Stopping a turn is not abandoning the work:
 * the branch and any uncommitted changes are still the worker's, and re-working the
 * issue reuses the same path (worktree creation is idempotent for a canonical path).
 * Collection belongs to release --- `done`, `cancelled`, or a merged pull request.
 */
export async function stopWorkerForTool(
  deps: WorkerToolDeps,
  args: { workerId: string; reason?: string },
): Promise<string> {
  const live = deps.live?.byWorker(args.workerId)
  if (!live) {
    return `No live handle for ${args.workerId}, so there is no turn to stop.`
  }
  // `{ kind: 'user' }` exactly: only the `hook` cause carries a reason, so a
  // reason here would be an invented field. The caller's text is echoed instead.
  live.handle.agent.cancel?.({ kind: 'user' })

  // Release the issue so the work is not stranded. A failure here is reported
  // rather than thrown: the turn was already cancelled, and pretending the stop
  // did not happen would invite a second stop that cancels nothing.
  let released = ''
  try {
    const store = await deps.store.get()
    const stored = await store.workers.get(args.workerId)
    if (stored === undefined) {
      released = 'No worker record was found, so no issue was released.'
    } else {
      const worker = normalizeWorker(stored)
      const issueStored = await store.issues.get(worker.issueId)
      if (issueStored === undefined) {
        released = `Its issue ${worker.issueId} is missing, so nothing was released.`
      } else {
        const issue = normalizeIssue(issueStored)
        await store.issues.put(issue.id, releaseWorker(issue, 'requeue'))
        released =
          `${issue.id} is back in the queue as \`open\`, free for another worker. ` +
          `Its worktree at ${worker.worktreePath} was kept: stopping a turn is not abandoning the work.`
      }
    }
  } catch (error) {
    released = `The issue could not be released: ${error instanceof Error ? error.message : String(error)}`
  }
  deps.live?.forget(args.workerId)

  const why = args.reason && args.reason.trim() !== '' ? ` (${args.reason.trim()})` : ''
  return [
    `Stopped ${args.workerId}'s active turn${why}. Its session is untouched.`,
    '',
    released,
  ].join('\n')
}


/**
 * Starts queued work while the cap allows (M5).
 *
 * A sweep rather than a hook on worker completion, because slots free in several ways
 * -- a merge, a close, a cancellation, a stop -- and a sweep catches all of them. It
 * reuses `startWorkerForTool` rather than duplicating the spawn path, so a queued start
 * behaves exactly like a direct one, including the worktree, the session title and the
 * report tool restriction.
 *
 * Bounded by the cap at the TOP of each iteration and stopped on the first failure, so
 * a spawn that fails cannot become an infinite loop.
 */
export async function fillSlots(deps: WorkerToolDeps): Promise<{ started: string[]; active: number }> {
  const started: string[] = []
  let store
  try {
    store = await deps.store.get()
  } catch {
    return { started, active: 0 }
  }

  for (;;) {
    const active = (await store.workers.list()).map(normalizeWorker).filter((c) => !isTerminalPhase(c.phase))
    if (active.length >= deps.config.maxConcurrentWorkers) return { started, active: active.length }

    const next = (await store.issues.list())
      .map(normalizeIssue)
      .filter((candidate) => candidate.pendingWorker === true && candidate.state === IssueState.open && !candidate.workerId)
      .sort(byQueueOrder)[0]
    if (!next) return { started, active: active.length }

    // Cleared BEFORE the attempt, so a failure marks the issue as tried rather than
    // leaving it to be retried on every sweep forever. The reply is reported either way.
    await store.issues.put(next.id, { ...next, pendingWorker: false, updatedAt: Date.now() })
    const reply = await startWorkerForTool(deps, { issueId: next.id })
    if (!reply.startsWith('Started')) return { started, active: active.length }
    started.push(next.id)
  }
}
