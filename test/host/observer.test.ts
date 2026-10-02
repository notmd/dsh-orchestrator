/**
 * The pull-request observer.
 *
 * Every test here is one side of R13: **a failed observation must never fabricate a
 * transition.** The dangerous failure is not "no data" — it is data that *looks
 * like* a state change, because an empty payload reads as `CLOSED` and a closed PR
 * archives a live worker.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveCiState,
  isBotAuthor,
  isTerminalPr,
  parsePrView,
  unfetchedSnapshot,
} from '../../src/domain/pr-snapshot.ts'
import type { PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import { changedFields, observeAll, observeWorker, snapshotKey } from '../../src/host/observer-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const NOW = 10_000_000

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    headRefOid: 'sha-1',
    headRefName: 'dsho/issue-1-x',
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Bot detection — R19
// ---------------------------------------------------------------------------

test('bot detection reads the provider type and NEVER the login', () => {
  // The tempting login.includes('bot') false-positives on robothon and lambot123,
  // silently dropping a HUMAN's review -- the worst direction, because the worker
  // then never hears about it.
  assert.equal(isBotAuthor({ __typename: 'Bot', login: 'anything' }), true)
  assert.equal(isBotAuthor({ type: 'Bot', login: 'robothon' }), true)
  assert.equal(isBotAuthor({ __typename: 'User', login: 'some-bot-named-human' }), false)
  assert.equal(isBotAuthor({ type: 'User', login: 'dependabot' }), false)
  assert.equal(isBotAuthor({ login: 'github-actions[bot]' }), undefined, 'no type means unknown, not bot')
})

test('an author the provider did not type is UNKNOWN, not human', () => {
  // Unknown is not "human": the caller decides, and the conservative direction is
  // to treat a review as actionable rather than drop it.
  assert.equal(isBotAuthor({ login: 'someone' }), undefined)
  assert.equal(isBotAuthor(undefined), undefined)
  assert.equal(isBotAuthor(null), undefined)
  assert.equal(isBotAuthor({ __typename: 'SomethingNew' }), undefined)
})

// ---------------------------------------------------------------------------
// CI derivation
// ---------------------------------------------------------------------------

test('a rollup with no checks is unknown, not passing', () => {
  // A repository with no CI must not be reported green, or a card would claim a
  // check that never ran.
  assert.equal(deriveCiState([]), 'unknown')
  assert.equal(deriveCiState(undefined), 'unknown')
  assert.equal(deriveCiState('nonsense'), 'unknown')
})

test('any failure wins over any pending, because the failure is the urgent fact', () => {
  assert.equal(deriveCiState([{ status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }]), 'failing')
  assert.equal(deriveCiState([{ conclusion: 'SUCCESS' }, { status: 'QUEUED' }]), 'pending')
  assert.equal(deriveCiState([{ conclusion: 'SUCCESS' }]), 'passing')
  for (const bad of ['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    assert.equal(deriveCiState([{ conclusion: bad }]), 'failing', bad)
  }
  assert.equal(deriveCiState([{ state: 'ERROR' }]), 'failing')
  assert.equal(deriveCiState([{ state: 'PENDING' }]), 'pending')
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a payload parses into facts, tolerating missing fields', () => {
  const snapshot = parsePrView(JSON.parse(payload()), NOW)
  assert.equal(snapshot.fetched, true)
  assert.equal(snapshot.number, 42)
  assert.equal(snapshot.state, 'OPEN')
  assert.equal(snapshot.headSha, 'sha-1')
  assert.equal(snapshot.observedAt, NOW)
  assert.equal(snapshot.ciState, 'unknown')
})

test('parsing never throws on a malformed payload', () => {
  // A provider that adds or omits a key must not take the observer down.
  for (const bad of [null, 5, 'text', [], {}, { reviews: 'nope', comments: 3 }]) {
    const snapshot = parsePrView(bad, NOW)
    assert.equal(snapshot.fetched, true)
    assert.deepEqual(snapshot.reviews, [])
    assert.deepEqual(snapshot.comments, [])
  }
})

test('the last comment id is the newest comment, for actionable-feedback detection', () => {
  const snapshot = parsePrView(
    JSON.parse(payload({ comments: [{ id: 'c1', author: { login: 'a' }, body: 'x' }, { id: 'c2', author: { login: 'b' }, body: 'y' }] })),
    NOW,
  )
  assert.equal(snapshot.lastCommentId, 'c2')
})

// ---------------------------------------------------------------------------
// R13 — the failure invariant
// ---------------------------------------------------------------------------

test('an unfetched snapshot carries the PRIOR facts, so a transition cannot be fabricated', () => {
  const prior = parsePrView(JSON.parse(payload({ state: 'OPEN' })), NOW - 1)
  const failed = unfetchedSnapshot(prior, 'rate-limited', NOW)
  assert.equal(failed.fetched, false)
  assert.equal(failed.state, 'OPEN', 'the prior state survives')
  assert.equal(failed.headSha, 'sha-1')
  assert.equal(failed.error, 'rate-limited')
  assert.equal(isTerminalPr(failed), false, 'an unfetched snapshot is never terminal')
})

test('a first observation that fails is never reported as terminal', () => {
  // The dangerous case: no prior, so an empty snapshot would read as CLOSED and
  // archive a live worker.
  const failed = unfetchedSnapshot(undefined, 'not-installed', NOW)
  assert.equal(failed.fetched, false)
  assert.notEqual(failed.state, 'CLOSED')
  assert.notEqual(failed.state, 'MERGED')
  assert.equal(isTerminalPr(failed), false)
})

test('a merged snapshot IS terminal, but only when it was fetched', () => {
  const merged = parsePrView(JSON.parse(payload({ state: 'MERGED' })), NOW)
  assert.equal(isTerminalPr(merged), true)
})

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

/** Whether an argv is the inline-comment request rather than the PR-facts one. */
function isReviewCommentsCall(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.endsWith('/comments'))
}

/** Whether an argv is the review-thread (GraphQL) request rather than the PR-facts one. */
function isReviewThreadsCall(argv: readonly string[]): boolean {
  return argv.includes('graphql')
}

/** Whether an argv is the recovery listing rather than a single-PR read. */
function isPrListCall(argv: readonly string[]): boolean {
  return argv[1] === 'pr' && argv[2] === 'list'
}

/**
 * A review-thread payload with one thread, in the shape `gh api graphql` returns.
 *
 * The nesting is the whole point of the parser test: a missing level must yield an empty
 * list rather than an exception, so the fixture states the real shape.
 */
function threadPayload(threads: Array<{ id: string; isResolved?: boolean; isOutdated?: boolean; databaseIds?: number[] }> = []): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((thread) => ({
              id: thread.id,
              isResolved: thread.isResolved === true,
              isOutdated: thread.isOutdated === true,
              comments: { nodes: (thread.databaseIds ?? []).map((databaseId) => ({ databaseId })) },
            })),
          },
        },
      },
    },
  })
}

async function observer(
  results: Array<Partial<CommandResult>>,
  comments = '[]',
  threads = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}',
) {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', owner: 'acme', name: 'widgets', rootPath: '/r' })
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
    branch: 'b',
    worktreePath: '/r/.dsho/worktrees/i1',
    workspaceId: 'w',
    phase: WorkerPhase.shipping,
    phaseHistory: [],
    pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42', headSha: 'sha-1' },
    lastSignalAt: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  let call = 0
  const calls: string[][] = []
  const run: RunCommand = async (argv) => {
    calls.push([...argv])
    // Observation is now THREE requests on a full refresh: the `gh pr view` facts, the
    // inline review comments, and the review threads. All three are routed by argv rather
    // than by position, so a test that queues results for the facts does not silently answer
    // a different call with a PR payload — and so adding a call cannot silently shift which
    // queued result lands where (which is exactly what happened when threads were added).
    if (isReviewCommentsCall(argv)) return { exitCode: 0, stdout: comments, stderr: '' }
    if (isReviewThreadsCall(argv)) return { exitCode: 0, stdout: threads, stderr: '' }
    if (isPrListCall(argv)) {
      const answer = results[Math.min(call, results.length - 1)] ?? { exitCode: 0, stdout: '[]' }
      call += 1
      return { exitCode: 0, stdout: '', stderr: '', ...answer }
    }
    const answer = results[Math.min(call, results.length - 1)] ?? { exitCode: 0, stdout: payload() }
    call += 1
    return { exitCode: 0, stdout: '', stderr: '', ...answer }
  }
  // A moveable clock: the cadence gate (finding G1) is a real behaviour now, so a test that
  // wants a second pass has to say that a tick has elapsed rather than assume it.
  let clock = NOW
  return {
    raw: store,
    calls,
    setNow(value: number) {
      clock = value
    },
    deps: { store: lazyFactStore(async () => store), run, now: () => clock },
  }
}

test('a successful observation records the facts and asks for the right PR', async () => {
  const { deps, raw, calls } = await observer([{ exitCode: 0, stdout: payload() }])
  const outcome = await observeAll(deps)
  assert.equal(outcome.observations.length, 1)
  assert.equal(outcome.observations[0]!.fetched, true)
  assert.equal(outcome.observations[0]!.changedFields[0], '(first observation)')

  const argv = calls[0]!
  assert.deepEqual(argv.slice(0, 5), ['gh', 'pr', 'view', '42', '--repo'])
  assert.equal(argv[5], 'acme/widgets', 'the repository is explicit, never inferred')
  const stored = (await raw.prSnapshots.get(snapshotKey('wrk-1'))) as PrSnapshot
  assert.equal(stored.state, 'OPEN')
})

test('a changed head is recorded on the worker, so the review loop keys on the right commit', async () => {
  const { deps, raw } = await observer([{ exitCode: 0, stdout: payload({ headRefOid: 'sha-2' }) }])
  await observeAll(deps)
  const worker = (await raw.workers.get('wrk-1')) as { pr?: { headSha: string } }
  assert.equal(worker.pr?.headSha, 'sha-2')
})

test('R13: a failed observation leaves the prior state intact', async () => {
  const { deps, raw, setNow } = await observer([
    { exitCode: 0, stdout: payload({ state: 'OPEN' }) },
    { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' },
  ])
  await observeAll(deps)
  // A tick has elapsed: the cadence gate defers a second pass at the same instant, which is
  // the whole point of having one.
  setNow(NOW + 60_000)
  const outcome = await observeAll(deps)

  assert.equal(outcome.observations.length, 1)
  assert.equal(outcome.observations[0]!.fetched, false)
  assert.equal(outcome.observations[0]!.error, 'rate-limited')
  assert.equal(outcome.observations[0]!.changed, false, 'a failure is not a change')

  const stored = (await raw.prSnapshots.get(snapshotKey('wrk-1'))) as PrSnapshot
  assert.equal(stored.state, 'OPEN', 'the prior state survives a rate limit')
  assert.equal(stored.fetched, false, 'and the flag says why')
  assert.equal(isTerminalPr(stored), false)
})

test('R13: a truncated payload is a failed observation, not a CLOSED PR', async () => {
  // Parsing half a JSON document is exactly what must not happen -- and a truncated
  // `gh pr view --json` is invalid JSON that looks like valid input.
  const { deps, raw } = await observer([{ exitCode: 0, stdout: '{"number":42,"sta', truncated: true }])
  const outcome = await observeAll(deps)
  assert.equal(outcome.observations[0]!.fetched, false)
  assert.equal(outcome.observations[0]!.error, 'unparseable')
  assert.notEqual(((await raw.prSnapshots.get(snapshotKey('wrk-1'))) as PrSnapshot).state, 'CLOSED')
})

test('a worker with no pull request is not OBSERVED — recovery is tried instead', async () => {
  // Finding G2 changed this from "skipped silently" to "one bounded recovery attempt": a
  // pull request the plugin was never told about used to be invisible forever.
  const { deps, raw, calls } = await observer([])
  const worker = (await raw.workers.get('wrk-1')) as Record<string, unknown>
  delete worker.pr
  await raw.workers.put('wrk-1', worker)
  const outcome = await observeAll(deps)

  assert.equal(outcome.observations.length, 0)
  assert.equal(outcome.skipped, 1)
  assert.equal(calls.length, 1, 'exactly one call: the recovery listing')
  assert.ok(isPrListCall(calls[0]!), 'and it is `gh pr list`, not a PR read')
  assert.ok(calls[0]!.includes('--head'), 'scoped to the worker\'s own branch')
  assert.ok(!calls.some((argv) => !isPrListCall(argv)), 'and nothing else was called')
})

test('an unknown repository is skipped rather than observed against nothing', async () => {
  const { deps, raw, calls } = await observer([])
  await raw.issues.put('iss-1', {
    id: 'iss-1',
    number: 1,
    repoId: 'gone',
    title: 'Fix it',
    state: 'in_progress',
    workerId: 'wrk-1',
    createdAt: 1,
    updatedAt: 1,
  })
  const outcome = await observeAll(deps)
  assert.equal(outcome.skipped, 1)
  assert.equal(calls.length, 0)
})

test('changedFields names what moved, and ignores what did not', () => {
  const prior = parsePrView(JSON.parse(payload()), NOW)
  const next = parsePrView(JSON.parse(payload({ state: 'MERGED', reviewDecision: 'APPROVED' })), NOW + 1)
  assert.deepEqual(changedFields(prior, next).sort(), ['reviewDecision', 'state'])
})

test('a store failure is contained, not thrown at the caller', async () => {
  const outcome = await observeAll({
    store: lazyFactStore(async () => {
      throw new Error('backend offline')
    }),
    run: (async () => ({ exitCode: 0, stdout: payload(), stderr: '' })) as RunCommand,
  })
  assert.deepEqual(outcome.observations, [])
})

// ---------------------------------------------------------------------------
// Inline review comments — the endpoint `gh pr view --json` does not expose
// ---------------------------------------------------------------------------

test('observation fetches inline review comments from their own endpoint', async () => {
  // The bug this closes: a person reviewing a diff clicks a line and types, and GitHub
  // files that as a review whose BODY is empty with the text on the inline comment. Reading
  // only `reviews[].body` meant every line comment was invisible -- the review looked like
  // it had nothing to say while the thing they said was on an endpoint nobody called.
  const { deps, calls } = await observer(
    [{ exitCode: 0, stdout: payload() }],
    JSON.stringify([
      {
        id: 1,
        node_id: 'PRRC_kwDOU3D4VM',
        pull_request_review_id: 5388068897,
        user: { login: 'notmd', type: 'User' },
        body: 'can you also remove this',
        path: 'README.md',
        line: 42,
        created_at: '2026-10-02T03:34:12Z',
      },
    ]),
  )
  const outcome = await observeAll(deps)

  assert.equal(outcome.observations[0]!.fetched, true)
  const snapshot = outcome.observations[0]!.snapshot
  assert.equal(snapshot.reviewComments?.length, 1, 'the inline comment is on the snapshot')
  const comment = snapshot.reviewComments![0]!
  assert.equal(comment.id, 'PRRC_kwDOU3D4VM', 'the node id, matching the id space reviews use')
  assert.equal(comment.reviewId, '5388068897', 'and the numeric parent review id, for exclusion')
  assert.equal(comment.body, 'can you also remove this')
  assert.equal(comment.path, 'README.md')
  assert.equal(comment.line, 42)
  assert.equal(comment.isBot, false, 'REST does supply the type marker')

  // Two requests, and the second one is the comments endpoint.
  assert.ok(
    calls.some((argv) => argv.some((arg) => arg.endsWith('/comments'))),
    'the inline comments were actually requested',
  )
})

test('R13: a failed inline-comment fetch is a failed observation, not "no comments"', async () => {
  // The direction matters. Treating the failure as an empty list would read as "the person
  // withdrew their comment" -- exactly the fabrication R13 forbids, and the one that
  // silently drops feedback a worker was supposed to act on.
  const { deps, raw } = await observer([{ exitCode: 0, stdout: payload({ state: 'OPEN' }) }])
  await observeAll(deps)
  assert.equal(((await raw.prSnapshots.get(snapshotKey('wrk-1'))) as PrSnapshot).fetched, true)

  const failing = await observer([{ exitCode: 0, stdout: payload() }], 'not json at all')
  const outcome = await observeAll(failing.deps)
  assert.equal(outcome.observations[0]!.fetched, false)
  assert.equal(outcome.observations[0]!.error, 'unparseable')
})

test('an outdated inline comment keeps the line it was written against', async () => {
  // GitHub drops `line` when the diff moves on but keeps `original_line`. The line they
  // commented on is more useful to the worker than no location at all.
  const { deps } = await observer(
    [{ exitCode: 0, stdout: payload() }],
    JSON.stringify([
      { node_id: 'c1', pull_request_review_id: 7, user: { login: 'a', type: 'User' }, body: 'x', path: 'a.ts', line: null, original_line: 12 },
      { node_id: 'c2', pull_request_review_id: 7, user: { login: 'a', type: 'User' }, body: 'y', path: 'b.ts' },
    ]),
  )
  const outcome = await observeAll(deps)
  const comments = outcome.observations[0]!.snapshot.reviewComments!
  assert.equal(comments[0]!.line, 12)
  assert.equal(comments[1]!.line, undefined, 'no line at all stays absent, not zero')
})
