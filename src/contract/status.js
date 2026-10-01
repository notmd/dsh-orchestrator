/**
 * Session-level facts and the SCM vocabulary the board reducer reads.
 *
 * PORTED from Agent Orchestrator `backend/pkg/contract/status.go`
 * (commit 53ba1e8, Apache-2.0). See NOTICE for the statement of modifications.
 * Only the subset the board needs is ported; `DeriveStatus` and the stack
 * helpers belong to AO's session list, not to this board.
 *
 * @module dsho/contract/status
 */

/** Aggregate CI state of a pull request. Ported verbatim. */
export const CIState = Object.freeze({
  unknown: 'unknown',
  pending: 'pending',
  passing: 'passing',
  failing: 'failing',
})

/** Aggregate review verdict on a pull request. Ported verbatim. */
export const ReviewDecision = Object.freeze({
  none: 'none',
  approved: 'approved',
  changesRequested: 'changes_requested',
  required: 'review_required',
})

/** Whether a pull request can currently be merged. Ported verbatim. */
export const Mergeability = Object.freeze({
  unknown: 'unknown',
  mergeable: 'mergeable',
  conflicting: 'conflicting',
  blocked: 'blocked',
  unstable: 'unstable',
})

/**
 * @typedef {object} SessionFacts
 * Durable-agnostic facts used to derive board placement.
 * @property {string} activity        {@link ActivityState} value.
 * @property {number} lastActivityAt  Epoch ms of the last observed activity.
 * @property {boolean} hasSignal      The runtime has reported at least once.
 * @property {boolean} signalExpected The runtime is expected to report activity.
 * @property {boolean} isTerminated   The session is finished and will not resume.
 */

/**
 * @typedef {object} KanbanSessionFacts
 * @property {string} activity
 * @property {number} lastActivityAt
 * @property {boolean} hasSignal
 * @property {boolean} signalExpected
 * @property {boolean} isTerminated
 * @property {boolean} autoReview
 * @property {boolean} autoInjectReview
 * @property {boolean} autoInjectCI
 * @property {boolean} requireHumanApprovalBeforeReady  DSHO-only. Not in AO.
 */

/**
 * Fills in Go's zero values for a session-facts object, so a caller that omits a
 * field behaves exactly like the Go struct's zero value.
 *
 * @param {Partial<KanbanSessionFacts>} [facts]
 * @returns {KanbanSessionFacts}
 */
export function sessionFacts(facts = {}) {
  return {
    activity: facts.activity ?? '',
    lastActivityAt: facts.lastActivityAt ?? 0,
    hasSignal: facts.hasSignal ?? false,
    signalExpected: facts.signalExpected ?? false,
    isTerminated: facts.isTerminated ?? false,
    autoReview: facts.autoReview ?? false,
    autoInjectReview: facts.autoInjectReview ?? false,
    autoInjectCI: facts.autoInjectCI ?? false,
    requireHumanApprovalBeforeReady: facts.requireHumanApprovalBeforeReady ?? false,
  }
}

/**
 * Reports whether a session that should be reporting hook activity has never
 * reported and has been quiet longer than the grace period.
 *
 * Ported from `func silentPastGrace(...)`. Faithful to AO: it requires
 * `signalExpected && !hasSignal`, so it fires on a session that never produced a
 * *first* signal — not on an agent that merely had a quiet minute.
 *
 * @param {SessionFacts} session
 * @param {number} now    Epoch ms.
 * @param {number} grace  No-signal grace period in ms.
 * @returns {boolean}
 */
export function silentPastGrace(session, now, grace) {
  return (
    session.signalExpected === true &&
    session.hasSignal !== true &&
    now - (session.lastActivityAt ?? 0) > grace
  )
}
