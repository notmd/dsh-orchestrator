/**
 * G3's visible half — the reasons reach the card, and they describe the same pull
 * request the phrase does.
 *
 * The teardown's point was precise: the *lane* was already right, so nothing looked
 * broken; what was missing was the reason list the reference feeds its merge-readiness
 * card. So these assert the plumbing, and one thing more — that a merged sibling cannot
 * supply the reasons for the PR the card is actually describing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { presentCard } from '../../src/board/presentation.ts'
import { buildCard, renderBoard } from '../../src/host/board-service.ts'
import { chosenKanbanPR, KanbanColumn, prFacts } from '../../src/contract/kanban.ts'
import { sessionFacts } from '../../src/contract/status.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import { WorkerPhase, normalizeWorker } from '../../src/domain/workers.ts'

const NOW = 1_700_000_000_000
const CONFIG = normalizePluginConfig({})

function card(prs: ReturnType<typeof prFacts>[], activity = 'idle') {
  return buildCard({
    worker: normalizeWorker({
      id: 'wrk-1',
      issueId: 'iss-1',
      sessionId: 'ses-1',
      branch: 'dsho/issue-1',
      worktreePath: '/tmp/wt',
      workspaceId: 'ws',
      phase: WorkerPhase.awaitingHuman,
      phaseHistory: [],
      lastSignalAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    issueTitle: 'a task',
    issueNumber: 1,
    prs,
    activity,
    config: CONFIG,
    now: NOW,
  })
}

test('the reasons ride along with the phrase', () => {
  const view = presentCard(
    card([prFacts({ url: 'pr/1', mergeability: 'blocked', mergeBlockers: ['ci_failing', 'draft'] })]),
    { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs },
  )
  assert.deepEqual(view.mergeBlockers, ['ci_failing', 'draft'])
})

test('nothing to say omits the field rather than sending an empty list', () => {
  const view = presentCard(card([prFacts({ url: 'pr/1', mergeability: 'mergeable' })]), {
    now: NOW,
    noSignalGraceMs: CONFIG.noSignalGraceMs,
  })
  assert.equal('mergeBlockers' in view, false)
})

test('a terminal sibling cannot supply the reasons for the live pull request', () => {
  // The card's phrase comes from the best-ranked LIVE PR; the reasons must come from the
  // same one. A merged PR's blockers are empty by construction, so reading them from the
  // wrong PR would silently drop the reasons — or worse, report a branch nobody will merge.
  const merged = prFacts({ url: 'pr/1', merged: true, mergeBlockers: [] })
  const live = prFacts({ url: 'pr/2', mergeBlockers: ['changes_requested'] })
  const session = sessionFacts({ activity: 'idle', autoReview: true })
  const selected = chosenKanbanPR(session, [merged, live])
  assert.equal(selected?.chosen.url, 'pr/2')

  const view = presentCard(card([merged, live]), { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs })
  assert.deepEqual(view.mergeBlockers, ['changes_requested'])
})

test('renderBoard tells the model what is left before the merge', () => {
  const rendered = renderBoard({
    generatedAt: NOW,
    lenses: {
      lanes: {
        [KanbanColumn.building]: [],
        [KanbanColumn.validating]: [],
        [KanbanColumn.needsReview]: [],
        [KanbanColumn.ready]: [
          presentCard(
            card([prFacts({ url: 'pr/1', mergeability: 'mergeable', mergeBlockers: ['review_required'] })]),
            { now: NOW, noSignalGraceMs: CONFIG.noSignalGraceMs },
          ),
        ],
      },
      archive: [],
    },
    counts: { total: 1, needsAttention: 0, byLane: {} },
    projects: [],
  })
  assert.match(rendered, /waiting on: review_required/)
})
