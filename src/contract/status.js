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

/**
 * The derived display status of a session.
 *
 * This is the *session-level* status: it aggregates the session's worst open PR,
 * which is deliberately not the same reading the board's `displayStatus` gives
 * (that one describes the PR the column was chosen from — the best landing). The
 * card uses this for the terminal treatment and the loader, and the divergence is
 * the cause of the reference's #5081 bug, which its comment records.
 */
export const SessionStatus = Object.freeze({
  working: 'working',
  prOpen: 'pr_open',
  draft: 'draft',
  ciFailed: 'ci_failed',
  reviewPending: 'review_pending',
  changesRequested: 'changes_requested',
  approved: 'approved',
  mergeable: 'mergeable',
  merged: 'merged',
  needsInput: 'needs_input',
  exited: 'exited',
  idle: 'idle',
  terminated: 'terminated',
  noSignal: 'no_signal',
})

/**
 * @typedef {object} PRFacts
 * @property {string} url
 * @property {boolean} draft
 * @property {boolean} merged
 * @property {boolean} closed
 * @property {string} ci               {@link CIState} value.
 * @property {string} review           {@link ReviewDecision} value.
 * @property {string} mergeability     {@link Mergeability} value.
 * @property {boolean} reviewComments
 * @property {string} sourceBranch
 * @property {string} targetBranch
 */

/** Fills Go's zero values for a PR-facts object. @param {Partial<PRFacts>} [pr] @returns {PRFacts} */
export function prStatusFacts(pr = {}) {
  return {
    url: pr.url ?? '',
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
    closed: pr.closed ?? false,
    ci: pr.ci ?? '',
    review: pr.review ?? '',
    mergeability: pr.mergeability ?? '',
    reviewComments: pr.reviewComments ?? false,
    sourceBranch: pr.sourceBranch ?? '',
    targetBranch: pr.targetBranch ?? '',
  }
}

/**
 * Derives the session display status from session and pull-request facts.
 *
 * Ported from `func DeriveStatus(...)`. Note the order: a terminated session is
 * decided first, then raw activity, and only then the SCM reading. So a running
 * worker reads `Working` even with a failing PR — the board's column reducer is
 * what reconciles that, and it deliberately reads different facts.
 *
 * @param {SessionFacts} session
 * @param {PRFacts[]|undefined|null} prs
 * @param {number} now
 * @param {number} noSignalGrace
 * @returns {string} A {@link SessionStatus} value.
 */
export function deriveStatus(session, prs, now, noSignalGrace) {
  if (session.isTerminated) {
    if (openPRs(prs).length === 0 && anyMerged(prs)) return SessionStatus.merged
    return SessionStatus.terminated
  }

  switch (session.activity) {
    case 'active':
      return SessionStatus.working
    case 'exited':
      return SessionStatus.exited
    case 'waiting_input':
    case 'blocked':
      return SessionStatus.needsInput
  }

  const scm = deriveSCMStatus(prs)
  if (scm) return scm

  if (silentPastGrace(session, now, noSignalGrace)) return SessionStatus.noSignal
  return SessionStatus.idle
}

/**
 * Derives stack-aware pull-request status independently of activity.
 *
 * Ported from `func DeriveSCMStatus(...)`. Returns `''` when there is nothing to
 * say, exactly as the reference does — the empty string is the caller's signal
 * that no SCM fact applies, and it is deliberately falsy rather than a status.
 *
 * @param {PRFacts[]|undefined|null} prs
 * @returns {string}
 */
export function deriveSCMStatus(prs) {
  const open = openPRs(prs)
  if (open.length > 0) return aggregatePRStatus(open)
  if (anyMerged(prs)) return SessionStatus.merged
  return ''
}

/**
 * Derives stack positions from open source and target branches.
 *
 * Ported from `func BuildStacks(...)`. Kept because the aggregate status depends
 * on it: a PR stacked on another open PR does not report its own non-actionable
 * signal, so a child waiting on its parent cannot make the parent look blocked.
 *
 * @param {PRFacts[]|undefined|null} prs
 * @returns {Map<string, {blocked: boolean, bottomOfStack: boolean}>}
 */
export function buildStacks(prs) {
  const openSources = new Set()
  for (const pr of prs ?? []) {
    if (!pr.merged && !pr.closed && pr.sourceBranch) openSources.add(pr.sourceBranch)
  }
  const positions = new Map()
  for (const pr of prs ?? []) {
    const blocked = Boolean(pr.targetBranch) && openSources.has(pr.targetBranch)
    positions.set(pr.url, { blocked, bottomOfStack: !blocked })
  }
  return positions
}

function openPRs(prs) {
  return (prs ?? []).filter((pr) => !pr.merged && !pr.closed)
}

function anyMerged(prs) {
  return (prs ?? []).some((pr) => pr.merged)
}

/**
 * The worst status among the open PRs.
 *
 * Ported from `func aggregatePRStatus(...)`. The non-actionable signals of a PR
 * stacked on another open PR are skipped, so a child that is merely waiting on
 * its parent cannot make the session look blocked; if that leaves nothing, every
 * open PR counts again rather than the function returning an empty aggregate.
 *
 * @param {PRFacts[]} open
 * @returns {string}
 */
function aggregatePRStatus(open) {
  const stacks = buildStacks(open)
  let candidates = []
  for (const pr of open) {
    const status = prPipelineStatus(pr)
    if (stacks.get(pr.url)?.blocked && !isActionableChildSignal(status)) continue
    candidates.push(status)
  }
  if (candidates.length === 0) candidates = open.map(prPipelineStatus)

  let worst = candidates[0]
  for (const status of candidates.slice(1)) {
    if (statusSeverity(status) < statusSeverity(worst)) worst = status
  }
  return worst
}

/** Ported from `isActionableChildSignal`. */
function isActionableChildSignal(status) {
  return (
    status === SessionStatus.ciFailed ||
    status === SessionStatus.draft ||
    status === SessionStatus.changesRequested
  )
}

/** Lower is worse. Ported from `statusSeverity`. */
function statusSeverity(status) {
  switch (status) {
    case SessionStatus.ciFailed:
      return 0
    case SessionStatus.changesRequested:
      return 1
    case SessionStatus.draft:
      return 2
    case SessionStatus.reviewPending:
      return 3
    case SessionStatus.prOpen:
      return 4
    case SessionStatus.approved:
      return 5
    case SessionStatus.mergeable:
      return 6
    default:
      return 7
  }
}

/** Ported from `prPipelineStatus`. */
function prPipelineStatus(pr) {
  switch (true) {
    case pr.ci === CIState.failing:
      return SessionStatus.ciFailed
    case pr.draft:
      return SessionStatus.draft
    case pr.review === ReviewDecision.changesRequested || pr.reviewComments:
      return SessionStatus.changesRequested
    case pr.mergeability === Mergeability.mergeable:
      return SessionStatus.mergeable
    case pr.review === ReviewDecision.required:
      return SessionStatus.reviewPending
    case pr.mergeability === Mergeability.blocked:
      return SessionStatus.prOpen
    case pr.review === ReviewDecision.approved:
      return SessionStatus.approved
    default:
      return SessionStatus.prOpen
  }
}
