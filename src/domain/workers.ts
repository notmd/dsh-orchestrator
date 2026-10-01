/**
 * The worker record and its phases (PRD §7.3, §5.2).
 *
 * The worker is the join between an issue and a DSH session: one issue, one
 * session, one branch, one worktree. The session is the durable spine — if DSH
 * restarts, the board reattaches to the same session rather than losing the work.
 *
 * ## The phases are declared, never inferred
 *
 * The plugin's **only** source of phase truth is the worker calling
 * `orchestrator_report`. Nothing here parses prose from a transcript, because a
 * board that guesses is worse than a board that says "unknown": a wrong lane is
 * acted on.
 *
 * `self_reviewing` and `awaiting_auto_review` are deliberately distinct, and the
 * PRD is explicit about why: `self_reviewing` is the **worker** checking its own
 * diff before opening the pull request, `awaiting_auto_review` is the **plugin's
 * independent reviewer** checking the PR afterwards. Collapsing them would hide the
 * distinction the whole review order depends on.
 *
 * @module dsho/domain/workers
 */

/** Where a worker is in its pipeline. */
export const WorkerPhase = Object.freeze({
  /** Accepted, waiting for a free slot. */
  queued: 'queued',
  planning: 'planning',
  implementing: 'implementing',
  verifying: 'verifying',
  /** The **worker** reading its own diff before opening the PR. */
  selfReviewing: 'self_reviewing',
  shipping: 'shipping',
  /** The **plugin's independent reviewer** reading the PR at an exact head. */
  awaitingAutoReview: 'awaiting_auto_review',
  /** The worker is acting on review findings. */
  addressingFeedback: 'addressing_feedback',
  /** Waiting on a person. */
  awaitingHuman: 'awaiting_human',
  mergeReady: 'merge_ready',
  // Terminal
  merged: 'merged',
  closed: 'closed',
  abandoned: 'abandoned',
  failed: 'failed',
})

/** The union of every phase. */
export type WorkerPhase = (typeof WorkerPhase)[keyof typeof WorkerPhase]

/** Phases after which a worker will not act again. */
export const TERMINAL_PHASES: readonly WorkerPhase[] = [
  WorkerPhase.merged,
  WorkerPhase.closed,
  WorkerPhase.abandoned,
  WorkerPhase.failed,
]

/** Reports whether a phase is terminal. */
export function isTerminalPhase(phase: WorkerPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

/** One phase change, for the audit trail. */
export interface PhaseEntry {
  phase: WorkerPhase
  at: number
  summary: string
}

/** A question the worker is waiting on a person to answer. */
export interface PendingQuestion {
  text: string
  at: number
}

/** The pull request a worker produced, once one exists. */
export interface PrRef {
  number: number
  url: string
  headSha: string
}

/** One worker: an issue being worked by one DSH session. */
export interface Worker {
  id: string
  issueId: string
  /** **The DSH session** — the durable spine. */
  sessionId: string
  branch: string
  worktreePath: string
  workspaceId: string
  phase: WorkerPhase
  phaseHistory: readonly PhaseEntry[]
  pendingQuestion?: PendingQuestion
  pr?: PrRef
  /** Epoch ms of the last sign of life, for `No signal` detection. */
  lastSignalAt: number
  createdAt: number
  updatedAt: number
  endedAt?: number
}

/** Normalizes a stored worker, filling Go's zero values. */
export function normalizeWorker(raw: unknown): Worker {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Worker>
  const phases: readonly string[] = Object.values(WorkerPhase)
  const worker: Worker = {
    id: typeof record.id === 'string' ? record.id : '',
    issueId: typeof record.issueId === 'string' ? record.issueId : '',
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    branch: typeof record.branch === 'string' ? record.branch : '',
    worktreePath: typeof record.worktreePath === 'string' ? record.worktreePath : '',
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : '',
    phase: phases.includes(record.phase as string) ? (record.phase as WorkerPhase) : WorkerPhase.queued,
    phaseHistory: Array.isArray(record.phaseHistory)
      ? record.phaseHistory.filter((entry): entry is PhaseEntry => typeof entry === 'object' && entry !== null)
      : [],
    lastSignalAt: typeof record.lastSignalAt === 'number' ? record.lastSignalAt : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
  if (record.pendingQuestion) worker.pendingQuestion = record.pendingQuestion
  if (record.pr) worker.pr = record.pr
  if (typeof record.endedAt === 'number') worker.endedAt = record.endedAt
  return worker
}

/** Records a phase change, appending to the audit trail. */
export function setPhase(worker: Worker, phase: WorkerPhase, summary: string, now = Date.now()): Worker {
  if (worker.phase === phase) return worker
  return {
    ...worker,
    phase,
    phaseHistory: [...worker.phaseHistory, { phase, at: now, summary }],
    lastSignalAt: now,
    updatedAt: now,
    ...(isTerminalPhase(phase) ? { endedAt: now } : {}),
  }
}

/** The session title for a worker: `#<n> <title>`, so the sidebar is legible. */
export function workerSessionTitle(issueNumber: number, title: string): string {
  return issueNumber > 0 ? `#${issueNumber} ${title}` : title
}
