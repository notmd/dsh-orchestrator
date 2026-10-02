/**
 * The observer's cost and recovery behaviour — findings G1, G2, G4 and G7.
 *
 * The teardown's G1 finding was that we re-fetch everything on every 30-second tick with no
 * cache, no `updatedAt` gate and no per-PR backoff: "2 billed `gh` calls per 30 s tick,
 * roughly 240/hour, always". `gh` offers no conditional-request path, so what can be removed
 * is the *unnecessary* work: a settled card's fast cadence, and a discussion refresh that runs
 * on its own interval instead of every tick.
 *
 * G2 was the missing half of the identity story: a pull request enters this system only through
 * the worker's own report, so a lost report used to hide a live PR forever.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import { parsePrView, resolvedCommentRestIds } from '../../src/domain/pr-snapshot.ts'
import { WorkerPhase, normalizeWorker } from '../../src/domain/workers.ts'
import type { Worker } from '../../src/domain/workers.ts'
import { createRateLimitCooldown } from '../../src/host/exec.ts'
import {
  OBSERVER_DEFAULTS,
  isSettledSnapshot,
  observationIntervalMs,
  observeAll,
  recoverWorkerPr,
  reviewSignature,
  shouldAttemptRecovery,
  shouldObserve,
  shouldRefreshReviewThreads,
  threadSignature,
} from '../../src/host/observer-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const NOW = 1_700_000_000_000

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return parsePrView(
    {
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      headRefOid: 'sha-1',
      reviews: [],
      comments: [],
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      ...overrides,
    },
    NOW,
  )
}

// ---------------------------------------------------------------------------
// G1 — the cadence
// ---------------------------------------------------------------------------

test('a settled card is polled slower, and a moving one is not', () => {
  // Settled: mergeable, approved, green, not a draft. Nothing about it changes except by a
  // person acting, so an extra minute to notice them is the right trade for the calls.
  assert.ok(isSettledSnapshot(snapshot()))
  assert.equal(observationIntervalMs(snapshot(), 30_000), 30_000 * OBSERVER_DEFAULTS.settledMultiplier)

  for (const unmoving of [
    snapshot({ reviewDecision: '' }),
    snapshot({ isDraft: true }),
    snapshot({ mergeable: 'UNKNOWN' }),
    snapshot({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
    snapshot({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }),
  ]) {
    assert.equal(isSettledSnapshot(unmoving), false, JSON.stringify({ m: unmoving.mergeable, r: unmoving.reviewDecision }))
    assert.equal(observationIntervalMs(unmoving, 30_000), 30_000)
  }
})

test('a landed pull request keeps the base cadence, so completion fires promptly', () => {
  // The slow path is for work waiting on a person, not for work that is finished and needs
  // collecting: an extra two minutes before a merged PR releases its issue and worktree is a
  // delay with nothing bought.
  const merged = snapshot({ state: 'MERGED' })
  assert.equal(observationIntervalMs(merged, 30_000), 30_000)
})

test('the tick is due only after the interval, and a failed fetch retries at once', () => {
  // A PR that is still moving: base cadence.
  const moving = { ...snapshot({ reviewDecision: '' }), observedAt: NOW }
  assert.equal(shouldObserve(moving, NOW, 30_000), false, 'the same instant is not a tick')
  assert.equal(shouldObserve(moving, NOW + 29_999, 30_000), false)
  assert.equal(shouldObserve(moving, NOW + 30_000, 30_000), true)
  assert.equal(shouldObserve(undefined, NOW, 30_000), true, 'never observed is always due')
  // A failure established no facts, so there is nothing to space out — the rate-limit
  // cooldown is what covers "the provider is refusing us".
  assert.equal(shouldObserve({ ...moving, fetched: false }, NOW, 30_000), true)

  // The settled shape is the same predicate with the wider interval it derives.
  const settled = { ...snapshot(), observedAt: NOW }
  assert.equal(shouldObserve(settled, NOW + 30_000, 30_000), false, 'settled: one tick is not enough')
  assert.equal(shouldObserve(settled, NOW + 120_000, 30_000), true)
})

test('the discussion refresh has its own interval, and re-reads when the reviews change', () => {
  const prior: PrSnapshot = { ...snapshot(), observedAt: NOW, reviewComments: [], reviewThreads: [], reviewThreadsAt: NOW }
  const unchanged: PrSnapshot = { ...prior, observedAt: NOW }
  assert.equal(shouldRefreshReviewThreads(prior, unchanged, NOW, 120_000), false, 'not yet due')
  assert.equal(shouldRefreshReviewThreads(prior, unchanged, NOW + 120_000, 120_000), true, 'now due')

  // A new review is what a thread hangs off, so it re-reads immediately.
  const newReview = parsePrView(
    { number: 42, state: 'OPEN', reviews: [{ id: 'R9', state: 'CHANGES_REQUESTED', author: { login: 'h', __typename: 'User' } }], comments: [] },
    NOW,
  )
  assert.equal(shouldRefreshReviewThreads(prior, { ...newReview, observedAt: NOW }, NOW, 120_000), true)

  // Never fetched before: fetch. This is what lets an existing record gain the resolution
  // state instead of being stuck without it forever.
  assert.equal(shouldRefreshReviewThreads({ ...prior, reviewThreads: undefined }, unchanged, NOW, 120_000), true)
  assert.equal(shouldRefreshReviewThreads(undefined, unchanged, NOW, 120_000), true)
})

test('a skipped discussion refresh CARRIES the lists forward rather than dropping them', async () => {
  const store = createMemoryFactStore()
  await seed(store)
  // The worker is bound to a PR: this test is about the discussion cadence, and an unbound
  // worker would take the recovery path instead.
  const worker = normalizeWorker(await store.workers.get('wrk-1'))
  await store.workers.put(
    'wrk-1',
    { ...worker, pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42', headSha: 'sha-1' } },
  )
  // Deliberately NOT the settled shape: a settled PR's own interval is four ticks, which is
  // longer than the discussion interval, and this test needs the PR read to be due while the
  // discussion refresh is not.
  await store.prSnapshots.put('wrk-1', {
    ...snapshot({ reviewDecision: '' }),
    observedAt: NOW - 1_000,
    reviewComments: [{ id: 'PRRC_1', restId: '1001', reviewId: '', author: 'h', body: 'look at this', path: 'a.ts', line: 3, createdAt: '', isBot: false }],
    reviewThreads: [{ id: 'T1', isResolved: false, isOutdated: false, commentRestIds: ['1001'] }],
    reviewThreadsAt: NOW - 1_000,
  } as never)

  const calls: string[][] = []
  const run: RunCommand = async (argv) => {
    calls.push([...argv])
    return { exitCode: 0, stdout: JSON.stringify({ number: 42, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: '', headRefOid: 'sha-1', reviews: [], comments: [], statusCheckRollup: [{ conclusion: 'SUCCESS' }] }), stderr: '' }
  }
  const outcome = await observeAll({
    store: lazyFactStore(async () => store),
    run,
    now: () => NOW + 31_000,
    intervalMs: 30_000,
  })

  const stored = (await store.prSnapshots.get('wrk-1')) as PrSnapshot
  assert.equal(outcome.observations.length, 1)
  assert.equal(calls.length, 1, 'only the PR read: the discussion was not due')
  assert.equal(stored.reviewComments?.length, 1, 'a person\'s comment does not flicker out of existence')
  assert.deepEqual(stored.reviewThreads?.[0]?.commentRestIds, ['1001'])
})

// ---------------------------------------------------------------------------
// G7 — the rate-limit back-off
// ---------------------------------------------------------------------------

test('a rate limit skips the whole pass, and a later success clears the cooldown', async () => {
  const cooldown = createRateLimitCooldown()
  const limited: CommandResult = { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded', }
  cooldown.record(limited, NOW)
  assert.equal(cooldown.clearsAt(NOW), NOW + 60_000, 'the default cooldown, since no hint was given')
  assert.equal(cooldown.clearsAt(NOW + 60_000), undefined, 'and it expires')

  // The provider's own hint wins when it gives one. GitHub's rate-limit body carries the
  // header dump, which is why the hint and the classification live in the same text.
  cooldown.record({ exitCode: 1, stdout: '', stderr: 'API rate limit exceeded. Retry-After: 5' }, NOW)
  assert.equal(cooldown.clearsAt(NOW), NOW + 5_000)

  const store = createMemoryFactStore()
  await seed(store)
  let calls = 0
  const deps = {
    store: lazyFactStore(async () => store),
    run: (async () => {
      calls += 1
      return { exitCode: 0, stdout: '{}', stderr: '' }
    }) as RunCommand,
    now: () => NOW,
    cooldown,
  }
  cooldown.record(limited, NOW)
  const outcome = await observeAll(deps)
  assert.equal(outcome.rateLimited, true)
  assert.equal(calls, 0, 'nothing was attempted while the credential is throttled')

  cooldown.record({ exitCode: 0, stdout: '', stderr: '' }, NOW)
  assert.equal(cooldown.clearsAt(NOW), undefined, 'a success proves the budget is usable again')
})

// ---------------------------------------------------------------------------
// G2 — recovery
// ---------------------------------------------------------------------------

test('recovery binds a pull request the plugin was never told about, and stamps the attempt', async () => {
  const store = createMemoryFactStore()
  await seed(store)
  const worker = normalizeWorker(await store.workers.get('wrk-1'))
  const argvSeen: string[][] = []
  const run: RunCommand = async (argv) => {
    argvSeen.push([...argv])
    return {
      exitCode: 0,
      stdout: JSON.stringify([{ number: 77, url: 'https://github.com/acme/widgets/pull/77', headRefOid: 'sha-77' }]),
      stderr: '',
    }
  }

  const bound = await recoverWorkerPr({ store: lazyFactStore(async () => store), run, now: () => NOW }, worker, 'acme/widgets')

  assert.equal(bound?.pr?.number, 77)
  assert.equal(bound?.pr?.headSha, 'sha-77')
  const argv = argvSeen[0]!
  assert.deepEqual(argv.slice(0, 3), ['gh', 'pr', 'list'])
  assert.ok(argv.includes('--head') && argv.includes('dsho/issue-1-x'), 'scoped to the worker\'s own branch')
  assert.ok(argv.includes('all'), 'including merged and closed, so a landed PR is not lost')
  const stored = normalizeWorker(await store.workers.get('wrk-1'))
  assert.equal(stored.pr?.number, 77, 'and it is durable')
  assert.equal(stored.prRecoveryAt, NOW)
})

test('recovery fails closed: two candidates is no attribution', async () => {
  const store = createMemoryFactStore()
  await seed(store)
  const worker = normalizeWorker(await store.workers.get('wrk-1'))
  const run: RunCommand = async () => ({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 77, url: 'u77', headRefOid: 'a' },
      { number: 78, url: 'u78', headRefOid: 'b' },
    ]),
    stderr: '',
  })

  const bound = await recoverWorkerPr({ store: lazyFactStore(async () => store), run, now: () => NOW }, worker, 'acme/widgets')
  assert.equal(bound, undefined, 'a wrong binding is worse than a missing one')
  assert.equal(normalizeWorker(await store.workers.get('wrk-1')).pr, undefined)
  // The attempt is recorded, so an ambiguous repository is not re-listed every tick.
  assert.equal(normalizeWorker(await store.workers.get('wrk-1')).prRecoveryAt, NOW)
})

test('recovery excludes a fork, whose head branch merely collides', async () => {
  const store = createMemoryFactStore()
  await seed(store)
  const worker = normalizeWorker(await store.workers.get('wrk-1'))
  const run: RunCommand = async () => ({
    exitCode: 0,
    stdout: JSON.stringify([{ number: 77, url: 'u77', headRefOid: 'a', isCrossRepository: true }]),
    stderr: '',
  })
  assert.equal(
    await recoverWorkerPr({ store: lazyFactStore(async () => store), run, now: () => NOW }, worker, 'acme/widgets'),
    undefined,
  )
})

test('recovery is spaced by its own, slower interval', () => {
  const worker = normalizeWorker({ id: 'w', branch: 'b', prRecoveryAt: NOW })
  assert.equal(shouldAttemptRecovery(worker, NOW, 120_000), false)
  assert.equal(shouldAttemptRecovery(worker, NOW + 120_000, 120_000), true)
  assert.equal(shouldAttemptRecovery(normalizeWorker({ id: 'w', branch: 'b' }), NOW, 120_000), true)
})

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

async function seed(store: ReturnType<typeof createMemoryFactStore>): Promise<void> {
  await store.repos.put('repo-1', { id: 'repo-1', owner: 'acme', name: 'widgets', rootPath: '/r' })
  await store.issues.put('iss-1', { id: 'iss-1', number: 1, repoId: 'repo-1', title: 'Fix it', state: 'in_progress' })
  await store.workers.put('wrk-1', {
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'dsho-wrk-1',
    branch: 'dsho/issue-1-x',
    worktreePath: '/r/.dsho/worktrees/i1',
    workspaceId: 'w',
    phase: WorkerPhase.shipping,
    phaseHistory: [],
    lastSignalAt: 1,
    createdAt: 1,
    updatedAt: 1,
  })
}

// ---------------------------------------------------------------------------
// The decision inputs behind the gates, asserted directly
// ---------------------------------------------------------------------------

test('the change signatures are what the gates compare', () => {
  // `reviewSignature` is the input to the discussion-refresh gate and `threadSignature` to the
  // board's changed-fields report. Both compare BY VALUE, so a shallow field comparison would
  // report every refresh as a change — the failure mode the gates exist to prevent.
  const base = parsePrView(
    { number: 42, state: 'OPEN', reviews: [{ id: 'R1', state: 'COMMENTED', author: { login: 'h', __typename: 'User' } }], comments: [{ id: 'c1', author: { login: 'h' }, body: 'x' }] },
    NOW,
  )
  assert.equal(reviewSignature(base), reviewSignature({ ...base }))

  const anotherReview = parsePrView(
    { number: 42, state: 'OPEN', reviews: [{ id: 'R2', state: 'CHANGES_REQUESTED', author: { login: 'h', __typename: 'User' } }], comments: [] },
    NOW,
  )
  assert.notEqual(reviewSignature(base), reviewSignature(anotherReview))

  const unresolved = { ...base, reviewThreads: [{ id: 'T1', isResolved: false, commentRestIds: ['1001'] }] }
  const resolved = { ...unresolved, reviewThreads: [{ id: 'T1', isResolved: true, commentRestIds: ['1001'] }] }
  assert.notEqual(threadSignature(unresolved), threadSignature(resolved), 'resolution is a board fact')
  assert.equal(threadSignature(resolved), threadSignature({ ...resolved, observedAt: NOW + 1 }), 'but a clock is not')
})

test('resolvedCommentRestIds reads the resolved threads and nothing else', () => {
  const ids = resolvedCommentRestIds({
    reviewThreads: [
      { id: 'T1', isResolved: true, commentRestIds: ['1', '2'] },
      { id: 'T2', isResolved: false, commentRestIds: ['3'] },
    ],
  })
  assert.deepEqual([...ids].sort(), ['1', '2'])
  // No thread list at all proves nothing, so nothing is skipped: the fail-open direction.
  assert.equal(resolvedCommentRestIds({}).size, 0)
})

// ---------------------------------------------------------------------------
// The decision inputs behind the gates, asserted directly
// ---------------------------------------------------------------------------

test('the change signatures are what the gates compare', () => {
  // `reviewSignature` is the discussion-refresh gate's input and `threadSignature` is the
  // board's changed-fields input. Both compare BY VALUE, so a shallow field comparison would
  // report every refresh as a change — the failure the gates exist to prevent.
  const base = parsePrView(
    {
      number: 42,
      state: 'OPEN',
      reviews: [{ id: 'R1', state: 'COMMENTED', author: { login: 'h', __typename: 'User' } }],
      comments: [{ id: 'c1', author: { login: 'h' }, body: 'x' }],
    },
    NOW,
  )
  assert.equal(reviewSignature(base), reviewSignature({ ...base }), 'a fresh object is not a change')

  const anotherReview = parsePrView(
    { number: 42, state: 'OPEN', reviews: [{ id: 'R2', state: 'CHANGES_REQUESTED', author: { login: 'h', __typename: 'User' } }], comments: [] },
    NOW,
  )
  assert.notEqual(reviewSignature(base), reviewSignature(anotherReview))

  const unresolved: PrSnapshot = { ...base, reviewThreads: [{ id: 'T1', isResolved: false, commentRestIds: ['1001'] }] }
  const resolved: PrSnapshot = { ...unresolved, reviewThreads: [{ id: 'T1', isResolved: true, commentRestIds: ['1001'] }] }
  assert.notEqual(threadSignature(unresolved), threadSignature(resolved), 'resolution is a board fact')
  assert.equal(threadSignature(resolved), threadSignature({ ...resolved, observedAt: NOW + 1 }), 'a clock is not')
})

test('resolvedCommentRestIds reads the resolved threads and nothing else', () => {
  const ids = resolvedCommentRestIds({
    reviewThreads: [
      { id: 'T1', isResolved: true, commentRestIds: ['1', '2'] },
      { id: 'T2', isResolved: false, commentRestIds: ['3'] },
    ],
  })
  assert.deepEqual([...ids].sort(), ['1', '2'])
  // No thread list at all proves nothing, so nothing is skipped: the fail-open direction.
  assert.equal(resolvedCommentRestIds({}).size, 0)
})
