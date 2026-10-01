/**
 * The issue record and its transitions (PRD §7.1).
 *
 * Deliberately small and pure: an issue is the *queue entry*, and its lifecycle is
 * orthogonal to the board's. `state` here is `open`/`in_progress`/`done`/
 * `cancelled` — issue-level — while a card's lane is derived from delivery facts
 * and never stored (PRD §7.1, and `../contract/kanban.ts` says the same about the
 * column).
 *
 * Two invariants the record enforces rather than documents:
 *
 *   - **At most one active worker per issue** (PRD §7.1). `assignWorker` refuses a
 *     second assignment while one is live, because two workers on one issue means
 *     two branches, two PRs, and no rule for which one the card follows.
 *   - **A state change is a decision, not a side effect.** Every mutation returns a
 *     new record and bumps `updatedAt`; nothing mutates in place, so a caller can
 *     never hold a half-updated issue.
 *
 * @module dsho/domain/issues
 */

import { newId } from './ids.ts'

/** Queue order. `high` is worked first. */
export const IssuePriority = Object.freeze({
  high: 'high',
  normal: 'normal',
  low: 'low',
})

/** The union of every priority. */
export type IssuePriority = (typeof IssuePriority)[keyof typeof IssuePriority]

/** Issue-level lifecycle. Not a board lane. */
export const IssueState = Object.freeze({
  open: 'open',
  inProgress: 'in_progress',
  done: 'done',
  cancelled: 'cancelled',
})

/** The union of every issue state. */
export type IssueState = (typeof IssueState)[keyof typeof IssueState]

/** Who created the issue. Provenance only; it changes no behaviour. */
export const IssueCreator = Object.freeze({
  user: 'user',
  orchestrator: 'orchestrator',
})

/** The union of every creator. */
export type IssueCreator = (typeof IssueCreator)[keyof typeof IssueCreator]

/** A mirrored GitHub issue, once one exists. */
export interface GithubIssueRef {
  number: number
  url: string
}

/** One queue entry. */
export interface Issue {
  id: string
  repoId: string
  title: string
  body: string
  priority: IssuePriority
  state: IssueState
  labels: readonly string[]
  createdBy: IssueCreator
  /** The session that created it, when that is known. */
  sourceSessionId?: string
  githubIssue?: GithubIssueRef
  /** At most one active worker per issue. */
  workerId?: string
  createdAt: number
  updatedAt: number
}

/** Something the caller must fix. */
export class IssueError extends Error {
  readonly field: string

  constructor(field: string, problem: string) {
    super(`issue ${field}: ${problem}`)
    this.name = 'IssueError'
    this.field = field
  }
}

const PRIORITIES: readonly string[] = Object.values(IssuePriority)
const STATES: readonly string[] = Object.values(IssueState)
const CREATORS: readonly string[] = Object.values(IssueCreator)

/** The queue order, first to last. */
export const PRIORITY_ORDER: readonly IssuePriority[] = [
  IssuePriority.high,
  IssuePriority.normal,
  IssuePriority.low,
]

/** Normalizes a value read back from storage, filling Go's zero values. */
export function normalizeIssue(raw: unknown): Issue {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Issue>
  const issue: Issue = {
    id: typeof record.id === 'string' ? record.id : '',
    repoId: typeof record.repoId === 'string' ? record.repoId : '',
    title: typeof record.title === 'string' ? record.title : '',
    body: typeof record.body === 'string' ? record.body : '',
    priority: PRIORITIES.includes(record.priority as string)
      ? (record.priority as IssuePriority)
      : IssuePriority.normal,
    state: STATES.includes(record.state as string) ? (record.state as IssueState) : IssueState.open,
    labels: Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [],
    createdBy: CREATORS.includes(record.createdBy as string)
      ? (record.createdBy as IssueCreator)
      : IssueCreator.user,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
  if (typeof record.sourceSessionId === 'string') issue.sourceSessionId = record.sourceSessionId
  if (typeof record.workerId === 'string') issue.workerId = record.workerId
  if (isGithubRef(record.githubIssue)) issue.githubIssue = record.githubIssue
  return issue
}

function isGithubRef(value: unknown): value is GithubIssueRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GithubIssueRef).number === 'number' &&
    typeof (value as GithubIssueRef).url === 'string'
  )
}

/** Validates a priority, returning the value or throwing. */
export function assertPriority(value: string): IssuePriority {
  if (!PRIORITIES.includes(value)) {
    throw new IssueError('priority', `must be one of ${PRIORITIES.join(' | ')}, got ${JSON.stringify(value)}`)
  }
  return value as IssuePriority
}

/** Validates a state, returning the value or throwing. */
export function assertState(value: string): IssueState {
  if (!STATES.includes(value)) {
    throw new IssueError('state', `must be one of ${STATES.join(' | ')}, got ${JSON.stringify(value)}`)
  }
  return value as IssueState
}

/**
 * Validates a title.
 *
 * Trimmed and required, and length-capped because the title becomes a branch
 * segment (`dsho/issue-<n>-<slug>`) and a session title. A 500-character title is
 * not an issue title; refusing it early is kinder than a truncated branch.
 */
export const MAX_TITLE_LENGTH = 200

export function assertTitle(value: string): string {
  const title = (value ?? '').trim()
  if (title === '') throw new IssueError('title', 'must not be empty')
  if (title.length > MAX_TITLE_LENGTH) {
    throw new IssueError('title', `must be at most ${MAX_TITLE_LENGTH} characters, got ${title.length}`)
  }
  return title
}

/** Normalizes a label list: trimmed, non-empty, de-duplicated, order kept. */
export function normalizeLabels(labels: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const label of labels ?? []) {
    const trimmed = (label ?? '').trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Creates an issue. Validates loudly; an unusable issue is refused here. */
export function createIssue(
  input: {
    repoId: string
    title: string
    body?: string
    priority?: IssuePriority
    labels?: readonly string[]
    createdBy?: IssueCreator
    sourceSessionId?: string
  },
  context: { now?: number; id?: string } = {},
): Issue {
  if (!input.repoId?.trim()) throw new IssueError('repoId', 'must name a connected repository')
  const now = context.now ?? Date.now()
  const issue: Issue = {
    id: context.id ?? newId('iss', now),
    repoId: input.repoId.trim(),
    title: assertTitle(input.title),
    body: input.body ?? '',
    priority: input.priority ? assertPriority(input.priority) : IssuePriority.normal,
    state: IssueState.open,
    labels: normalizeLabels(input.labels),
    createdBy: input.createdBy ?? IssueCreator.user,
    createdAt: now,
    updatedAt: now,
  }
  if (input.sourceSessionId) issue.sourceSessionId = input.sourceSessionId
  return issue
}

/** The fields `updateIssue` may change. */
export interface IssuePatch {
  title?: string
  body?: string
  priority?: IssuePriority
  labels?: readonly string[]
  state?: IssueState
}

/**
 * Applies a patch, returning a new record.
 *
 * An empty patch is not a change, so `updatedAt` does not move: a caller that
 * re-sends the current values must not make the issue look freshly touched, which
 * would disturb the queue order.
 */
export function updateIssue(issue: Issue, patch: IssuePatch, now = Date.now()): Issue {
  const next: Issue = { ...issue }
  let changed = false

  if (patch.title !== undefined) {
    const title = assertTitle(patch.title)
    if (title !== next.title) {
      next.title = title
      changed = true
    }
  }
  if (patch.body !== undefined && patch.body !== next.body) {
    next.body = patch.body
    changed = true
  }
  if (patch.priority !== undefined) {
    const priority = assertPriority(patch.priority)
    if (priority !== next.priority) {
      next.priority = priority
      changed = true
    }
  }
  if (patch.labels !== undefined) {
    const labels = normalizeLabels(patch.labels)
    if (labels.join('\u0000') !== next.labels.join('\u0000')) {
      next.labels = labels
      changed = true
    }
  }
  if (patch.state !== undefined) {
    const state = assertState(patch.state)
    if (state !== next.state) {
      next.state = state
      changed = true
    }
  }

  if (!changed) return issue
  next.updatedAt = now
  return next
}

/**
 * Binds a worker to the issue.
 *
 * Refuses a second worker while one is live (`PRD §7.1`, "at most one active worker
 * per issue"). Two workers on one issue would mean two branches, two PRs, and no
 * rule for which one a card follows — the kind of ambiguity that only shows up as a
 * confusing board much later.
 */
export function assignWorker(issue: Issue, workerId: string, now = Date.now()): Issue {
  if (!workerId.trim()) throw new IssueError('workerId', 'must not be empty')
  if (issue.workerId === workerId) return issue
  if (issue.workerId) {
    throw new IssueError(
      'workerId',
      `issue ${issue.id} already has worker ${issue.workerId}; stop it before assigning another`,
    )
  }
  return { ...issue, workerId, state: IssueState.inProgress, updatedAt: now }
}

/**
 * Releases the issue's worker, returning it to the queue.
 *
 * The worker id is cleared so a replacement can be assigned; the issue stays
 * `in_progress` only while a worker exists, so this is also how a failed spawn
 * returns work to the queue rather than leaving it stranded.
 */
export function releaseWorker(issue: Issue, outcome: 'done' | 'cancelled' | 'requeue', now = Date.now()): Issue {
  const next: Issue = { ...issue }
  delete next.workerId
  next.state = outcome === 'done' ? IssueState.done : outcome === 'cancelled' ? IssueState.cancelled : IssueState.open
  next.updatedAt = now
  return next
}

/** Queue order: priority first, then oldest first so nothing starves. */
export function byQueueOrder(left: Issue, right: Issue): number {
  const rank = PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority)
  if (rank !== 0) return rank
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Renders one issue as a line, and in detail when asked. */
export function describeIssue(issue: Issue, detailed = false): string {
  const worker = issue.workerId ? ` worker=${issue.workerId}` : ''
  const github = issue.githubIssue ? ` github=#${issue.githubIssue.number}` : ''
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : ''
  const head = `${issue.id}  ${issue.state}  ${issue.priority}${worker}${github}${labels}  ${issue.title}`
  if (!detailed) return head
  return [
    head,
    `  repo: ${issue.repoId}`,
    ...(issue.body ? ['  body:', ...issue.body.split('\n').map((line) => `    ${line}`)] : []),
    `  created: ${new Date(issue.createdAt).toISOString()}  updated: ${new Date(issue.updatedAt).toISOString()}`,
  ].join('\n')
}
