/**
 * Activity model.
 *
 * PORTED from Agent Orchestrator `backend/internal/domain/activity.go`
 * (commit 53ba1e8, Apache-2.0). See NOTICE for the statement of modifications.
 *
 * `ActivityState` is how busy the agent is. AO reports it via the agent's CLI
 * hook callbacks, explicitly *not* inferred from a transcript. A DSH plugin sits
 * inside the process, so the equivalent signals are first-class: `Agent.status`,
 * the pending `ask_user_question` call, and a live permission decision. Those
 * live in `../domain/activity.js`; this module is the vocabulary only.
 *
 * @module dsho/contract/activity
 */

/**
 * Activity states.
 *
 * `waiting_input` and `blocked` both mean "paused on the user" but demand
 * opposite automation: `waiting_input` is an agent at an empty prompt awaiting
 * its next INSTRUCTION (safe to message or nudge), while `blocked` is an agent
 * stopped on a pending DECISION — a tool-permission or approval dialog — where a
 * stray keystroke could answer the dialog on the user's behalf. Automated
 * senders must never inject input into a `blocked` session.
 *
 * `unknown` is DSH-specific (agent-orchestrator has no equivalent): after a
 * restart, before a worker's handle is reattached, we genuinely do not know. It
 * is deliberately **not** `idle`, because rendering it as `idle` would claim the
 * worker is available when we do not know that (PRD §7.6, A27).
 */
export const ActivityState = Object.freeze({
  active: 'active',
  idle: 'idle',
  waitingInput: 'waiting_input',
  blocked: 'blocked',
  exited: 'exited',
  /** DSH-only. Not a ported value. */
  unknown: 'unknown',
})

/** Every activity state, in the order the PRD lists them. */
export const ACTIVITY_STATES = Object.freeze([
  ActivityState.active,
  ActivityState.idle,
  ActivityState.waitingInput,
  ActivityState.blocked,
  ActivityState.exited,
  ActivityState.unknown,
])

/** Normalizes an absent or unrecognized value to `unknown`, never to `idle`. */
export function normalizeActivity(value) {
  return ACTIVITY_STATES.includes(value) ? value : ActivityState.unknown
}

/**
 * Reports whether an activity state must NOT be aged/demoted by the passage of
 * time — a paused agent is still paused until a new signal says so.
 *
 * Ported from `func (a ActivityState) IsSticky() bool`. Note the ported function
 * returns `false` for `unknown`: AO has no `unknown`, and a state we have not
 * observed is not a state we may keep asserting forever.
 *
 * @param {string} activity
 * @returns {boolean}
 */
export function isSticky(activity) {
  return activity === ActivityState.waitingInput || activity === ActivityState.blocked
}

/**
 * Reports whether the agent is paused on the user — waiting for the next
 * instruction (`waiting_input`) or blocked on a decision (`blocked`). Both
 * render as `Needs you`.
 *
 * Distinct from {@link isSticky}: stickiness is about time-demotion, NeedsInput
 * about the user being the unblocker.
 *
 * Ported from `func (a ActivityState) NeedsInput() bool`.
 *
 * @param {string} activity
 * @returns {boolean}
 */
export function needsInput(activity) {
  return activity === ActivityState.waitingInput || activity === ActivityState.blocked
}
