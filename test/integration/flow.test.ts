/**
 * The whole requested flow, end to end, against a MOCK provider.
 *
 * The PRD's acceptance criteria are statements about a running system, and the user's
 * decision was explicit: a real pull request needs write access to a repository
 * somebody owns, so mock the provider and keep the flow under test instead of leaving
 * it unexercised.
 *
 * What is REAL here: a real git repository, a real worktree on a real branch, the real
 * reducer, the real observer, the real review loop, the real services, and the real
 * argv the plugin builds. What is mocked: `gh`.
 *
 * That is worth stating precisely, because the temptation is to treat "end to end" as
 * "everything is fake, so it must be fine". A mock provider cannot tell you whether
 * `gh` accepts the flags the plugin sends -- `gh repo view .` passed every test and was
 * rejected by the real CLI. Everything else about this flow is genuinely exercised.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mockGitHub } from './mock-gh.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { createRunCommand } from '../../src/host/exec.ts'
import { createLiveWorkers } from '../../src/host/handle-registry.ts'
import { connectRepoForTool } from '../../src/host/tools.ts'
import { createIssueForTool } from '../../src/host/issues-service.ts'
import { startWorkerForTool } from '../../src/host/workers-service.ts'
import { observeWorker } from '../../src/host/observer-service.ts'
import { buildBoard } from '../../src/host/board-service.ts'
import { submitVerdict, sweepReviewPasses } from '../../src/host/reviewer-service.ts'
import { sweepCompletions } from '../../src/host/completion.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import { normalizeWorker } from '../../src/domain/workers.ts'
import type { PrSnapshot } from '../../src/domain/pr-snapshot.ts'
import type { ReviewRun } from '../../src/review/runs.ts'

const REPOSITORY = 'acme/widgets'
const NOW = 10_000_000

/** A real repository with a real commit, since git work needs somewhere to stand. */
function scratchRepo(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsho-flow-'))
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: path, stdio: 'pipe' })
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'flow@example.invalid')
  git('config', 'user.name', 'Flow')
  writeFileSync(join(path, 'README.md'), '# flow\n')
  writeFileSync(join(path, '.gitignore'), '.dsho/\n')
  git('add', '.')
  git('commit', '-m', 'init')
  return path
}

/** A spawn seam that records what it was asked to create. */
function spawnFixture() {
  const sessions: string[] = []
  return {
    sessions,
    deps: {
      permissionPresets: { resolve: () => undefined, set() {} },
      agentPresets: { async resolve() { return { id: 'standard' } }, async acquireScope() { return { dispose() {} } }, async mount() {} },
      workspaceRegistry: { async create(path: string) { return { path, async attachSession() {} } } },
      sessionTitle: { rename() {} },
      agents: {
        get: () => undefined,
        async create(options: { sessionId: string }) {
          sessions.push(options.sessionId)
          return { agent: { session: { id: options.sessionId }, status: 'idle', followup() {} }, async dispose() {} }
        },
      },
      userMessage: (text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    },
  }
}

test('the requested flow runs end to end against a mock provider', async (t) => {
  const rootPath = scratchRepo()
  const store = createMemoryFactStore()
  const live = createLiveWorkers()
  const spawn = spawnFixture()
  // A REAL subprocess seam: the same handle shape `exec.ts` expects, but it actually
  // runs the command. A fake that answered from a script would verify nothing about the
  // git work, which is half the integration risk.
  const real = createRunCommand({
    subprocess: {
      spawn(spec: { argv: readonly string[]; cwd?: string }) {
        let stdout = ''
        let stderr = ''
        let exitCode: number | null = 0
        try {
          stdout = execFileSync(spec.argv[0]!, spec.argv.slice(1), {
            cwd: spec.cwd ?? rootPath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          const failure = error as { status?: number; stdout?: unknown; stderr?: unknown }
          exitCode = failure.status ?? 1
          stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
          stderr = typeof failure.stderr === 'string' ? failure.stderr : String(error)
        }
        const read = (text: string) => ({ text, nextOffset: text.length, lossy: false })
        return {
          done: Promise.resolve({ exitCode, signal: null }),
          collected: { stdout: { readFrom: () => read(stdout) }, stderr: { readFrom: () => read(stderr) } },
          terminate() {},
        }
      },
    } as never,
    cwd: rootPath,
  })

  const gh = mockGitHub({ repository: REPOSITORY, passThrough: real })
  const config = normalizePluginConfig({ maxReviewRounds: 3 })
  const lazy = lazyFactStore(async () => store)
  const deps = { store: lazy, config, run: gh.run, spawn: spawn.deps as never, live, now: () => NOW }

  // 1. Connect the repository. `gh repo view` is the mock; the verify command is real.
  const connected = await connectRepoForTool({ config, run: gh.run, store: lazy }, { path: rootPath })
  assert.match(connected, /^Connected acme\/widgets/m, connected)

  // 2. Create an issue.
  const created = await createIssueForTool({ store: lazy }, { title: 'Fix the flaky auth test' })
  const issueId = /\b(iss-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(created)?.[1]
  assert.ok(issueId, created)

  // 3. Start a worker: a REAL worktree on a real branch.
  const started = await startWorkerForTool(deps as never, { issueId: issueId! })
  const workerId = /\b(wrk-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(started)?.[1]
  assert.ok(workerId, started)
  assert.match(started, /#1 Fix the flaky auth test/, 'the session title carries the issue number')
  const worker = normalizeWorker(await store.workers.get(workerId!))
  assert.equal(worker.branch, 'dsho/issue-1-fix-the-flaky-auth-test', 'a real branch name')
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: rootPath, encoding: 'utf8' })
  assert.ok(worktrees.includes(worker.worktreePath), 'and a real worktree on disk')

  // The worker's live handle, as `worker_start` registers it -- the review gate reads it.
  live.register({
    workerId: workerId!,
    sessionId: worker.sessionId,
    handle: { agent: { session: { id: worker.sessionId }, status: 'idle', followup() {} }, async dispose() {} },
  })

  // 4. The worker opens a pull request, through the REAL argv path.
  const prCreate = gh.run(['gh', 'pr', 'create', '--head', worker.branch, '--base', 'main', '--title', 'x', '--body', 'y'])
  await prCreate
  assert.equal(gh.prs.length, 1, 'the provider now has a pull request')
  const prNumber = gh.prs[0]!.number
  gh.head(prNumber, 'sha-' + 'a'.repeat(12))

  // The plugin learns the PR from the worker's own report.
  await store.workers.put(workerId!, {
    ...worker,
    pr: { number: prNumber, url: gh.prs[0]!.url, headSha: gh.prs[0]!.headRefOid },
    // Backdated, so the review gate's idle threshold has legitimately elapsed: the
    // gate is a safety property and the test accommodates it rather than weakening it.
    lastSignalAt: NOW - config.reviewIdleThresholdMs - 1_000,
  })
  const withPr = normalizeWorker(await store.workers.get(workerId!))

  // 5. The observer reads the provider and records the facts.
  const observed = await observeWorker(deps as never, withPr, REPOSITORY)
  assert.equal(observed?.fetched, true)
  assert.equal(observed?.snapshot.state, 'OPEN')

  const lane = async (): Promise<string> => {
    const board = await buildBoard({ store: lazy, config, now: () => NOW, activityOf: () => 'idle' })
    const card = Object.values(board.lenses.lanes).flat().find((candidate) => candidate.id === workerId)
    return card ? `${card.column} / ${card.displayStatus}` : `(no card) ${JSON.stringify(board.counts.byLane)}`
  }

  // 6. The card left Building, on real facts.
  assert.match(await lane(), /^validating \/ Review scheduled$/)

  // 7. The review sweep spawns a real reviewer at the pinned head.
  const sweep = await sweepReviewPasses(deps as never)
  assert.equal(sweep.scheduled.length, 1)
  const runs = (await store.reviewRuns.list()) as ReviewRun[]
  assert.equal(runs[0]!.headSha, withPr.pr!.headSha, 'pinned to the observed head')
  assert.match(await lane(), /^validating \/ Reviewing$/)

  // 8. The reviewer's verdict moves the card -- and NOT to Ready.
  const verdict = await submitVerdict(
    deps as never,
    { verdict: 'approved', summary: 'looks correct' },
    runs[0]!.sessionId,
  )
  assert.match(verdict, /Recorded approved/)
  assert.match(await lane(), /^needs_review \/ Needs human review$/, 'A17: auto review first, then a human')

  // 9. The pull request merges, and the worker finishes.
  gh.setState(prNumber, 'MERGED')
  const merged = await observeWorker(deps as never, normalizeWorker(await store.workers.get(workerId!)), REPOSITORY)
  assert.equal(merged?.snapshot.state, 'MERGED')

  const completed = await sweepCompletions(deps as never)
  assert.equal(completed.length, 1, 'the merge finished the worker')
  const issue = (await store.issues.get(issueId!)) as { state: string; workerId?: string }
  assert.equal(issue.state, 'done', 'and released its issue')
  assert.equal(issue.workerId, undefined)

  // 10. And the worktree is gone, which is where R4's disk bound is paid.
  const after = execFileSync('git', ['worktree', 'list'], { cwd: rootPath, encoding: 'utf8' })
  assert.ok(!after.includes(worker.worktreePath), 'the worktree was collected on completion')

  // The provider was asked for what the plugin needed, in its own vocabulary.
  const ghCalls = gh.calls.filter((argv) => argv[0] === 'gh').map((argv) => argv.slice(0, 3).join(' '))
  assert.ok(ghCalls.includes('gh repo view'), ghCalls.join(' | '))
  assert.ok(ghCalls.includes('gh pr view'), ghCalls.join(' | '))
  // Explicit rather than positional: the repository follows `--repo`, and asserting a
  // fixed index asserts the argv layout rather than the property.
  const named = gh.calls
    .filter((argv) => argv.includes('--repo'))
    .map((argv) => argv[argv.indexOf('--repo') + 1])
  assert.ok(named.length > 0, 'at least one call named the repository')
  assert.deepEqual([...new Set(named)], [REPOSITORY], 'every named read used the connected repository')
  t.diagnostic(`gh calls: ${ghCalls.join(', ')}`)
})
