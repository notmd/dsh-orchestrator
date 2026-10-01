/**
 * The human feedback loop (M4).
 *
 * Three rules carry the weight, and each has a test that would fail if it were
 * dropped:
 *
 *   route a person's review ONCE -- without dedup the worker is nudged every poll
 *   for one comment, which reads as a broken loop and burns its context;
 *   never route OUR OWN review back -- an untyped author counts as human, because
 *   being redundantly told about our own finding is merely wasteful while dropping a
 *   person's review is the failure the PRD cares about;
 *   bound the nudges per COMMIT -- a new head gets a fresh budget, so a worker that
 *   fixed what it was told to fix is not silenced by an old count.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { actionableFeedback, renderFeedback, routeHumanFeedback, sweepHumanFeedback } from '../../src/host/feedback-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { createLiveWorkers } from '../../src/host/handle-registry.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import { WorkerPhase, normalizeWorker } from '../../src/domain/workers.ts'
import type { PrSnapshot, PrReview } from '../../src/domain/pr-snapshot.ts'

const NOW = 10_000_000
const HEAD = 'sha-1'

function review(id: string, state: PrReview['state'], extra: Partial<PrReview> = {}): PrReview {
  return { id, state, author: 'a-person', isBot: false, ...extra }
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: 'pr/7', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: '', ciState: 'passing', headSha: HEAD,
    headRefName: 'b', reviews: [], comments: [], lastCommentId: '', updatedAt: '',
    observedAt: NOW, fetched: true, ...overrides,
  } as PrSnapshot
}

// ---------------------------------------------------------------------------
// What counts as actionable
// ---------------------------------------------------------------------------

test('a CHANGES_REQUESTED review and a written comment are actionable; approval is not', () => {
  const items = actionableFeedback(
    snapshot({
      reviews: [
        review('r1', 'CHANGES_REQUESTED', { body: 'this drops the token' }),
        review('r2', 'APPROVED'),
        review('r3', 'COMMENTED', { body: 'worth a look' }),
        review('r4', 'COMMENTED', { body: '   ' }),
        review('r5', 'DISMISSED', { body: 'x' }),
      ],
    }),
    [],
  )
  assert.deepEqual(items.map((item) => item.id), ['r1', 'r3'], 'an empty comment is not actionable')
  assert.equal(items[0]!.kind, 'changes_requested')
  assert.equal(items[1]!.kind, 'comment')
})

test("our own review is not routed back, by author type -- never by login", () => {
  const items = actionableFeedback(
    snapshot({
      reviews: [
        { id: 'ours', state: 'CHANGES_REQUESTED', author: 'dependabot', isBot: true },
        { id: 'theirs', state: 'CHANGES_REQUESTED', author: 'robothon', isBot: false },
      ],
    }),
    [],
  )
  assert.deepEqual(items.map((item) => item.id), ['theirs'], 'a human whose name contains "bot" is still human')
})

test('an UNTYPED author counts as human', () => {
  // The provider did not say. Routing our own finding again is wasteful; dropping a
  // person's review is the failure the PRD cares about. So the doubt resolves human.
  const items = actionableFeedback(
    snapshot({ reviews: [{ id: 'r1', state: 'CHANGES_REQUESTED', author: 'someone', isBot: undefined }] }),
    [],
  )
  assert.equal(items.length, 1)
})

test('an already-routed review is not actionable again', () => {
  // Without this the worker is nudged on EVERY poll for one comment.
  const snap = snapshot({ reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' })] })
  assert.equal(actionableFeedback(snap, []).length, 1)
  assert.equal(actionableFeedback(snap, ['r1']).length, 0)
})

test('the message names the author and quotes what they asked for', () => {
  const worker = normalizeWorker({ id: 'w', issueId: 'i', sessionId: 's', branch: 'dsho/issue-7', worktreePath: '/p', workspaceId: 'ws', phase: WorkerPhase.implementing, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1 })
  const text = renderFeedback(worker, [{ id: 'r1', kind: 'changes_requested', author: 'a-person', body: 'this drops the token' }], 'pr/7')
  assert.match(text, /A person requested changes/, 'the worker learns a person, not the plugin, asked')
  assert.match(text, /a-person requested changes/)
  assert.match(text, /this drops the token/, 'the worker needs to know WHAT to fix')
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function feedbackFixture(options: { withHandle?: boolean; maxNudge?: number } = {}) {
  const store = createMemoryFactStore()
  await store.workers.put('w', {
    id: 'w', issueId: 'i', sessionId: 's', branch: 'dsho/issue-7', worktreePath: '/p', workspaceId: 'ws',
    phase: WorkerPhase.addressingFeedback, phaseHistory: [], lastSignalAt: 1, createdAt: 1, updatedAt: 1,
  })
  const live = createLiveWorkers()
  const sent: string[] = []
  if (options.withHandle !== false) {
    live.register({
      workerId: 'w', sessionId: 's',
      handle: { agent: { session: { id: 's' }, status: 'idle', followup: (m: unknown) => { sent.push(JSON.stringify(m)) } }, async dispose() {} },
    })
  }
  return {
    store, live, sent,
    deps: {
      store: lazyFactStore(async () => store),
      config: normalizePluginConfig({ reviewMaxNudge: options.maxNudge ?? 3 }),
      live,
      now: () => NOW,
    },
  }
}

test('a human review is routed once, and recorded so it is not routed again', async () => {
  const { store, deps, sent } = await feedbackFixture()
  const worker = normalizeWorker(await store.workers.get('w'))
  const snap = snapshot({ reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'fix this' })] })

  const first = await routeHumanFeedback(deps, worker, snap)
  assert.equal(first.routed, 1)
  assert.equal(first.reason, 'changes_requested')
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /fix this/)

  const after = normalizeWorker(await store.workers.get('w'))
  assert.deepEqual(after.feedback?.routedIds, ['r1'])
  assert.equal(after.feedback?.nudgedAtHead, 1)
  assert.equal(after.feedback?.headSha, HEAD, 'the count belongs to this commit')

  const second = await routeHumanFeedback(deps, after, snap)
  assert.equal(second.routed, 0, 'and the second poll sends nothing')
  assert.equal(second.reason, 'nothing-new')
  assert.equal(sent.length, 1)
})

test('the nudge cap stops the loop and SAYS SO', async () => {
  // A loop that quietly gives up is indistinguishable from one that is working.
  const { store, deps, sent } = await feedbackFixture({ maxNudge: 1 })
  const worker = normalizeWorker(await store.workers.get('w'))
  await routeHumanFeedback(deps, worker, snapshot({ reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' })] }))
  assert.equal(sent.length, 1)

  const capped = await routeHumanFeedback(
    deps,
    normalizeWorker(await store.workers.get('w')),
    snapshot({ reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' }), review('r2', 'CHANGES_REQUESTED', { body: 'y' })] }),
  )
  assert.equal(capped.capped, true)
  assert.equal(capped.reason, 'nudge-limit')
  assert.equal(sent.length, 1, 'nothing more was sent')
})

test('a NEW head gets a fresh budget, so a worker that complied is not silenced', async () => {
  const { store, deps, sent } = await feedbackFixture({ maxNudge: 1 })
  await routeHumanFeedback(deps, normalizeWorker(await store.workers.get('w')), snapshot({ reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' })] }))
  assert.equal(sent.length, 1)

  // The worker pushed. Same review id, new commit -- the count resets.
  const pushed = snapshot({ headSha: 'sha-2', reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' })] })
  const outcome = await routeHumanFeedback(deps, normalizeWorker(await store.workers.get('w')), pushed)
  assert.equal(outcome.routed, 1, 'the cap was per commit, not per worker')
  assert.equal(sent.length, 2)
})

test('R13: an unfetched observation routes nothing', async () => {
  // An empty review list on a failed fetch must never read as "the objection was
  // withdrawn" -- and must never read as "there is new feedback" either.
  const { deps, store, sent } = await feedbackFixture()
  const worker = normalizeWorker(await store.workers.get('w'))
  const outcome = await routeHumanFeedback(deps, worker, snapshot({ fetched: false, reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' })] }))
  assert.equal(outcome.routed, 0)
  assert.equal(outcome.reason, 'no-observation')
  assert.equal(sent.length, 0)
})

test('no snapshot at all routes nothing', async () => {
  const { deps, store } = await feedbackFixture()
  assert.equal((await routeHumanFeedback(deps, normalizeWorker(await store.workers.get('w')), undefined)).reason, 'no-observation')
})

test('with no live handle, nothing is sent AND nothing is recorded', async () => {
  // Recording it would lose the feedback for a worker whose session is momentarily
  // absent, and the person's review would never reach them.
  const { store, deps, sent } = await feedbackFixture({ withHandle: false })
  const outcome = await routeHumanFeedback(
    deps, normalizeWorker(await store.workers.get('w')),
    snapshot({ reviews: [review('r1', 'CHANGES_REQUESTED', { body: 'x' })] }),
  )
  assert.equal(outcome.routed, 0)
  assert.equal(outcome.reason, 'no-live-handle')
  assert.equal(sent.length, 0)
  assert.equal((await store.workers.get('w') as { feedback?: unknown }).feedback, undefined, 'so it is retried later')
})

test('the sweep contains a failure and reports only what it routed', async () => {
  const outcomes = await sweepHumanFeedback({
    store: lazyFactStore(async () => { throw new Error('offline') }),
    config: normalizePluginConfig(),
  })
  assert.deepEqual(outcomes, [])
})
