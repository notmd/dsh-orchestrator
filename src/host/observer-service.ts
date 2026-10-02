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
 * ## What this module does NOT write
 *
 * Recovery (`recoverWorkerPr`) is the one place it touches a worker record, and only to
 * *bind identity* — the pull request number, url and head — because a worker whose report
 * was lost has no PR to observe at all. It never moves a phase: phases belong to the
 * producers in `reviewer-service`, `feedback-service`, `reports-service` and
 * `merge-readiness`, which is what keeps "the observer records facts" true.
 *
 * @module dsho/host/observer-service
 */

import {
  parsePrView,
  parseReviewComments,
  parseReviewThreads,
  unfetchedSnapshot,
} from '../domain/pr-snapshot.ts'
import type { PrSnapshot } from '../domain/pr-snapshot.ts'
import { normalizeIssue } from '../domain/issues.ts'
import { normalizeWorker } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { PR_LIST_MINIMAL_FIELDS, prListArgv, prReviewCommentsArgv, prReviewThreadsArgv, prViewArgv } from '../github/argv.ts'
import { classifyCommandFailure } from './exec.ts'
import type { RateLimitCooldown } from './exec.ts'
import type { RunCommand } from './worktree.ts'
import type { LazyFactStore } from './store.ts'

/**
 * The default cadences, matching the reference's.
 *
 * The reference polls PR facts every 30 s, refreshes review threads on their own 2-minute
 * interval, and never re-fetches anything unconditionally for longer than 5 minutes.
 */
export const OBSERVER_DEFAULTS = Object.freeze({
  intervalMs: 30_000,
  reviewThreadIntervalMs: 2 * 60_000,
  recoveryIntervalMs: 2 * 60_000,
  /**
   * How much slower a *settled* card is polled (finding G1).
   *
   * "Settled" is mergeable, approved, green and not a draft — the shape a card has while it
   * waits for a person to press merge. Nothing about it changes on a 30-second cadence, and
   * the reference's steady-state cost is about one (mostly unbilled) request per 30 s. Ours
   * were two **billed** calls per tick, always; this is the part of that cost that can be
   * removed without a conditional-request path `gh` does not offer.
   */
  settledMultiplier: 4,
})

/** What the observer needs. */
export interface ObserverDeps {
  store: LazyFactStore
  run: RunCommand
  now?: () => number
  /** Overrides the argv builder, for a caller that needs different fields. */
  argvFor?: (pr: { number: number; repository: string }) => readonly string[]
  /** Overrides the inline-comment argv builder, for the same reason. */
  reviewCommentsArgvFor?: (pr: { number: number; repository: string }) => readonly string[]
  /** Overrides the review-thread argv builder, for the same reason. */
  reviewThreadsArgvFor?: (pr: { number: number; repository: string }) => readonly string[]
  /** Overrides the candidate-listing argv builder recovery uses. */
  listArgvFor?: (input: { repository: string; headBranch: string }) => readonly string[]
  /** The PR-fact cadence. */
  intervalMs?: number
  /** The thread/comment cadence. */
  reviewThreadIntervalMs?: number
  /** How often recovery may look for a lost pull request (finding G2). */
  recoveryIntervalMs?: number
  /**
   * The shared rate-limit back-off (finding G7).
   *
   * Shared rather than per-worker: GitHub's limit is per credential, so one worker being
   * throttled means every worker will be.
   */
  cooldown?: RateLimitCooldown
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
  /** Workers with no bound pull request that recovery could not bind either. */
  skipped: number
  /** Workers whose tick was not due yet. */
  deferred: number
  /** The whole pass was skipped because the credential is rate limited (finding G7). */
  rateLimited: boolean
  /** Recovery bound a pull request the plugin had never been told about (finding G2). */
  recovered: Array<{ workerId: string; prNumber: number }>
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

/** The resolution state of the review threads, as one comparable string. */
export function threadSignature(snapshot: PrSnapshot): string {
  return (snapshot.reviewThreads ?? []).map((thread) => `${thread.id}:${thread.isResolved}`).join(',')
}

/**
 * Which of the watched fields differ.
 *
 * The thread signature is compared **by value** rather than by reference, so it is handled
 * separately: a resolution state is a fact about the board's `comments` reading (finding G4),
 * and a shallow field comparison would report every refresh as a change.
 */
export function changedFields(prior: PrSnapshot | undefined, next: PrSnapshot): string[] {
  if (!prior) return ['(first observation)']
  const fields: string[] = WATCHED_FIELDS.filter((field) => prior[field] !== next[field])
  if (threadSignature(prior) !== threadSignature(next)) fields.push('reviewThreads')
  return fields
}

/**
 * Whether a snapshot describes a **settled** pull request.
 *
 * Mergeable, approved, green, not a draft — the shape a card has while it waits for a
 * person. Deliberately conservative: a failing check, an unresolved review decision or an
 * unknown mergeability all mean something *could* still change without a human, so those
 * stay on the fast cadence. A settled card can only change by a person acting, and a person
 * acting is exactly what the slower poll is allowed to take an extra minute to notice.
 */
export function isSettledSnapshot(snapshot: PrSnapshot | undefined): boolean {
  if (!snapshot || snapshot.fetched !== true) return false
  if (snapshot.state !== 'OPEN') return false
  if (snapshot.isDraft) return false
  if (snapshot.ciState === 'failing' || snapshot.ciState === 'pending') return false
  if (snapshot.mergeable !== 'MERGEABLE') return false
  return snapshot.reviewDecision === 'APPROVED'
}

/**
 * How long to wait before observing this pull request again.
 *
 * A merged or closed PR keeps the base cadence so completion fires promptly — the *slow*
 * path is for work that is waiting on a person, not for work that is finished.
 */
export function observationIntervalMs(
  prior: PrSnapshot | undefined,
  baseIntervalMs: number,
  multiplier = OBSERVER_DEFAULTS.settledMultiplier,
): number {
  if (prior && (prior.state === 'MERGED' || prior.state === 'CLOSED')) return baseIntervalMs
  return isSettledSnapshot(prior) ? baseIntervalMs * multiplier : baseIntervalMs
}

/** Whether this worker's tick is due. */
export function shouldObserve(prior: PrSnapshot | undefined, now: number, baseIntervalMs: number): boolean {
  if (!prior) return true
  // A FAILED observation is retried on the next tick rather than backed off: the cadence is
  // there to stop re-fetching facts that have not changed, and a failure established no facts
  // at all. The rate-limit cooldown is what covers the "the provider is refusing us" case.
  if (prior.fetched !== true) return true
  return now - (prior.observedAt ?? 0) >= observationIntervalMs(prior, baseIntervalMs)
}

/** The identity of the review list, for deciding whether the slower calls are worth making. */
export function reviewSignature(snapshot: PrSnapshot): string {
  return [
    (snapshot.reviews ?? []).map((review) => `${review.id}:${review.state}`).join(','),
    snapshot.lastCommentId ?? '',
  ].join('|')
}

/**
 * Whether to re-fetch the inline comments and review threads.
 *
 * This is the whole of finding G4's *cost* half and finding G1's cheapest win. The comment
 * and thread endpoints are billed calls that describe a discussion, and a discussion changes
 * on its own schedule — the reference refreshes it every two minutes. The gate:
 *
 *   - never fetched before → fetch, always. This is what makes an existing record gain the
 *     resolution state rather than being stuck without it;
 *   - the review list changed → fetch, because a new review is what a thread hangs off;
 *   - the interval elapsed → fetch, because a **reply** into an existing thread changes
 *     neither the review list nor the last comment id, and that is precisely how a person
 *     answers a finding.
 *
 * The interval is therefore a bounded staleness guarantee rather than a guess: a reply is
 * noticed within `reviewThreadIntervalMs` by construction.
 */
export function shouldRefreshReviewThreads(
  prior: PrSnapshot | undefined,
  next: PrSnapshot,
  now: number,
  intervalMs: number,
): boolean {
  if (!prior || prior.fetched !== true) return true
  if (prior.reviewThreads === undefined || prior.reviewComments === undefined) return true
  if (reviewSignature(prior) !== reviewSignature(next)) return true
  return now - (prior.reviewThreadsAt ?? 0) >= intervalMs
}

/**
 * Whether recovery may run for this worker yet (finding G2).
 *
 * Failures retry immediately (there is nothing to back off from — nothing was learned), and
 * a successful attempt is spaced by `recoveryIntervalMs` through the worker's own watermark.
 */
export function shouldAttemptRecovery(worker: Worker, now: number, intervalMs: number): boolean {
  if (worker.prRecoveryAt === undefined) return true
  return now - worker.prRecoveryAt >= intervalMs
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
  deps.cooldown?.record(result, now)
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

  // The slower half: inline comments and review threads, on their own cadence (findings G1
  // and G4). Both are skipped together because they describe the same discussion, and both
  // are carried FORWARD from the prior snapshot when skipped — a list we already have and
  // know is unchanged is not data we may drop.
  const refreshThreads = shouldRefreshReviewThreads(prior, snapshot, now, deps.reviewThreadIntervalMs ?? OBSERVER_DEFAULTS.reviewThreadIntervalMs)
  if (refreshThreads) {
    const commentsArgv = (deps.reviewCommentsArgvFor ?? prReviewCommentsArgv)({
      number: worker.pr.number,
      repository,
    })
    const commentsResult = await deps.run(commentsArgv, { cwd: worker.worktreePath })
    deps.cooldown?.record(commentsResult, now)
    if (commentsResult.exitCode !== 0) {
      const failure = classifyCommandFailure(commentsResult)
      const failed = unfetchedSnapshot(prior, failure.kind, now)
      await store.prSnapshots.put(snapshotKey(worker.id), failed)
      return {
        workerId: worker.id,
        prNumber: worker.pr.number,
        fetched: false,
        changed: false,
        changedFields: [],
        snapshot: failed,
        error: failure.kind,
      }
    }

    const threadsArgv = (deps.reviewThreadsArgvFor ?? prReviewThreadsArgv)({
      number: worker.pr.number,
      repository,
    })
    const threadsResult = await deps.run(threadsArgv, { cwd: worker.worktreePath })
    deps.cooldown?.record(threadsResult, now)
    // A failure here is a failed observation too, and for the same reason: an empty thread
    // list would read as "nothing is unresolved", which is a *state change* about a person's
    // review derived from no data (R13).
    if (threadsResult.exitCode !== 0) {
      const failure = classifyCommandFailure(threadsResult)
      const failed = unfetchedSnapshot(prior, failure.kind, now)
      await store.prSnapshots.put(snapshotKey(worker.id), failed)
      return {
        workerId: worker.id,
        prNumber: worker.pr.number,
        fetched: false,
        changed: false,
        changedFields: [],
        snapshot: failed,
        error: failure.kind,
      }
    }

    let commentPayload: unknown
    let threadPayload: unknown
    try {
      commentPayload = JSON.parse(commentsResult.stdout)
      threadPayload = JSON.parse(threadsResult.stdout)
    } catch {
      const failed = unfetchedSnapshot(prior, 'unparseable', now)
      await store.prSnapshots.put(snapshotKey(worker.id), failed)
      return {
        workerId: worker.id,
        prNumber: worker.pr.number,
        fetched: false,
        changed: false,
        changedFields: [],
        snapshot: failed,
        error: 'unparseable',
      }
    }
    snapshot.reviewComments = parseReviewComments(commentPayload)
    snapshot.reviewThreads = parseReviewThreads(threadPayload)
    snapshot.reviewThreadsAt = now
  } else if (prior) {
    // Carried forward, not omitted: the snapshot is a snapshot of *facts*, and losing the
    // comment list on every other tick would make a person's feedback flicker out of
    // existence between refreshes.
    snapshot.reviewComments = prior.reviewComments
    snapshot.reviewThreads = prior.reviewThreads
    snapshot.reviewThreadsAt = prior.reviewThreadsAt
  }

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
 * Recovers a pull request the plugin was never told about (finding G2).
 *
 * The teardown's finding, inverted relative to the reference's: AO's risk was a *wrong*
 * attribution, and it built five derivations and alias collapse to fix it; ours is a
 * *missing* binding. A pull request enters this system exactly one way — the worker's own
 * `pr_created` report — so a crash, a truncated report, or a worker that opens the PR and
 * never reports leaves a live PR invisible to the board **forever**, because the plugin
 * never looks for PRs it was not told about.
 *
 * `prListArgv` already encoded the shape of the fix ("used to recover PRs after a restart")
 * and was called from nowhere. The rules here are deliberately strict, because a wrong
 * binding is worse than a missing one — the board would show one worker's progress against
 * another's pull request:
 *
 *   - **the branch is the identity**, and it is the plugin's own branch name for that issue;
 *   - **a fork is excluded**: a head from another repository is a different author's work
 *     with a colliding branch name, and the reference excludes ineligible heads for the same
 *     reason;
 *   - **ambiguity fails closed**: two candidates means no attribution, and the attempt is
 *     recorded so it is not retried every tick.
 */
export async function recoverWorkerPr(
  deps: ObserverDeps,
  worker: Worker,
  repository: string,
): Promise<Worker | undefined> {
  if (worker.pr && worker.pr.number > 0) return worker
  const branch = worker.branch.trim()
  if (branch === '' || repository === '') return undefined

  const store = await deps.store.get()
  const now = (deps.now ?? Date.now)()
  const argv = (deps.listArgvFor ?? ((input: { repository: string; headBranch: string }) =>
    prListArgv({
      repository: input.repository,
      headBranch: input.headBranch,
      state: 'all',
      limit: 10,
      fields: PR_LIST_MINIMAL_FIELDS,
    })))({ repository, headBranch: branch })

  /**
   * Records that an attempt happened, whatever it found.
   *
   * Written in ONE place because every exit needs it and only one of them produces a
   * binding: an ambiguous listing, an empty one, and a repository we could not list at all
   * must all stop being retried on the next tick. A safety net that runs every 30 seconds is
   * no longer a safety net, it is the cost finding G1 is about.
   */
  const markAttempted = (extra: Partial<Worker> = {}): Promise<void> =>
    store.workers.put(worker.id, { ...worker, ...extra, prRecoveryAt: now, updatedAt: now })

  let candidates: unknown[]
  try {
    const result = await deps.run(argv, { cwd: worker.worktreePath })
    deps.cooldown?.record(result, now)
    if (result.exitCode !== 0) {
      await markAttempted()
      return undefined
    }
    const payload = JSON.parse(result.stdout)
    candidates = Array.isArray(payload) ? payload : []
  } catch {
    // A store or parse failure is not a reason to leave the worker un-retried either, but a
    // failure to WRITE is: let it propagate, because the caller contains it.
    return undefined
  }

  const eligible = candidates.filter((candidate) => {
    const record = (typeof candidate === 'object' && candidate !== null ? candidate : {}) as Record<string, unknown>
    // A head from another repository is somebody else's branch with a colliding name.
    if (record.isCrossRepository === true) return false
    const number = typeof record.number === 'number' ? record.number : 0
    return Number.isInteger(number) && number > 0
  })

  // Zero candidates: nothing to bind. More than one: refuse to guess.
  if (eligible.length !== 1) {
    await markAttempted()
    return undefined
  }

  const record = eligible[0] as Record<string, unknown>
  const number = typeof record.number === 'number' ? record.number : 0
  const url = typeof record.url === 'string' && record.url !== '' ? record.url : `#${number}`
  const headSha = typeof record.headRefOid === 'string' ? record.headRefOid : ''
  const bound: Worker = {
    ...worker,
    pr: { number, url, headSha },
    prRecoveryAt: now,
    updatedAt: now,
    lastSignalAt: now,
  }
  await store.workers.put(bound.id, bound)
  return bound
}

/**
 * Observes every worker, **one repository at a time**.
 *
 * Serialised per repository so the tick cannot fan out into unbounded concurrent
 * `gh` calls against one rate limit. Failures are contained per worker: one
 * unobservable PR must not stop the rest of the board from updating.
 *
 * Three gates run before any call, and each exists to remove a specific cost:
 *
 *   1. **A rate-limit cooldown** (finding G7). While it is active the pass returns without
 *      touching `gh` at all, which is what makes `describeFailure`'s "backs off rather than
 *      retrying" true.
 *   2. **The per-worker cadence.** A settled card is polled at a multiple of the base
 *      interval (finding G1).
 *   3. **Recovery.** A worker with no bound pull request gets one `gh pr list` on its own,
 *      slower cadence, so a lost report cannot hide a PR forever without turning into a
 *      per-tick cost.
 */
export async function observeAll(deps: ObserverDeps): Promise<ObserverOutcome> {
  const outcome: ObserverOutcome = { observations: [], skipped: 0, deferred: 0, recovered: [], rateLimited: false }
  const now = (deps.now ?? Date.now)()

  if (deps.cooldown?.clearsAt(now) !== undefined) {
    // Nothing is attempted at all: the credential is throttled, so a call from any worker
    // would spend budget that is not there. Reported as its own fact rather than as
    // "deferred", because the two have different causes and only one of them is ours.
    outcome.rateLimited = true
    return outcome
  }

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
    const issue = issues.find((candidate) => candidate.id === worker.issueId)
    const repoId = issue?.repoId ?? ''
    const group = byRepo.get(repoId)
    if (group) group.push(worker)
    else byRepo.set(repoId, [worker])
  }

  const baseInterval = deps.intervalMs ?? OBSERVER_DEFAULTS.intervalMs
  const recoveryInterval = deps.recoveryIntervalMs ?? OBSERVER_DEFAULTS.recoveryIntervalMs

  for (const [repoId, group] of byRepo) {
    const repo = repos.find((candidate) => candidate.id === repoId)
    const repository = typeof repo?.owner === 'string' && typeof repo?.name === 'string' ? `${repo.owner}/${repo.name}` : ''
    if (repository === '') {
      outcome.skipped += group.length
      continue
    }
    for (const listed of group) {
      try {
        // The worker record may have moved since the list was read (a phase write, a
        // binding), so re-read before deciding anything from it.
        const stored = await store.workers.get(listed.id)
        let worker = stored === undefined ? listed : normalizeWorker(stored)

        if (!worker.pr || worker.pr.number <= 0) {
          if (!shouldAttemptRecovery(worker, now, recoveryInterval)) {
            outcome.deferred += 1
            continue
          }
          const recovered = await recoverWorkerPr(deps, worker, repository)
          if (!recovered) {
            outcome.skipped += 1
            continue
          }
          worker = recovered
          outcome.recovered.push({ workerId: worker.id, prNumber: worker.pr?.number ?? 0 })
        }

        const prior = (await store.prSnapshots.get(snapshotKey(worker.id))) as PrSnapshot | undefined
        if (!shouldObserve(prior, now, baseInterval)) {
          outcome.deferred += 1
          continue
        }

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
