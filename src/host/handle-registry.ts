/**
 * Live agent handles, keyed by worker.
 *
 * `spawnWorker` returns a handle, and that handle is the only way to speak to a
 * running worker: `followup()` to queue a turn, `cancel()` to stop one. It is an
 * in-process object, so it cannot be stored — the durable spine is the session id
 * (PRD §7.3), and this is the cache in front of it.
 *
 * ## What unload must NOT do
 *
 * **A9: unloading the plugin leaves sessions and worktrees intact.** Disposing an
 * agent handle "stops/drains, unregisters, removes the session, and unwinds the
 * scope" — so disposing every handle on unload would *destroy* exactly what A9
 * says must survive. Unloading therefore **drops the references and disposes
 * nothing**: the sessions keep running, and reloading the plugin reattaches to
 * them.
 *
 * The same reasoning applies to the agent-preset scope lease each worker holds:
 * releasing it on unload could pull the preset out from under a live session, so it
 * is left alone. Both choices are asserted by tests, because both look like leaks
 * to a reader who has not read A9.
 *
 * @module dsho/host/handle-registry
 */

import type { AgentHandle, Disposable } from './spawn.ts'

/** One live worker: its handle, and the identity it was spawned under. */
export interface LiveWorker {
  workerId: string
  sessionId: string
  handle: AgentHandle
  /** The preset scope lease, held for the worker's lifetime. */
  scope?: Disposable
}

/** The live set. */
export interface LiveWorkers {
  register(entry: LiveWorker): void
  byWorker(workerId: string): LiveWorker | undefined
  bySession(sessionId: string): LiveWorker | undefined
  /** Drops the reference without touching the session. */
  forget(workerId: string): void
  /** Drops every reference, disposing nothing. See the module comment. */
  clear(): void
  size(): number
}

/** An in-process registry. */
export function createLiveWorkers(): LiveWorkers {
  const byWorkerId = new Map<string, LiveWorker>()
  return {
    register(entry) {
      byWorkerId.set(entry.workerId, entry)
    },
    byWorker(workerId) {
      return byWorkerId.get(workerId)
    },
    bySession(sessionId) {
      for (const entry of byWorkerId.values()) {
        if (entry.sessionId === sessionId) return entry
      }
      return undefined
    },
    forget(workerId) {
      byWorkerId.delete(workerId)
    },
    clear() {
      byWorkerId.clear()
    },
    size() {
      return byWorkerId.size
    },
  }
}
