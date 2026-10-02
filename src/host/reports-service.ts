/**
 * `orchestrator_report` — the worker protocol's single channel (PRD §12.2).
 *
 * ## The worker does not say who it is
 *
 * There is no worker id in the arguments, deliberately. The caller's **session**
 * identifies the worker (`exec.agent.session`), and the plugin resolves it. A
 * worker that supplied its own id could report on another's behalf, and the board
 * would show one worker's progress against another's card. This is the same reason
 * server-side sessions exist: identity is not the client's to assert.
 *
 * ## What a report changes
 *
 * Three durable effects, and nothing else:
 *
 *   1. A `Report` record is appended to the outbox — never a session event, because
 *      a plugin must not append events with a new `type` (Appendix A3.6).
 *   2. The worker's **phase** moves, when the state implies one. `needs_input` and
 *      `stuck` also set the activity predicate the board reads as `Needs you`.
 *   3. A `pr_created` output **binds the pull request** to the worker, which is what
 *      the observer and the review loop key on.
 *
 * Deliberately *not* here: delivering the report. Delivery is the outbox's policy
 * (`./report-outbox.ts`), so the tool stays deterministic and the batching rules
 * live in one place.
 *
 * @module dsho/host/reports-service
 */

import { newId } from '../domain/ids.ts'
import {
  ReportError,
  ReportState,
  assertOutputs,
  assertReportStage,
  assertReportState,
  truncateNote,
} from '../domain/reports.ts'
import type { Report, ReportStage } from '../domain/reports.ts'
import {
  WorkerPhase,
  isValidPhaseTransition,
  normalizeWorker,
  setPhase,
} from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import type { LazyFactStore } from './store.ts'
import { dirtyPaths, newlyDirty } from './root-cleanliness.ts'
import type { RunCommand } from './worktree.ts'

/** What the report tool needs. */
export interface ReportToolDeps {
  store: LazyFactStore
  now?: () => number
  /**
   * The command seam, for R7's check at shipping time.
   *
   * Optional: reporting without a shell is still reporting, and a host that cannot shell
   * out should record the report rather than refuse it.
   */
  run?: RunCommand
  /**
   * The configured bound on a report's note (PRD §13).
   *
   * Passed in rather than defaulted, because the setting EXISTED and was ignored:
   * `truncateNote(note)` used the module's own constant, so a user who lowered
   * `maxReportCharacters` got the default anyway. A setting that is validated, offered,
   * and then not applied is worse than no setting -- the user believes they configured
   * something.
   */
  maxReportCharacters?: number
}

/**
 * Paths at the repository root that changed since the worker started (R7).
 *
 * A DELTA, not a verdict on the tree: the plugin shares the user's checkout, so the root
 * is often dirty for legitimate reasons and a guard that refused on any dirt would be
 * disabled the first time it cried wolf. `.dsho/` is ignored because it is the plugin's
 * own scratch space and changes whenever a worker does anything.
 */
async function escapedEdits(
  deps: ReportToolDeps,
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  worker: Worker,
): Promise<string[]> {
  if (!deps.run) return []
  const issue = await store.issues.get(worker.issueId)
  const repoId = typeof issue === 'object' && issue !== null ? (issue as { repoId?: unknown }).repoId : undefined
  const repo = (await store.repos.list()).find(
    (candidate) => typeof candidate === 'object' && candidate !== null && (candidate as { id?: unknown }).id === repoId,
  ) as { rootPath?: unknown } | undefined
  const rootPath = typeof repo?.rootPath === 'string' ? repo.rootPath : ''
  if (rootPath === '') return []
  return newlyDirty(await dirtyPaths(deps.run, rootPath), worker.rootDirtyAtStart ?? [])
}

/**
 * The phase a report implies, if any.
 *
 * Three inputs, in this order, and the order is the interesting part:
 *
 *   1. **A person blocking outranks a stage declaration.** `needs_input`/`stuck` land
 *      in `awaiting_human` whatever stage the worker also names, because the card must
 *      show `Needs you` and the guardrails key on that fact. The stage in such a report is
 *      **not** lost — it is recorded on the report and in `pendingQuestion` — but the phase
 *      says what the board has to act on: the worker is paused, not working. When it resumes
 *      it declares the stage again, and the table's `awaiting_human` row is the edge that
 *      lets it.
 *   2. **A declared stage is the phase.** PRD §8.1's checkpoints: the worker says where
 *      it is, and nothing infers it.
 *   3. `done` means the work shipped, which is PRD §8's `shipping`.
 */
function phaseFor(state: ReportState | undefined, stage: ReportStage | undefined): WorkerPhase | undefined {
  switch (state) {
    case ReportState.needsInput:
    case ReportState.stuck:
      // Both are "paused on the user" -- the board shows `Blocked` and the card
      // enters `Needs you`. They stay distinct states because they demand opposite
      // automation, but the phase they land in is the same.
      return WorkerPhase.awaitingHuman
    default:
      break
  }
  if (stage !== undefined) return stage as WorkerPhase
  return state === ReportState.done ? WorkerPhase.shipping : undefined
}

/** Resolves the worker whose session is calling. */
export async function findWorkerBySession(
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  sessionId: string,
): Promise<Worker | undefined> {
  const workers = (await store.workers.list()).map(normalizeWorker)
  return workers.find((worker) => worker.sessionId === sessionId)
}

/**
 * Records a report from the calling worker.
 *
 * @param callerSessionId - `exec.agent.session.id`. Absent only outside a session.
 */
export async function reportForTool(
  deps: ReportToolDeps,
  args: {
    state?: ReportState
    stage?: ReportStage
    note?: string
    outputs?: ReadonlyArray<{ kind: never; ref: string }>
  },
  callerSessionId: string | undefined,
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return (
      'The plugin could not open its storage, so the report was not recorded.\n\n' +
      `Storage error: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!callerSessionId) {
    return 'This tool reports on behalf of the calling session, and no session was available to identify.'
  }
  const worker = await findWorkerBySession(store, callerSessionId)
  if (!worker) {
    return (
      `No worker is registered for session ${callerSessionId}, so there is nothing to report against. ` +
      'Reports are accepted only from worker sessions the plugin spawned.'
    )
  }

  let state: ReportState | undefined
  let stage: ReportStage | undefined
  let outputs: ReturnType<typeof assertOutputs>
  try {
    state = assertReportState(args.state)
    stage = assertReportStage(args.stage)
    outputs = assertOutputs(args.outputs as never)
  } catch (error) {
    return error instanceof ReportError ? `Could not record the report — ${error.message}` : String(error)
  }
  // R7 AT SHIPPING TIME, and BEFORE anything is written. "Before shipping" gates the
  // ship, so a refusal must leave no report either: a stored `done` with no bound pull
  // request would tell the orchestrator the work had shipped when it had not. A refusal
  // rather than a warning, for the same reason.
  const prOutput = outputs.find((output) => output.kind === 'pr_created')
  if (prOutput && deps.run) {
    const escaped = await escapedEdits(deps, store, worker)
    if (escaped.length > 0) {
      return [
        'The pull request was NOT recorded: this worker looks like it edited the shared checkout.',
        '',
        'Paths changed at the repository root since the worker started:',
        ...escaped.slice(0, 10).map((path) => `  ${path}`),
        '',
        'Work and commit inside your worktree. If a path here is yours, revert it; if it is the',
        "user's own work, the issue needs a fresh baseline.",
      ].join('\n')
    }
  }

  if (state === undefined && stage === undefined && outputs.length === 0) {
    return 'A report needs a `state`, a `stage`, an `outputs` entry, or a combination — otherwise there is nothing to record.'
  }

  const now = deps.now ?? Date.now
  const at = now()
  const { note, truncated } = truncateNote(args.note ?? '', deps.maxReportCharacters)
  const report: Report = {
    id: newId('rpt', at),
    workerId: worker.id,
    issueId: worker.issueId,
    note,
    outputs,
    createdAt: at,
    ...(state ? { state } : {}),
    ...(stage ? { stage } : {}),
    ...(truncated ? { truncated } : {}),
  }
  await store.reports.put(report.id, report)

  // Bind the pull request, which is what the observer and the review loop key on. The
  // output was already validated and R7-checked above, before anything was written.
  const pr = prOutput
  let bound: Worker = worker
  if (pr) {
    const number = Number.parseInt(pr.ref.replace(/[^0-9]/g, ''), 10)
    bound = {
      ...bound,
      pr: {
        number: Number.isFinite(number) ? number : 0,
        url: pr.ref.startsWith('http') ? pr.ref : `#${pr.ref}`,
        headSha: bound.pr?.headSha ?? '',
      },
      updatedAt: at,
      lastSignalAt: at,
    }
  }

  // R9's declared blockage, which until now had **no producer at all**: nothing in
  // production wrote `pendingQuestion`, so the fact the protocol promises (and the branch
  // that reads it) could not be reached. Both paused states set it -- "waiting on an answer"
  // and "waiting on a decision" are one question to a person, and both render as `Needs you`
  // -- and **every other report clears it**, which is what makes this a live fact rather than
  // a latch: the next thing a resumed worker says is any report at all.
  const paused = state === ReportState.needsInput || state === ReportState.stuck
  const next: Worker = { ...bound, lastSignalAt: at, updatedAt: at }
  const question = report.note.trim() === '' ? 'waiting on a person' : report.note
  if (paused) next.pendingQuestion = { text: question, at }
  else delete next.pendingQuestion

  // The phase write, guarded rather than attempted. A worker that has already finished can
  // still report -- its session outlives the record -- and the honest answer is "recorded,
  // but it no longer moves your card", not a crashed tool or a resurrected worker. The
  // transition table is the single arbiter (see `PHASE_TRANSITIONS`).
  const phase = phaseFor(state, stage)
  let refusal = ''
  bound = next
  if (phase !== undefined && isValidPhaseTransition(next.phase, phase)) {
    bound = setPhase(next, phase, report.note || stage || (state ?? ''), at)
  } else if (phase !== undefined && phase !== next.phase) {
    // Re-declaring the stage a worker is already in is routine and silent; anything else that
    // the table refuses is worth saying, because the worker can act on it.
    refusal =
      `The phase stays ${next.phase}: ${next.phase} -> ${phase} is not a legal transition` +
      ' (the worker has finished, or is past that stage).'
  }
  await store.workers.put(bound.id, bound)

  const queued = (await store.reports.list()).filter(
    (candidate) => (candidate as Report).deliveredAt === undefined,
  ).length

  return [
    `Recorded ${state ?? stage ?? 'update'} for ${worker.id}.`,
    ...(pr ? [`Bound pull request ${pr.ref} to this worker.`] : []),
    ...(phase && refusal === '' ? [`Phase is now ${phase}.`] : []),
    ...(refusal === '' ? [] : [refusal]),
    `The orchestrator is notified on its own schedule (${queued} report(s) pending delivery).`,
  ].join('\n')
}
