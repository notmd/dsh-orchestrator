/**
 * Finishing a worker whose pull request landed (A7).
 *
 * The rule under test most often is R13's: a **terminal transition requires a
 * successful observation**. The dangerous case is a failed observation whose empty
 * payload *reads* as `CLOSED` — which would terminate a live worker and delete its
 * worktree. An observation that did not succeed must finish nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { completeWorker, sweepCompletions } from '../../src/host/completion.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase, normalizeWorker } from '../../src/domain/workers.ts'
import { parsePrView, unfetchedSnapshot } from '../../src/domain/pr-snapshot.ts'
import type { PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const NOW = 10_000_000
const WORKTREE = '/repos/r1/.dsho/worktrees/issue-1-x'

function snapshot(state: string, fetched = true): PrSnapshot {
  return { ...parsePrView({ number: 42, state, headRefOid: 'sha-1' }, NOW), fetched }
}

/** A git that really knows about the worktree, and records argv. */
function git(): { run: RunCommand; readonly calls: string[][] } {
  const calls: string[][] = []
  const existing = new Map<string, string>([[WORKTREE, 'dsho/issue-1-x']])
  const run: RunCommand = async (argv) => {
    calls.push([...argv])
    const joined = argv.join(' ')
    if (joined.startsWith('git worktree list')) {
      const stdout = [...existing].map(([path, branch]) => `worktree ${path}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/${branch}\n`).join('\n')
      return { exitCode: 0, stdout, stderr: '' }
    }
    if (joined.startsWith('git worktree remove')) {
      existing.delete(argv[argv.length - 1]!)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { run, get calls() { return calls } }
}

async function finishable(phase = WorkerPhase.mergeReady) {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/repos/r1', owner: 'acme', name: 'widgets' })
  await store.issues.put('iss-1', {
    id: 'iss-1', number: 1, repoId: 'repo-1', title: 'Task', state: 'in_progress',
    workerId: 'wrk-1', createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 'dsho-wrk-1', branch: 'dsho/issue-1-x',
    worktreePath: WORKTREE, workspaceId: 'w', phase, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
    pr: { number: 42, url: 'pr/42', headSha: 'sha-1' },
  })
  const g = git()
  return {
    store,
    git: g,
    deps: { store: lazyFactStore(async () => store), run: g.run, now: () => NOW },
  }
}

test('a MERGED pull request finishes the worker: phase, issue and worktree', async () => {
  const { store, git, deps } = await finishable()
  const outcome = await completeWorker(deps, normalizeWorker(await store.workers.get('wrk-1')), snapshot('MERGED'))

  assert.equal(outcome.completed, true)
  assert.equal(outcome.reason, 'merged')
  assert.equal(((await store.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.merged)
  const issue = (await store.issues.get('iss-1')) as { state: string; workerId?: string }
  assert.equal(issue.state, 'done', 'a merge means the work landed')
  assert.equal(issue.workerId, undefined, 'and the worker is released')
  assert.equal(outcome.cleanup?.removed, true, 'R4 is paid here')
  assert.ok(git.calls.some((argv) => argv.includes('remove')))
})

test('a CLOSED pull request is cancelled, not done', async () => {
  // A close without merge means the work was abandoned. Conflating the two hides
  // abandoned work from whoever reads the queue.
  const { store, deps } = await finishable()
  await completeWorker(deps, normalizeWorker(await store.workers.get('wrk-1')), snapshot('CLOSED'))
  assert.equal(((await store.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.closed)
  assert.equal(((await store.issues.get('iss-1')) as { state: string }).state, 'cancelled')
})

test('an open pull request finishes nothing', async () => {
  const { store, deps } = await finishable()
  const outcome = await completeWorker(deps, normalizeWorker(await store.workers.get('wrk-1')), snapshot('OPEN'))
  assert.equal(outcome.completed, false)
  assert.equal(outcome.reason, 'not-terminal')
  assert.equal(((await store.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.mergeReady)
})

test('R13: an UNFETCHED snapshot can finish nothing, however it reads', async () => {
  // The dangerous case. A failed observation keeps the prior facts, and if it were
  // treated as terminal it would terminate a live worker and delete its worktree.
  const { store, deps } = await finishable()
  const prior = snapshot('MERGED')
  const failed = unfetchedSnapshot(prior, 'rate-limited', NOW)
  // Even a snapshot that SAYS merged cannot finish anything without a fetch.
  const outcome = await completeWorker(deps, normalizeWorker(await store.workers.get('wrk-1')), { ...failed, state: 'MERGED' })
  assert.equal(outcome.completed, false)
  assert.equal(outcome.reason, 'not-terminal')
  assert.equal(((await store.issues.get('iss-1')) as { state: string }).state, 'in_progress')
})

test('no snapshot at all finishes nothing', async () => {
  const { store, deps } = await finishable()
  assert.equal((await completeWorker(deps, normalizeWorker(await store.workers.get('wrk-1')), undefined)).completed, false)
})

test('finishing is idempotent, so a per-poll sweep does not re-run cleanup', async () => {
  const { store, deps, git } = await finishable()
  const worker = normalizeWorker(await store.workers.get('wrk-1'))
  await completeWorker(deps, worker, snapshot('MERGED'))
  const removes = git.calls.filter((argv) => argv.includes('remove')).length

  const again = await completeWorker(deps, normalizeWorker(await store.workers.get('wrk-1')), snapshot('MERGED'))
  assert.equal(again.completed, false)
  assert.equal(again.reason, 'already-terminal')
  assert.equal(git.calls.filter((argv) => argv.includes('remove')).length, removes, 'no second removal')
})

test('a cleanup failure does not roll back the completion', async () => {
  // The completion is what the user is waiting for; a git problem while collecting
  // the tree must not undo it, nor hide itself.
  const { store, deps, git } = await finishable()
  const failing = {
    ...deps,
    run: (async (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      if (argv.includes('remove')) return { exitCode: 128, stdout: '', stderr: 'fatal: not a working tree' } as CommandResult
      return git.run(argv, options)
    }) as RunCommand,
  }
  const outcome = await completeWorker(failing, normalizeWorker(await store.workers.get('wrk-1')), snapshot('MERGED'))
  assert.equal(outcome.completed, true)
  assert.match(outcome.cleanup?.error ?? '', /not a working tree/)
  assert.equal(((await store.workers.get('wrk-1')) as { phase: string }).phase, WorkerPhase.merged)
})

test('the sweep finishes only the workers whose snapshot is terminal', async () => {
  const { store, deps } = await finishable()
  await store.prSnapshots.put('wrk-1', snapshot('OPEN'))
  assert.deepEqual(await sweepCompletions(deps), [], 'an open PR is left alone')

  await store.prSnapshots.put('wrk-1', snapshot('MERGED'))
  const outcomes = await sweepCompletions(deps)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]!.reason, 'merged')
  assert.deepEqual(await sweepCompletions(deps), [], 'and does not repeat')
})

test('the sweep contains a storage failure instead of throwing', async () => {
  const outcomes = await sweepCompletions({
    store: lazyFactStore(async () => {
      throw new Error('backend offline')
    }),
    run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as RunCommand,
  })
  assert.deepEqual(outcomes, [])
})
