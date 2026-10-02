/**
 * The Kanban column and display-status reducers — the board's single source of
 * truth for where a card sits and what it says.
 *
 * PORTED from Agent Orchestrator `backend/pkg/contract/kanban.go`
 * (commit 53ba1e8, Apache-2.0). See NOTICE for the full statement of
 * modifications and for the list of labelled divergences.
 *
 * Two divergences are marked `DIVERGENCE` below. Both implement PRD §7.6 rows 5b
 * and 6 — the guaranteed human gate. They are **not** porting bugs, and a future
 * reader comparing this file against `kanban.go` should not "fix" them.
 *
 * @module dsho/contract/kanban
 */

import { ActivityState } from './activity.ts'
import { CIState, Mergeability, ReviewDecision, silentPastGrace } from './status.ts'
import type { KanbanSessionFacts } from './status.ts'

/**
 * The derived delivery-lifecycle placement of a session. It answers where the
 * session sits between first commit and merge, and which loop is turning it. It
 * is independent of the display status and **is never persisted**.
 */
export const KanbanColumn = Object.freeze({
  /** No PR yet. */
  building: 'building',
  /** A PR inside a plugin-driven loop. */
  validating: 'validating',
  /** The review-feedback loop, and the next turn is a person's. */
  needsReview: 'needs_review',
  /** Merged, closed, mergeable, or approved by a person. */
  ready: 'ready',
  /** A terminated session. */
  archive: 'archive',
} as const)

/** The union of every Kanban column. */
export type KanbanColumn = (typeof KanbanColumn)[keyof typeof KanbanColumn]

/**
 * Board lanes in delivery order. `archive` is deliberately absent: terminated
 * sessions render in a separate archive sheet, never as a fifth lane.
 */
export const KANBAN_LANES: readonly KanbanColumn[] = Object.freeze([
  KanbanColumn.building,
  KanbanColumn.validating,
  KanbanColumn.needsReview,
  KanbanColumn.ready,
])

/**
 * The short phrase shown inside a session's column. It answers what is happening
 * right now *in the column the session already sits in*, so it changes with CI,
 * review runs, activity, and approvals while the column stays put. Values are
 * already renderable: clients print them as-is.
 *
 * The string values are load-bearing — the client locale layer keys off them, and
 * the needs-attention predicate matches on them. Do not reword.
 */
export const DisplayStatus = Object.freeze({
  // building
  working: 'Working',
  blocked: 'Blocked',
  exited: 'Exited',
  noSignal: 'No signal',
  awaitingPr: 'Awaiting PR',
  // validating
  fixingCI: 'Fixing CI failures',
  addressingComments: 'Addressing comments',
  needsReview: 'Needs review',
  reviewScheduled: 'Review scheduled',
  reviewing: 'Reviewing',
  reviewFailed: 'Review failed',
  reviewPending: 'Review pending',
  draft: 'Draft',
  // needs_review
  ciFailing: 'CI failing',
  commented: 'Commented',
  changesRequested: 'Changes requested',
  needsHumanReview: 'Needs human review',
  // ready
  mergeable: 'Mergeable',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed without merge',
  // archive
  terminated: 'Terminated',
} as const)

/** The union of every display status. */
export type DisplayStatus = (typeof DisplayStatus)[keyof typeof DisplayStatus]

/**
 * The columns that can produce each display status. Used by tests and by the
 * client to assert a card never shows a phrase from a stage it is not in.
 */
export const DISPLAY_STATUSES_BY_COLUMN: Readonly<Record<KanbanColumn, readonly DisplayStatus[]>> =
  Object.freeze({
    [KanbanColumn.building]: [
      DisplayStatus.working,
      DisplayStatus.blocked,
      DisplayStatus.exited,
      DisplayStatus.noSignal,
      DisplayStatus.awaitingPr,
    ],
    [KanbanColumn.validating]: [
      DisplayStatus.blocked,
      DisplayStatus.exited,
      DisplayStatus.noSignal,
      DisplayStatus.fixingCI,
      DisplayStatus.ciFailing,
      DisplayStatus.addressingComments,
      DisplayStatus.needsReview,
      DisplayStatus.reviewScheduled,
      DisplayStatus.reviewing,
      DisplayStatus.reviewFailed,
      DisplayStatus.reviewPending,
      DisplayStatus.draft,
    ],
    [KanbanColumn.needsReview]: [
      DisplayStatus.blocked,
      DisplayStatus.exited,
      DisplayStatus.noSignal,
      DisplayStatus.fixingCI,
      DisplayStatus.ciFailing,
      DisplayStatus.addressingComments,
      DisplayStatus.changesRequested,
      DisplayStatus.commented,
      DisplayStatus.needsHumanReview,
    ],
    [KanbanColumn.ready]: [
      DisplayStatus.merged,
      DisplayStatus.closed,
      DisplayStatus.mergeable,
      DisplayStatus.ciFailing,
      DisplayStatus.approved,
    ],
    [KanbanColumn.archive]: [DisplayStatus.terminated],
  })

/**
 * Summarizes our own review passes against one PR's **current** head commit.
 * Passes recorded for an earlier head are excluded before this object is built,
 * so a stale run can never decide the column.
 */
export interface KanbanReviewRunFacts {
  /** At least one pass was recorded. */
  present: boolean
  /** A pass is still in flight. */
  running: boolean
  /** A pass asked the worker for changes. */
  changesRequested: boolean
  /**
   * A pass returned a verdict. `present` without `outcome` is a head we tried
   * and failed to review, which still owes the PR the pass auto review promised.
   */
  outcome: boolean
  /** A pass ended without producing a verdict. */
  failed: boolean
  /** A pass was cancelled. */
  cancelled: boolean
  /** DSHO-only, and part of DIVERGENCE row 5b. */
  roundBudgetExhausted: boolean
  /** DSHO-only, and part of DIVERGENCE row 5b. */
  failedRetryLimitReached: boolean
}

/**
 * Provider review verdicts on one PR that we did **not** author. Our own provider
 * reviews are matched by review id and excluded, because the aggregate
 * `ReviewDecision` mixes both sources and cannot tell whose turn the loop is on.
 */
export interface KanbanExternalReviewFacts {
  approved: boolean
  changesRequested: boolean
  comments: boolean
}

/** The per-PR facts the column reducer reads. */
export interface KanbanPRFacts {
  url: string
  draft: boolean
  merged: boolean
  closed: boolean
  /** A {@link CIState} value, or `''`. */
  ci: string
  /** A {@link ReviewDecision} value, or `''`. */
  review: string
  /** A {@link Mergeability} value, or `''`. */
  mergeability: string
  /** Epoch ms. */
  updatedAt: number
  reviewRun: KanbanReviewRunFacts
  externalReview: KanbanExternalReviewFacts
  /** PR number, for the card and the API. */
  number?: number
  /**
   * Why this pull request cannot be merged yet, in reading order (finding G3).
   *
   * DSHO carries the *reasons* alongside the mergeability the reference synthesizes, so a
   * card can say what is left between an approval and the merge button instead of only
   * showing the phrase. Empty on a record written before this existed.
   */
  mergeBlockers?: readonly string[]
}

/** What a caller may supply for a PR; every field is optional and defaulted. */
export type KanbanPRFactsInput = Omit<Partial<KanbanPRFacts>, 'reviewRun' | 'externalReview'> & {
  reviewRun?: Partial<KanbanReviewRunFacts>
  externalReview?: Partial<KanbanExternalReviewFacts>
}

/** Normalizes a PR-facts object, filling Go's zero values. */
export function prFacts(pr: KanbanPRFactsInput = {}): KanbanPRFacts {
  const facts: KanbanPRFacts = {
    url: pr.url ?? '',
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
    closed: pr.closed ?? false,
    ci: pr.ci ?? '',
    review: pr.review ?? '',
    mergeability: pr.mergeability ?? '',
    updatedAt: pr.updatedAt ?? 0,
    reviewRun: reviewRunFacts(pr.reviewRun),
    externalReview: externalReviewFacts(pr.externalReview),
  }
  // Absent rather than empty when there is nothing to say: the ported facts object keeps
  // its shape for every caller that never asks about merge blockers, and a present-but-empty
  // list would read as "computed, and there is nothing blocking it" to a future reader.
  if ((pr.mergeBlockers ?? []).length > 0) facts.mergeBlockers = [...(pr.mergeBlockers ?? [])]
  if (pr.number !== undefined) facts.number = pr.number
  return facts
}

/** Normalizes review-run facts, filling Go's zero values. */
export function reviewRunFacts(facts: Partial<KanbanReviewRunFacts> = {}): KanbanReviewRunFacts {
  return {
    present: facts.present ?? false,
    running: facts.running ?? false,
    changesRequested: facts.changesRequested ?? false,
    outcome: facts.outcome ?? false,
    failed: facts.failed ?? false,
    cancelled: facts.cancelled ?? false,
    roundBudgetExhausted: facts.roundBudgetExhausted ?? false,
    failedRetryLimitReached: facts.failedRetryLimitReached ?? false,
  }
}

/** Normalizes external-review facts, filling Go's zero values. */
export function externalReviewFacts(
  facts: Partial<KanbanExternalReviewFacts> = {},
): KanbanExternalReviewFacts {
  return {
    approved: facts.approved ?? false,
    changesRequested: facts.changesRequested ?? false,
    comments: facts.comments ?? false,
  }
}

/** The board placement plus, when the automated loop has stopped, why. */
export interface KanbanDerivation {
  column: KanbanColumn
  displayStatus: DisplayStatus
  /**
   * `review-round-limit` or `review-failed-retry-limit` when the automated loop
   * gave up on the current head. Drives the `Needs you` badge (PRD §7.5, A18).
   */
  escalationReason?: 'review-round-limit' | 'review-failed-retry-limit'
}

/**
 * The per-PR column reducer.
 *
 * Rows 1–4 and 7–8 are AO's reducer verbatim. **Row 5b is a DIVERGENCE**, and so
 * is the extra `requireHumanApprovalBeforeReady` clause in row 6.
 */
function derivePRKanbanColumn(session: KanbanSessionFacts, pr: KanbanPRFacts): KanbanColumn {
  switch (true) {
    case pr.merged || pr.closed:
      return KanbanColumn.ready
    case pr.draft:
      return KanbanColumn.validating
    case externallyApproved(pr):
      return KanbanColumn.ready
    // DIVERGENCE (row 5b, new) — and it is deliberately placed *before* the
    // "we own the next step" row, which is the only ordering that makes A18
    // reachable. Row 4 fires on `autoInjectReview && changesRequested`, which is
    // the default configuration; if the escalation release sat after it, a
    // changes-requested PR whose round budget ran out would keep claiming a loop
    // that has stopped, and the card would never be released from Validating.
    //
    // PRD §7.5's rule is general: "a lane may only claim an active loop while
    // that loop is actually running." The round cap and the failed-retry limit
    // are the two ways the loop stops, so both are checked here.
    //
    // Placed before the mergeability row as well, so a halted PR cannot reach
    // Ready on mergeability alone — that is AO's row 7 firing, and it is the one
    // outcome A18 forbids.
    //
    // Gated on `requireHumanApprovalBeforeReady`, so setting that flag false
    // restores AO's exact behaviour (which has no round cap in its reducer at all).
    case session.autoReview &&
      session.requireHumanApprovalBeforeReady &&
      !approvedByUs(pr) &&
      autoReviewLoopHalted(pr):
      return KanbanColumn.needsReview
    case pluginOwnsNextStep(session, pr):
      return KanbanColumn.validating
    // Auto review owns this head until its own pass approves it. A head we have
    // not reviewed yet, a pass that failed or was cancelled, and a pass that asked
    // for changes are all "not approved yet" — auto review's job is to keep
    // re-reviewing this PR until it can approve, whether or not anything is
    // configured to act on what it finds in between. Without AutoReview, a
    // changes-requested verdict is as far as our involvement goes, so it does
    // release the PR from Validating — see pluginOwnsNextStep above.
    //
    // DIVERGENCE (row 5): AO has no round-budget clause here, because AO has no
    // round cap in the reducer at all. Ours is handled by row 5b above, which is
    // equivalent for every case that reaches this row.
    case session.autoReview && !approvedByUs(pr):
      return KanbanColumn.validating
    // DIVERGENCE (row 6, new). AO's reducer has no row 6: with auto review
    // approved and the PR mergeable, AO's mergeability row fires and the card
    // lands in Ready even though no human has reviewed it. The requested flow is
    // explicit that "human review will be after that", so we insert a guaranteed
    // human gate. With the flag on (default), an auto-review-approved PR can only
    // reach Ready via a real human signal — a surviving human approval (row 3), a
    // merge, or a human close (row 1).
    //
    // The guard is `!externalReview.approved` rather than re-testing the aggregate
    // `reviewDecision`: row 3 needs both, so a human approval that the aggregate
    // has not caught up with (a dismissed review, a review on an older commit)
    // must still count as "a human approved" here. Otherwise a real human approval
    // could be downgraded to `Needs human review`.
    case session.requireHumanApprovalBeforeReady &&
      approvedByUs(pr) &&
      !pr.externalReview.approved:
      return KanbanColumn.needsReview
    case pr.mergeability === Mergeability.mergeable:
      return KanbanColumn.ready
    // Fallthrough: the PR is in its review cycle and no plugin loop is turning
    // it, so the next turn is a person's — give the review, answer the feedback
    // already on it, or decide what to do about a failing check.
    default:
      return KanbanColumn.needsReview
  }
}

/**
 * Reports whether our own review pass approved the PR's current head. A pass that
 * requested changes, one that has not run yet, and one that failed or was
 * cancelled without a verdict are all "not approved."
 *
 * Ported from `approvedByAO`.
 */
export function approvedByUs(pr: KanbanPRFacts): boolean {
  return pr.reviewRun.outcome === true && pr.reviewRun.changesRequested !== true
}

/**
 * Requires both the provider's aggregate decision (which honors dismissed
 * reviews) and a surviving approval we did not author.
 *
 * Ported from `externallyApproved`.
 */
export function externallyApproved(pr: KanbanPRFacts): boolean {
  return pr.review === ReviewDecision.approved && pr.externalReview.approved === true
}

/**
 * Reports whether the plugin itself is turning the PR's review-feedback loop: its
 * review pass on the current head is still running, it is addressing review
 * feedback, or it is fixing failing CI. When it is not, the same loop continues
 * with a person taking the next turn.
 *
 * Ported from `aoOwnsNextStep`.
 */
export function pluginOwnsNextStep(session: KanbanSessionFacts, pr: KanbanPRFacts): boolean {
  if (pr.reviewRun.running) return true
  if (session.autoInjectReview && pr.reviewRun.changesRequested) return true
  return session.autoInjectCI && pr.ci === CIState.failing
}

/**
 * Reports whether the automated review loop has stopped trying on this head —
 * either because it burned its round budget across successive heads, or because
 * it failed to produce a verdict `autoReviewFailedRetryLimit` times on this one.
 *
 * DSHO-only, and the reason a stopped loop releases the PR from `Validating`
 * (PRD §7.5, row 5's round-budget clause, A18).
 */
export function autoReviewLoopHalted(pr: KanbanPRFacts): boolean {
  return (
    pr.reviewRun.roundBudgetExhausted === true || pr.reviewRun.failedRetryLimitReached === true
  )
}

/**
 * Why the automated loop stopped, or `undefined` when it has not.
 *
 * The string is the `reason` shown on the board's `Needs you` badge. PRD §7.5
 * names `review-round-limit`; the retry-limit case is the same escalation one
 * level down, so it reuses the shape.
 *
 * Returns `undefined` for a head our pass **approved**, even when the round
 * budget is spent: the budget being exhausted is history at that point, and the
 * card is waiting on a human for the ordinary reason, not because a loop gave up.
 * An escalation banner there would claim automation stopped when the pass in fact
 * succeeded.
 */
export function autoReviewHaltReason(
  pr: KanbanPRFacts,
): 'review-round-limit' | 'review-failed-retry-limit' | undefined {
  if (approvedByUs(pr)) return undefined
  if (pr.reviewRun.roundBudgetExhausted === true) return 'review-round-limit'
  if (pr.reviewRun.failedRetryLimitReached === true) return 'review-failed-retry-limit'
  return undefined
}

/**
 * The live PRs, or every PR when none is live.
 *
 * Ported from `liveKanbanPRs`.
 */
export function liveKanbanPRs(prs: readonly KanbanPRFacts[]): KanbanPRFacts[] {
  return prs.filter((pr) => !pr.merged && !pr.closed)
}

/**
 * Picks the more actionable of two placements, breaking ties on the most
 * recently updated PR and finally on URL so the board never flickers between
 * equally ranked PRs.
 *
 * Ported from `outranksKanban`. Note `updatedAt` ties compare equal on the
 * number, exactly as `time.Time.Equal` does; the PRD requires the ordering to be
 * stable across a no-op refresh (A29), and comparing the URL last is what
 * guarantees it.
 */
export function outranksKanban(
  candidate: KanbanColumn,
  pr: KanbanPRFacts,
  current: KanbanColumn,
  chosen: KanbanPRFacts,
): boolean {
  if (kanbanPriority(candidate) !== kanbanPriority(current)) {
    return kanbanPriority(candidate) < kanbanPriority(current)
  }
  if (pr.updatedAt !== chosen.updatedAt) {
    return pr.updatedAt > chosen.updatedAt
  }
  return pr.url < chosen.url
}

/** Lower is more actionable. Ported from `kanbanPriority`. */
export function kanbanPriority(column: KanbanColumn): number {
  switch (column) {
    case KanbanColumn.ready:
      return 0
    case KanbanColumn.needsReview:
      return 1
    case KanbanColumn.validating:
      return 2
    default:
      return 3
  }
}

/**
 * Picks the pull request whose facts decide the session's placement, and the column they
 * decide.
 *
 * Extracted from {@link deriveKanbanPresentation} so a caller that needs to say something
 * **about that pull request** — its merge blockers, its number — asks the same ranking
 * rather than running one of its own, which is how a card's phrase and its reasons would
 * come to describe two different PRs. Extracting it changes no behaviour: the loop below is
 * the original, moved.
 */
export function chosenKanbanPR(
  session: KanbanSessionFacts,
  prs: readonly KanbanPRFacts[] | undefined | null,
): { column: KanbanColumn; chosen: KanbanPRFacts } | undefined {
  const all = prs ?? []
  if (all.length === 0) return undefined
  // A terminal PR must not hide a live one still moving through either loop;
  // merged/closed placements count only once nothing is live.
  const live = liveKanbanPRs(all)
  const pool = live.length > 0 ? live : all

  let column: KanbanColumn | undefined
  let chosen: KanbanPRFacts | undefined
  for (const pr of pool) {
    const candidate = derivePRKanbanColumn(session, pr)
    if (column === undefined || chosen === undefined || outranksKanban(candidate, pr, column, chosen)) {
      column = candidate
      chosen = pr
    }
  }
  if (column === undefined || chosen === undefined) return undefined
  return { column, chosen }
}

/**
 * Derives a session's board placement and the phrase shown on its card, in that
 * order. The column is chosen first from lifecycle facts; the display status is
 * then derived from the facts that column cares about, so a session never shows a
 * phrase belonging to a stage it is not in.
 *
 * With several PRs the column is picked per PR and ranked, and the winning PR is
 * the one whose facts the display status reads. A merged or closed PR therefore
 * cannot speak for a session that still has live work.
 *
 * Ported from `DeriveKanbanPresentation`.
 */
export function deriveKanbanPresentation(
  session: KanbanSessionFacts,
  prs: readonly KanbanPRFacts[] | undefined | null,
  now: number,
  noSignalGrace: number,
): KanbanDerivation {
  if (session.isTerminated) {
    return { column: KanbanColumn.archive, displayStatus: DisplayStatus.terminated }
  }
  const all = prs ?? []
  if (all.length === 0) {
    return {
      column: KanbanColumn.building,
      displayStatus: buildingDisplayStatus(session, now, noSignalGrace),
    }
  }
  const selected = chosenKanbanPR(session, all)
  const column = selected?.column
  const chosen = selected?.chosen
  if (column === undefined || chosen === undefined) {
    // Unreachable: `pool` is non-empty whenever `all` is. Stated explicitly
    // rather than asserted so a future refactor cannot silently change the answer.
    return {
      column: KanbanColumn.building,
      displayStatus: buildingDisplayStatus(session, now, noSignalGrace),
    }
  }
  const reason = autoReviewHaltReason(chosen)
  const derivation: KanbanDerivation = {
    column,
    displayStatus: displayStatusInColumn(column, session, chosen, now, noSignalGrace),
  }
  if (reason) derivation.escalationReason = reason
  return derivation
}

function displayStatusInColumn(
  column: KanbanColumn,
  session: KanbanSessionFacts,
  pr: KanbanPRFacts,
  now: number,
  noSignalGrace: number,
): DisplayStatus {
  switch (column) {
    case KanbanColumn.validating:
      return validatingDisplayStatus(session, pr, now, noSignalGrace)
    case KanbanColumn.needsReview:
      return inReviewDisplayStatus(session, pr, now, noSignalGrace)
    case KanbanColumn.ready:
      return readyDisplayStatus(pr)
    default:
      return buildingDisplayStatus(session, now, noSignalGrace)
  }
}

/**
 * Explains worker progress, because a session with no PR has produced no delivery
 * facts to report yet.
 *
 * Ported from `buildingDisplayStatus`. An agent-level blockage outranks
 * everything else, and `waiting_input` renders as `Blocked` exactly as AO does.
 * `unknown` deliberately falls through to `Awaiting PR` and never to `Working`.
 */
export function buildingDisplayStatus(
  session: KanbanSessionFacts,
  now: number,
  grace: number,
): DisplayStatus {
  switch (true) {
    case session.activity === ActivityState.active:
      return DisplayStatus.working
    case session.activity === ActivityState.blocked ||
      session.activity === ActivityState.waitingInput:
      return DisplayStatus.blocked
    case session.activity === ActivityState.exited:
      return DisplayStatus.exited
    case silentPastGrace(session, now, grace):
      return DisplayStatus.noSignal
    default:
      return DisplayStatus.awaitingPr
  }
}

/**
 * Reports the plugin-driven loop turning the PR. A worker that needs a person
 * outranks the loop it was running, and the work we are doing outranks the review
 * pass that asked for it. Crediting the auto-fix loops requires the worker to
 * actually be active right now: a stale autoInjectCI/autoInjectReview flag on an
 * idle worker falls through to the plain CI/review-facts reading instead of
 * claiming work nobody is doing.
 *
 * Ported from `validatingDisplayStatus` verbatim.
 *
 * Note the one situation in which a halted loop reaches this function: with
 * `requireHumanApprovalBeforeReady: false` the escalation release is disabled, so
 * a changes-requested PR whose round budget ran out stays in `Validating` showing
 * `Addressing comments` or `Needs review` even though no reviewer pass will run
 * again. That is AO's own behaviour — AO's reducer has no round cap — and it is
 * the documented cost of setting the flag false.
 */
export function validatingDisplayStatus(
  session: KanbanSessionFacts,
  pr: KanbanPRFacts,
  now: number,
  grace: number,
): DisplayStatus {
  switch (true) {
    case session.activity === ActivityState.blocked ||
      session.activity === ActivityState.waitingInput:
      return DisplayStatus.blocked
    case session.activity === ActivityState.exited:
      return DisplayStatus.exited
    case silentPastGrace(session, now, grace):
      return DisplayStatus.noSignal
    case pr.ci === CIState.failing &&
      session.autoInjectCI &&
      session.activity === ActivityState.active:
      return DisplayStatus.fixingCI
    case pr.ci === CIState.failing:
      return DisplayStatus.ciFailing
    case changesRequestedOn(pr) && session.autoInjectReview && session.activity === ActivityState.active:
      return DisplayStatus.addressingComments
    case pr.reviewRun.changesRequested:
      return DisplayStatus.needsReview
    case session.autoReview && !pr.reviewRun.present:
      return DisplayStatus.reviewScheduled
    case pr.reviewRun.running:
      return DisplayStatus.reviewing
    case pr.reviewRun.failed:
      return DisplayStatus.reviewFailed
    case pr.reviewRun.cancelled:
      return DisplayStatus.reviewPending
    case pr.draft:
      return DisplayStatus.draft
    default:
      return DisplayStatus.needsReview
  }
}

/**
 * Reports the review-feedback loop from the person's side. By the column rule,
 * `pluginOwnsNextStep` already routes a PR with failing CI under autoInjectCI, or
 * a plugin-addressed changes request, to `Validating` before this ever runs — so
 * these guards do not change today's output. They stay here, matching
 * `validatingDisplayStatus`'s shape, so this function reports the policy phrase
 * correctly on its own rather than depending on a rule enforced in a different
 * function for its correctness. A dead or idle worker outranks all of it.
 *
 * Ported from `inReviewDisplayStatus`. This is the function that produces
 * `Needs human review` for both the human-gate paths and the plain fallthrough.
 */
export function inReviewDisplayStatus(
  session: KanbanSessionFacts,
  pr: KanbanPRFacts,
  now: number,
  grace: number,
): DisplayStatus {
  switch (true) {
    case session.activity === ActivityState.blocked ||
      session.activity === ActivityState.waitingInput:
      return DisplayStatus.blocked
    case session.activity === ActivityState.exited:
      return DisplayStatus.exited
    case silentPastGrace(session, now, grace):
      return DisplayStatus.noSignal
    case pr.ci === CIState.failing &&
      session.autoInjectCI &&
      session.activity === ActivityState.active:
      return DisplayStatus.fixingCI
    case pr.ci === CIState.failing:
      return DisplayStatus.ciFailing
    case pr.externalReview.comments && session.autoInjectReview && session.activity === ActivityState.active:
      return DisplayStatus.addressingComments
    case pr.externalReview.changesRequested &&
      session.autoInjectReview &&
      session.activity === ActivityState.active:
      return DisplayStatus.addressingComments
    case pr.externalReview.changesRequested:
      return DisplayStatus.changesRequested
    case pr.externalReview.comments:
      return DisplayStatus.commented
    default:
      return DisplayStatus.needsHumanReview
  }
}

/**
 * Reports whether anyone asked the worker for changes on the PR, whether that was
 * our own pass or a person.
 *
 * Ported from `changesRequestedOn`.
 */
export function changesRequestedOn(pr: KanbanPRFacts): boolean {
  return pr.reviewRun.changesRequested === true || pr.externalReview.changesRequested === true
}

/**
 * Reports how the PR landed, or what is left between an approval and the merge
 * button. Merged and closed come first: they are what happened to the PR, and no
 * merge-readiness reading can override them.
 *
 * Ported from `readyDisplayStatus`.
 */
export function readyDisplayStatus(pr: KanbanPRFacts): DisplayStatus {
  switch (true) {
    case pr.merged:
      return DisplayStatus.merged
    case pr.closed:
      return DisplayStatus.closed
    case pr.mergeability === Mergeability.mergeable:
      return DisplayStatus.mergeable
    case pr.ci === CIState.failing:
      return DisplayStatus.ciFailing
    default:
      return DisplayStatus.approved
  }
}
