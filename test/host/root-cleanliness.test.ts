/**
 * Detecting edits outside a worker's worktree (R7).
 *
 * The guard's whole design is the DELTA. The plugin shares the user's own checkout, so
 * the repository root is frequently dirty for legitimate reasons -- their work in
 * progress, a scratch file, a build artefact. A guard that refused on any dirt would be
 * disabled the first time it cried wolf, so the tests below care most about what it
 * IGNORES.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dirtyPaths, newlyDirty } from '../../src/host/root-cleanliness.ts'
import { reportForTool } from '../../src/host/reports-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

function git(porcelain: string, exitCode = 0): RunCommand {
  return async () => ({ exitCode, stdout: porcelain, stderr: '' }) as CommandResult
}

// ---------------------------------------------------------------------------
// Parsing and the delta
// ---------------------------------------------------------------------------

test('porcelain output becomes paths, with the status codes stripped', async () => {
  const paths = await dirtyPaths(git(' M src/a.ts\n?? src/new.ts\nA  src/staged.ts\n'), '/r')
  assert.deepEqual(paths, ['src/a.ts', 'src/new.ts', 'src/staged.ts'])
})

test('a git failure reads as CLEAN, never as dirty', async () => {
  // The other choice -- treating an unreadable tree as a violation -- would block every
  // worker on a host where git complained, for a reason nobody could act on.
  assert.deepEqual(await dirtyPaths(git('', 128), '/r'), [])
})

test('R7: the delta ignores what was ALREADY dirty, and reports only what changed', () => {
  // The point of the whole design. The human's work in progress is not the worker's.
  const baseline = ['src/theirs.ts', 'notes.md']
  const current = ['src/theirs.ts', 'notes.md', 'src/escaped.ts']
  assert.deepEqual(newlyDirty(current, baseline), ['src/escaped.ts'])
})

test('the delta ignores the plugin\'s own scratch space', () => {
  // `.dsho/` changes whenever a worker does anything -- the worktrees live inside it --
  // so counting it would make every root look freshly dirtied.
  assert.deepEqual(newlyDirty(['.dsho/worktrees/issue-1', '.dsho'], []), [])
  assert.deepEqual(newlyDirty(['.dsho-notes/x'], []), ['.dsho-notes/x'], 'but a lookalike path is not the scratch space')
})

test('a clean delta is empty, which is the ordinary case', () => {
  assert.deepEqual(newlyDirty(['a', 'b'], ['a', 'b']), [])
  assert.deepEqual(newlyDirty([], []), [])
})

// ---------------------------------------------------------------------------
// The guard at shipping time
// ---------------------------------------------------------------------------

async function ship(dirty: string, baseline: readonly string[]) {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', rootPath: '/r', owner: 'acme', name: 'widgets' })
  await store.issues.put('iss-1', {
    id: 'iss-1', number: 1, repoId: 'repo-1', title: 'Task', state: 'in_progress',
    workerId: 'wrk-1', createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 'dsho-wrk-1', branch: 'b', worktreePath: '/r/.dsho/w',
    workspaceId: 'w', phase: WorkerPhase.shipping, phaseHistory: [], rootDirtyAtStart: baseline,
    lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  const deps = { store: lazyFactStore(async () => store), run: git(dirty), now: () => 50 }
  const reply = await reportForTool(
    deps as never,
    { state: 'done' as never, outputs: [{ kind: 'pr_created' as never, ref: 'https://github.com/acme/widgets/pull/9' }] },
    'dsho-wrk-1',
  )
  return { reply, store }
}

test('R7: shipping is REFUSED when a path became dirty, and the paths are named', async () => {
  const { reply, store } = await ship(' M src/escaped.ts\n', ['src/theirs.ts'])
  assert.match(reply, /was NOT recorded/)
  assert.match(reply, /src\/escaped\.ts/, 'the worker is told WHICH path')
  assert.equal((await store.reports.list()).length, 0, 'and nothing was recorded')
  assert.equal(
    ((await store.workers.get('wrk-1')) as { pr?: unknown }).pr,
    undefined,
    'so the pull request is not bound and the board is not told it shipped',
  )
})

test('shipping is allowed when only the BASELINE paths are dirty', async () => {
  // The human's own work in progress must not block a worker.
  const { reply, store } = await ship(' M src/theirs.ts\n', ['src/theirs.ts'])
  assert.ok(!/was NOT recorded/.test(reply), reply)
  assert.equal((await store.reports.list()).length, 1, 'the report was recorded')
  assert.ok(((await store.workers.get('wrk-1')) as { pr?: { number?: number } }).pr?.number === 9, 'and bound')
})

test('with no shell available the report is still recorded', async () => {
  // A host that cannot shell out should record the report rather than refuse it.
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 'dsho-wrk-1', branch: 'b', worktreePath: '/r/.dsho/w',
    workspaceId: 'w', phase: WorkerPhase.shipping, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  const reply = await reportForTool(
    { store: lazyFactStore(async () => store), now: () => 50 } as never,
    { state: 'done' as never, outputs: [{ kind: 'pr_created' as never, ref: '9' }] },
    'dsho-wrk-1',
  )
  assert.ok(!/was NOT recorded/.test(reply), reply)
  assert.equal((await store.reports.list()).length, 1)
})

test('a report with no pull-request output is never gated by the check', async () => {
  // The check is about shipping. A progress report from a worker mid-task must not be
  // refused because the tree happens to be dirty.
  const store = createMemoryFactStore()
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-1', sessionId: 'dsho-wrk-1', branch: 'b', worktreePath: '/r/.dsho/w',
    workspaceId: 'w', phase: WorkerPhase.implementing, phaseHistory: [], rootDirtyAtStart: [],
    lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  const reply = await reportForTool(
    { store: lazyFactStore(async () => store), run: git(' M src/escaped.ts\n'), now: () => 50 } as never,
    { state: 'checkpoint' as never, note: 'still going' },
    'dsho-wrk-1',
  )
  assert.ok(!/was NOT recorded/.test(reply), reply)
  assert.equal((await store.reports.list()).length, 1)
})
