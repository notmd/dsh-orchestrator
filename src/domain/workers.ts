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

import { ActivityState, needsInput } from '../contract/activity.ts'

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

/**
 * Whether a worker will act again.
 *
 * ## The one precedence for "finished" (§12.3)
 *
 * The reference teardown lists three overlapping representations of a finished worker — a
 * terminal phase, an `endedAt` timestamp, and an `isTerminated` flag handed to the reducers
 * (`IssueState` being a fourth, one level up on the issue). They are not collapsed, because
 * each has a job; instead the precedence is stated **here**, next to the only one that
 * decides anything:
 *
 *   1. **`phase` is authoritative.** This function is the only source of truth for "will this
 *      worker act again"; everything else below is derived from it or merely records it.
 *   2. **`endedAt` is a watermark on the phase**, written by {@link setPhase} at the moment
 *      the phase went terminal. It never decides anything: a record whose `endedAt` is set
 *      but whose phase is not terminal still reads as live, because the phase can only leave
 *      a terminal state through {@link PHASE_TRANSITIONS} — which forbids it — so the pair can
 *      disagree only on a hand-edited record.
 *   3. **`isTerminated` on the session facts handed to the ported reducers is derived** from
 *      the phase at read time and never stored. That is what makes the archive lane reachable
 *      without a second durable flag to keep in step, and it is why the board calls this
 *      function rather than testing a stored boolean.
 *   4. **`IssueState` (`done`/`cancelled`) is the *issue's* vocabulary**, released by
 *      completion. It tracks the work, not the worker: a requeued issue is `open` again while
 *      the abandoned worker that held it stays terminal.
 */
export function isTerminalPhase(phase: WorkerPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

/**
 * Every legal phase change, as an explicit table.
 *
 * `ValidPhaseTransition` is the reference's pattern (its `ValidAgentSwitchTransition`
 * in `domain/agent_switching.go`): a **domain-level** guard plus "terminal is
 * terminal", enforced at the persistence boundary so no alternate caller can skip
 * the ordering. Before this table existed, `setPhase` accepted anything —
 * `merged -> implementing` was representable, and the only thing stopping a
 * post-terminal write was `completeWorker`'s own idempotency check, which is a
 * property of one caller rather than of the record.
 *
 * ## How the table was derived
 *
 * From PRD §8's state diagram, plus the producers that actually drive each edge.
 * Three rules shape it:
 *
 *   1. **The pipeline is a ladder.** A worker may skip a stage it did not report,
 *      because a report is a checkpoint and a worker that never declared
 *      `planning` is not thereby forbidden to declare `implementing`. So forward
 *      moves anywhere up the ladder are legal.
 *   2. **Backward moves are enumerated, not general.** Only the edges the PRD names
 *      are allowed back down: a failed verify, a self-review and a fix round all
 *      return to `implementing`; a re-requested review returns `merge_ready` to
 *      `awaiting_human`.
 *   3. **`merge_ready` is a decision, not a declaration.** It is derived from
 *      provider facts by the merge-readiness sweep, so it is reachable from every
 *      non-terminal phase — a worker whose pull request is already mergeable when it
 *      is reattached must not be stuck because of where its last checkpoint left it.
 *
 * The terminal phases list nothing: a finished worker does not act again, and a
 * report arriving after termination is refused rather than resurrecting the record.
 */
export const PHASE_TRANSITIONS: Readonly<Record<WorkerPhase, readonly WorkerPhase[]>> = Object.freeze({
  [WorkerPhase.queued]: [
    WorkerPhase.planning,
    WorkerPhase.implementing,
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.planning]: [
    WorkerPhase.implementing,
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.implementing]: [
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.verifying]: [
    // The PRD's named back-edge: a failed verify returns to implementing.
    WorkerPhase.implementing,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.selfReviewing]: [
    WorkerPhase.implementing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.shipping]: [
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.awaitingAutoReview]: [
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.addressingFeedback]: [
    WorkerPhase.implementing,
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.awaitingHuman,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.awaitingHuman]: [
    // RESUME. The worker answered the question and declared its stage again — the normal
    // outcome, and the one this table originally got wrong: with no forward edge, a worker
    // that reported `needs_input` and then went back to work had its stage declaration
    // REFUSED and sat paused for the rest of the task.
    WorkerPhase.planning,
    WorkerPhase.implementing,
    WorkerPhase.verifying,
    WorkerPhase.selfReviewing,
    WorkerPhase.shipping,
    // PRD §8's forward edges from the paused state.
    WorkerPhase.addressingFeedback,
    WorkerPhase.awaitingAutoReview,
    WorkerPhase.mergeReady,
  ],
  [WorkerPhase.mergeReady]: [
    // "review re-requested" — a person asked for another round after all.
    WorkerPhase.awaitingHuman,
    WorkerPhase.addressingFeedback,
    // A new head on a merge-ready pull request owes a fresh pass. The merge-readiness sweep
    // would normally move the worker out of `merge_ready` first (the card is no longer
    // Ready), but the two sweeps share a cadence and neither may depend on the other having
    // run, so the edge is legal on its own.
    WorkerPhase.awaitingAutoReview,
  ],
  [WorkerPhase.merged]: [],
  [WorkerPhase.closed]: [],
  [WorkerPhase.abandoned]: [],
  [WorkerPhase.failed]: [],
})

/**
 * The phases that may be entered from **any** live phase, because nothing in the
 * pipeline decides them.
 *
 * A person can merge the pull request, close it, or stop the worker while the worker
 * is in the middle of any stage, and a reviewer can fail one from any stage. These are
 * facts imposed from outside the pipeline rather than moves within it, so enumerating
 * them per row would be fourteen copies of the same four entries — and the copies would
 * be the thing that eventually went stale. Everything else in the table is a real
 * ordering constraint, which is the part worth writing out.
 */
const IMPOSED_FROM_ANY_LIVE_PHASE: readonly WorkerPhase[] = Object.freeze([
  WorkerPhase.merged,
  WorkerPhase.closed,
  WorkerPhase.failed,
  WorkerPhase.abandoned,
])

/** A phase change the table forbids. */
export class InvalidPhaseTransitionError extends Error {
  readonly from: WorkerPhase
  readonly to: WorkerPhase

  constructor(from: WorkerPhase, to: WorkerPhase) {
    super(
      `${from} -> ${to} is not a legal worker phase transition` +
        (isTerminalPhase(from) ? ` (${from} is terminal)` : ''),
    )
    this.name = 'InvalidPhaseTransitionError'
    this.from = from
    this.to = to
  }
}

/**
 * Reports whether a phase change is legal.
 *
 * A phase equal to its own is **not** a transition: `setPhase` treats it as the
 * no-op it is, and reporting it here would make every "declare what I already am"
 * report look like a state change.
 */
export function isValidPhaseTransition(from: WorkerPhase, to: WorkerPhase): boolean {
  if (from === to) return false
  // Terminal is terminal `from`; and nothing may `to` a terminal except the imposed
  // outcomes, which any live phase can reach.
  if (isTerminalPhase(from)) return false
  if (IMPOSED_FROM_ANY_LIVE_PHASE.includes(to)) return true
  return (PHASE_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * The activity a worker has **declared**, if any.
 *
 * The protocol's explicit blockage, read through the ported predicates rather than
 * hand-compared, so the two questions stay separable: {@link needsInput} is "a person
 * is the unblocker" (asked here), and `isSticky` is "a clock may not demote this" (asked by
 * the board, where the demotion decision is actually taken). A worker
 * with nothing declared returns `undefined`, and the caller falls back to live status.
 */
export function declaredActivity(worker: Worker): ActivityState | undefined {
  // `waiting_input` for a recorded question, `blocked` for the phase. Both mean "a person is
  // the unblocker", and both render as `Needs you`; they stay distinct because the reference
  // keeps them distinct, and because the injection rule treats them differently (see
  // {@link isBlockedWorker}, which is deliberately stricter than this).
  if (worker.pendingQuestion !== undefined) return ActivityState.waitingInput
  if (worker.phase === WorkerPhase.awaitingHuman) return ActivityState.blocked
  return undefined
}

/**
 * Whether a worker is paused on a person, and therefore must not be aged out of that
 * state by the passage of time.
 *
 * This is R20's guard, named, and it is where the ported {@link needsInput} becomes
 * load-bearing: a paused worker's declared state is returned by `cardActivity` **instead of**
 * the live `AgentStatus`, so a quiet session can never be inferred `idle` and then demoted to
 * `No signal` while the question is still unanswered.
 */
export function isPausedWorker(worker: Worker): boolean {
  const declared = declaredActivity(worker)
  // The "is a person the unblocker?" half. (The time-demotion half is `isSticky`, consulted
  // by the board where the demotion decision is actually taken — one predicate per question,
  // rather than one conjunction asked twice.)
  return declared !== undefined && needsInput(declared)
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
  /**
   * When pull-request recovery last ran for this worker, epoch ms (finding G2).
   *
   * The plugin has **no discovery**: a pull request enters the system only through the
   * worker's own report, so a crash or a truncated report leaves a live PR invisible
   * forever. `prListArgv` was written for exactly this recovery path and called from
   * nowhere. A watermark rather than a flag, because recovery is a *safety net* with its own
   * slow cadence — retrying it on every 30-second tick would add a billed `gh` call per
   * unbound worker, which is the cost finding G1 is about.
   */
  prRecoveryAt?: number
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
    ...(typeof record.prRecoveryAt === 'number' ? { prRecoveryAt: record.prRecoveryAt } : {}),
    lastSignalAt: typeof record.lastSignalAt === 'number' ? record.lastSignalAt : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
  // Carried EXPLICITLY, for the reason the `feedback` comment above records: this normalizer
  // rebuilds the record field by field, so a field added to the interface alone is dropped on
  // the next read.
  if (record.pendingQuestion) worker.pendingQuestion = record.pendingQuestion
  if (record.pr) worker.pr = record.pr
  if (typeof record.endedAt === 'number') worker.endedAt = record.endedAt
  return worker
}

/**
 * Records a phase change, appending to the audit trail.
 *
 * **The transition table is enforced here**, which is the only writer — so the guard
 * cannot be bypassed by a caller that forgets to check. A caller that may legitimately
 * hit a forbidden edge (a report arriving for a worker that has already finished)
 * should test {@link isValidPhaseTransition} first and explain the refusal, rather
 * than catching this: a thrown guard is the bug case, not a routine outcome.
 *
 * `endedAt` is stamped here and only here, so the watermark can never disagree with
 * the phase that produced it (see {@link workerTerminality}).
 *
 * @throws {InvalidPhaseTransitionError} when the change is not in the table.
 */
export function setPhase(worker: Worker, phase: WorkerPhase, summary: string, now = Date.now()): Worker {
  if (worker.phase === phase) return worker
  if (!isValidPhaseTransition(worker.phase, phase)) {
    throw new InvalidPhaseTransitionError(worker.phase, phase)
  }
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
