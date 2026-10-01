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
/**
 * Whether a worker is BLOCKED on a human decision (R14, Guardrail 3).
 *
 * One definition, because two would diverge and the divergence would be a
 * security-relevant bug: `blocked` sessions must never be injected into, since input
 * arriving while a permission prompt is pending can read as an ANSWER to it.
 *
 * Blockage is explicit rather than inferred. `AgentStatus` is only `idle | running`, so
 * a session waiting on a person is indistinguishable from an idle one at that level --
 * which is why R9 has the protocol record it: a `pendingQuestion`, or the
 * `awaiting_human` phase, is the fact, and this reads exactly those.
 */
export function isBlockedWorker(worker: Worker): boolean {
  if (worker.pendingQuestion !== undefined) return true
  return worker.phase === WorkerPhase.awaitingHuman
}

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
  /**
   * What human feedback has already been routed to this worker (M4).
   *
   * Kept on the worker rather than in its own table because it is per-worker state
   * with the same lifetime, and it must be saved in the same write as the phase — a
   * separate table would let a crash between the two re-nudge the worker for feedback
   * it has already answered.
   */
  feedback?: {
    /** Provider ids (reviews and comments) already routed, so nothing is sent twice. */
    routedIds: readonly string[]
    /** How many nudges have been sent at this head, against `reviewMaxNudge`. */
    nudgedAtHead: number
    /** The commit the count belongs to; a new head resets it. */
    headSha: string
  }
  /**
   * The repo root's dirty paths when this worker started (R7).
   *
   * The plugin SHARES the user's checkout, so the root is often dirty for legitimate
   * reasons -- their work in progress, a scratch file, a build artefact. Only paths that
   * become dirty AFTER this baseline are evidence that a worker edited outside its
   * worktree, which is why the guard compares rather than judging.
   */
  rootDirtyAtStart?: readonly string[]
  createdAt: number
  updatedAt: number
  endedAt?: number
}

/** Normalizes a stored worker, filling Go's zero values. */
/**
 * Whether a stored value is a usable feedback record.
 *
 * Validated rather than trusted: it comes from storage, and a malformed one would make
 * the dedup silently stop working rather than fail loudly.
 */
function isFeedback(value: unknown): value is NonNullable<Worker['feedback']> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { routedIds?: unknown; nudgedAtHead?: unknown; headSha?: unknown }
  return (
    Array.isArray(candidate.routedIds) &&
    typeof candidate.nudgedAtHead === 'number' &&
    typeof candidate.headSha === 'string'
  )
}

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
    // Carried EXPLICITLY. This normalizer builds a record field by field, so a field
    // added to the interface alone is silently dropped on the next read -- which is
    // exactly how the feedback dedup failed: the routing wrote it, and the read that
    // followed lost it, so every poll re-nudged the worker.
    ...(isFeedback(record.feedback) ? { feedback: record.feedback } : {}),
    ...(Array.isArray(record.rootDirtyAtStart)
      ? { rootDirtyAtStart: record.rootDirtyAtStart.filter((p): p is string => typeof p === 'string') }
      : {}),
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
