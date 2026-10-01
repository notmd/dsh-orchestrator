/**
 * M0 spike — does a card move through lanes?
 *
 * The previous spike proved issue → worker → card. This one drives the half that
 * follows: the observer's facts move the card into `Validating`, the review sweep
 * spawns a real read-only reviewer, and a verdict moves it to `Needs human review`
 * — **auto review first, then the human**, which is the ordering the whole design
 * exists to guarantee.
 *
 * **A real pull request is deliberately not opened.** `gh pr create` would need
 * write access to a repository the spike does not own, and creating a PR on someone
 * else's repository is not a side effect an unattended spike may have. So the
 * observer's *output* — a PR snapshot — is written directly, which is exactly the
 * boundary the observer is unit-tested at; what this spike adds is everything the
 * snapshot then drives against the real services.
 *
 * @module dsho/spike/lane-spike
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { FACT_SCHEMAS } from '../host/schemas.ts'
import { lazyFactStore, openFactStore } from '../host/store.ts'
import { createRunCommand } from '../host/exec.ts'
import { createSpawnDeps } from '../host/spawn-deps.ts'
import { createLiveWorkers } from '../host/handle-registry.ts'
import { connectRepoForTool } from '../host/tools.ts'
import { createIssueForTool } from '../host/issues-service.ts'
import { startWorkerForTool } from '../host/workers-service.ts'
import { buildBoard } from '../host/board-service.ts'
import { reportReviewFailure, submitVerdict, sweepReviewPasses } from '../host/reviewer-service.ts'
import { normalizePluginConfig } from '../config/validate.ts'
import { normalizeWorker } from '../domain/workers.ts'
import type { HostContext } from '../host/context.ts'

export const name = 'lane-spike'

export const inject = [
  'subprocess',
  'storageDomain',
  'agents',
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
  'sessionTitle',
]

const REPO = '/tmp/dsho-lane'
const RESULT = '/tmp/dsho-lane-result.json'
const ORIGIN = 'https://github.com/Untrivial-ai/agent-orchestrator.git'

const steps: Array<{ step: string; detail?: unknown }> = []

function record(step: string, detail?: unknown): void {
  steps.push({ step, ...(detail === undefined ? {} : { detail }) })
  try {
    writeFileSync(RESULT, JSON.stringify({ steps }, null, 2))
  } catch {
    // Never take the host down over bookkeeping.
  }
}

export function apply(ctx: HostContext): void {
  void run(ctx)
}

/** The card's lane and phrase, as the panel would read them. */
async function view(
  deps: { store: ReturnType<typeof lazyFactStore>; config: ReturnType<typeof normalizePluginConfig> },
  workerId: string,
): Promise<string> {
  const board = await buildBoard({ ...deps, activityOf: () => 'idle' })
  const all = Object.values(board.lenses.lanes).flat()
  const card = all.find((candidate) => candidate.id === workerId)
  return card ? `${card.column} / ${card.displayStatus}` : `(no card) lanes=${JSON.stringify(board.counts.byLane)}`
}

async function run(ctx: HostContext): Promise<void> {
  record('begin')
  try {
    rmSync(REPO, { recursive: true, force: true })
    mkdirSync(REPO, { recursive: true })
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: REPO })
    execFileSync('git', ['config', 'user.email', 'spike@example.invalid'], { cwd: REPO })
    execFileSync('git', ['config', 'user.name', 'Spike'], { cwd: REPO })
    writeFileSync(`${REPO}/README.md`, '# spike\n')
    writeFileSync(`${REPO}/.gitignore`, '.dsho/\n')
    execFileSync('git', ['add', '.'], { cwd: REPO })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: REPO })
    execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: REPO })
    record('scratch-repo:ready')

    const config = normalizePluginConfig()
    const run0 = createRunCommand({ subprocess: ctx.subprocess, cwd: REPO })
    const store = lazyFactStore(() => openFactStore({ facility: ctx.storageDomain, schemas: FACT_SCHEMAS }))
    const spawn = createSpawnDeps(ctx)
    const live = createLiveWorkers()

    const connected = await connectRepoForTool({ config, run: run0, store }, { path: REPO })
    if (!connected.startsWith('Connected')) throw new Error(connected)
    const created = await createIssueForTool({ store }, { title: 'Move this card' })

    const issueId = /\b(iss-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(created)?.[1]
    if (!issueId) throw new Error(`no issue id in ${created}`)
    const started = await startWorkerForTool({ run: run0, store, spawn, config, live }, { issueId })
    const workerId = /\b(wrk-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(started)?.[1]
    if (!workerId) throw new Error(`no worker id in ${started}`)
    record('worker_started', { workerId })

    // The worker's handle, as `worker_start` would have registered it — the review
    // gate reads its status, so without it the sweep correctly refuses.
    const stored = await (await store.get()).workers.get(workerId)
    live.register({
      workerId,
      sessionId: normalizeWorker(stored).sessionId,
      handle: { agent: { session: { id: 'x' }, status: 'idle', followup() {} }, async dispose() {} },
    })

    const deps = { store, spawn, config, live }
    record('lane:before-a-pr', { view: await view(deps, workerId) })

    // What the OBSERVER would record once a PR exists: the pull half is unit-tested,
    // and the point here is everything the snapshot then drives.
    const head = 'sha-' + 'a'.repeat(12)
    const worker = normalizeWorker(stored)
    await (await store.get()).prSnapshots.put(workerId, {
      number: 42,
      url: `${ORIGIN.replace(/\.git$/, '')}/pull/42`,
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: '',
      ciState: 'passing',
      headSha: head,
      headRefName: worker.branch,
      reviews: [],
      comments: [],
      lastCommentId: '',
      updatedAt: new Date().toISOString(),
      observedAt: Date.now(),
      fetched: true,
    })
    await (await store.get()).workers.put(workerId, { ...worker, pr: { number: 42, url: 'pr/42', headSha: head } })
    record('lane:with-a-pr', { view: await view(deps, workerId) })

    const sweep = await sweepReviewPasses(deps)
    record('review_sweep', { considered: sweep.considered, scheduled: sweep.scheduled.length })
    const runs = (await (await store.get()).reviewRuns.list()) as Array<{ id: string; sessionId?: string; headSha: string }>
    record('review_run', { count: runs.length, headSha: runs[0]?.headSha, session: runs[0]?.sessionId })
    record('lane:review-running', { view: await view(deps, workerId) })

    if (!runs[0]?.sessionId) throw new Error('the sweep did not spawn a reviewer')
    const verdict = await submitVerdict(
      deps,
      { verdict: 'approved', summary: 'looks correct, tests cover it' },
      runs[0].sessionId,
    )
    record('verdict', { summary: verdict.split('\n')[0] })
    record('lane:after-approval', { view: await view(deps, workerId) })

    // And the retry path, on a second head, so both sides of a pass are exercised.
    const second = 'sha-' + 'b'.repeat(12)
    await (await store.get()).workers.put(workerId, {
      ...normalizeWorker(await (await store.get()).workers.get(workerId)),
      pr: { number: 42, url: 'pr/42', headSha: second },
    })
    await (await store.get()).prSnapshots.put(workerId, {
      ...(await (await store.get()).prSnapshots.get(workerId) as Record<string, unknown>),
      headSha: second,
    })
    const sweep2 = await sweepReviewPasses(deps)
    record('review_sweep:second-head', { scheduled: sweep2.scheduled.length })
    const runs2 = (await (await store.get()).reviewRuns.list()) as Array<{ sessionId?: string; headSha: string }>
    const current = runs2.find((candidate) => candidate.headSha === second)
    if (!current?.sessionId) throw new Error('no pass for the second head')
    const failed = await reportReviewFailure(deps, { reason: 'reviewer could not read the diff' }, current.sessionId)
    record('review_failed', { summary: failed.split('\n')[0] })
    record('lane:review-failed', { view: await view(deps, workerId) })

    finish(true, {})
  } catch (error) {
    record('failed', { message: error instanceof Error ? error.message : String(error) })
    finish(false, { message: error instanceof Error ? error.message : String(error) })
  }
}

function finish(ok: boolean, detail: Record<string, unknown>): void {
  try {
    writeFileSync(RESULT, JSON.stringify({ ok, detail, steps }, null, 2))
  } catch {
    // As above.
  }
}
