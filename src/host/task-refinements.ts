/**
 * Outstanding title refinements — the bookkeeping half of the new-task flow.
 *
 * ## Why this is only bookkeeping
 *
 * The reference asks its own provider for a title and reads the answer. This
 * plugin **cannot read an agent's output**: the report protocol exists precisely
 * because the only channel out of a worker session is a tool call. So the title
 * request travels the channel that exists — the worker is asked, as its first
 * instruction, to call `orchestrator_task_title` — and what is left for the host to
 * own is the *expectation*: which tasks are still waiting to be named, what their
 * provisional title was, and when to stop waiting.
 *
 * That expectation is deliberately **in memory and process-local**. The durable
 * fact is the issue title; a restart loses only the chance to refine, which is
 * cosmetic, and a durable queue of cosmetic work is a queue that outlives the
 * reason it existed.
 *
 * ## The two bounds are the reference's
 *
 *  - **A deadline** ({@link TASK_REFINEMENT_TIMEOUT_MS}), because a worker that
 *    never answers must not leave a task replaceable forever — a title the user
 *    has since edited by hand would be overwritten minutes later.
 *  - **A cap** ({@link TASK_REFINEMENT_LIMIT}), and at the cap the request is
 *    **dropped**, not queued. This is the reference's decision and it is right:
 *    a title is cosmetic, and cosmetic work must never accumulate.
 *
 * @module dsho/host/task-refinements
 */

import { TASK_REFINEMENT_LIMIT, TASK_REFINEMENT_TIMEOUT_MS } from '../domain/task-title.ts'

/** One task waiting to be named. */
export interface PendingTaskTitle {
  issueId: string
  /** The title to replace, and the compare-and-swap guard for the replacement. */
  provisional: string
  /** When the wait ends, in epoch milliseconds. */
  expiresAt: number
}

/** What happened to an expectation. */
export type RefinementAcceptance = 'accepted' | 'replaced' | 'at-capacity'

/** The registry. Small on purpose: five methods, each one fact. */
export interface TaskRefinements {
  /** Registers (or replaces) the expectation for one task. */
  expect(issueId: string, provisional: string): RefinementAcceptance
  /**
   * Takes the expectation, if it is still live.
   *
   * Taking it is what makes refinement **one-shot**: the first title a worker
   * sends wins, and a second call finds nothing pending rather than overwriting a
   * title a person may already have corrected.
   */
  claim(issueId: string): PendingTaskTitle | undefined
  /** Drops expired expectations, returning how many went. */
  sweep(): number
  /** How many are outstanding, ignoring expired ones. */
  pending(): number
  clear(): void
}

/**
 * Creates a registry.
 *
 * Time and both bounds are injectable so the tests can pin them: a deadline
 * asserted against the real clock is a test that passes and fails at random.
 */
export function createTaskRefinements(
  options: { now?: () => number; timeoutMs?: number; limit?: number } = {},
): TaskRefinements {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? TASK_REFINEMENT_TIMEOUT_MS
  const limit = options.limit ?? TASK_REFINEMENT_LIMIT
  const pending = new Map<string, PendingTaskTitle>()

  const dropExpired = (): void => {
    const at = now()
    for (const [issueId, job] of pending) {
      if (job.expiresAt <= at) pending.delete(issueId)
    }
  }

  return {
    expect(issueId, provisional) {
      dropExpired()
      const existing = pending.get(issueId)
      if (existing) {
        // A re-created task keeps its one slot; it does not consume a second.
        pending.set(issueId, { issueId, provisional, expiresAt: now() + timeoutMs })
        return 'replaced'
      }
      if (pending.size >= limit) return 'at-capacity'
      pending.set(issueId, { issueId, provisional, expiresAt: now() + timeoutMs })
      return 'accepted'
    },
    claim(issueId) {
      dropExpired()
      const job = pending.get(issueId)
      if (job) pending.delete(issueId)
      return job
    },
    sweep() {
      const before = pending.size
      dropExpired()
      return before - pending.size
    },
    pending() {
      dropExpired()
      return pending.size
    },
    clear() {
      pending.clear()
    },
  }
}
