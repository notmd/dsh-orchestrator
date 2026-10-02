/**
 * Card presentation: what a card says, whether it demands attention, and the
 * order cards appear in a lane.
 *
 * PORTED from Agent Orchestrator `packages/product-ui/src/SessionsBoardView.tsx`
 * (`boardSessionNeedsAttention`, the lane sort, the card's finished/loader
 * conditions) and `packages/product-ui/src/session-presentation.ts`
 * (`attentionZone`). See NOTICE.
 *
 * The attention predicate is the piece most easily got wrong, so it is stated
 * once here and exercised by tests rather than re-derived in the component.
 *
 * @module dsho/board/presentation
 */

import { ActivityState } from '../contract/activity.ts'
import {
  DisplayStatus,
  KANBAN_LANES,
  KanbanColumn,
  chosenKanbanPR,
  deriveKanbanPresentation,
  prFacts,
} from '../contract/kanban.ts'
import { SessionStatus, sessionFacts } from '../contract/status.ts'
import type { KanbanPRFacts, KanbanPRFactsInput } from '../contract/kanban.ts'

/**
 * Startup verification, never a persisted status.
 *
 * This is the honest answer to "do we actually know this worker's state yet?".
 * `checking` is the state after a restart, before a worker's handle is reattached
 * (A27), and `unavailable` means we could not find out. Either way it suppresses
 * the attention treatment: **uncertainty must not be rendered as a demand.**
 */
export const StatusReadiness = Object.freeze({
  checking: 'checking',
  ready: 'ready',
  unavailable: 'unavailable',
} as const)

/** The union of every readiness value. */
export type StatusReadiness = (typeof StatusReadiness)[keyof typeof StatusReadiness]

/** Normalizes a missing readiness to `ready`; only a *known* non-ready suppresses. */
export function normalizeStatusReadiness(value: unknown): StatusReadiness {
  if (value === StatusReadiness.checking || value === StatusReadiness.unavailable) return value
  return StatusReadiness.ready
}

/**
 * The older, separate attention vocabulary.
 *
 * These are **not** the board lanes. They survive in the reference only as a
 * fallback mapping for a daemon too old to send `displayStatus`, and the PRD
 * keeps them for exactly the same reason: the predicate must still answer when
 * `displayStatus` is absent.
 */
export const AttentionZone = Object.freeze({
  working: 'working',
  action: 'action',
  pending: 'pending',
  merge: 'merge',
  done: 'done',
} as const)

/** The union of every attention zone. */
export type AttentionZone = (typeof AttentionZone)[keyof typeof AttentionZone]

/**
 * Maps a session status to its attention zone. Ported from `attentionZone`.
 *
 * Note what lands in `action`: `needs_input`, `exited`, `no_signal`, `ci_failed`,
 * `changes_requested`, and — importantly — `unknown`. An unknown state is an
 * action item, because we cannot rule out that a person is needed. `working` and
 * `idle` are not.
 */
export function attentionZone(status: string): AttentionZone | undefined {
  switch (status) {
    case SessionStatus.merged:
    case SessionStatus.approved:
    case SessionStatus.mergeable:
      return AttentionZone.merge
    case SessionStatus.terminated:
      return AttentionZone.done
    case SessionStatus.needsInput:
    case SessionStatus.exited:
    case SessionStatus.noSignal:
    case SessionStatus.ciFailed:
    case SessionStatus.changesRequested:
    case 'unknown':
      return AttentionZone.action
    case SessionStatus.reviewPending:
    case SessionStatus.prOpen:
    case SessionStatus.draft:
      return AttentionZone.pending
    case SessionStatus.working:
    case SessionStatus.idle:
      return AttentionZone.working
    default:
      return undefined
  }
}

/**
 * The display statuses that demand attention.
 *
 * **Exactly three.** `Needs human review` is deliberately not among them: it
 * waits on a person, but it is the *normal* resting place of a finished automated
 * loop, and pulsing on it would train the user to ignore the pulse (A28).
 */
export const ATTENTION_DISPLAY_STATUSES: readonly DisplayStatus[] = Object.freeze([
  DisplayStatus.blocked,
  DisplayStatus.ciFailing,
  DisplayStatus.changesRequested,
])

/** The display statuses that mean the automated loop is still turning the PR. */
export const IN_PROGRESS_DISPLAY_STATUSES: readonly DisplayStatus[] = Object.freeze([
  DisplayStatus.reviewPending,
  DisplayStatus.fixingCI,
  DisplayStatus.addressingComments,
  DisplayStatus.reviewing,
])

/** One card's inputs. */
/**
 * The auto-review loop's position and findings, as the inspector needs them.
 *
 * One named shape shared by the card and the view: two structurally identical
 * declarations would drift, and the drift would show up as a field the inspector
 * silently renders as absent.
 *
 * `round/maxRounds` is shown while the loop runs so the BOUND is visible rather than
 * arriving as a surprise when it trips, and the findings are carried so a machine
 * review can be inspected -- a review the user cannot inspect is one they cannot
 * trust.
 */
/**
 * A person who reviewed the pull request, and their latest verdict.
 *
 * Bots are excluded, because "the automated reviewer approved" is already said by the
 * status line -- repeating it as an avatar would suggest a human had looked. The card is
 * answering one question with these: **is this waiting on me?**
 */
export interface CardReviewer {
  name: string
  /** The provider's own word: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING. */
  state: string
}

export interface CardReview {
  round: number
  maxRounds: number
  verdict?: string
  findings: ReadonlyArray<{ severity: string; path?: string; line?: number; summary: string; detail: string }>
  githubReviewId?: string
}

export interface BoardCard {
  /** Stable identity, for keys and tie-breaks. */
  id: string
  sessionId: string
  title: string
  /** Epoch ms, for ordering. */
  updatedAt: number
  /** A {@link StatusReadiness} value. */
  statusReadiness?: string
  /** A {@link SessionStatus} value. */
  status?: string
  /** An {@link ActivityState} value. */
  activity?: string
  isTerminated?: boolean
  lastActivityAt?: number
  hasSignal?: boolean
  signalExpected?: boolean
  /** Reference-only daemon override. */
  statusPresentation?: unknown
  /**
   * A pre-derived display status, when the caller already ran the reducer.
   * `presentCard` supplies it explicitly.
   */
  displayStatus?: DisplayStatus
  autoReview?: boolean
  autoInjectReview?: boolean
  autoInjectCI?: boolean
  requireHumanApprovalBeforeReady?: boolean
  prs?: readonly KanbanPRFactsInput[]
  /** The auto-review evidence the inspector shows. */
  review?: CardReview
  /** The worker's branch, shown only when it says something the title does not. */
  branch?: string
  /** Humans who reviewed, so the card can say who it is waiting on. */
  reviewers?: readonly CardReviewer[]
}

/**
 * Reports whether a card should carry the needs-attention treatment.
 *
 * Ported from `boardSessionNeedsAttention`, with the reference's guard order
 * preserved:
 *
 *   1. A non-`ready` `statusReadiness` suppresses attention outright — uncertainty
 *      is not a demand (A27, R21).
 *   2. The three attention display statuses win.
 *   3. With no `displayStatus` at all, fall back to the older attention-zone
 *      mapping plus a directly blocked activity state.
 *   4. Everything else — including `Needs human review` — does not pulse (A28).
 *
 * The reference's `statusPresentation` guard is reproduced and documented: it is
 * a daemon-side presentation override that this plugin never sets, so it is inert
 * here. It is kept so that a future port that does start setting it inherits the
 * reference's behaviour instead of silently losing it.
 */
export function needsAttention(card: OrderableCard, displayStatus?: DisplayStatus): boolean {
  if (normalizeStatusReadiness(card.statusReadiness) !== StatusReadiness.ready) return false
  if (card.statusPresentation) return false
  const status = displayStatus ?? card.displayStatus
  if (status === undefined) {
    return (
      attentionZone(card.status ?? '') === AttentionZone.action ||
      card.activity === ActivityState.blocked
    )
  }
  return ATTENTION_DISPLAY_STATUSES.includes(status)
}

/**
 * Reports whether a session has genuinely finished.
 *
 * Ported from the card's `isFinishedForPullRequestProgress`. **Both** facts are
 * required: a live session can already read `merged` before it exits, and it may
 * still gain more PRs, so `merged` alone must not render as finished (A30).
 */
export function isFinished(card: BoardCard): boolean {
  return (
    card.status === SessionStatus.terminated ||
    (card.status === SessionStatus.merged && card.isTerminated === true)
  )
}

/**
 * Reports whether the card shows a working spinner.
 *
 * Ported from the card's `showStatusLoader`. Two conditions are worth keeping
 * verbatim because both are bug fixes the reference earned:
 *
 *   - `Needs human review` and `Draft` get no spinner. A draft describes the PR,
 *     not work anyone is turning, and a finished loop is not in progress.
 *   - The check reads `displayStatus`, **not** `status`. `status` aggregates the
 *     session's *worst* open PR while `displayStatus` describes its *best* one, so
 *     keying the spinner off `status` spun a settled `Mergeable` card forever
 *     whenever a sibling PR was still review-pending (the reference's #5081).
 */
export function showStatusLoader(card: OrderableCard, displayStatus?: DisplayStatus): boolean {
  const readiness = normalizeStatusReadiness(card.statusReadiness)
  if (readiness === StatusReadiness.checking) return true
  if (readiness === StatusReadiness.unavailable) return false
  const status = displayStatus ?? card.displayStatus
  if (needsAttention(card, status)) return false
  if (status === DisplayStatus.needsHumanReview) return false
  if (status === DisplayStatus.draft) return false
  if (status) return IN_PROGRESS_DISPLAY_STATUSES.includes(status)
  return card.status === SessionStatus.reviewPending
}

/**
 * Orders the cards inside one lane.
 *
 * `(needsAttention desc, updatedAt desc)`, exactly as the reference sorts — so a
 * worker waiting on a person floats above a freshly-updated idle one (A29, R22).
 *
 * **One added tie-break, and it is deliberate.** The reference relies on
 * `Array.prototype.sort` being stable to keep equal cards in insertion order. That
 * is not enough for us: our board is rebuilt from a snapshot on every refresh, and
 * if the snapshot's order ever varies the board flickers on a no-op refresh,
 * which A29 forbids. Comparing `id` last makes the result a pure function of the
 * card set, so a no-op refresh provably cannot reorder it.
 *
 * Returns a new array; the input is not mutated.
 */
export function orderCards<T extends OrderableCard>(
  cards: readonly T[],
  displayStatusOf?: (card: T) => DisplayStatus | undefined,
): T[] {
  const statusOf = displayStatusOf ?? ((card: T) => card.displayStatus)
  return [...cards].sort((left, right) => {
    const attention =
      Number(needsAttention(right, statusOf(right))) - Number(needsAttention(left, statusOf(left)))
    if (attention !== 0) return attention
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * The minimum a card needs to be ordered.
 *
 * Structural rather than `BoardCard`, because a **presented** card must be
 * orderable too — and a view is a different type. Typing this as `BoardCard` would
 * have forced every caller to re-derive a card it already had.
 */
export interface OrderableCard {
  id: string
  /** Epoch ms. The second sort key, after attention. */
  updatedAt: number
  statusReadiness?: string
  status?: string
  activity?: string
  statusPresentation?: unknown
  displayStatus?: DisplayStatus
}

/** One card's full derived presentation. */
export interface BoardCardView {
  id: string
  /** Epoch ms, carried so a view can be ordered without its source card. */
  updatedAt: number
  sessionId: string
  title: string
  column: KanbanColumn
  displayStatus: DisplayStatus
  status: string
  statusReadiness: StatusReadiness
  /** The auto-review loop's position and findings, for the inspector. */
  review?: CardReview
  /** The worker's branch. */
  branch?: string
  /** Humans who reviewed, never bots. */
  reviewers?: readonly CardReviewer[]
  needsAttention: boolean
  showStatusLoader: boolean
  isFinished: boolean
  /** Why the automated loop stopped, if it did. */
  escalationReason?: 'review-round-limit' | 'review-failed-retry-limit'
  /** What is left before the merge, when the card is waiting on one. */
  mergeBlockers?: readonly string[]
  prs: readonly KanbanPRFacts[]
}

/**
 * Assembles one card's full presentation.
 *
 * The one place that reads every derived field, so the component cannot disagree
 * with the reducer.
 */
export function presentCard(
  card: BoardCard,
  timing: { now: number; noSignalGraceMs: number },
): BoardCardView {
  const session = sessionFacts({
    activity: card.activity,
    lastActivityAt: card.lastActivityAt,
    hasSignal: card.hasSignal,
    signalExpected: card.signalExpected,
    isTerminated: card.isTerminated,
    autoReview: card.autoReview,
    autoInjectReview: card.autoInjectReview,
    autoInjectCI: card.autoInjectCI,
    requireHumanApprovalBeforeReady: card.requireHumanApprovalBeforeReady,
  })
  const prs = (card.prs ?? []).map(prFacts)
  const derived = deriveKanbanPresentation(session, prs, timing.now, timing.noSignalGraceMs)
  const readiness = normalizeStatusReadiness(card.statusReadiness)
  const status = card.status ?? ''

  const view: BoardCardView = {
    ...(card.review ? { review: card.review } : {}),
    ...(card.branch ? { branch: card.branch } : {}),
    ...(card.reviewers && card.reviewers.length > 0 ? { reviewers: card.reviewers } : {}),
    id: card.id,
    updatedAt: card.updatedAt,
    sessionId: card.sessionId,
    title: card.title,
    column: derived.column,
    displayStatus: derived.displayStatus,
    status,
    statusReadiness: readiness,
    needsAttention: needsAttention(card, derived.displayStatus),
    showStatusLoader: showStatusLoader(card, derived.displayStatus),
    isFinished: isFinished(card),
    prs,
  }
  if (derived.escalationReason) view.escalationReason = derived.escalationReason
  // Read from the CHOSEN pull request — the one whose facts drew the column — through the
  // SAME ranking the reducer used, so the reasons describe the same PR the phrase above
  // them does. Empty is omitted rather than sent as an empty list, because every reader
  // treats absence as "nothing to say" and a present-but-empty array as a promise that
  // there was something to look at.
  const blockers = chosenKanbanPR(session, prs)?.chosen.mergeBlockers ?? []
  if (blockers.length > 0) view.mergeBlockers = blockers
  return view
}

/**
 * Groups presented cards into the four lanes, in delivery order.
 *
 * Archive is deliberately **not** a lane: terminated sessions belong in a
 * separate sheet, and the board stays one continuous four-lane grid (A30).
 */
export function groupIntoLanes(views: readonly BoardCardView[]): Record<KanbanColumn, BoardCardView[]> {
  const lanes = {} as Record<KanbanColumn, BoardCardView[]>
  for (const lane of KANBAN_LANES) lanes[lane] = []
  for (const view of views) {
    if (view.column === KanbanColumn.archive) continue
    lanes[view.column].push(view)
  }
  return lanes
}

/** The archive sheet's contents: terminated sessions. */
export function archiveSheet(views: readonly BoardCardView[]): BoardCardView[] {
  return views.filter((view) => view.column === KanbanColumn.archive)
}
