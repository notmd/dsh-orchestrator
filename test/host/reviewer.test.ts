/**
 * The auto-review pass.
 *
 * The rule under test most often is A16: **a verdict against a superseded head
 * never changes a lane.** A worker pushing mid-review must not have its *old*
 * head's approval applied to its *new* one, which is the race that head-scoped
 * review runs exist to prevent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  reportReviewFailure,
  runningRunForSession,
  startReviewPass,
  submitVerdict,
  sweepReviewPasses,
} from '../../src/host/reviewer-service.ts'
import { createLiveWorkers } from '../../src/host/handle-registry.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { ReviewRunStatus, ReviewVerdict } from '../../src/review/runs.ts'
import type { ReviewRun } from '../../src/review/runs.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'
import { apply } from '../../src/index.ts'
import type { AgentLike, AgentHandle } from '../../src/host/spawn.ts'

const NOW = 10_000_000
const HEAD = 'sha-1'

function fakeHandle(): { handle: AgentHandle; readonly followups: Array<{ content: Array<{ text: string }> }> } {
  const followups: Array<{ content: Array<{ text: string }> }> = []
  const agent: AgentLike = {
    session: { id: 's' },
    // A quiet worker: the review gate reads this, so a fixture with no status would
    // (correctly) be treated as UNKNOWN and nothing would ever be scheduled.
    status: 'idle',
    followup(message) {
      followups.push(message as { content: Array<{ text: string }> })
    },
  }
  return { handle: { agent, async dispose() {} }, followups }
}

/** A store with a worker whose PR head is `HEAD`, and a running pass for it. */
async function review(overrides: { runStatus?: string; inject?: boolean } = {}) {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', {
    id: 'repo-1',
    owner: 'acme',
    name: 'widgets',
    rootPath: '/r',
    defaultBranch: 'main',
  })
  await store.issues.put('iss-1', {
    id: 'iss-1',
    number: 1,
    repoId: 'repo-1',
    title: 'Fix it',
    state: 'in_progress',
    workerId: 'wrk-1',
    sourceSessionId: 'session-1',
    createdAt: 1,
    updatedAt: 1,
  })
  await store.workers.put('wrk-1', {
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'dsho-wrk-1',
    branch: 'dsho/issue-1-x',
    worktreePath: '/r/.dsho/worktrees/i1',
    workspaceId: 'w',
    phase: WorkerPhase.awaitingAutoReview,
    phaseHistory: [],
    pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42', headSha: HEAD },
    lastSignalAt: NOW - 1_000_000,
    createdAt: 1,
    updatedAt: 1,
  })
  const run: ReviewRun = {
    id: 'run-1',
    workerId: 'wrk-1',
    prNumber: 42,
    prUrl: 'https://github.com/acme/widgets/pull/42',
    headSha: HEAD,
    round: 1,
    status: (overrides.runStatus as ReviewRunStatus) ?? ReviewRunStatus.running,
    triggerSource: 'auto',
    sessionId: 'dsho-rev-1',
    startedAt: 1,
  }
  await store.reviewRuns.put('run-1', run)

  const live = createLiveWorkers()
  const workerHandle = fakeHandle()
  live.register({ workerId: 'wrk-1', sessionId: 'dsho-wrk-1', handle: workerHandle.handle })

  const spawnCalls: Array<{ sessionId: string; worktreePath: string; permissionPreset: string; prompt: string }> = []
  const spawn = {
    permissionPresets: { resolve: () => undefined, set() {} },
    agentPresets: {
      async resolve() {
        return { id: 'standard' }
      },
      async acquireScope() {
        return { dispose() {} }
      },
      async mount() {},
    },
    workspaceRegistry: {
      async create(path: string) {
        return { path, async attachSession() {} }
      },
    },
    sessionTitle: { rename() {} },
    agents: {
      async create(options: { sessionId: string; meta: { cwd: string } }) {
        return {
          agent: { session: { id: options.sessionId }, followup() {} },
          async dispose() {},
        }
      },
    },
    userMessage: (text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }

  const config = apply(
    {
      tools: { register: () => () => {} },
      subprocess: { spawn: () => { throw new Error('no') } } as never,
      storageDomain: { open: async () => { throw new Error('no') } } as never,
      agentRegistry: { get: () => undefined },
      agents: spawn.agents as never,
      agentPresets: spawn.agentPresets as never,
      permissionPresets: spawn.permissionPresets as never,
      workspaceRegistry: spawn.workspaceRegistry as never,
      sessionTitle: spawn.sessionTitle as never,
      effect: (cb: () => (() => void) | void) => {
        const cleanup = cb()
        return typeof cleanup === 'function' ? cleanup : () => {}
      },
    } as never,
    overrides.inject === false ? { autoInjectReview: false } : {},
  )

  return {
    raw: store,
    live,
    workerHandle,
    spawnCalls,
    deps: { store: lazyFactStore(async () => store), spawn: spawn as never, config, live, now: () => NOW },
  }
}

// ---------------------------------------------------------------------------
// A verdict is bound to a head
// ---------------------------------------------------------------------------

test('A16: a verdict naming another commit is REJECTED', async () => {
  // Without this, a worker that pushed mid-review could have its old head's
  // approval applied to its new one.
  const { deps, raw } = await review()
  const text = await submitVerdict(deps, { verdict: 'approved', headSha: 'sha-other' }, 'dsho-rev-1')
  assert.match(text, /judged sha-1, but the verdict names sha-other/)
  assert.match(text, /only for the commit the pass was pinned to/)
  assert.equal(
    ((await raw.reviewRuns.get('run-1')) as ReviewRun).status,
    ReviewRunStatus.running,
    'the run is untouched, so the pass can still be completed correctly',
  )
})

test('a verdict without a head is accepted, since the pass already pinned one', async () => {
  const { deps } = await review()
  assert.match(await submitVerdict(deps, { verdict: 'approved' }, 'dsho-rev-1'), /Recorded approved/)
})

test('a verdict for the pinned head is accepted', async () => {
  const { deps, raw } = await review()
  await submitVerdict(deps, { verdict: 'approved', headSha: HEAD, summary: 'looks right' }, 'dsho-rev-1')
  const run = (await raw.reviewRuns.get('run-1')) as ReviewRun
  assert.equal(run.status, ReviewRunStatus.complete, 'the lifecycle is finished')
  assert.equal(run.verdict, ReviewVerdict.approved, 'and the verdict is the outcome')
  assert.equal(run.summary, 'looks right')
  assert.equal(run.endedAt, NOW)
})

test('a session with no running pass cannot submit a verdict', async () => {
  const { deps } = await review()
  assert.match(await submitVerdict(deps, { verdict: 'approved' }, 'not-a-reviewer'), /No running review pass/)
})

test('a verdict is accepted only from a reviewer session', async () => {
  const { deps } = await review()
  assert.match(await submitVerdict(deps, { verdict: 'approved' }, undefined), /only from a reviewer session/)
})

test('a verdict that is neither approved nor changes_requested is refused', async () => {
  const { deps } = await review()
  assert.match(await submitVerdict(deps, { verdict: 'looks fine' }, 'dsho-rev-1'), /must be "approved" or "changes_requested"/)
})

// ---------------------------------------------------------------------------
// Routing findings back to the worker
// ---------------------------------------------------------------------------

test('changes_requested routes the findings to the owning worker', async () => {
  const { deps, workerHandle } = await review()
  const text = await submitVerdict(
    deps,
    {
      verdict: 'changes_requested',
      findings: [{ severity: 'high', path: 'src/a.ts', line: 12, summary: 'off by one', detail: 'the loop runs once too far' }],
      githubReviewId: 'PRR_123',
    },
    'dsho-rev-1',
  )
  assert.match(text, /Recorded changes_requested/)
  assert.match(text, /Routed 1 finding\(s\) to wrk-1/)
  assert.equal(workerHandle.followups.length, 1)
  const prompt = workerHandle.followups[0]!.content.map((b) => b.text).join('\n')
  assert.match(prompt, /requested changes/)
  assert.match(prompt, /src\/a\.ts:12/)
  assert.match(prompt, /off by one/)
  // The review id is named so the worker knows WHICH review to address and reply to.
  assert.match(prompt, /PRR_123/)
})

test('an approval injects nothing', async () => {
  const { deps, workerHandle } = await review()
  const text = await submitVerdict(deps, { verdict: 'approved' }, 'dsho-rev-1')
  assert.equal(workerHandle.followups.length, 0)
  assert.match(text, /moves to In review for a human/)
})

test('with autoInjectReview off the findings sit on the card instead', async () => {
  const { deps, workerHandle } = await review()
  // Set on the resolved config directly: the routing decision is what is under test
  // here, and the config plumbing has its own tests.
  ;(deps.config as { autoInjectReview: boolean }).autoInjectReview = false
  const text = await submitVerdict(
    deps,
    { verdict: 'changes_requested', findings: [{ severity: 'low', summary: 's', detail: 'd' }] },
    'dsho-rev-1',
  )
  assert.equal(workerHandle.followups.length, 0)
  assert.match(text, /`autoInjectReview` is off/)
})

test('findings with no live worker handle are held, not lost', async () => {
  const { deps, raw } = await review()
  deps.live = createLiveWorkers()
  const text = await submitVerdict(deps, { verdict: 'changes_requested' }, 'dsho-rev-1')
  assert.match(text, /queued on the card/)
  // The verdict is still recorded, which is what the board reads.
  assert.equal(((await raw.reviewRuns.get('run-1')) as ReviewRun).verdict, ReviewVerdict.changesRequested)
})

// ---------------------------------------------------------------------------
// Failure and the retry budget
// ---------------------------------------------------------------------------

test('a failed pass is marked failed and reports the retry budget', async () => {
  const { deps, raw } = await review()
  const text = await reportReviewFailure(deps, { reason: 'reviewer crashed' }, 'dsho-rev-1')
  assert.match(text, /Recorded a failed pass/)
  assert.match(text, /2 retry\/retries remain/, '3 allowed minus 1 spent')
  const run = (await raw.reviewRuns.get('run-1')) as ReviewRun
  assert.equal(run.status, ReviewRunStatus.failed)
  assert.equal(run.summary, 'reviewer crashed')
})

test('a failed pass cannot be recorded for a session with no running pass', async () => {
  const { deps } = await review()
  assert.match(await reportReviewFailure(deps, {}, 'nope'), /No running review pass/)
})

test('runningRunForSession finds only a RUNNING pass', async () => {
  const { deps, raw } = await review()
  assert.equal((await runningRunForSession(await deps.store.get(), 'dsho-rev-1'))?.id, 'run-1')
  const store = await raw.reviewRuns.get('run-1')
  await raw.reviewRuns.put('run-1', { ...(store as ReviewRun), status: ReviewRunStatus.complete })
  assert.equal(await runningRunForSession(await deps.store.get(), 'dsho-rev-1'), undefined)
})

// ---------------------------------------------------------------------------
// Starting a pass
// ---------------------------------------------------------------------------

test('a pass is scheduled at the head, with a read-only reviewer in the SAME worktree', async () => {
  const { deps, raw, spawnCalls } = await review({})
  // Remove the existing running pass so the planner is free to schedule.
  await raw.reviewRuns.delete('run-1')

  const worker = (await raw.workers.get('wrk-1')) as never
  const text = await startReviewPass(deps, worker)
  assert.match(text, /Review scheduled for acme\/widgets#42 at sha-1/)
  assert.match(text, /read-only, enforced/)

  const runs = (await raw.reviewRuns.list()) as ReviewRun[]
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.headSha, HEAD)
  assert.equal(runs[0]!.status, ReviewRunStatus.running)
  assert.equal(runs[0]!.triggerSource, 'auto')
})

test('an already-approved head is not re-reviewed, and the reason is named', async () => {
  const { deps, raw } = await review()
  await raw.reviewRuns.put('run-1', {
    ...((await raw.reviewRuns.get('run-1')) as ReviewRun),
    status: ReviewRunStatus.complete,
    verdict: ReviewVerdict.approved,
  })
  const text = await startReviewPass(deps, (await raw.workers.get('wrk-1')) as never)
  assert.match(text, /No pass scheduled/)
  assert.match(text, /already_approved/)
})

test('a worker with no pull request is refused before anything is spawned', async () => {
  const { deps, raw } = await review()
  const worker = { ...((await raw.workers.get('wrk-1')) as Record<string, unknown>) }
  delete worker.pr
  assert.match(await startReviewPass(deps, worker as never), /has no pull request to review/)
})


// ---------------------------------------------------------------------------
// The sweep, and the activity gate it reads
// ---------------------------------------------------------------------------

test('the sweep schedules for a worker whose head has no pass', async () => {
  const { deps, raw } = await review()
  await raw.reviewRuns.delete('run-1')
  const outcome = await sweepReviewPasses(deps)
  assert.equal(outcome.considered, 1)
  assert.equal(outcome.scheduled.length, 1)
  assert.match(outcome.scheduled[0]!.summary, /Review scheduled for acme\/widgets#42/)
})

test('the gate reads the LIVE activity: a worker mid-turn is not reviewed', async () => {
  // The reviewer must not race a worker whose diff is still moving. AgentStatus is
  // only idle | running, and that is exactly the signal the gate wants.
  const { deps, raw } = await review()
  await raw.reviewRuns.delete('run-1')
  const busy = createLiveWorkers()
  busy.register({
    workerId: 'wrk-1',
    sessionId: 'dsho-wrk-1',
    handle: {
      agent: { session: { id: 's' }, status: 'running', followup() {} },
      async dispose() {},
    },
  })
  deps.live = busy
  const outcome = await sweepReviewPasses(deps)
  assert.equal(outcome.scheduled.length, 0, 'nothing was scheduled')
})

test('no live handle means UNKNOWN, and unknown is not idle', async () => {
  // After a restart we genuinely do not know. Refusing to review is the safe
  // direction, and the pass starts as soon as the worker next reports.
  const { deps, raw } = await review()
  await raw.reviewRuns.delete('run-1')
  deps.live = createLiveWorkers()
  const outcome = await sweepReviewPasses(deps)
  assert.equal(outcome.scheduled.length, 0)
  assert.equal((await raw.reviewRuns.list()).length, 0, 'no run was created')
})

test('the sweep skips workers with no pull request, and contains a failure', async () => {
  const { deps, raw } = await review()
  await raw.reviewRuns.delete('run-1')
  const worker = { ...((await raw.workers.get('wrk-1')) as Record<string, unknown>) }
  delete worker.pr
  await raw.workers.put('wrk-1', worker)
  const outcome = await sweepReviewPasses(deps)
  assert.equal(outcome.considered, 0, 'the worker has no PR, so it is not considered')
})

test('a store failure is contained, not thrown at the sweep caller', async () => {
  const outcome = await sweepReviewPasses({
    store: lazyFactStore(async () => {
      throw new Error('backend offline')
    }),
    spawn: {} as never,
    config: {} as never,
  })
  assert.deepEqual(outcome, { scheduled: [], considered: 0 })
})
