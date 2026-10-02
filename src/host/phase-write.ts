/**
 * The tolerant phase write: the one place a **producer** moves a worker's phase.
 *
 * ## Why this exists
 *
 * Every producer of a phase that is driven by something *other than the worker's own report*
 * needs the same three lines, and there were five copies of them by the time the reference
 * teardown's §12 work landed: guard with `isValidPhaseTransition`, skip if the worker is
 * already there, write — and swallow a failure, because a phase is bookkeeping and must never
 * fail the operation that produced it (a routed review, a scheduled pass, a stop).
 *
 * Five copies is five chances for the policy to drift, and the policy has a real edge case: a
 * worker that has since **finished** must not make a background sweep throw. That rule is
 * stated once here.
 *
 * ## What it deliberately does not do
 *
 * It re-reads the worker and writes only the phase. A caller that must write the phase in the
 * SAME put as other state cannot use this — `feedback-service` writes it together with the
 * feedback dedup, because a crash between two writes would re-nudge a worker for feedback it
 * has already answered — and that is why it keeps its own inline version rather than this one.
 *
 * @module dsho/host/phase-write
 */

import { isValidPhaseTransition, normalizeWorker, setPhase } from '../domain/workers.ts'
import type { WorkerPhase } from '../domain/workers.ts'
import type { LazyFactStore } from './store.ts'

/**
 * Moves a worker into a phase, if the transition table allows it.
 *
 * @returns `true` when the phase was written, `false` when it was already there, the edge is
 * forbidden, the worker is gone, or the write failed.
 */
export async function advanceWorkerPhase(
  store: LazyFactStore,
  workerId: string,
  phase: WorkerPhase,
  summary: string,
  now: number,
): Promise<boolean> {
  try {
    const facts = await store.get()
    const stored = await facts.workers.get(workerId)
    if (stored === undefined) return false
    const worker = normalizeWorker(stored)
    if (worker.phase === phase || !isValidPhaseTransition(worker.phase, phase)) return false
    await facts.workers.put(worker.id, setPhase(worker, phase, summary, now))
    return true
  } catch {
    // Bookkeeping. It must never fail the operation that produced it, and the phase axis
    // records what happened to the worker rather than what a sweep wanted.
    return false
  }
}
