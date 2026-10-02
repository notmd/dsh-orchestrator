/**
 * Do the settings REACH the work?
 *
 * A settings page is the easiest feature in a project to leave cosmetic: every control
 * renders, every write is persisted, and nothing downstream reads the value. That failure
 * is invisible from the page, so these tests are written at the far end of the wire --
 * a real git repository, a real branch on disk, and the preset name the spawn actually
 * resolved.
 *
 * Real here: a real repository, a real worktree, the real services, and the real argv.
 * Mocked: `gh`, exactly as `flow.test.ts` mocks it, and the session spawn (which needs a
 * live host).
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
import { connectRepo } from '../../src/host/repo.ts'
import { updateProjectSettings } from '../../src/host/settings-service.ts'
import { fillSlots, startWorkerForTool } from '../../src/host/workers-service.ts'
import { sweepReviewPasses } from '../../src/host/reviewer-service.ts'
import { normalizePluginConfig } from '../../src/config/validate.ts'
import { normalizeIssue } from '../../src/domain/issues.ts'
import { normalizeRepo } from '../../src/host/repo.ts'
import { normalizeWorker } from '../../src/domain/workers.ts'

const REPOSITORY = 'acme/widgets'
const NOW = 20_000_000

/** A real repository with a real commit, since git work needs somewhere to stand. */
function scratchRepo(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsho-settings-'))
  const git = (...argv: string[]): void => {
    execFileSync('git', argv, { cwd: path, stdio: 'pipe' })
  }
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'settings@example.invalid')
  git('config', 'user.name', 'Settings')
  writeFileSync(join(path, 'README.md'), '# settings\n')
  writeFileSync(join(path, '.gitignore'), '.dsho/\n')
  git('add', '.')
  git('commit', '-m', 'init')
  return path
}

/**
 * A spawn seam that records the PRESET NAME it was asked to resolve.
 *
 * Recording `resolve`'s argument rather than the session is the point: the preset is
 * chosen by a name, and a name is exactly what a settings page writes.
 */
function spawnFixture() {
  /** Every `agentPresets.resolve()` argument, in order: worker first, then the reviewer. */
  const resolvedPresets: string[] = []
  /** Every `permissionPresets.set()` NAME, in spawn order. */
  const appliedPermissions: string[] = []
  return {
    resolvedPresets,
    appliedPermissions,
    deps: {
      permissionPresets: {
        resolve: () => undefined,
        set(_session: unknown, name: string) {
          appliedPermissions.push(name)
        },
      },
      agentPresets: {
        async resolve(name: string) {
          resolvedPresets.push(name)
          return { id: name }
        },
        async acquireScope() {
          return { dispose() {} }
        },
        async mount() {},
      },
      workspaceRegistry: { async create(path: string) { return { path, async attachSession() {} } } },
      sessionTitle: { rename() {} },
      agents: {
        get: () => undefined,
        async create(options: { sessionId: string }) {
          return { agent: { session: { id: options.sessionId }, status: 'idle', followup() {} }, async dispose() {} }
        },
      },
      userMessage: (text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    },
  }
}

/** The same real-subprocess seam the flow test uses. */
function realRun(rootPath: string) {
  return createRunCommand({
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
}

async function harness() {
  const rootPath = scratchRepo()
  const store = createMemoryFactStore()
  const spawn = spawnFixture()
  const gh = mockGitHub({ repository: REPOSITORY, passThrough: realRun(rootPath) })
  const config = normalizePluginConfig({})
  const lazy = lazyFactStore(async () => store)
  const deps = {
    store: lazy,
    config,
    run: gh.run,
    spawn: spawn.deps as never,
    live: createLiveWorkers(),
    now: () => NOW,
  }
  const connected = await connectRepoForTool({ config, run: gh.run, store: lazy }, { path: rootPath })
  assert.match(connected, /^Connected acme\/widgets/m, connected)
  const repo = (await store.repos.list()).map(normalizeRepo)[0]!
  return { rootPath, store, deps, spawn, gh, config, lazy, repo }
}

test('the branch prefix reaches a REAL worktree branch', async () => {
  const { store, deps, repo } = await harness()

  const saved = await updateProjectSettings(deps as never, { repoId: repo.id, patch: { sessionPrefix: 'web' } })
  assert.ok(saved.ok, 'the prefix is accepted')

  const started = await startWorkerForTool(deps as never, { title: 'Fix the flaky auth test' })
  const workerId = /\b(wrk-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(started)?.[1]
  assert.ok(workerId, started)
  const worker = normalizeWorker(await store.workers.get(workerId!))

  assert.equal(
    worker.branch,
    'dsho/web/issue-1-fix-the-flaky-auth-test',
    'PRD 13.1 sessionPrefix is now a real namespace on a real branch',
  )
  // And on disk, not only in the record: a branch name the repository does not have would
  // mean `git worktree add` was given something else.
  const branches = execFileSync('git', ['branch', '--list', worker.branch], { cwd: repo.rootPath, encoding: 'utf8' })
  assert.match(branches, /dsho\/web\/issue-1-fix-the-flaky-auth-test/, 'the branch exists in the repository')

  // Clearing it restores the un-namespaced branch, so the setting is reversible.
  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { sessionPrefix: '' } })
  const second = await startWorkerForTool(deps as never, { title: 'Second task' })
  const secondId = /\b(wrk-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(second)?.[1]
  assert.ok(secondId, second)
  assert.equal(normalizeWorker(await store.workers.get(secondId!)).branch, 'dsho/issue-2-second-task')
})

test('the assignee preset reaches the spawn, and clearing it returns to the plugin default', async () => {
  const { deps, repo, spawn } = await harness()
  assert.deepEqual(spawn.resolvedPresets, [], 'nothing resolved yet')

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { workerAgentPreset: 'strict' } })
  await startWorkerForTool(deps as never, { title: 'One' })
  assert.deepEqual(spawn.resolvedPresets, ['strict'], 'the project preset is the one resolved')

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { workerAgentPreset: '' } })
  await startWorkerForTool(deps as never, { title: 'Two' })
  assert.equal(spawn.resolvedPresets[1], deps.config.workerAgentPreset, 'and empty falls back to the plugin default')
})

test('the WORKER permission preset reaches the spawn, per project, and clearing it returns to the default', async () => {
  // This one is not cosmetic either. A worker commits and pushes, and a linked git worktree
  // keeps no git data of its own -- its `.git` points into the PARENT repo, so a
  // worktree-scoped sandbox refuses `git add`/`commit`/`push` and the worker stalls on an
  // approval nobody answers. The preset that reaches the spawn is therefore the difference
  // between a stage that can finish and one that cannot.
  const { deps, repo, spawn } = await harness()
  assert.deepEqual(spawn.appliedPermissions, [], 'nothing applied yet')

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { workerPermissionPreset: 'read-only' } })
  await startWorkerForTool(deps as never, { title: 'One' })
  assert.deepEqual(spawn.appliedPermissions, ['read-only'], 'the project boundary is the one applied')

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { workerPermissionPreset: '' } })
  await startWorkerForTool(deps as never, { title: 'Two' })
  assert.equal(
    spawn.appliedPermissions[1],
    deps.config.workerPermissionPreset,
    'and empty falls back to the plugin default',
  )
  assert.equal(deps.config.workerPermissionPreset, 'danger-full-access', 'which is full access, so a stage can finish')
})

test('the REVIEWER preset reaches the reviewer spawn, per project', async () => {
  // PRD 13.1 asks for this per repo -- "a heavy repo can use a stricter reviewer" -- and
  // until this field existed the per-repo preset was validated and read by nothing, so the
  // only reviewer an install could have was the plugin's.
  const { store, deps, repo, spawn } = await harness()

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { reviewerAgentPreset: 'strict-reviewer' } })

  // A worker with a pull request, quiet long enough for the idle gate, and a live handle:
  // the three things the pass needs before it will spawn anything.
  const started = await startWorkerForTool(deps as never, { title: 'Review me' })
  const workerId = /\b(wrk-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(started)?.[1]
  assert.ok(workerId, started)
  const worker = normalizeWorker(await store.workers.get(workerId!))
  await store.workers.put(workerId!, {
    ...worker,
    pr: { number: 7, url: 'https://example.invalid/acme/widgets/pull/7', headSha: 'a'.repeat(40) },
    lastSignalAt: NOW - 10 * 60 * 1000,
  })
  await store.prSnapshots.put(workerId!, { workerId, url: 'https://example.invalid/acme/widgets/pull/7', headSha: 'a'.repeat(40), fetched: true })
  deps.live.register({
    workerId: workerId!,
    sessionId: worker.sessionId,
    handle: { agent: { session: { id: worker.sessionId }, status: 'idle', followup() {} }, async dispose() {} },
  })

  spawn.resolvedPresets.length = 0
  const sweep = await sweepReviewPasses(deps as never)
  assert.equal(sweep.scheduled.length, 1, `a pass is scheduled: ${JSON.stringify(sweep)}`)
  assert.deepEqual(spawn.resolvedPresets, ['strict-reviewer'], 'the PER-REPO reviewer preset is what the pass resolves')

  // The harness is recorded on the run, which PRD 13.2 asks for so a future multi-reviewer
  // key needs no migration. It has to name the preset that actually ran.
  const runs = (await store.reviewRuns.list()) as Array<{ harness?: unknown }>
  assert.equal(runs[0]?.harness, 'strict-reviewer')

  // Clearing it falls back to the plugin default, so the override is reversible.
  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { reviewerAgentPreset: '' } })
  assert.equal(normalizeRepo(await store.repos.get(repo.id)).reviewerAgentPreset, '')
})

test('issue intake OFF holds the queue, and turning it back on starts the work', async () => {
  const { store, deps, repo } = await harness()
  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { intakeEnabled: false } })

  // Queue work by filling the cap: `startWorkerForTool` records the intent rather than
  // refusing it, which is what `fillSlots` later acts on.
  await startWorkerForTool(deps as never, { title: 'One' })
  await startWorkerForTool(deps as never, { title: 'Two' })
  await startWorkerForTool(deps as never, { title: 'Three' })
  const queued = (await store.issues.list()).map(normalizeIssue).filter((issue) => issue.pendingWorker === true)
  assert.equal(queued.length, 1, 'the third issue is queued behind the cap of 2')

  passCap(deps.config, 10)
  const held = await fillSlots(deps as never)
  assert.deepEqual(held.started, [], 'intake off: the sweep starts nothing')
  const stillQueued = (await store.issues.list()).map(normalizeIssue).filter((issue) => issue.pendingWorker === true)
  assert.equal(stillQueued.length, 1, 'and the request SURVIVES, which is what makes the setting reversible')

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { intakeEnabled: true } })
  const resumed = await fillSlots(deps as never)
  assert.equal(resumed.started.length, 1, 'turning intake back on starts it on the next sweep')
})

/** Raises the cap in place, so the sweep is what decides rather than the limiter. */
function passCap(config: { maxConcurrentWorkers: number }, value: number): void {
  config.maxConcurrentWorkers = value
}

test('a project that is not connected is left alone by the sweep', async () => {
  // An issue whose repository is gone would otherwise be refused on every tick, forever,
  // filling the log with the same message.
  const store = createMemoryFactStore()
  const config = normalizePluginConfig({})
  await store.issues.put('iss-orphan', {
    id: 'iss-orphan', number: 1, repoId: 'repo-gone', title: 'orphaned', state: 'open',
    pendingWorker: true, createdAt: 1, updatedAt: 1,
  })
  const outcome = await fillSlots({ store: lazyFactStore(async () => store), config, spawn: {} as never, run: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never } as never)
  assert.deepEqual(outcome.started, [])
  assert.equal(
    (await store.issues.get('iss-orphan') as { pendingWorker?: boolean }).pendingWorker,
    true,
    'the request is kept, not consumed by a refusal',
  )
})

test('connectRepo is exported for the harness and keeps the identity', async () => {
  // A guard on the fixture itself: if the preflight stopped producing a repo record, every
  // test above would fail for a reason that had nothing to do with settings.
  const { repo } = await harness()
  const again = await connectRepo({
    run: (async (argv: readonly string[]) => {
      const joined = argv.join(' ')
      if (joined.startsWith('git rev-parse')) return { exitCode: 0, stdout: 'true\n', stderr: '' }
      if (joined.startsWith('git check-ignore')) return { exitCode: 0, stdout: '', stderr: '' }
      if (joined.startsWith('gh auth status')) return { exitCode: 0, stdout: 'Logged in', stderr: '' }
      return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: REPOSITORY, defaultBranchRef: { name: 'main' } }), stderr: '' }
    }) as never,
    rootPath: repo.rootPath,
    previous: repo,
    id: repo.id,
  })
  assert.ok(again.ok)
  assert.equal(again.repo.id, repo.id)
})

test('the REVIEWER permission preset reaches the reviewer spawn, per project, and clearing it returns to the default', async () => {
  // Measured live: the reviewer runs under `read-only` + `approval: ask`, and a read-only
  // sandbox has no writable TEMP directory -- so a reviewer that staged a file before
  // posting (`<<'JSON'`, `--input -`) died with "cannot create temp file for here
  // document", escalated, and then waited forever on an approval nobody could answer. The
  // auto-review loop is dead until this boundary is right.
  const { store, deps, repo, spawn } = await harness()

  const started = await startWorkerForTool(deps as never, { title: 'Review me' })
  const workerId = /\b(wrk-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(started)?.[1]
  assert.ok(workerId, started)
  const worker = normalizeWorker(await store.workers.get(workerId!))
  await store.workers.put(workerId!, {
    ...worker,
    pr: { number: 8, url: 'https://example.invalid/acme/widgets/pull/8', headSha: 'b'.repeat(40) },
    lastSignalAt: NOW - 10 * 60 * 1000,
  })
  await store.prSnapshots.put(workerId!, { workerId, url: 'https://example.invalid/acme/widgets/pull/8', headSha: 'b'.repeat(40), fetched: true })
  deps.live.register({
    workerId: workerId!,
    sessionId: worker.sessionId,
    handle: { agent: { session: { id: worker.sessionId }, status: 'idle', followup() {} }, async dispose() {} },
  })

  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { reviewerPermissionPreset: 'workspace-write' } })
  spawn.appliedPermissions.length = 0
  let sweep = await sweepReviewPasses(deps as never)
  assert.equal(sweep.scheduled.length, 1, `a pass is scheduled: ${JSON.stringify(sweep)}`)
  assert.ok(
    spawn.appliedPermissions.includes('workspace-write'),
    `the project boundary reaches the reviewer (applied: ${JSON.stringify(spawn.appliedPermissions)})`,
  )

  // Clearing it returns to the plugin default, which stays `read-only`: a reviewer must
  // mutate nothing, and widening it is a per-project decision rather than the new normal.
  await updateProjectSettings(deps as never, { repoId: repo.id, patch: { reviewerPermissionPreset: '' } })
  // A NEW head, because a judged head is never re-judged (A20) -- the sweep would have
  // nothing to do and the assertion below would pass for the wrong reason.
  const atNewHead = normalizeWorker(await store.workers.get(workerId!))
  await store.workers.put(workerId!, {
    ...atNewHead,
    pr: { number: 8, url: 'https://example.invalid/acme/widgets/pull/8', headSha: 'c'.repeat(40) },
    lastSignalAt: NOW - 10 * 60 * 1000,
  })
  await store.prSnapshots.put(workerId!, { workerId, url: 'https://example.invalid/acme/widgets/pull/8', headSha: 'c'.repeat(40), fetched: true })
  spawn.appliedPermissions.length = 0
  sweep = await sweepReviewPasses(deps as never)
  assert.ok(
    spawn.appliedPermissions.includes(deps.config.reviewerPermissionPreset),
    `empty falls back to the plugin default (applied: ${JSON.stringify(spawn.appliedPermissions)})`,
  )
  assert.equal(deps.config.reviewerPermissionPreset, 'read-only', 'and the default boundary is unchanged')
})
