/**
 * The session-status reducer's truth table.
 *
 * PORTED from Agent Orchestrator `backend/pkg/contract/status_test.go`
 * (commit 53ba1e8, Apache-2.0). See NOTICE.
 *
 * This layer is not the board's column reducer: `StatusStatus` aggregates the
 * session's *worst* open PR, while the board's `displayStatus` describes the PR
 * the column was chosen from — the *best* landing. A30's finished-treatment gate
 * reads this one, so its precedence has to be pinned here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SessionStatus,
  buildStacks,
  deriveSCMStatus,
  deriveStatus,
  prStatusFacts,
  sessionFacts,
} from '../../src/contract/status.js'

const GRACE = 90_000
const STATUS_NOW = Date.UTC(2026, 5, 10, 12, 0, 0)

/** A session that has reported, at `STATUS_NOW`. Ported from the Go `session()`. */
function sessionAt(activity) {
  return sessionFacts({ activity, lastActivityAt: STATUS_NOW, hasSignal: true })
}

function facts(prs) {
  return (prs ?? []).map(prStatusFacts)
}

test('deriveStatus: precedence', async (t) => {
  const cases = [
    ['terminated', sessionFacts({ isTerminated: true }), undefined, SessionStatus.terminated],
    [
      'terminated merged',
      sessionFacts({ isTerminated: true }),
      [{ merged: true }],
      SessionStatus.merged,
    ],
    [
      'terminated closed only',
      sessionFacts({ isTerminated: true }),
      [{ closed: true }],
      SessionStatus.terminated,
    ],
    [
      'terminated merged with open pr',
      sessionFacts({ isTerminated: true }),
      [{ merged: true }, { merged: false }],
      SessionStatus.terminated,
    ],
    [
      'terminated all merged',
      sessionFacts({ isTerminated: true }),
      [{ merged: true }, { merged: true }],
      SessionStatus.merged,
    ],
    ['active before PR', sessionAt('active'), [{ ci: 'failing' }], SessionStatus.working],
    ['exited before PR', sessionAt('exited'), [{ mergeability: 'mergeable' }], SessionStatus.exited],
    ['waiting before PR', sessionAt('waiting_input'), [{ ci: 'failing' }], SessionStatus.needsInput],
    ['blocked before PR', sessionAt('blocked'), [{ ci: 'failing' }], SessionStatus.needsInput],
    ['PR before idle', sessionAt('idle'), [{ ci: 'failing' }], SessionStatus.ciFailed],
    ['idle', sessionAt('idle'), undefined, SessionStatus.idle],
  ]
  for (const [name, session, prs, want] of cases) {
    await t.test(name, () => {
      assert.equal(deriveStatus(session, facts(prs), STATUS_NOW, GRACE), want)
    })
  }
})

test('deriveStatus: the no-signal rules', async (t) => {
  const silent = {
    activity: 'idle',
    lastActivityAt: STATUS_NOW - 2 * GRACE,
    hasSignal: false,
  }
  const cases = [
    ['past grace', { ...silent, signalExpected: true }, STATUS_NOW, SessionStatus.noSignal],
    ['signal not expected', { ...silent, signalExpected: false }, STATUS_NOW, SessionStatus.idle],
    [
      'signal received',
      { ...silent, signalExpected: true, hasSignal: true },
      STATUS_NOW,
      SessionStatus.idle,
    ],
    [
      'at boundary',
      { ...silent, signalExpected: true },
      silent.lastActivityAt + GRACE,
      SessionStatus.idle,
    ],
  ]
  for (const [name, session, now, want] of cases) {
    await t.test(name, () => {
      assert.equal(deriveStatus(sessionFacts(session), undefined, now, GRACE), want)
    })
  }
})

test('deriveSCMStatus: the pipeline reading, and worst wins', async (t) => {
  const cases = [
    ['closed ignored', [{ closed: true }], ''],
    ['merged', [{ merged: true }], SessionStatus.merged],
    ['open', [{}], SessionStatus.prOpen],
    ['review pending', [{ review: 'review_required' }], SessionStatus.reviewPending],
    [
      'review pending with provider merge blocker',
      [{ review: 'review_required', mergeability: 'blocked' }],
      SessionStatus.reviewPending,
    ],
    ['approved', [{ review: 'approved' }], SessionStatus.approved],
    ['mergeable', [{ mergeability: 'mergeable' }], SessionStatus.mergeable],
    ['merge blocked', [{ mergeability: 'blocked' }], SessionStatus.prOpen],
    [
      'merge blocked with approved review',
      [{ mergeability: 'blocked', review: 'approved' }],
      SessionStatus.prOpen,
    ],
    ['changes requested', [{ review: 'changes_requested' }], SessionStatus.changesRequested],
    ['review comments', [{ reviewComments: true }], SessionStatus.changesRequested],
    ['draft', [{ draft: true }], SessionStatus.draft],
    ['CI failed', [{ ci: 'failing' }], SessionStatus.ciFailed],
    [
      'worst wins',
      [
        { url: 'a', sourceBranch: 'a', targetBranch: 'main', mergeability: 'mergeable' },
        { url: 'b', sourceBranch: 'b', targetBranch: 'main', ci: 'failing' },
      ],
      SessionStatus.ciFailed,
    ],
  ]
  for (const [name, prs, want] of cases) {
    await t.test(name, () => {
      assert.equal(deriveSCMStatus(facts(prs)), want)
    })
  }
})

test('the stack rules', async (t) => {
  const parent = {
    url: 'parent',
    sourceBranch: 'feature',
    targetBranch: 'main',
    mergeability: 'mergeable',
  }
  const child = { url: 'child', sourceBranch: 'feature/child', targetBranch: 'feature' }

  await t.test('a child stacked on an open parent is blocked; the parent is not', () => {
    const positions = buildStacks(facts([parent, child]))
    assert.deepEqual(positions.get('parent'), { blocked: false, bottomOfStack: true })
    assert.deepEqual(positions.get('child'), { blocked: true, bottomOfStack: false })
  })

  await t.test('a blocked child\'s mergeability is suppressed', () => {
    assert.equal(deriveSCMStatus(facts([parent, child])), SessionStatus.mergeable)
  })

  await t.test('but a blocked child\'s real problem is not suppressed', () => {
    assert.equal(
      deriveSCMStatus(facts([parent, { ...child, ci: 'failing' }])),
      SessionStatus.ciFailed,
    )
  })

  await t.test('a merged parent no longer blocks its child', () => {
    const positions = buildStacks(facts([{ ...parent, merged: true }, child]))
    assert.equal(positions.get('child').blocked, false)
  })
})
