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

import { buildBoard, buildCard, cardActivity, laneOf, renderBoard, reviewEvidence, reviewerEvidence, toPrFacts } from '../../src/host/board-service.ts'
import { BOARD_ROUTE_PATH, createBoardRoute, handleBoardRequest } from '../../src/host/board-route.ts'
import { presentCard } from '../../src/board/presentation.ts'
import type { BoardDeps } from '../../src/host/board-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { snapshotKey } from '../../src/host/observer-service.ts'
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
  // The gate is ON for this case on purpose: the round-limit release it asserts is itself
  // gated on `requireHumanApprovalBeforeReady`, so with the shipped default (off — the user's
  // decision) a halted loop lands in Ready, not here. Asking for the gate keeps the test
  // about the release row instead of about the default.
  deps.config = { ...deps.config, requireHumanApprovalBeforeReady: true }
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


test('the board reads the snapshot the way the OBSERVER writes it', () => {
  // The bug this guards: the observer writes under `snapshotKey(workerId)` and the
  // board used to look up by matching `url`. Those disagree as soon as a worker's
  // `pr.url` differs from the snapshot's url -- which is the normal case, since one
  // is set by the worker's report and the other by the provider. A real pull request
  // then never moved a card, silently, with both halves individually green.
  //
  // A live end-to-end run found it. Neither unit test could: each side agreed with
  // itself.
  const workerUrl = 'https://github.com/acme/widgets/pull/42'
  const providerUrl = 'https://github.com/acme/widgets/pull/42?diff=split'
  assert.notEqual(workerUrl, providerUrl, 'the two urls must differ for this to test anything')

  return (async () => {
    const store = createMemoryFactStore()
    await store.issues.put('iss-0', {
      id: 'iss-0', number: 1, repoId: 'repo-1', title: 'Task', state: 'in_progress', workerId: 'wrk-1',
      createdAt: 1, updatedAt: 1,
    })
    await store.workers.put('wrk-1', {
      id: 'wrk-1', issueId: 'iss-0', sessionId: 's1', branch: 'b', worktreePath: '/p', workspaceId: 'w',
      phase: 'shipping', phaseHistory: [], lastSignalAt: NOW - 1, createdAt: 1, updatedAt: 1,
      pr: { number: 42, url: workerUrl, headSha: 'sha-1' },
    })
    // Exactly how `observeWorker` stores it.
    await store.prSnapshots.put(snapshotKey('wrk-1'), snapshot({ url: providerUrl }))

    const board = await buildBoard({
      store: lazyFactStore(async () => store),
      config: CONFIG,
      now: () => NOW,
      activityOf: () => 'idle',
    })
    assert.equal(board.counts.byLane[KanbanColumn.building], 0, 'the PR is seen')
    assert.equal(board.counts.byLane[KanbanColumn.validating], 1)
    assert.equal(board.lenses.lanes[KanbanColumn.validating]![0]!.displayStatus, DisplayStatus.reviewScheduled)
  })()
})


// ---------------------------------------------------------------------------
// Review evidence for the inspector (§11.2)
// ---------------------------------------------------------------------------

test('review evidence is head-scoped, like everything else about reviews', () => {
  // An earlier head's findings are history. Showing them as if they applied to the
  // commit under review is the confusion head-scoping exists to prevent.
  const runs: ReviewRun[] = [
    { id: 'r1', workerId: 'wrk-1', headSha: 'sha-old', round: 1, status: 'complete', verdict: 'changes_requested',
      findings: [{ severity: 'high', summary: 'old finding', detail: 'stale' }] },
    { id: 'r2', workerId: 'wrk-1', headSha: 'sha-new', round: 2, status: 'complete', verdict: 'approved' },
  ]
  const evidence = reviewEvidence(runs, 'sha-new', 3)!
  assert.deepEqual(evidence.findings, [], 'the old head\'s findings are not carried forward')

  const older = reviewEvidence(runs, 'sha-old', 3)!
  assert.equal(older.findings[0]!.summary, 'old finding', 'and they are still visible at the head they belong to')
})

test('no pass at this head means no review evidence at all', () => {
  assert.equal(reviewEvidence([], 'sha-1', 3), undefined)
  assert.equal(reviewEvidence([{ id: 'r', workerId: 'w', headSha: 'sha-other', status: 'complete' }], 'sha-1', 3), undefined)
  assert.equal(reviewEvidence([{ id: 'r', workerId: 'w', headSha: 'sha-1', status: 'running' }], '', 3), undefined,
    'a worker with no head has nothing to show')
})

test('the round and the bound both travel, so the limit is visible before it trips', () => {
  // The PRD asks for `round/maxReviewRounds` on the card so the bound is visible
  // rather than surprising when it trips.
  const runs: ReviewRun[] = [
    { id: 'r1', workerId: 'w', headSha: 'a', status: 'complete', verdict: 'changes_requested' },
    { id: 'r2', workerId: 'w', headSha: 'b', status: 'complete', verdict: 'changes_requested' },
    { id: 'r3', workerId: 'w', headSha: 'sha-now', status: 'running' },
  ]
  const evidence = reviewEvidence(runs, 'sha-now', 3)!
  assert.equal(evidence.round, 3, 'a RUNNING pass is the one in progress, so cycles + 1')
  assert.equal(evidence.maxRounds, 3)
})

test('a COMPLETE pass shows its own round, not the next one', () => {
  // Seen live: a card displayed `auto review round 3/3` -- budget spent -- while the
  // lane below it correctly said `Needs review`. The completed run was round 2, and
  // cycles+1 invented a third round that had not started. The PRD wants the bound
  // visible so it is not surprising when it trips; a bound that reads as tripped when
  // it has not is the same problem inverted.
  const runs: ReviewRun[] = [
    { id: 'r1', workerId: 'w', headSha: 'a', round: 1, status: 'complete', verdict: 'changes_requested' },
    { id: 'r2', workerId: 'w', headSha: 'sha-1', round: 2, status: 'complete', verdict: 'changes_requested' },
  ]
  const evidence = reviewEvidence(runs, 'sha-1', 3)!
  assert.equal(evidence.round, 2, 'the pass that actually ran')
  assert.notEqual(evidence.round, evidence.maxRounds, 'and it does not read as exhausted')

  const failed: ReviewRun[] = [
    { id: 'r1', workerId: 'w', headSha: 'sha-1', round: 1, status: 'failed' },
  ]
  assert.equal(reviewEvidence(failed, 'sha-1', 3)!.round, 1, 'a failed pass is still its own round')
})

test('findings carry severity, file and line, which is what makes them inspectable', () => {
  const runs: ReviewRun[] = [
    { id: 'r1', workerId: 'w', headSha: 'sha-1', status: 'complete', verdict: 'changes_requested',
      githubReviewId: 'PRR_9',
      findings: [{ severity: 'medium', path: 'src/a.ts', line: 12, summary: 'off by one', detail: 'the loop runs once too far' }] },
  ]
  const evidence = reviewEvidence(runs, 'sha-1', 3)!
  assert.equal(evidence.verdict, 'changes_requested')
  assert.equal(evidence.githubReviewId, 'PRR_9', 'the review id is how the user finds it on the provider')
  assert.deepEqual(evidence.findings, [
    { severity: 'medium', path: 'src/a.ts', line: 12, summary: 'off by one', detail: 'the loop runs once too far' },
  ])
})

test('the presented view carries the review evidence through', () => {
  const card = buildCard({
    worker: worker(),
    issueTitle: 'Fix it',
    issueNumber: 1,
    prs: [{ url: 'pr/1', reviewRun: { present: true, changesRequested: true, outcome: true, roundBudgetExhausted: false } }],
    review: { round: 2, maxRounds: 3, verdict: 'changes_requested', findings: [{ severity: 'low', summary: 's', detail: 'd' }] },
    activity: 'idle',
    config: CONFIG,
    now: NOW,
  })
  const view = presentCard(card, { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs })
  assert.equal(view.review?.round, 2)
  assert.equal(view.review?.maxRounds, 3)
  assert.equal(view.review?.findings.length, 1)
})

test('a card with no review omits the field rather than inventing one', () => {
  const card = buildCard({
    worker: worker(), issueTitle: 'Fix it', issueNumber: 1, prs: [], activity: 'idle', config: CONFIG, now: NOW,
  })
  const view = presentCard(card, { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs })
  assert.equal(view.review, undefined)
})


// ---------------------------------------------------------------------------
// R9 / R20 — the protocol's blockage is primary, not inferred
// ---------------------------------------------------------------------------

test('the card reads the protocol\'s blockage, not the live status', () => {
  const blocked = worker({ pendingQuestion: { id: 'q1', text: 'which branch?', at: 1 } })
  assert.equal(cardActivity(blocked, () => 'idle'), 'waiting_input', 'the question outranks an idle inference')
  assert.equal(cardActivity(worker({ phase: WorkerPhase.awaitingHuman }), () => 'idle'), 'blocked')
  assert.equal(cardActivity(worker(), () => 'active'), 'active', 'with no explicit blockage, the live status is used')
  assert.equal(cardActivity(worker()), 'unknown', 'and with no live status either, unknown -- not idle')
})

test('R20: a waiting worker does NOT decay out of Needs you, however quiet it is', () => {
  // Rated High. The failure: a worker waiting on a person whose session went quiet is
  // inferred `idle`, then demoted to `No signal` once the grace elapsed -- so the card
  // SILENTLY leaves `Needs you` while the question is still unanswered.
  const longQuiet = worker({
    pendingQuestion: { id: 'q1', text: 'which branch?', at: 1 },
    lastSignalAt: NOW - 10 * 60_000,
  })
  const card = buildCard({
    worker: longQuiet,
    issueTitle: 'Waiting',
    issueNumber: 4,
    prs: [],
    activity: 'waiting_input',
    config: CONFIG,
    now: NOW,
  })
  assert.equal(card.status, SessionStatus.needsInput, 'the question survives the clock')
  const view = presentCard(card, { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs })
  assert.notEqual(view.displayStatus, DisplayStatus.noSignal, 'and the card is not demoted to No signal')
  assert.equal(view.needsAttention, true, 'so it stays in Needs you')
})

test('the board applies that precedence when it builds cards, not just when asked', async () => {
  // The unit above could pass while `buildBoard` still used the raw live status, so this
  // asserts the wiring: a blocked worker reads as blocked even though the live handle says
  // idle, which is what `AgentStatus` always says for a session waiting on a person.
  const store = createMemoryFactStore()
  await store.issues.put('iss-0', {
    id: 'iss-0', number: 1, repoId: 'repo-1', title: 'Waiting', state: 'in_progress', workerId: 'wrk-1',
    createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-1', {
    id: 'wrk-1', issueId: 'iss-0', sessionId: 's', branch: 'b', worktreePath: '/p', workspaceId: 'w',
    phase: WorkerPhase.implementing, phaseHistory: [],
    pendingQuestion: { id: 'q1', text: 'which branch?', at: 1 },
    lastSignalAt: NOW - 10 * 60_000, createdAt: 1, updatedAt: 1,
  })
  const board = await buildBoard({
    store: lazyFactStore(async () => store), config: CONFIG, now: () => NOW, activityOf: () => 'idle',
  })
  const card = Object.values(board.lenses.lanes).flat()[0]!
  // Asserted on the PRESENTED card, because that is what a reader sees: the activity is
  // an internal fact and the view does not carry it.
  assert.notEqual(card.displayStatus, DisplayStatus.noSignal, 'not demoted, though the session is long quiet')
  assert.equal(card.needsAttention, true, 'and it is surfaced as needing a person')
})


// ---------------------------------------------------------------------------
// Reviewer evidence (§11.2: the card must say who it is waiting on)
// ---------------------------------------------------------------------------

test('reviewers are the humans, one entry per person, latest verdict winning', () => {
  // A person can review twice. An earlier CHANGES_REQUESTED followed by an APPROVED
  // means they are satisfied; showing the stale state would make the card claim someone
  // is blocking when they are not.
  const evidence = reviewerEvidence(
    snapshot({
      reviews: [
        { id: 'r1', state: 'CHANGES_REQUESTED', author: 'alice', isBot: false },
        { id: 'r2', state: 'COMMENTED', author: 'bob', isBot: false },
        { id: 'r3', state: 'APPROVED', author: 'alice', isBot: false },
      ],
    }),
  )
  assert.deepEqual(evidence, [
    { name: 'alice', state: 'APPROVED' },
    { name: 'bob', state: 'COMMENTED' },
  ])
})

test('our own reviewer is NOT shown as a person', () => {
  // The card answers "is this waiting on me?". Our reviewer's approval is already the
  // status line, and an avatar for it would suggest a human had looked.
  const evidence = reviewerEvidence(
    snapshot({
      reviews: [
        { id: 'r1', state: 'APPROVED', author: 'dsho-reviewer', isBot: true },
        { id: 'r2', state: 'APPROVED', author: 'alice', isBot: false },
      ],
    }),
  )
  assert.deepEqual(evidence.map((r) => r.name), ['alice'])
})

test('an anonymous review names nobody, and unknown authorship is not assumed human', () => {
  const evidence = reviewerEvidence(
    snapshot({
      reviews: [
        { id: 'r1', state: 'APPROVED', author: '', isBot: false },
        { id: 'r2', state: 'APPROVED', author: '   ', isBot: false },
        { id: 'r3', state: 'CHANGES_REQUESTED', author: 'carol', isBot: undefined },
      ],
    }),
  )
  assert.deepEqual(evidence, [{ name: 'carol', state: 'CHANGES_REQUESTED' }], 'an untyped author is kept')
})

test('R13: an unfetched observation names no reviewers', () => {
  // An empty review list on a failed fetch must not read as "nobody has reviewed".
  assert.deepEqual(reviewerEvidence(snapshot({ fetched: false, reviews: [{ id: 'r1', state: 'APPROVED', author: 'alice', isBot: false }] })), [])
  assert.deepEqual(reviewerEvidence(undefined), [])
})

test('the presented card carries the reviewers through', () => {
  const card = buildCard({
    worker: worker(),
    issueTitle: 'Fix it',
    issueNumber: 1,
    prs: [],
    reviewers: [{ name: 'alice', state: 'APPROVED' }],
    activity: 'idle',
    config: CONFIG,
    now: NOW,
  })
  assert.deepEqual(presentCard(card, { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs }).reviewers, [
    { name: 'alice', state: 'APPROVED' },
  ])
})


// ---------------------------------------------------------------------------
// The archive column was UNREACHABLE
// ---------------------------------------------------------------------------

test('a finished worker reaches the ARCHIVE, which nothing could before', async () => {
  // `isTerminated` short-circuits both derivations, and `buildCard` hardcoded it false --
  // so the archive column and the Terminated/Merged statuses were structurally
  // unreachable, and the board fetched `lenses.archive` every poll to render a count
  // that was always 0.
  const store = createMemoryFactStore()
  await store.issues.put('iss-done', {
    id: 'iss-done', number: 2, repoId: 'repo-1', title: 'Landed', state: 'done', workerId: 'wrk-done',
    createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-done', {
    id: 'wrk-done', issueId: 'iss-done', sessionId: 's', branch: 'b', worktreePath: '/p', workspaceId: 'w',
    phase: WorkerPhase.merged, phaseHistory: [], lastSignalAt: NOW - 1, createdAt: 1, updatedAt: 1,
    pr: { number: 9, url: 'pr/9', headSha: 'sha-1' },
  })
  await store.prSnapshots.put('wrk-done', snapshot({ number: 9, url: 'pr/9', state: 'MERGED', headSha: 'sha-1' }))

  const board = await buildBoard({
    store: lazyFactStore(async () => store), config: CONFIG, now: () => NOW, activityOf: () => 'idle',
  })
  assert.equal(board.counts.byLane[KanbanColumn.archive] ?? 0, 0, 'the archive is not a lane')
  assert.equal(board.lenses.archive.length, 1, 'but it now has content')
  assert.equal(board.lenses.archive[0]!.column, KanbanColumn.archive)
  // `Terminated`, not `Merged` -- and that is the ported contract's behaviour, not a bug
  // I fixed here: the kanban derivation returns Terminated for ANY terminated session
  // (kanban.ts:475), while only the STATUS derivation distinguishes merged from closed
  // (status.ts:190). So the archive loses the landed/abandoned distinction that the
  // status keeps. Recorded rather than changed, because the kanban rule is ported and
  // tested, and A17's gating depends on it.
  assert.equal(board.lenses.archive[0]!.displayStatus, DisplayStatus.terminated)
  assert.equal(board.counts.total, 1, 'and it is still counted')
})

test('a worker that closed without merging ALSO reads Terminated', async () => {
  const store = createMemoryFactStore()
  await store.issues.put('iss-x', {
    id: 'iss-x', number: 3, repoId: 'repo-1', title: 'Abandoned', state: 'cancelled', workerId: 'wrk-x',
    createdAt: 1, updatedAt: 1,
  })
  await store.workers.put('wrk-x', {
    id: 'wrk-x', issueId: 'iss-x', sessionId: 's', branch: 'b', worktreePath: '/p', workspaceId: 'w',
    phase: WorkerPhase.closed, phaseHistory: [], lastSignalAt: NOW - 1, createdAt: 1, updatedAt: 1,
  })
  const board = await buildBoard({
    store: lazyFactStore(async () => store), config: CONFIG, now: () => NOW, activityOf: () => 'idle',
  })
  assert.equal(board.lenses.archive[0]!.displayStatus, DisplayStatus.terminated)
})

test('an ACTIVE worker is not archived -- the fix did not archive everything', async () => {
  // The risk of deriving a flag is over-applying it. A working, a blocked, and a
  // merge-ready worker must all stay on the board.
  const store = createMemoryFactStore()
  const phases = [WorkerPhase.implementing, WorkerPhase.awaitingHuman, WorkerPhase.mergeReady] as const
  for (const [index, phase] of phases.entries()) {
    await store.issues.put(`iss-${index}`, {
      id: `iss-${index}`, number: 10 + index, repoId: 'repo-1', title: `T${index}`, state: 'in_progress',
      workerId: `wrk-${index}`, createdAt: 1, updatedAt: 1,
    })
    await store.workers.put(`wrk-${index}`, {
      id: `wrk-${index}`, issueId: `iss-${index}`, sessionId: 's', branch: 'b', worktreePath: '/p',
      workspaceId: 'w', phase, phaseHistory: [], lastSignalAt: NOW - 1, createdAt: 1, updatedAt: 1,
    })
  }
  const board = await buildBoard({
    store: lazyFactStore(async () => store), config: CONFIG, now: () => NOW, activityOf: () => 'idle',
  })
  assert.equal(board.lenses.archive.length, 0, 'none of these are finished')
  assert.equal(board.counts.total, 3)
})

// ---------------------------------------------------------------------------
// buildBoard — the project scope
// ---------------------------------------------------------------------------

/** A store with one project per worker, plus a worker whose issue is missing. */
async function twoProjects() {
  const store = createMemoryFactStore()
  for (const [id, name] of [['repo-1', 'widgets'], ['repo-2', 'gadgets']] as const) {
    await store.repos.put(id, { id, owner: 'acme', name, rootPath: `/code/${name}` })
  }
  for (const [index, repoId] of [['0', 'repo-1'], ['1', 'repo-2']] as const) {
    await store.issues.put(`iss-${index}`, {
      id: `iss-${index}`, number: Number(index) + 1, repoId, title: `Task ${index}`, state: 'in_progress',
      workerId: `wrk-${index}`, createdAt: 1, updatedAt: 1,
    })
    await store.workers.put(`wrk-${index}`, { id: `wrk-${index}`, issueId: `iss-${index}`, updatedAt: 5, lastSignalAt: NOW - 1 })
  }
  // An orphan: no issue record at all, so no project it can honestly be attributed to.
  await store.workers.put('wrk-orphan', { id: 'wrk-orphan', issueId: 'iss-gone', updatedAt: 5, lastSignalAt: NOW - 1 })
  const deps: BoardDeps = { store: lazyFactStore(async () => store), config: CONFIG, now: () => NOW }
  return deps
}

test('a scoped board carries ONE project cards, and every project on the list', async () => {
  const deps = await twoProjects()
  const scoped = await buildBoard(deps, { repoId: 'repo-1' })

  assert.equal(scoped.counts.total, 1)
  assert.deepEqual(scoped.lenses.lanes[KanbanColumn.building]!.map((card) => card.id), ['wrk-0'])
  assert.deepEqual(
    scoped.projects.map((project) => project.id),
    ['repo-1', 'repo-2'],
    'the list stays whole: it is what tells the page which rows should exist',
  )
})

test('the counts and the lanes are scoped together, so the header cannot disagree with the board', async () => {
  const deps = await twoProjects()
  const scoped = await buildBoard(deps, { repoId: 'repo-2' })
  assert.equal(scoped.counts.total, 1)
  assert.equal(scoped.counts.byLane[KanbanColumn.building], 1)
  assert.equal(
    Object.values(scoped.lenses.lanes).flat().length + scoped.lenses.archive.length,
    scoped.counts.total,
    'every card on screen is counted, and nothing else is',
  )
})

test('no scope still means every project, including the orphan', async () => {
  const deps = await twoProjects()
  const whole = await buildBoard(deps)
  assert.equal(whole.counts.total, 3)
  // `''` and an absent scope are the same read: the tool and the project list both use it.
  assert.deepEqual((await buildBoard(deps, { repoId: '' })).counts, whole.counts)
})

test('an unknown project is an EMPTY board, not the whole install', async () => {
  // The failure this prevents: a project that was disconnected leaving its panel showing every
  // other project's workers, which reads as "these are mine".
  const deps = await twoProjects()
  const scoped = await buildBoard(deps, { repoId: 'repo-gone' })
  assert.equal(scoped.counts.total, 0)
  assert.deepEqual(scoped.lenses.archive, [])
  assert.equal(scoped.projects.length, 2)
})

test('a worker whose issue is missing is attributed to no project, not guessed into one', async () => {
  const deps = await twoProjects()
  const scoped = await buildBoard(deps, { repoId: 'repo-1' })
  assert.deepEqual(scoped.lenses.lanes[KanbanColumn.building]!.map((card) => card.id), ['wrk-0'])
})

test('the route reads the scope from the query string the client writes', async () => {
  const deps = await twoProjects()
  const route = createBoardRoute(deps)
  const response = fakeResponse()
  await route.handler({ url: `${BOARD_ROUTE_PATH}?repoId=repo-2` }, response)

  const body = JSON.parse(response.record.body ?? '{}') as { counts: { total: number }; projects: unknown[] }
  assert.equal(response.record.status, 200)
  assert.equal(body.counts.total, 1)
  assert.equal(body.projects.length, 2)
})

test('a board read with no query string is the whole install', async () => {
  // The routes answer a request object that may carry no URL at all, and the unscoped board is
  // a real answer: a malformed request must not become a panel that can only say 500.
  const deps = await twoProjects()
  const response = fakeResponse()
  await createBoardRoute(deps).handler({}, response)
  const body = JSON.parse(response.record.body ?? '{}') as { counts: { total: number } }
  assert.equal(response.record.status, 200)
  assert.equal(body.counts.total, 3)
})
