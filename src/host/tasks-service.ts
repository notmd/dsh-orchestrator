/**
 * The new-task flow (the reference's "New task"): a brief becomes a running worker.
 *
 * ## What this adds over the existing ad-hoc path
 *
 * `orchestrator_worker_start({ title, description })` already starts a worker without
 * filing an issue by hand, and this is the same path underneath. Two things are
 * different, and both are the feature:
 *
 *   1. **The title is derived, not asked for.** The panel sends a *brief* — what the
 *      person typed, in their own words — and the task is named from it immediately,
 *      so the card appears with a name on it rather than waiting on a model. See
 *      `../domain/task-title.ts` for the ported rules.
 *   2. **The name is provisional, and the worker is asked for a better one.** The
 *      expectation is registered **before the spawn**, because the worker's first
 *      instruction is to name the task: a registration that happened after the prompt
 *      would race the very call it exists to authorise. The replacement is
 *      compare-and-swap against the provisional title, so a title a person has edited
 *      in the meantime is never overwritten.
 *
 * A task whose brief is empty is **allowed** — the reference's promptless worker —
 * and is simply never refined: there is nothing to refine from.
 *
 * @module dsho/host/tasks-service
 */

import {
  IssueCreator,
  IssueError,
  createIssue,
  nextIssueNumber,
  normalizeIssue,
  updateIssue,
} from '../domain/issues.ts'
import { generatedTaskTitle, provisionalTaskTitle } from '../domain/task-title.ts'
import { workerSessionTitle } from '../domain/workers.ts'
import { resolveRepoId } from './issues-service.ts'
import { findWorkerBySession } from './reports-service.ts'
import { startWorkerForTool } from './workers-service.ts'
import type { WorkerToolDeps } from './workers-service.ts'
import type { TaskRefinements } from './task-refinements.ts'

/** Everything the new-task flow needs. */
export interface TaskDeps extends WorkerToolDeps {
  /** Outstanding title refinements. Optional: a caller that never refines still works. */
  refinements?: TaskRefinements
}

/** What a new task produced. Every field is optional but `ok` and `message`. */
export interface NewTaskOutcome {
  ok: boolean
  message: string
  issueId?: string
  /** The worker, once one exists. Absent while the task is queued at capacity. */
  workerId?: string
  /** The title the card carries now: provisional until a refinement lands. */
  title?: string
  /** Whether a worker was started (false means queued, which is not a failure). */
  started?: boolean
  /** Whether a title replacement is still awaited. */
  refining?: boolean
}

/** One line naming the two hidden states a caller cannot otherwise see. */
function refinementNote(refining: boolean): string[] {
  return refining
    ? [
        '',
        'The title is PROVISIONAL. The worker is asked to name the task with',
        '`orchestrator_task_title`, and its title replaces this one only if it arrives',
        'within a minute and nobody has renamed the task meanwhile.',
      ]
    : []
}

/**
 * Creates a task and starts a worker on it.
 *
 * The order is: issue, then the refinement expectation, then the worker. Every
 * failure before the spawn leaves a task in the queue rather than a stray session,
 * and a failure *at* the spawn is `startWorkerForTool`'s problem: it already removes
 * the worktree it made.
 */
export async function createTaskWithWorker(deps: TaskDeps, input: { repoId?: string; brief?: string; sourceSessionId?: string }): Promise<NewTaskOutcome> {
  let store: Awaited<ReturnType<TaskDeps['store']['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return {
      ok: false,
      message:
        'The plugin could not open its storage, so no task could be created.\n\n' +
        `Storage error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const brief = (input.brief ?? '').trim()
  const resolved = await resolveRepoId(store, input.repoId)
  if ('message' in resolved) return { ok: false, message: resolved.message }

  const existing = (await store.issues.list()).map(normalizeIssue)
  let issue
  try {
    issue = createIssue(
      {
        repoId: resolved.repoId,
        number: nextIssueNumber(existing, resolved.repoId),
        title: provisionalTaskTitle(brief),
        body: brief,
        createdBy: IssueCreator.user,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      },
      deps.now ? { now: deps.now() } : {},
    )
  } catch (error) {
    return {
      ok: false,
      message: error instanceof IssueError ? `Could not create the task — ${error.message}` : String(error),
    }
  }
  await store.issues.put(issue.id, issue)

  // BEFORE the spawn, deliberately: the worker is told to name the task, so an
  // expectation registered afterwards could arrive after the call it authorises.
  const acceptance = brief === '' ? 'at-capacity' : deps.refinements?.expect(issue.id, issue.title) ?? 'at-capacity'
  let refining = acceptance !== 'at-capacity'

  const reply = await startWorkerForTool(deps, { issueId: issue.id, nameTheTask: refining })
  const started = reply.startsWith('Started')
  if (!started && refining) {
    // Nothing will report a title, and the queue sweep starts workers through a path
    // that does not ask for one either — so the expectation must go, or a later rename
    // would land against a task whose worker never heard the request.
    deps.refinements?.claim(issue.id)
    refining = false
  }
  const stored = await store.issues.get(issue.id)
  const workerId = stored === undefined ? undefined : normalizeIssue(stored).workerId

  return {
    ok: true,
    issueId: issue.id,
    ...(workerId ? { workerId } : {}),
    title: issue.title,
    started,
    refining,
    message: [
      `Created ${issue.id} — "${issue.title}"`,
      '',
      reply,
      ...refinementNote(refining),
    ].join('\n'),
  }
}

/**
 * `orchestrator_task_title` — the worker's answer to "name this task".
 *
 * Accepts only a call from the worker the refinement is waiting on, and applies the
 * title only if the task still carries the provisional one. Both guards are the
 * reference's: the first is the same caller check every worker protocol tool does,
 * and the second is its `RenameSessionIfDisplayName` compare-and-swap, which exists
 * because a person may have renamed the task while the worker was reading its brief.
 */
export async function setTaskTitleForTool(
  deps: TaskDeps,
  args: { title?: string },
  callerSessionId: string | undefined,
): Promise<string> {
  let store: Awaited<ReturnType<TaskDeps['store']['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return `The plugin could not open its storage, so the title was not recorded.\n\nStorage error: ${error instanceof Error ? error.message : String(error)}`
  }

  if (!callerSessionId) {
    return 'This tool names the calling session\u2019s own task, and no session was available to identify.'
  }
  const worker = await findWorkerBySession(store, callerSessionId)
  if (!worker) {
    return (
      `No worker is registered for session ${callerSessionId}, so there is no task to name. ` +
      'Titles are accepted only from worker sessions this plugin spawned.'
    )
  }

  const job = deps.refinements?.claim(worker.issueId)
  if (!job) {
    // Not an error worth an alarm: either this task was never awaiting a title (an
    // ad-hoc worker started from a title it was given), or the wait has ended.
    return `No title refinement is pending for ${worker.issueId}, so the current title was kept.`
  }

  const title = generatedTaskTitle(args.title ?? '')
  if (title === '') {
    return (
      'A title needs at least one letter or a digit. The provisional title was kept; ' +
      'there is no second attempt for this task.'
    )
  }

  const stored = await store.issues.get(worker.issueId)
  if (stored === undefined) return `The task ${worker.issueId} no longer exists, so nothing was renamed.`
  const issue = normalizeIssue(stored)
  if (issue.title !== job.provisional) {
    return (
      `${issue.id} is already titled "${issue.title}", which is not the provisional one this ` +
      'refinement was waiting to replace — so it was kept. The task is named.'
    )
  }

  const next = updateIssue(issue, { title }, deps.now ? deps.now() : Date.now())
  await store.issues.put(next.id, next)

  // The durable title is the issue, but the reference renames the SESSION too, and a
  // sidebar entry still reading the raw brief is the visible half of this feature.
  const live = deps.live?.byWorker(worker.id)
  if (live) {
    // Read the issue back rather than trusting the local value: the number is what
    // makes the session title match the card.
    deps.spawn.sessionTitle.rename(live.handle.agent.session, workerSessionTitle(next.number, next.title))
  }

  return `${next.id} is now titled "${next.title}".`
}
