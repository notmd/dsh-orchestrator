/**
 * The board assembly.
 *
 * Written after the module, and that gap is worth naming: the *lanes* were already
 * covered by the ported reducer tests, so what was unverified was the **joins** —
 * worker → issue → snapshot → runs → card. Assembly is where assumptions hide, which
 * is exactly the lesson the storage adapter and the worktree fakes taught.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBoard, buildCard, laneOf, renderBoard, toPrFacts } from '../../src/host/board-service.ts'
import { BOARD_ROUTE_PATH, createBoardRoute, handleBoardRequest } from '../../src/host/board-route.ts'
import { presentCard } from '../../src/board/presentation.ts'
import type { BoardDeps } from '../../src/host/board-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import { normalizeWorker } from '../../src/domain/workers.ts'
import { WorkerPhase } from '../../src/domain/workers.ts'
import { KanbanColumn, DisplayStatus } from '../../src/contract/kanban.ts'
import { SessionStatus } from '../../src/contract/status.ts'
import type { PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import type { ReviewRun } from '../../src/review/runs.ts'

const NOW = 10_000_000
const CONFIG = normalizePluginConfig()
const BOUNDS = { maxReviewRounds: 3, autoReviewFailedRetryLimit: 3 }

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    ciState: 'passing',
    headSha: 'sha-1',
    headRefName: 'dsho/issue-1-x',
    reviews: [],
    comments: [],
    lastCommentId: '',
    updatedAt: '2026-10-01T00:00:00Z',
    observedAt: NOW,
    fetched: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// toPrFacts — the snapshot join
// ---------------------------------------------------------------------------

test('the snapshot maps onto the reducer facts', () => {
  const [facts] = toPrFacts(snapshot(), [], BOUNDS)
  assert.equal(facts!.number, 42)
  assert.equal(facts!.merged, false)
  assert.equal(facts!.closed, false)
  assert.equal(facts!.draft, false)
  assert.equal(facts!.ci, 'passing')
  assert.equal(facts!.mergeability, 'mergeable', 'lower-cased for the reducer enum')
  assert.equal(facts!.updatedAt, Date.parse('2026-10-01T00:00:00Z'))
})

test('MERGED and CLOSED map onto the terminal facts', () => {
  assert.equal(toPrFacts(snapshot({ state: 'MERGED' }), [], BOUNDS)[0]!.merged, true)
  assert.equal(toPrFacts(snapshot({ state: 'CLOSED' }), [], BOUNDS)[0]!.closed, true)
})

test('an unknown CI state becomes the empty Go zero value, not a claim', () => {
  // `''` means "unknown" to the reducer. Passing `'unknown'` through would be a
  // value it does not recognise, and would read as neither passing nor failing.
  assert.equal(toPrFacts(snapshot({ ciState: 'unknown' }), [], BOUNDS)[0]!.ci, '')
})

test('OUR OWN provider reviews are excluded from the external facts by id', () => {
  // The aggregate reviewDecision mixes ours with a person's and cannot tell whose
  // turn it is, so our reviews are matched by id and removed. Row 3 and A17 depend
  // on this: a self-review must never count as a human approval.
  const mine: ReviewRun = {
    id: 'run-1',
    workerId: 'wrk-1',
    headSha: 'sha-1',
    status: 'complete',
    verdict: 'approved',
    githubReviewId: 'R-mine',
  }
  const reviews = [
    { id: 'R-mine', state: 'APPROVED' as const, author: 'bot', isBot: true },
    { id: 'R-human', state: 'APPROVED' as const, author: 'someone', isBot: false },
  ]
  const withOurs = toPrFacts(snapshot({ reviews }), [mine], BOUNDS)[0]!
  // Only the human's remains, so the external approval is real.
  assert.equal(withOurs.externalReview.approved, true)

  const onlyOurs = toPrFacts(snapshot({ reviews: [reviews[0]!] }), [mine], BOUNDS)[0]!
  assert.equal(onlyOurs.externalReview.approved, false, 'our own review never counts as human')
})

test('external changes-requested and comment-only reviews are distinguished', () => {
  const changes = toPrFacts(
    snapshot({ reviews: [{ id: 'R1', state: 'CHANGES_REQUESTED', author: 'h', isBot: false }] }),
    [],
    BOUNDS,
  )[0]!
  assert.equal(changes.externalReview.changesRequested, true)
  assert.equal(changes.externalReview.comments, false)

  const comments = toPrFacts(
    snapshot({ reviews: [{ id: 'R1', state: 'COMMENTED', author: 'h', isBot: false }] }),
    [],
    BOUNDS,
  )[0]!
  assert.equal(comments.externalReview.comments, true)
  assert.equal(comments.externalReview.changesRequested, false)
})

test('the review-run facts are head-scoped through the join', () => {
  const runs: ReviewRun[] = [
    { id: 'run-1', workerId: 'wrk-1', headSha: 'sha-1', status: 'complete', verdict: 'changes_requested', round: 1 },
    { id: 'run-0', workerId: 'wrk-1', headSha: 'sha-old', status: 'complete', verdict: 'approved' },
  ]
  const facts = toPrFacts(snapshot({ headSha: 'sha-1' }), runs, BOUNDS)[0]!
  assert.equal(facts.reviewRun.present, true)
  assert.equal(facts.reviewRun.changesRequested, true)
  assert.equal(facts.reviewRun.outcome, true)
  assert.equal(facts.reviewRun.roundBudgetExhausted, false)
})

test('no snapshot means no PR facts, so the card stays in Building', () => {
  assert.deepEqual(toPrFacts(undefined, [], BOUNDS), [])
})

// ---------------------------------------------------------------------------
// buildCard — the worker join
// ---------------------------------------------------------------------------

function worker(overrides: Record<string, unknown> = {}) {
  return normalizeWorker({
    id: 'wrk-1',
    issueId: 'iss-1',
    sessionId: 'dsho-wrk-1',
    branch: 'dsho/issue-1-x',
    worktreePath: '/r/.dsho/worktrees/i1',
    workspaceId: 'w',
    phase: WorkerPhase.implementing,
    phaseHistory: [],
    lastSignalAt: NOW - 1_000,
    createdAt: 1,
    updatedAt: NOW - 500,
    ...overrides,
  })
}

test('the card title is `#<n> <title>`, which is what A2 asks for', () => {
  const card = buildCard({
    worker: worker(),
    issueTitle: 'Fix the flaky auth test',
    issueNumber: 3,
    prs: [],
    activity: 'idle',
    config: CONFIG,
    now: NOW,
  })
  assert.equal(card.title, '#3 Fix the flaky auth test')
  assert.equal(card.id, 'wrk-1')
  assert.equal(card.sessionId, 'dsho-wrk-1')
  assert.equal(card.updatedAt, NOW - 500)
})

test('the card status is the SESSION status, which is not the lane status', () => {
  // The lane describes the BEST landing; the session status aggregates the WORST
  // open PR. A30's finished gate reads this one, and the reference's #5081 bug was
  // exactly this confusion.
  const card = buildCard({
    worker: worker(),
    issueTitle: 'Fix it',
    issueNumber: 1,
    prs: [
      { url: 'pr/1', merged: true },
      { url: 'pr/2', ci: 'failing' },
    ],
    activity: 'idle',
    config: CONFIG,
    now: NOW,
  })
  assert.equal(card.status, SessionStatus.ciFailed, 'the worst open PR speaks for the session')
})

test('an unknown activity is not rendered as idle or working', () => {
  const card = buildCard({
    worker: worker(),
    issueTitle: 'Fix it',
    issueNumber: 1,
    prs: [],
    activity: 'unknown',
    config: CONFIG,
    now: NOW,
  })
  assert.equal(card.activity, 'unknown')
  const view = buildBoardCardView(card)
  assert.equal(view.column, KanbanColumn.building)
  assert.notEqual(view.displayStatus, DisplayStatus.working)
})

/** Presents one card through the same function the board uses. */
function buildBoardCardView(card: ReturnType<typeof buildCard>) {
  return presentCard(card, { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs })
}

// ---------------------------------------------------------------------------
// buildBoard — the whole assembly
// ---------------------------------------------------------------------------

async function board(workers: Array<Record<string, unknown>>, options: { snapshot?: Partial<PrSnapshot>; runs?: ReviewRun[] } = {}) {
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', { id: 'repo-1', owner: 'acme', name: 'widgets', rootPath: '/r' })
  for (const [index, entry] of workers.entries()) {
    await store.issues.put(`iss-${index}`, {
      id: `iss-${index}`,
      number: index + 1,
      repoId: 'repo-1',
      title: `Task ${index + 1}`,
      state: 'in_progress',
      workerId: String(entry.id),
      sourceSessionId: 'session-1',
      createdAt: 1,
      updatedAt: 1,
    })
    await store.workers.put(String(entry.id), { ...entry, issueId: `iss-${index}` })
    if (options.snapshot) {
      await store.prSnapshots.put(String(entry.id), snapshot(options.snapshot))
    }
  }
  for (const [index, run] of (options.runs ?? []).entries()) {
    await store.reviewRuns.put(run.id ?? `run-${index}`, run)
  }
  const deps: BoardDeps = { store: lazyFactStore(async () => store), config: CONFIG, now: () => NOW }
  return { raw: store, deps }
}

test('a worker with no PR lands in building, and the lane count reflects it', async () => {
  const { deps } = await board([{ id: 'wrk-1', sessionId: 'dsho-wrk-1', updatedAt: 5, lastSignalAt: NOW - 1 }])
  const snapshotResult = await buildBoard(deps)
  assert.equal(snapshotResult.counts.total, 1)
  assert.equal(snapshotResult.counts.byLane[KanbanColumn.building], 1)
  assert.equal(snapshotResult.lenses.lanes[KanbanColumn.building]![0]!.title, '#1 Task 1')
})

test('a worker with an unreviewed PR lands in validating with a scheduled review', async () => {
  const { deps } = await board(
    [{ id: 'wrk-1', sessionId: 'dsho-wrk-1', updatedAt: 5, lastSignalAt: NOW - 1, pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42', headSha: 'sha-1' } }],
    { snapshot: {} },
  )
  const result = await buildBoard(deps)
  const card = result.lenses.lanes[KanbanColumn.validating]![0]!
  assert.equal(card.column, KanbanColumn.validating)
  assert.equal(card.displayStatus, DisplayStatus.reviewScheduled)
})

test('the board is one snapshot with no per-card fan-out', async () => {
  const { deps } = await board([
    { id: 'wrk-1', sessionId: 's1', updatedAt: 2, lastSignalAt: NOW - 1 },
    { id: 'wrk-2', sessionId: 's2', updatedAt: 3, lastSignalAt: NOW - 1 },
  ])
  const result = await buildBoard(deps)
  assert.equal(result.counts.total, 2)
  assert.equal(result.generatedAt, NOW)
})

test('a lane orders a needs-attention card above a fresher quiet one', async () => {
  // R22: attention floats to the top of its lane, whatever the timestamps say.
  const { deps } = await board([
    { id: 'wrk-quiet', sessionId: 's1', updatedAt: NOW, lastSignalAt: NOW - 1 },
    { id: 'wrk-stuck', sessionId: 's2', updatedAt: 1, phase: WorkerPhase.awaitingHuman, phaseHistory: [], lastSignalAt: NOW - 1 },
  ])
  deps.activityOf = (workerId: string) => (workerId === 'wrk-stuck' ? 'blocked' : 'idle')
  const result = await buildBoard(deps)
  const building = result.lenses.lanes[KanbanColumn.building]!
  assert.equal(building[0]!.id, 'wrk-stuck', 'the blocked worker is first despite being older')
  assert.equal(building[0]!.needsAttention, true)
})

test('an unknown activity falls back honestly rather than claiming idle', async () => {
  const { deps } = await board([{ id: 'wrk-1', sessionId: 's1', updatedAt: 1, lastSignalAt: NOW - 1 }])
  // No `activityOf` at all, which is the after-restart case.
  const result = await buildBoard({ store: deps.store, config: CONFIG, now: () => NOW })
  assert.equal(result.lenses.lanes[KanbanColumn.building]![0]!.displayStatus, DisplayStatus.awaitingPr)
})

test('renderBoard marks attention and names the escalation reason', async () => {
  const { deps } = await board([
    { id: 'wrk-1', sessionId: 's1', updatedAt: 1, lastSignalAt: NOW - 1, pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42', headSha: 'sha-1' } },
  ], {
    snapshot: { mergeable: 'MERGEABLE', reviews: [{ id: 'R1', state: 'CHANGES_REQUESTED', author: 'h', isBot: false }] },
    runs: [
      { id: 'r1', workerId: 'wrk-1', headSha: 'sha-1', round: 1, status: 'complete', verdict: 'changes_requested' },
      { id: 'r2', workerId: 'wrk-1', headSha: 'sha-old', round: 2, status: 'complete', verdict: 'changes_requested' },
      { id: 'r3', workerId: 'wrk-1', headSha: 'sha-2', round: 3, status: 'complete', verdict: 'changes_requested' },
    ],
  })
  deps.activityOf = () => 'blocked'
  const text = renderBoard(await buildBoard(deps))
  assert.match(text, /Board — 1 worker/)
  assert.match(text, /needing attention/)
  assert.match(text, /! wrk-1/)
  // A spent round budget on a PR whose only human review asked for changes is
  // released from Validating to `needs_review`, and the reason is on the card.
  assert.match(text, /needs_review \(1\)/)
  assert.match(text, /\[review-round-limit\]/)
  assert.match(text, /ready \(0\)/, 'every lane is listed, even empty ones')
})

test('laneOf finds a card, including in the archive sheet', async () => {
  const { deps } = await board([{ id: 'wrk-1', sessionId: 's1', updatedAt: 1, lastSignalAt: NOW - 1 }])
  const result = await buildBoard(deps)
  assert.equal(laneOf(result, 'wrk-1'), KanbanColumn.building)
  assert.equal(laneOf(result, 'nope'), undefined)
})

test('every lane is present even when empty, so the client never renders an undefined lane', async () => {
  const { deps } = await board([])
  const result = await buildBoard(deps)
  for (const lane of [KanbanColumn.building, KanbanColumn.validating, KanbanColumn.needsReview, KanbanColumn.ready]) {
    assert.deepEqual(result.lenses.lanes[lane], [])
    assert.equal(result.counts.byLane[lane], 0)
  }
  assert.deepEqual(result.lenses.archive, [])
})


// ---------------------------------------------------------------------------
// The read endpoint
// ---------------------------------------------------------------------------

/** A response that records what was written. */
function fakeResponse() {
  const record: { status?: number; headers?: Record<string, string>; body?: string } = {}
  return {
    record,
    writeHead(status: number, headers?: Record<string, string>) {
      record.status = status
      record.headers = headers
    },
    end(body?: string) {
      record.body = body
    },
  }
}

test('the route is an exact path the client can hard-code', () => {
  const route = createBoardRoute({
    store: lazyFactStore(async () => createMemoryFactStore()),
    config: CONFIG,
  })
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/dsho/api/board')
  assert.equal(route.path, BOARD_ROUTE_PATH)
})

test('a successful read answers 200 with the snapshot and no caching', async () => {
  // A cached board is a stale board, which is the one thing this endpoint must
  // never serve.
  const { deps } = await board([{ id: 'wrk-1', sessionId: 's1', updatedAt: 1, lastSignalAt: NOW - 1 }])
  const response = fakeResponse()
  await handleBoardRequest(deps, response)

  assert.equal(response.record.status, 200)
  assert.match(response.record.headers?.['content-type'] ?? '', /application\/json/)
  assert.equal(response.record.headers?.['cache-control'], 'no-store')
  const body = JSON.parse(response.record.body ?? '{}') as { counts: { total: number } }
  assert.equal(body.counts.total, 1)
  assert.equal(
    Number(response.record.headers?.['content-length']),
    Buffer.byteLength(response.record.body ?? ''),
    'the length is the byte length, not the character count',
  )
})

test('a storage failure answers 500 explicitly, not a 400 from a throw', async () => {
  // The web server answers a THROWING handler with 400 -- but a storage failure is
  // not a bad request, and a lie there leaves the client guessing. Answering
  // explicitly is what lets it show an error state rather than an empty board.
  const response = fakeResponse()
  await handleBoardRequest(
    {
      store: lazyFactStore(async () => {
        throw new Error('backend offline')
      }),
      config: CONFIG,
    },
    response,
  )

  assert.equal(response.record.status, 500)
  const body = JSON.parse(response.record.body ?? '{}') as { error: string; message: string }
  assert.equal(body.error, 'board-unavailable')
  assert.match(body.message, /backend offline/)
})

test('the handler never throws, whatever the store does', async () => {
  const response = fakeResponse()
  await assert.doesNotReject(() =>
    handleBoardRequest(
      {
        store: lazyFactStore(async () => {
          throw new Error('boom')
        }),
        config: CONFIG,
      },
      response,
    ),
  )
})
