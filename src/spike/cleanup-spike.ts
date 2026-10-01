/**
 * M0 spike — remove the WORKSPACE REGISTRATIONS my own spikes left behind.
 *
 * Every spike run registers a workspace (`workspaceRegistry.create`), so the sidebar in
 * the user's real profile accumulated rows like `seed-spike`, `restrict-spike`,
 * `#1 Move this card`. That is test residue in a real profile, and it is mine.
 *
 * Through the SERVICE, not by editing `workspace.json`: that file is a running service's
 * own state with the user's real workspaces in the same table, and hand-editing it means
 * reimplementing the registry's bookkeeping from outside.
 *
 * `Workspace.delete` is documented as removing "one workspace registration while
 * retaining its directory and every session log" — so nothing on disk is lost and an
 * unknown id is an idempotent no-op.
 *
 * ## The guard is the point
 *
 * It deletes ONLY registrations whose path is a `/tmp/dsho-*` scratch directory the
 * spikes created. Every candidate is recorded whether or not it is removed, so the log
 * shows exactly what was considered — a cleanup that deletes by a rule you cannot read
 * afterwards is indistinguishable from one that deletes too much.
 *
 * @module dsho/spike/cleanup-spike
 */

import { writeFileSync } from 'node:fs'

export const name = 'cleanup-spike'

export const inject = ['workspaceRegistry']

const RESULT = '/tmp/dsho-cleanup-result.json'

interface WorkspaceRecord {
  id: string
  title?: string
  path?: string
}

const steps: Array<{ step: string; detail?: unknown }> = []

function record(step: string, detail?: unknown): void {
  steps.push({ step, ...(detail === undefined ? {} : { detail }) })
  try {
    writeFileSync(RESULT, JSON.stringify({ steps }, null, 2))
  } catch {
    // Never take the host down over bookkeeping.
  }
}

/** Whether a registration is one MY spikes made: a throwaway scratch path. */
function isSpikeResidue(workspace: WorkspaceRecord): boolean {
  const path = typeof workspace.path === 'string' ? workspace.path : ''
  return path.startsWith('/tmp/dsho-') || path.startsWith('/private/tmp/dsho-')
}

export function apply(ctx: {
  workspaceRegistry: {
    list(): WorkspaceRecord[]
    delete(id: string): Promise<boolean>
  }
}): void {
  void (async () => {
    record('begin')
    let all: WorkspaceRecord[]
    try {
      all = ctx.workspaceRegistry.list()
    } catch (error) {
      record('failed', { message: error instanceof Error ? error.message : String(error) })
      return
    }
    record('registrations', {
      total: all.length,
      // Everything considered, so the decision is auditable after the fact.
      considered: all.map((w) => ({ id: w.id, title: w.title ?? null, path: w.path ?? null })),
    })

    const residue = all.filter(isSpikeResidue)
    const removed: Array<{ id: string; title?: string; path?: string }> = []
    for (const workspace of residue) {
      try {
        const ok = await ctx.workspaceRegistry.delete(workspace.id)
        removed.push({ id: workspace.id, ...(workspace.title ? { title: workspace.title } : {}), ...(workspace.path ? { path: workspace.path } : {}) })
        record(ok ? 'deleted' : 'already-gone', { id: workspace.id, title: workspace.title ?? null })
      } catch (error) {
        record('delete-failed', {
          id: workspace.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    record('done', { removed: removed.length, kept: all.length - residue.length })
  })()
}
