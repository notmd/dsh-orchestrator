/**
 * M0 spike — seed one card into the PLUGIN's domain, then release it.
 *
 * The client inspector needs a card that really carries review evidence, and the
 * board reads the plugin's own `dsho` domain. Joining that domain directly was
 * tried and it BROKE the plugin: a storage domain can only be opened once per
 * process, and the plugin's lazy open then failed with "domain 'dsho' is already
 * open".
 *
 * The fix is to **open, write, and CLOSE**. `FactStore.close()` releases the domain,
 * so the plugin's own lazy open succeeds afterwards and reads the rows from disk.
 * That is the pattern for seeding a running plugin's storage from outside, and the
 * reason the lane spike's own domain is not enough: isolation keeps the plugin alive
 * but leaves the board empty.
 *
 * @module dsho/spike/seed-spike
 */

import { mkdirSync, writeFileSync } from 'node:fs'

import { FACT_SCHEMAS } from '../host/schemas.ts'
import { openFactStore } from '../host/store.ts'
import { normalizePluginConfig } from '../config/validate.ts'
import type { HostContext } from '../host/context.ts'

export const name = 'seed-spike'

export const inject = ['storageDomain']

const RESULT = '/tmp/dsho-seed-result.json'
const REPO = '/tmp/dsho-seed-repo'
const HEAD = 'sha-' + 'c'.repeat(12)

const steps: Array<{ step: string; detail?: unknown }> = []

function record(step: string, detail?: unknown): void {
  steps.push({ step, ...(detail === undefined ? {} : { detail }) })
  try {
    writeFileSync(RESULT, JSON.stringify({ steps }, null, 2))
  } catch {
    // Never take the host down over bookkeeping.
  }
}

export function apply(ctx: HostContext): void {
  void run(ctx)
}

async function run(ctx: HostContext): Promise<void> {
  record('begin')
  let store: Awaited<ReturnType<typeof openFactStore>> | undefined
  try {
    mkdirSync(REPO, { recursive: true })
    const now = Date.now()
    // The plugin's OWN domain, opened deliberately and closed again below.
    store = await openFactStore({ facility: ctx.storageDomain, schemas: FACT_SCHEMAS })

    await store.repos.put('repo-seed-1', {
      id: 'repo-seed-1',
      owner: 'acme',
      name: 'widgets',
      rootPath: REPO,
      defaultBranch: 'main',
      connectedAt: now,
    })
    await store.issues.put('iss-seed-1', {
      id: 'iss-seed-1',
      number: 7,
      repoId: 'repo-seed-1',
      title: 'Fix the flaky auth test',
      state: 'in_progress',
      workerId: 'wrk-seed-1',
      createdAt: now,
      updatedAt: now,
    })
    await store.workers.put('wrk-seed-1', {
      id: 'wrk-seed-1',
      issueId: 'iss-seed-1',
      sessionId: 'dsho-wrk-seed-1',
      branch: 'dsho/issue-7-flaky-auth-test',
      worktreePath: `${REPO}/.dsho/worktrees/issue-7`,
      workspaceId: 'w',
      phase: 'awaitingAutoReview',
      phaseHistory: [],
      pr: { number: 128, url: 'https://github.com/acme/widgets/pull/128', headSha: HEAD },
      lastSignalAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // A snapshot, so the card leaves Building at all -- the board reads PR facts.
    await store.prSnapshots.put('wrk-seed-1', {
      number: 128,
      url: 'https://github.com/acme/widgets/pull/128',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: '',
      ciState: 'passing',
      headSha: HEAD,
      headRefName: 'dsho/issue-7-flaky-auth-test',
      reviews: [],
      comments: [],
      lastCommentId: '',
      updatedAt: new Date(now).toISOString(),
      observedAt: now,
      fetched: true,
    })
    await store.reviewRuns.put('run-seed-1', {
      id: 'run-seed-1',
      workerId: 'wrk-seed-1',
      prNumber: 128,
      headSha: HEAD,
      round: 2,
      status: 'complete',
      verdict: 'changes_requested',
      triggerSource: 'auto',
      sessionId: 'dsho-rev-seed-1',
      startedAt: now - 60_000,
      endedAt: now - 30_000,
      githubReviewId: 'PRR_seed',
      summary: 'Two things worth fixing before this lands.',
      findings: [
        { severity: 'high', path: 'src/auth/session.ts', line: 42, summary: 'the retry drops the token', detail: 'The second attempt rebuilds the request without the Authorization header.' },
        { severity: 'medium', path: 'src/auth/session.test.ts', summary: 'no test covers the retry path', detail: 'The flake it fixes is not asserted anywhere.' },
      ],
    })
    record('seeded', { workerId: 'wrk-seed-1', head: HEAD, config: normalizePluginConfig().maxReviewRounds })
    finish(true)
  } catch (error) {
    record('failed', { message: error instanceof Error ? error.message : String(error) })
    finish(false)
  } finally {
    // THE POINT: release the domain, so the plugin's own lazy open can succeed.
    try {
      await store?.close()
      record('closed', { released: true })
    } catch (error) {
      record('closed:failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }
}

function finish(ok: boolean): void {
  try {
    writeFileSync(RESULT, JSON.stringify({ ok, steps }, null, 2))
  } catch {
    // As above.
  }
}
