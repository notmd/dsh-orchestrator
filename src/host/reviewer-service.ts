/**
 * The auto-review pass (PRD §7.5, M3).
 *
 * The feature the request calls out: when a pull request opens, the plugin's **own
 * independent reviewer** reads that exact head commit, and the worker iterates on
 * its findings until the pass approves. Only then does the card reach `In review`
 * and wait for a person.
 *
 * ## The reviewer is a separate session, not a subagent
 *
 * A subagent would run inside the worker's own context — the one context most
 * likely to be blind to the worker's mistakes — and would not get an enforced
 * permission preset. So the reviewer is a root session with its own `sessionId` and
 * `read-only`, sharing the worker's **worktree** (it must read the real diff) but
 * nothing else.
 *
 * ## A verdict is bound to a head, and the plugin pins it
 *
 * The reviewer does not choose which commit it judged. The pass records the pinned
 * `headSha` on the `ReviewRun`, and `submitVerdict` **rejects a verdict naming any
 * other commit** (A16). Without that, a worker pushing mid-review could have its
 * *old* head's approval applied to its new one — the race the head-scoped run
 * exists to prevent.
 *
 * ## One pass per `(PR, head)`
 *
 * Decided by `evaluateSession` in `../review/planner.ts`, which is already tested:
 * a running pass, an approval, a changes-requested verdict, a cancellation, or an
 * exhausted retry budget all refuse a new pass for the same head.
 *
 * @module dsho/host/reviewer-service
 */

import { newId } from '../domain/ids.ts'
import { normalizeIssue } from '../domain/issues.ts'
import { normalizeRepo } from './repo.ts'
import { normalizeWorker } from '../domain/workers.ts'
import type { Worker } from '../domain/workers.ts'
import { reviewerSystemPrompt, reviewerTaskMessage } from '../domain/reviewer-contract.ts'
import type { ReviewRun } from '../review/runs.ts'
import { ReviewRunStatus, ReviewVerdict, changesRequestedCycles, isVerdict } from '../review/runs.ts'
import { evaluateSession } from '../review/planner.ts'
import type { PRFactsForPlan } from '../review/planner.ts'
import { spawnWorker } from './spawn.ts'
import type { SpawnDeps, SpawnedWorker } from './spawn.ts'
import type { LazyFactStore } from './store.ts'
import type { PluginConfig } from '../config/validate.ts'
import type { LiveWorkers } from './handle-registry.ts'

/** What the review pass needs. */
export interface ReviewerToolDeps {
  store: LazyFactStore
  spawn: SpawnDeps
  config: PluginConfig
  live?: LiveWorkers
  now?: () => number
}

/** A finding, as the reviewer reports it. */
export interface ReviewFindingInput {
  severity: string
  path?: string
  line?: number
  summary: string
  detail: string
}

function storageFailure(error: unknown): string {
  return (
    'The plugin could not open its storage, so the review could not be recorded.\n\n' +
    `Storage error: ${error instanceof Error ? error.message : String(error)}`
  )
}

/** Every run recorded for a worker, newest first by creation. */
export async function runsForWorker(
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  workerId: string,
): Promise<ReviewRun[]> {
  return (await store.reviewRuns.list()).filter(
    (candidate): candidate is ReviewRun =>
      typeof candidate === 'object' && candidate !== null && (candidate as ReviewRun).workerId === workerId,
  )
}

/** The run a reviewer session is currently working, if any. */
export async function runningRunForSession(
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  sessionId: string,
): Promise<ReviewRun | undefined> {
  const runs = (await store.reviewRuns.list()) as ReviewRun[]
  return runs.find((run) => run.sessionId === sessionId && run.status === ReviewRunStatus.running)
}

/**
 * Decides whether a pass may start, and starts it.
 *
 * Returns the text the caller reports. Every refusal names a reason code from the
 * planner, because "why did my PR not get reviewed?" is the question this loop
 * generates most often.
 */
export async function startReviewPass(
  deps: ReviewerToolDeps,
  worker: Worker,
  options: { force?: boolean } = {},
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }

  if (!worker.pr || worker.pr.number <= 0) return `${worker.id} has no pull request to review.`

  const issue = normalizeIssue(await store.issues.get(worker.issueId))
  // Normalized rather than cast: a record written before the per-repo fields existed must
  // read as the DEFAULTS, and a cast would hand `undefined` to the code below.
  const repo = (await store.repos.list()).map(normalizeRepo).find((candidate) => candidate.id === issue.repoId)
  if (repo === undefined || (repo.owner === '' && repo.rootPath === '')) {
    return `The repository for ${worker.id} is not connected, so it cannot be reviewed.`
  }
  const repository = repo.owner !== '' && repo.name !== '' ? `${repo.owner}/${repo.name}` : repo.rootPath

  // Auto review can be turned off per repo, which the reference stores per project
  // because the right answer genuinely differs by repository.
  const autoReview = repo.autoReview ?? deps.config.autoReview
  if (!autoReview) return `Auto review is off for ${repository}, so no pass was scheduled.`

  // The reviewer's preset is per project too (PRD §13.1), so a heavy repository can run a
  // stricter reviewer than the rest. Empty means "the plugin's default", which is why this
  // is a fallback and not a required field.
  const reviewerPreset = repo.reviewerAgentPreset !== '' ? repo.reviewerAgentPreset : deps.config.reviewerAgentPreset

  const runs = await runsForWorker(store, worker.id)
  const snapshot = (await store.prSnapshots.get(worker.id)) as { headSha?: unknown } | undefined
  const headSha = worker.pr.headSha || (typeof snapshot?.headSha === 'string' ? snapshot.headSha : '')
  if (headSha === '') {
    return `The head commit of ${repository}#${worker.pr.number} is not known yet, so no pass was scheduled.`
  }

  const prs: PRFactsForPlan[] = [
    {
      url: worker.pr.url || `#${worker.pr.number}`,
      number: worker.pr.number,
      headSha,
      // The planner treats a draft as reviewable; `draft` is a *skip* reason the
      // caller applies, not an ineligibility.
      ...(typeof snapshot === 'object' && snapshot !== null && 'isDraft' in snapshot
        ? { draft: (snapshot as { isDraft?: unknown }).isDraft === true }
        : {}),
    },
  ]

  // The gate reads the **live** activity, not an assumption. `AgentStatus` is only
  // `idle | running`, and that is exactly the signal the gate wants: a reviewer must
  // not race a worker mid-turn, because the diff would still be moving.
  //
  // No handle means we genuinely do not know — after a restart, before the worker
  // does anything. `unknown` is deliberately NOT `idle`: refusing to review is the
  // safe direction, and the pass starts as soon as the worker next reports.
  const liveStatus = deps.live?.byWorker(worker.id)?.handle.agent.status
  const activity = liveStatus === 'running' ? 'active' : liveStatus === 'idle' ? 'idle' : 'unknown'

  // A forced pass bypasses the guards that exist to stop AUTOMATION from spinning:
  // the already-judged-this-head rule and the round cap. It does not bypass
  // ineligibility -- there is no diff to review on a merged or head-less PR -- which
  // is why the forced path still checks the head, just not the history.
  //
  // The run is recorded as `manual` so it does not consume the auto-retry budget
  // (PRD §7.5).
  const scheduled = options.force
    ? { trigger: headSha !== '', reason: 'triggered', headsToReview: headSha === '' ? [] : [headSha] }
    : evaluateSession({
    session: {
      autoReview: true,
      kind: 'worker',
      isTerminated: false,
      activity,
      lastActivityAt: worker.lastSignalAt,
      reviewerHarness: reviewerPreset,
    },
    prs,
    runs,
    now: (deps.now ?? Date.now)(),
    bounds: {
      maxReviewRounds: deps.config.maxReviewRounds,
      autoReviewFailedRetryLimit: deps.config.autoReviewFailedRetryLimit,
      idleThresholdMs: deps.config.reviewIdleThresholdMs,
    },
      })

  const decision = scheduled
  if (!decision.trigger || !decision.headsToReview.includes(headSha)) {
    const why =
      decision.reason === 'not_idle'
        ? "the worker is not idle, so the diff may still be moving"
        : decision.reason === 'idle_threshold_not_met'
          ? 'the worker has not been quiet long enough'
          : decision.reason
    return `No pass scheduled for ${repository}#${worker.pr.number}: ${why}.`
  }

  const round = changesRequestedCycles(runs) + 1
  const sessionId = `dsho-${newId('rev', (deps.now ?? Date.now)())}`
  const baseBranch = repo.defaultBranch

  let spawned: SpawnedWorker
  try {
    spawned = await spawnWorker(deps.spawn, {
      sessionId,
      // The SAME worktree: the reviewer must read the real diff. `create` returns the
      // existing workspace for a canonical path (Appendix A4), so the reviewer is
      // grouped with its worker rather than given a second tree.
      worktreePath: worker.worktreePath,
      title: `Review #${worker.pr.number}`,
      prompt: `${reviewerSystemPrompt()}\n\n---\n\n${reviewerTaskMessage({
        workerId: worker.id,
        prNumber: worker.pr.number,
        prUrl: worker.pr.url,
        headSha,
        baseBranch,
        branch: worker.branch,
        attempt: round,
      })}`,
      permissionPreset: deps.config.reviewerPermissionPreset,
      agentPreset: reviewerPreset,
    })
  } catch (error) {
    return `Could not start a reviewer for ${repository}#${worker.pr.number}: ${error instanceof Error ? error.message : String(error)}`
  }

  const at = (deps.now ?? Date.now)()
  const runId = newId('run', at)
  const run: ReviewRun = {
    id: runId,
    workerId: worker.id,
    prNumber: worker.pr.number,
    prUrl: worker.pr.url,
    headSha,
    round,
    status: ReviewRunStatus.running,
    triggerSource: options.force ? 'manual' : 'auto',
    sessionId,
    startedAt: at,
    harness: reviewerPreset,
  }
  await store.reviewRuns.put(runId, run)
  deps.live?.register({ workerId: `reviewer:${runId}`, sessionId, handle: spawned.handle, ...(spawned.scope ? { scope: spawned.scope } : {}) })

  return [
    `Review scheduled for ${repository}#${worker.pr.number} at ${headSha.slice(0, 7)} (round ${round}).`,
    '',
    `  reviewer session: ${sessionId}`,
    `  permission preset: ${deps.config.reviewerPermissionPreset} (read-only, enforced)`,
    '',
    'The reviewer reads the diff and reports through `orchestrator_review_verdict`.',
  ].join('\n')
}

/**
 * Records a verdict (`orchestrator_review_verdict`).
 *
 * The head check is the important part: a verdict naming a commit other than the
 * one the run was pinned to is **rejected**, so a worker that pushed mid-review
 * cannot have an old head's approval applied to its new one (A16).
 */
export async function submitVerdict(
  deps: ReviewerToolDeps,
  args: {
    verdict: string
    summary?: string
    findings?: readonly ReviewFindingInput[]
    githubReviewId?: string
    githubReviewNodeId?: string
    headSha?: string
  },
  callerSessionId: string | undefined,
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }

  if (!callerSessionId) return 'A verdict is accepted only from a reviewer session, and none was available.'
  const run = await runningRunForSession(store, callerSessionId)
  if (!run) {
    return `No running review pass is bound to session ${callerSessionId}.`
  }

  if (!isVerdict(args.verdict)) {
    return `A verdict must be "approved" or "changes_requested", got ${JSON.stringify(args.verdict)}.`
  }
  if (args.headSha !== undefined && args.headSha !== '' && args.headSha !== run.headSha) {
    return (
      `This pass judged ${run.headSha}, but the verdict names ${args.headSha}. ` +
      'A verdict is accepted only for the commit the pass was pinned to.'
    )
  }

  const at = (deps.now ?? Date.now)()
  const findings = (args.findings ?? []).map((finding) => ({
    severity: finding.severity,
    ...(finding.path ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    summary: finding.summary,
    detail: finding.detail,
  }))

  // `status` is the lifecycle and `verdict` is the outcome: they are separate
  // fields, so finishing a pass must set the lifecycle explicitly rather than
  // leaving it `running` (which would make the head look busy forever).
  const completed: ReviewRun = {
    ...run,
    status: ReviewRunStatus.complete,
    verdict: args.verdict === ReviewVerdict.approved ? ReviewVerdict.approved : ReviewVerdict.changesRequested,
    findings,
    endedAt: at,
    ...(args.summary ? { summary: args.summary } : {}),
    ...(args.githubReviewId ? { githubReviewId: args.githubReviewId } : {}),
    // Recorded so this review can be told apart from a person's later. The node id is the
    // matching key; see `ourReviewIds`.
    ...(args.githubReviewNodeId ? { githubReviewNodeId: args.githubReviewNodeId } : {}),
  }
  await store.reviewRuns.put(run.id ?? completed.headSha, completed)

  const tail: string[] = []
  if (completed.verdict === ReviewVerdict.changesRequested && deps.config.autoInjectReview) {
    tail.push(await routeFindingsToWorker(deps, store, run, completed))
  } else if (completed.verdict === ReviewVerdict.changesRequested) {
    tail.push('`autoInjectReview` is off, so the findings sit on the card for you to act on.')
  } else {
    tail.push('The pass approved this commit; the card moves to In review for a human.')
  }

  return [
    `Recorded ${completed.verdict} for ${run.workerId} at ${run.headSha.slice(0, 7)}.`,
    ...(findings.length > 0 ? [`${findings.length} finding(s).`] : []),
    '',
    ...tail,
  ].join('\n')
}

/**
 * Routes findings to the owning worker.
 *
 * The GitHub review id is named so the worker knows **which review to address and
 * reply to** — without it the worker has to guess which of the reviews on the PR
 * the orchestrator means.
 */
async function routeFindingsToWorker(
  deps: ReviewerToolDeps,
  store: Awaited<ReturnType<LazyFactStore['get']>>,
  run: ReviewRun,
  completed: ReviewRun,
): Promise<string> {
  const live = deps.live?.byWorker(run.workerId)
  if (!live) {
    return `No live handle for ${run.workerId}, so the findings are queued on the card rather than injected.`
  }
  const findings = (completed.findings ?? [])
    .map((finding) => {
      const where = finding.path ? ` ${finding.path}${finding.line ? `:${finding.line}` : ''}` : ''
      return `- [${finding.severity}]${where} ${finding.summary}\n  ${finding.detail}`
    })
    .join('\n')
  const reviewId = completed.githubReviewId ? `\n\nAddress review ${completed.githubReviewId} on the pull request.` : ''
  live.handle.agent.followup(
    deps.spawn.userMessage(
      `The automated review of ${completed.headSha.slice(0, 7)} requested changes.\n\n${findings}${reviewId}\n\n` +
        'Fix these, push, and the new commit will be reviewed again.',
    ),
  )
  return `Routed ${(completed.findings ?? []).length} finding(s) to ${run.workerId}.`
}

/** Records a failed pass (`orchestrator_review_failed`). */
export async function reportReviewFailure(
  deps: ReviewerToolDeps,
  args: { reason?: string },
  callerSessionId: string | undefined,
): Promise<string> {
  let store: Awaited<ReturnType<LazyFactStore['get']>>
  try {
    store = await deps.store.get()
  } catch (error) {
    return storageFailure(error)
  }
  if (!callerSessionId) return 'A failure is accepted only from a reviewer session.'
  const run = await runningRunForSession(store, callerSessionId)
  if (!run) return `No running review pass is bound to session ${callerSessionId}.`

  const at = (deps.now ?? Date.now)()
  const failed: ReviewRun = { ...run, status: ReviewRunStatus.failed, endedAt: at }
  if (args.reason) failed.summary = args.reason
  await store.reviewRuns.put(run.id ?? failed.headSha, failed)

  const runs = await runsForWorker(store, run.workerId)
  const autoFailures = runs.filter(
    (candidate) =>
      candidate.headSha === run.headSha &&
      candidate.status === ReviewRunStatus.failed &&
      candidate.triggerSource !== 'manual',
  ).length
  const remaining = Math.max(0, deps.config.autoReviewFailedRetryLimit - autoFailures)

  return [
    `Recorded a failed pass for ${run.workerId} at ${run.headSha.slice(0, 7)}${args.reason ? `: ${args.reason}` : '.'}`,
    remaining > 0
      ? `${remaining} retry/retries remain on this commit.`
      : 'The retry budget for this commit is spent, so the card is released to you.',
  ].join('\n')
}


/**
 * Schedules passes for every worker that is owed one.
 *
 * This is what makes the loop turn without a human: on each sweep, every worker
 * whose current head has no pass gets one. It is deliberately a thin loop over
 * `startReviewPass`, because the decision belongs to the planner and duplicating it
 * here is how the board and the scheduler start disagreeing.
 *
 * Serialised rather than fanned out: a sweep that spawns five reviewers at once
 * would burn five sessions' worth of tokens in a burst, and the per-worker decision
 * is cheap enough that the delay does not matter.
 */
export async function sweepReviewPasses(
  deps: ReviewerToolDeps,
): Promise<{ scheduled: Array<{ workerId: string; summary: string }>; considered: number }> {
  const scheduled: Array<{ workerId: string; summary: string }> = []
  let store
  try {
    store = await deps.store.get()
  } catch {
    return { scheduled, considered: 0 }
  }

  const workers = (await store.workers.list()).map(normalizeWorker).filter((worker) => !!worker.pr)
  for (const worker of workers) {
    try {
      const summary = await startReviewPass(deps, worker)
      if (summary.startsWith('Review scheduled')) scheduled.push({ workerId: worker.id, summary })
    } catch {
      // One worker's failure must not stop the sweep.
    }
  }
  return { scheduled, considered: workers.length }
}
