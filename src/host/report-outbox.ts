/**
 * The report outbox's delivery policy (PRD §10.5).
 *
 * A worker's reports must reach the orchestrator session **without interrupting it
 * once per report**. Three reports during one task should be one message, not
 * three; but a worker that has stopped to ask a question must not wait for a batch
 * that may never come.
 *
 * That tension is the whole policy, and it is a pure function of the reports, the
 * clock, and three configured windows — so it is testable without a session, and
 * the trigger path and the read path cannot disagree about when a batch is due.
 *
 * | Report | Delivery |
 * |---|---|
 * | `needs_input` | **immediately** — a worker blocked on a person is the reason the board is open |
 * | `stuck` | immediately, but at most once per worker per interrupt window, so a loop cannot flood the session |
 * | `checkpoint` | held, and batched with everything else |
 * | `done` | opens the settlement window: the batch goes out once the window closes, so a final straggler joins it |
 * | anything older than the fallback window | delivered regardless — a batch must never be held forever |
 *
 * @module dsho/host/report-outbox
 */

import { ReportState } from '../domain/reports.ts'
import type { Report } from '../domain/reports.ts'

/** The windows that decide delivery. Values verified against the reference source. */
export const OUTBOX_DEFAULTS = Object.freeze({
  /** A held batch is delivered after this long even if nothing else arrives. */
  batchFallbackMs: 3_600_000,
  /** After a `done`, wait this long so a straggler joins the same delivery. */
  settlementWindowMs: 300_000,
  /** At most one `stuck` interrupt per worker per window. */
  interruptWindowMs: 180_000,
})

/** Overrides, from the plugin config. */
export interface OutboxBounds {
  batchFallbackMs?: number
  settlementWindowMs?: number
  interruptWindowMs?: number
}

/** What to do with the reports for one worker. */
export interface DeliveryPlan {
  /** Deliver these now, in order. */
  deliver: Report[]
  /** Hold these; they are not due yet. */
  hold: Report[]
  /** Why, in a phrase — for logs and for a test that wants to assert the reason. */
  reason: string
}

/**
 * Decides what to deliver for **one worker**.
 *
 * Per worker, not global: the settlement window is opened by *that* worker's
 * `done`, and the interrupt window rate-limits *that* worker's `stuck`. Pooling
 * workers would let one worker's `done` flush another's half-finished batch, which
 * would put an unrelated report in the middle of a delivery the reader is
 * following.
 *
 * `lastInterruptAt` is passed in rather than derived, because it is durable state
 * the caller owns: a restart must not forget that this worker interrupted two
 * seconds ago.
 */
export function planDelivery(options: {
  reports: readonly Report[]
  now: number
  /** The last `stuck` that was delivered for this worker, if any. */
  lastInterruptAt?: number
  bounds?: OutboxBounds
}): DeliveryPlan {
  const batchFallbackMs = options.bounds?.batchFallbackMs ?? OUTBOX_DEFAULTS.batchFallbackMs
  const settlementWindowMs = options.bounds?.settlementWindowMs ?? OUTBOX_DEFAULTS.settlementWindowMs
  const interruptWindowMs = options.bounds?.interruptWindowMs ?? OUTBOX_DEFAULTS.interruptWindowMs

  // Only undelivered reports are ever planned; a delivered one is history.
  const pending = options.reports.filter((report) => report.deliveredAt === undefined)
  if (pending.length === 0) return { deliver: [], hold: [], reason: 'nothing-pending' }

  const ordered = [...pending].sort((left, right) =>
    left.createdAt !== right.createdAt ? left.createdAt - right.createdAt : left.id < right.id ? -1 : 1,
  )

  const deliver: Report[] = []
  const hold: Report[] = []

  const interruptAllowed =
    options.lastInterruptAt === undefined || options.now - options.lastInterruptAt >= interruptWindowMs

  // `done` anywhere in the pending set opens the settlement window from when it
  // was reported, so a straggler that arrived just after it still joins the batch.
  const doneAt = ordered.reduce<number | undefined>(
    (earliest, report) =>
      report.state === ReportState.done
        ? earliest === undefined
          ? report.createdAt
          : Math.min(earliest, report.createdAt)
        : earliest,
    undefined,
  )
  const settlementElapsed = doneAt !== undefined && options.now - doneAt >= settlementWindowMs

  let interruptUsed = false
  for (const report of ordered) {
    if (report.state === ReportState.needsInput) {
      // A person is the unblocker; batching this would delay the only thing the
      // board exists to surface.
      deliver.push(report)
      continue
    }
    if (report.state === ReportState.stuck) {
      if (interruptAllowed && !interruptUsed) {
        deliver.push(report)
        interruptUsed = true
      } else {
        hold.push(report)
      }
      continue
    }
    // `checkpoint`, `done`, and a state-less output report are all batchable.
    if (settlementElapsed || options.now - report.createdAt >= batchFallbackMs) {
      deliver.push(report)
    } else {
      hold.push(report)
    }
  }

  const reason =
    deliver.length === 0
      ? 'awaiting-window'
      : deliver.some((report) => report.state === ReportState.needsInput)
        ? 'needs-input'
        : settlementElapsed
          ? 'settled'
          : deliver.some((report) => report.state === ReportState.stuck)
            ? 'interrupt'
            : 'fallback'

  return { deliver, hold, reason }
}

/**
 * Renders one delivery as the message the orchestrator session receives.
 *
 * Grouped under one heading rather than concatenated, so the reader can tell a
 * batch from a single report — and so a `needs_input` inside a batch is still
 * visually the thing that needs an answer.
 */
export function renderDelivery(reports: readonly Report[]): string {
  if (reports.length === 0) return ''
  if (reports.length === 1) return renderReport(reports[0]!)

  const lines = [`${reports.length} reports:`]
  for (const report of reports) lines.push('', renderReport(report))
  return lines.join('\n')
}

/** Renders one report. */
export function renderReport(report: Report): string {
  const label = report.state ?? 'update'
  const head = `[${report.workerId}] ${label}: ${report.note}`
  if (report.outputs.length === 0) return head
  return [head, ...report.outputs.map((output) => `  ${output.kind}: ${output.ref}`)].join('\n')
}
