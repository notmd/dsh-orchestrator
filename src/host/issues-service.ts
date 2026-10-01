/**
 * The three issue tools' behaviour, over the fact store.
 *
 * Split from `./tools.ts` so the tool *declarations* stay readable and the
 * behaviour stays directly testable — the same reason `connectRepoForTool` is
 * separate. Every function returns the text the model reads, because that is the
 * tool's whole output contract.
 *
 * The one decision worth stating: **`repoId` is inferred when it is unambiguous.**
 * An install with exactly one connected repository should not make the user repeat
 * itself on every call, and the flow the PRD describes ("create an issue to fix X")
 * has no repository in it at all. With zero connected it says so; with several it
 * asks, rather than guessing — picking the wrong repository silently is how an
 * issue ends up on the wrong board.
 *
 * @module dsho/host/issues-service
 */

import {
  IssueError,
  IssueState,
  assignWorker,
  byQueueOrder,
  createIssue,
  describeIssue,
  nextIssueNumber,
  normalizeIssue,
  updateIssue,
} from '../domain/issues.ts'
import type { Issue, IssueCreator, IssuePriority } from '../domain/issues.ts'
import type { LazyFactStore } from './store.ts'

/** What the issue tools need. */
export interface IssueToolDeps {
  store: LazyFactStore
  /** Injected so tests pin timestamps. */
  now?: () => number
}

/** A failed store access, phrased for the model. */
function storageFailure(error: unknown): string {
  return (
    'The plugin could not open its storage, so the issue could not be recorded.\n\n' +
    `Storage error: ${error instanceof Error ? error.message : String(error)}`
  )
}

/** Every stored issue, normalized. */
async function loadIssues(store: Awaited<ReturnType<LazyFactStore['get']>>): Promise<Issue[]> {
  return (await store.issues.list()).map(normalizeIssue)
}

/**
 * Resolves the repository an issue belongs to.
 *
 * Returns the id, or a message explaining why it could not be resolved — so the
 * caller never has to guess which of "no repos", "several repos" and "unknown id"
 * it is looking at.
 */
async function resolveRepoId(
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  requested: string | undefined,
): Promise<{ repoId: string } | { message: string }> {
  const repos = (await store.repos.list()) as Array<{ id?: unknown; rootPath?: unknown }>
  if (requested && requested.trim() !== '') {
    const wanted = requested.trim()
    const byId = repos.find((repo) => repo.id === wanted)
    if (byId && typeof byId.id === 'string') return { repoId: byId.id }
    const byPath = repos.find((repo) => repo.rootPath === wanted)
    if (byPath && typeof byPath.id === 'string') return { repoId: byPath.id }
    return {
      message:
        `No connected repository matches ${JSON.stringify(wanted)}. ` +
        `Connected: ${repos.map((repo) => String(repo.id)).join(', ') || '(none)'}. ` +
        'Call `orchestrator_repo_connect` first, or pass a connected id or path.',
    }
  }
  if (repos.length === 0) {
    return {
      message:
        'No repository is connected, so there is nowhere to file an issue.\n\n' +
        'Call `orchestrator_repo_connect` with the absolute path to a local checkout first.',
    }
  }
  if (repos.length > 1) {
    return {
      message:
        `Several repositories are connected, so this issue needs an explicit \`repoId\`. ` +
        `Connected: ${repos.map((repo) => String(repo.id)).join(', ')}.`,
    }
  }
  return { repoId: String(repos[0]!.id) }
}

/** `orchestrator_issue_create`. */
export async function createIssueForTool(
  deps: IssueToolDeps,
  args: {
    title: string
    body?: string
    repoId?: string
    priority?: IssuePriority
    labels?: readonly string[]
    createdBy?: IssueCreator
    /** The calling session, captured by the tool for report delivery. */
    sourceSessionId?: string
  },
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }

  const resolved = await resolveRepoId(store, args.repoId)
  if ('message' in resolved) return resolved.message

  const existing = await loadIssues(store)
  let issue: Issue
  try {
    issue = createIssue(
      {
        repoId: resolved.repoId,
        // The session that asked for the issue is where its worker's reports are
        // delivered. Without it there is nowhere for a report to land.
        ...(args.sourceSessionId ? { sourceSessionId: args.sourceSessionId } : {}),
        // `max + 1`, so a cancelled issue keeps its number and two issues can never
        // share the `#3` in a session title or a branch.
        number: nextIssueNumber(existing, resolved.repoId),
        title: args.title,
        body: args.body ?? '',
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.labels ? { labels: args.labels } : {}),
        ...(args.createdBy ? { createdBy: args.createdBy } : {}),
      },
      deps.now ? { now: deps.now() } : {},
    )
  } catch (error) {
    return error instanceof IssueError ? `Could not create the issue — ${error.message}` : String(error)
  }

  await store.issues.put(issue.id, issue)
  return [
    `Created ${issue.id}`,
    '',
    describeIssue(issue, true),
    '',
    'It is queued in `open`; the board shows it in Building until a worker is started.',
  ].join('\n')
}

/** `orchestrator_issue_list`. */
export async function listIssuesForTool(
  deps: IssueToolDeps,
  args: { state?: IssueState; repoId?: string; workerId?: string } = {},
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }

  let issues = await loadIssues(store)
  const total = issues.length
  if (args.state) issues = issues.filter((issue) => issue.state === args.state)
  if (args.repoId) issues = issues.filter((issue) => issue.repoId === args.repoId)
  if (args.workerId) issues = issues.filter((issue) => issue.workerId === args.workerId)
  issues.sort(byQueueOrder)

  if (issues.length === 0) {
    return total === 0
      ? 'No issues yet. Create one with `orchestrator_issue_create`.'
      : `No issues match those filters (${total} exist in total).`
  }

  const counts = {
    open: issues.filter((issue) => issue.state === IssueState.open).length,
    inProgress: issues.filter((issue) => issue.state === IssueState.inProgress).length,
    done: issues.filter((issue) => issue.state === IssueState.done).length,
    cancelled: issues.filter((issue) => issue.state === IssueState.cancelled).length,
  }
  return [
    `${issues.length} issue(s) — open ${counts.open}, in progress ${counts.inProgress}, done ${counts.done}, cancelled ${counts.cancelled}`,
    '',
    // Queue order, so the list *is* the work order.
    ...issues.map((issue) => describeIssue(issue)),
  ].join('\n')
}

/** `orchestrator_issue_update`. */
export async function updateIssueForTool(
  deps: IssueToolDeps,
  args: {
    id: string
    title?: string
    body?: string
    priority?: IssuePriority
    labels?: readonly string[]
    state?: IssueState
  },
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }

  const stored = await store.issues.get(args.id)
  if (stored === undefined) {
    const issues = await loadIssues(store)
    return (
      `No issue with id ${JSON.stringify(args.id)}. ` +
      (issues.length > 0 ? `Known: ${issues.map((issue) => issue.id).join(', ')}.` : 'There are no issues yet.')
    )
  }

  const issue = normalizeIssue(stored)
  let next: Issue
  try {
    next = updateIssue(issue, args, deps.now ? deps.now() : Date.now())
  } catch (error) {
    return error instanceof IssueError ? `Could not update ${issue.id} — ${error.message}` : String(error)
  }

  if (next === issue) {
    // An empty patch is not a change, and `updatedAt` must not move: a caller
    // re-sending the current values must not make the issue look freshly touched.
    return `No change to ${issue.id}.`
  }
  await store.issues.put(next.id, next)
  return `Updated ${next.id}\n\n${describeIssue(next, true)}`
}

/** `orchestrator_issue_assign` shares `assignWorker`'s invariant. */
export async function assignWorkerForTool(
  deps: IssueToolDeps,
  args: { id: string; workerId: string },
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }
  const stored = await store.issues.get(args.id)
  if (stored === undefined) return `No issue with id ${JSON.stringify(args.id)}.`
  const issue = normalizeIssue(stored)
  try {
    const next = assignWorker(issue, args.workerId, deps.now ? deps.now() : Date.now())
    await store.issues.put(next.id, next)
    return `${next.id} is now worked by ${next.workerId}.`
  } catch (error) {
    return error instanceof IssueError ? error.message : String(error)
  }
}
