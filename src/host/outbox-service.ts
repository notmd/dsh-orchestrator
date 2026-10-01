/**
 * Delivering the outbox (PRD §10.5).
 *
 * `planDelivery` decides *what* to deliver; this decides *where* and takes care of
 * the durable bookkeeping. The two are separate so the policy stays a pure
 * function and the side effects stay in one short place.
 *
 * ## Where a report lands
 *
 * On the **session that created the issue** (`issue.sourceSessionId`). That is the
 * session the person is watching — the one where they typed "create an issue to
 * fix X" — so it is where the answer belongs. It is reached through
 * `ctx.agents.get()`, not through an owned handle, because the plugin does not own
 * the user's session and must not pretend to.
 *
 * ## Claim-based, so a retry cannot double-deliver
 *
 * Reports are **marked delivered before the send**. A second pass over the same
 * reports then finds nothing to do, which is what makes a retry safe. If the send
 * itself throws, the claim is released so the next tick tries again — the
 * alternative, claiming after sending, would double-deliver whenever a send
 * succeeded but its bookkeeping did not.
 *
 * A report whose orchestrator session is gone is **not** claimed: it stays pending,
 * which is what makes A23's "with the orchestrator session closed, the reports
 * persist and are delivered when it reopens" true.
 *
 * @module dsho/host/outbox-service
 */

import type { Report } from '../domain/reports.ts'
import type { Worker } from '../domain/workers.ts'
import { normalizeWorker } from '../domain/workers.ts'
import { OUTBOX_DEFAULTS, planDelivery, renderDelivery } from './report-outbox.ts'
import type { OutboxBounds } from './report-outbox.ts'
import type { LazyFactStore } from './store.ts'
import type { Issue } from '../domain/issues.ts'
import { normalizeIssue } from '../domain/issues.ts'

/** What one delivery pass needs. */
export interface OutboxServiceDeps {
  store: LazyFactStore
  /** Live-agent lookup, for the orchestrator session. */
  agents: { get(id: string): { followup(message: unknown): void } | undefined }
  /** Builds the message admitted to the orchestrator session. */
  userMessage(text: string): unknown
  now?: () => number
  bounds?: OutboxBounds
}

/** What one pass did. */
export interface DeliveryOutcome {
  /** Reports delivered, by worker. */
  delivered: Array<{ workerId: string; sessionId: string; reportIds: string[]; reason: string }>
  /** Reports held because their window has not come. */
  held: number
  /** Workers whose orchestrator session could not be reached. */
  unreachable: Array<{ workerId: string; sessionId: string }>
  /** Failures, contained so one worker cannot stop the pass. */
  errors: Array<{ workerId: string; message: string }>
}

/**
 * Runs one delivery pass over every worker.
 *
 * Per worker, isolating failures: one worker's unreachable session or storage error
 * must not stop the others, or a single stuck worker would silence the whole board.
 */
export async function deliverPendingReports(deps: OutboxServiceDeps): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { delivered: [], held: 0, unreachable: [], errors: [] }

  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    outcome.errors.push({ workerId: '(store)', message: error instanceof Error ? error.message : String(error) })
    return outcome
  }

  const now = (deps.now ?? Date.now)()
  const workers = (await store.workers.list()).map(normalizeWorker)
  const issues = (await store.issues.list()).map(normalizeIssue)
  const reports = (await store.reports.list()).filter(
    (candidate): candidate is Report => typeof candidate === 'object' && candidate !== null,
  )

  for (const worker of workers) {
    const mine = reports.filter((report) => report.workerId === worker.id)
    if (mine.length === 0) continue

    try {
      const lastInterruptAt = mine
        .filter((report) => report.state === 'stuck' && report.deliveredAt !== undefined)
        .reduce<number | undefined>(
          (latest, report) =>
            latest === undefined || (report.deliveredAt ?? 0) > latest ? report.deliveredAt : latest,
          undefined,
        )

      const plan = planDelivery({
        reports: mine,
        now,
        ...(lastInterruptAt !== undefined ? { lastInterruptAt } : {}),
        ...(deps.bounds ? { bounds: deps.bounds } : {}),
      })
      outcome.held += plan.hold.length
      if (plan.deliver.length === 0) continue

      const issue = issues.find((candidate) => candidate.id === worker.issueId)
      const sessionId = issue?.sourceSessionId
      const agent = sessionId ? deps.agents.get(sessionId) : undefined
      if (!sessionId || !agent) {
        // Not claimed: the reports must survive until the session exists again.
        outcome.unreachable.push({ workerId: worker.id, sessionId: sessionId ?? '(none)' })
        continue
      }

      // Claim first. A second pass then finds nothing to do, which is what makes a
      // retry safe; claiming after sending would double-deliver whenever a send
      // succeeded but its bookkeeping did not.
      const batchId = `batch-${now}-${worker.id}`
      const claimed = plan.deliver.map((report) => ({ ...report, deliveredAt: now, batchId }))
      for (const report of claimed) await store.reports.put(report.id, report)

      try {
        agent.followup(deps.userMessage(renderDelivery(claimed)))
      } catch (error) {
        // Release the claim so the next tick retries, rather than losing the batch.
        for (const report of plan.deliver) {
          const cleared: Report = { ...report }
          delete cleared.deliveredAt
          delete cleared.batchId
          await store.reports.put(cleared.id, cleared)
        }
        outcome.errors.push({
          workerId: worker.id,
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      outcome.delivered.push({
        workerId: worker.id,
        sessionId,
        reportIds: plan.deliver.map((report) => report.id),
        reason: plan.reason,
      })
    } catch (error) {
      outcome.errors.push({
        workerId: worker.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return outcome
}

/** The default tick, matching the reference's report sweep cadence. */
export const OUTBOX_TICK_MS = 30_000

/** Reports still waiting, for a diagnostic or a test. */
export async function pendingReportCount(store: Awaited<ReturnType<LazyFactStore['get']>>): Promise<number> {
  return (await store.reports.list()).filter(
    (candidate) => (candidate as Report).deliveredAt === undefined,
  ).length
}

export { OUTBOX_DEFAULTS }

/** A worker whose reports are owed to a session that is not live. */
export type UnreachableWorker = { worker: Worker; sessionId: string }
