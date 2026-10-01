/**
 * The new-task flow end to end, with a REAL worktree and the real board.
 *
 * The unit tests prove the rules; this proves the thing the user sees: a task created from a
 * brief is on the board immediately, under a name taken from that brief, and that name
 * becomes the worker's own once the worker answers -- through the real reducer, so the card
 * that moves is the card the GUI draws.
 *
 * What is real here: git (a real repository, a real worktree on a real branch), the issue
 * store, the worktree manager, the spawn recipe's call order, the board. What is faked: the
 * agent session (`gh` is not involved at all -- nothing in this flow opens a pull request).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizePluginConfig } from '../../src/config/validate.ts'
import { createLiveWorkers } from '../../src/host/handle-registry.ts'
import { buildBoard } from '../../src/host/board-service.ts'
import { createTaskRefinements } from '../../src/host/task-refinements.ts'
import { createTaskWithWorker, setTaskTitleForTool } from '../../src/host/tasks-service.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { normalizeWorker } from '../../src/domain/workers.ts'
import type { SpawnDeps } from '../../src/host/spawn.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const NOW = 10_000_000

/** A real repository with a real commit, because git work needs somewhere to stand. */
function scratchRepo(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsho-task-'))
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: path, stdio: 'pipe' })
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'task@example.invalid')
  git('config', 'user.name', 'Task')
  writeFileSync(join(path, 'README.md'), '# task\n')
  writeFileSync(join(path, '.gitignore'), '.dsho/\n')
  git('add', '.')
  git('commit', '-m', 'init')
  return path
}

/** A REAL subprocess seam: it actually runs the command, in the scratch repository. */
function realRun(rootPath: string): RunCommand {
  return async (argv): Promise<CommandResult> => {
    try {
      const stdout = execFileSync(argv[0]!, argv.slice(1), { cwd: rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { exitCode: 0, stdout, stderr: '' }
    } catch (error) {
      const failure = error as { status?: number; stdout?: unknown; stderr?: unknown }
      return {
        exitCode: failure.status ?? 1,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : String(error),
      }
    }
  }
}

/** A spawn seam that records the admitted prompt and returns a live handle. */
function spawnFixture() {
  const sessions: string[] = []
  const prompts: string[] = []
  const deps: SpawnDeps = {
    permissionPresets: { resolve: () => undefined, set() {} },
    agentPresets: {
      async resolve() {
        return { id: 'standard' }
      },
      async acquireScope() {
        return { dispose() {} }
      },
      async mount() {},
    },
    workspaceRegistry: {
      async create(path) {
        return { path, async attachSession() {} }
      },
    },
    sessionTitle: { rename() {} },
    agents: {
      async create(options) {
        sessions.push(options.sessionId)
        return {
          agent: {
            session: { id: options.sessionId },
            status: 'idle' as const,
            followup(message: { content: Array<{ text: string }> }) {
              prompts.push(message.content.map((block) => block.text).join('\n'))
            },
          },
          async dispose() {},
        }
      },
    },
    userMessage: (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
  return { deps, sessions, prompts }
}

test('a task from a brief is on the board at once, and takes the worker\'s name when it answers', async () => {
  const rootPath = scratchRepo()
  const store = createMemoryFactStore()
  await store.repos.put('repo-1', {
    id: 'repo-1',
    rootPath,
    defaultBranch: 'main',
    verifyCommands: ['pnpm test'],
    intakeEnabled: true,
  })
  const config = normalizePluginConfig({})
  const spawn = spawnFixture()
  const refinements = createTaskRefinements()
  const live = createLiveWorkers()
  const deps = {
    store: lazyFactStore(async () => store),
    run: realRun(rootPath),
    spawn: spawn.deps,
    config,
    refinements,
    live,
    now: () => NOW,
  }

  // 1. One brief, and a task exists with a name on it.
  const outcome = await createTaskWithWorker(deps, { brief: 'fix the flaky auth test in the login flow' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.started, true)
  assert.equal(outcome.title, 'fix the flaky auth test in the login flow')

  // 2. The worktree is REAL, and the worker was pointed at it.
  const workerId = outcome.workerId!
  const worker = normalizeWorker(await store.workers.get(workerId))
  assert.equal(worker.branch, 'dsho/issue-1-fix-the-flaky-auth-test-in-the-login-flow')
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: rootPath, encoding: 'utf8' })
  assert.ok(worktrees.includes(worker.worktreePath), 'a real worktree on disk')

  // 3. The worker was asked to name the task, once, and told it is not extra work.
  assert.match(spawn.prompts[0]!, /## Name this task/)
  assert.match(spawn.prompts[0]!, /orchestrator_task_title/)

  // 4. The board -- the REAL reducer -- shows it, under the brief's own words.
  const cardTitle = async (): Promise<string> => {
    const board = await buildBoard({ store: deps.store, config, now: () => NOW, activityOf: () => 'idle' })
    const card = Object.values(board.lenses.lanes).flat().find((candidate) => candidate.id === workerId)
    return card?.title ?? '(no card)'
  }
  assert.equal(await cardTitle(), '#1 fix the flaky auth test in the login flow')

  // 5. The worker answers, and the same card is renamed -- no second card, no empty one.
  const answered = await setTaskTitleForTool(deps, { title: 'Fix the flaky login test' }, spawn.sessions[0]!)
  assert.match(answered, /is now titled "Fix the flaky login test"/)
  assert.equal(await cardTitle(), '#1 Fix the flaky login test')

  // 6. The wait is over: nothing else may rename it.
  assert.equal(refinements.pending(), 0)
})
