/**
 * The pull-request observer (PRD §10.2).
 *
 * Polls `gh pr view --json` for every worker with a bound pull request, diffs the
 * result against the stored snapshot, and records the new one. It is the only
 * source of PR facts, and therefore the only reason a card ever leaves `Building`.
 *
 * ## The invariant, stated once
 *
 * **A failed observation must never fabricate a transition (R13).** The dangerous
 * failure is not "no data" — it is *data that looks like a state change*: an empty
 * payload reads as `CLOSED`, and a closed PR archives a live worker. So a failed
 * observation writes a snapshot carrying `fetched: false` **and the prior facts**,
 * which means even a caller that ignores the flag sees the previous state rather
 * than a fabricated one.
 *
 * ## Observations are serialised per repository
 *
 * The bounded-work NFR says the observer "never spawns unbounded concurrent `gh`
 * calls (serialize per repo)". `observeAll` runs repositories one at a time, so a
 * twenty-worker board makes twenty sequential calls per tick rather than twenty at
 * once against the same rate limit.
 *
 * @module dsho/host/observer-service
 */

import { parsePrView, unfetchedSnapshot } from '../domain/pr-snapshot.ts'
import type { PrSnapshot } from '../domain/pr-snapshot.ts'
import { normalizeIssue } from '../domain/issues.ts'
import { normalizeWorker } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { prViewArgv } from '../github/argv.ts'
import { classifyCommandFailure } from './exec.ts'
import type { RunCommand } from './worktree.ts'
import type { LazyFactStore } from './store.ts'

/** What the observer needs. */
export interface ObserverDeps {
  store: LazyFactStore
  run: RunCommand
  now?: () => number
  /** Overrides the argv builder, for a caller that needs different fields. */
  argvFor?: (pr: { number: number; repository: string }) => readonly string[]
}

/** One worker's observation. */
export interface Observation {
  workerId: string
  prNumber: number
  /** A new snapshot was recorded with `fetched: true`. */
  fetched: boolean
  /** The facts differ from the prior snapshot. */
  changed: boolean
  /** Which fields changed, for a log or a test. */
  changedFields: readonly string[]
  snapshot: PrSnapshot
  /** Why the observation failed, when it did. */
  error?: string
}

/** One pass over every worker. */
export interface ObserverOutcome {
  observations: Observation[]
  /** Workers with no bound pull request, so nothing to observe. */
  skipped: number
}

/** The fields whose change means the board may move. */
const WATCHED_FIELDS = [
  'state',
  'isDraft',
  'headSha',
  'ciState',
  'reviewDecision',
  'mergeable',
  'mergeStateStatus',
  'lastCommentId',
] as const

/** Which of the watched fields differ. */
export function changedFields(prior: PrSnapshot | undefined, next: PrSnapshot): string[] {
  if (!prior) return ['(first observation)']
  return WATCHED_FIELDS.filter((field) => prior[field] !== next[field])
}

/**
 * Observes one worker's pull request.
 *
 * `repository` is passed explicitly rather than inferred from a remote, because a
 * worker's worktree shares `.git/config` with the human checkout — the association
 * must be the plugin's decision (the same reason `prViewArgv` always passes
 * `--repo`).
 */
export async function observeWorker(
  deps: ObserverDeps,
  worker: Worker,
  repository: string,
): Promise<Observation | undefined> {
  if (!worker.pr || worker.pr.number <= 0) return undefined

  const store = await deps.store.get()
  const now = (deps.now ?? Date.now)()
  const prior = (await store.prSnapshots.get(snapshotKey(worker.id))) as PrSnapshot | undefined
  const argv = (deps.argvFor ?? prViewArgv)({ number: worker.pr.number, repository })

  const result = await deps.run(argv, { cwd: worker.worktreePath })
  if (result.exitCode !== 0) {
    const failure = classifyCommandFailure(result)
    const snapshot = unfetchedSnapshot(prior, failure.kind, now)
    await store.prSnapshots.put(snapshotKey(worker.id), snapshot)
    return {
      workerId: worker.id,
      prNumber: worker.pr.number,
      fetched: false,
      changed: false,
      changedFields: [],
      snapshot,
      error: failure.kind,
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    // A truncated or non-JSON payload is a failed observation, not a `CLOSED` PR.
    // `result.truncated` is the usual cause, and parsing half a document is exactly
    // what must not happen.
    const snapshot = unfetchedSnapshot(prior, 'unparseable', now)
    await store.prSnapshots.put(snapshotKey(worker.id), snapshot)
    return {
      workerId: worker.id,
      prNumber: worker.pr.number,
      fetched: false,
      changed: false,
      changedFields: [],
      snapshot,
      error: 'unparseable',
    }
  }

  const snapshot = parsePrView(payload, now)
  const fields = changedFields(prior, snapshot)
  await store.prSnapshots.put(snapshotKey(worker.id), snapshot)

  // A new head means the review pass for the old one is history; record the head on
  // the worker so the review loop keys on the right commit.
  if (snapshot.headSha && worker.pr.headSha !== snapshot.headSha) {
    await store.workers.put(worker.id, {
      ...worker,
      pr: { ...worker.pr, headSha: snapshot.headSha },
      updatedAt: now,
      lastSignalAt: now,
    })
  }

  return {
    workerId: worker.id,
    prNumber: worker.pr.number,
    fetched: true,
    changed: fields.length > 0,
    changedFields: fields,
    snapshot,
  }
}

/** The snapshot key: one row per worker, since a worker has one PR (Phase 1). */
export function snapshotKey(workerId: string): string {
  return workerId
}

/**
 * Observes every worker, **one repository at a time**.
 *
 * Serialised per repository so the tick cannot fan out into unbounded concurrent
 * `gh` calls against one rate limit. Failures are contained per worker: one
 * unobservable PR must not stop the rest of the board from updating.
 */
export async function observeAll(deps: ObserverDeps): Promise<ObserverOutcome> {
  const outcome: ObserverOutcome = { observations: [], skipped: 0 }

  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch {
    return outcome
  }

  const workers = (await store.workers.list()).map(normalizeWorker)
  const issues = (await store.issues.list()).map(normalizeIssue)
  const repos = (await store.repos.list()) as Array<{ id?: unknown; owner?: unknown; name?: unknown }>

  // Group by repository, so each repository's calls are sequential and two
  // repositories do not interleave their rate-limit budget.
  const byRepo = new Map<string, Worker[]>()
  for (const worker of workers) {
    if (!worker.pr || worker.pr.number <= 0) {
      outcome.skipped += 1
      continue
    }
    const issue = issues.find((candidate) => candidate.id === worker.issueId)
    const repoId = issue?.repoId ?? ''
    const group = byRepo.get(repoId)
    if (group) group.push(worker)
    else byRepo.set(repoId, [worker])
  }

  for (const [repoId, group] of byRepo) {
    const repo = repos.find((candidate) => candidate.id === repoId)
    const repository = typeof repo?.owner === 'string' && typeof repo?.name === 'string' ? `${repo.owner}/${repo.name}` : ''
    if (repository === '') {
      outcome.skipped += group.length
      continue
    }
    for (const worker of group) {
      try {
        const observation = await observeWorker(deps, worker, repository)
        if (observation) outcome.observations.push(observation)
        else outcome.skipped += 1
      } catch {
        // Contained: one worker's observation must not stop the others.
        outcome.skipped += 1
      }
    }
  }

  return outcome
}
