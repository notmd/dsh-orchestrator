/**
 * M0 integration spike — the whole path, headlessly.
 *
 * Drives the same functions the tools call, in order, against the real host
 * services: connect a repository, create an issue, start a worker (which creates a
 * real worktree and spawns a real session), then build the board. Its result goes to
 * a file, because a host-side outcome is otherwise invisible from outside.
 *
 * A spike, not product code. Kept out of the shipped bundle.
 *
 * @module dsho/spike/e2e-spike
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { FACT_SCHEMAS } from '../host/schemas.ts'
import { lazyFactStore, openFactStore } from '../host/store.ts'
import { createRunCommand } from '../host/exec.ts'
import { createSpawnDeps } from '../host/spawn-deps.ts'
import { createLiveWorkers } from '../host/handle-registry.ts'
import { connectRepoForTool } from '../host/tools.ts'
import { createIssueForTool } from '../host/issues-service.ts'
import { startWorkerForTool } from '../host/workers-service.ts'
import { buildBoard } from '../host/board-service.ts'
import { normalizePluginConfig } from '../config/validate.ts'
import type { HostContext } from '../host/context.ts'

export const name = 'e2e-spike'

/** Every service the path needs, so a missing one fails loudly at activation. */
export const inject = [
  'subprocess',
  'storageDomain',
  'agents',
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
  'sessionTitle',
]

const REPO = '/tmp/dsho-e2e'
const RESULT = '/tmp/dsho-e2e-result.json'
const ORIGIN = 'https://github.com/Untrivial-ai/agent-orchestrator.git'

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
  record('begin', { repo: REPO, origin: ORIGIN })
  try {
    // A scratch repository the spike owns. The remote is only so `gh repo view .`
    // can resolve an identity; the worktree lands under /tmp either way.
    rmSync(REPO, { recursive: true, force: true })
    mkdirSync(REPO, { recursive: true })
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: REPO })
    execFileSync('git', ['config', 'user.email', 'spike@example.invalid'], { cwd: REPO })
    execFileSync('git', ['config', 'user.name', 'Spike'], { cwd: REPO })
    writeFileSync(`${REPO}/README.md`, '# spike\n')
    writeFileSync(`${REPO}/.gitignore`, '.dsho/\n')
    execFileSync('git', ['add', '.'], { cwd: REPO })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: REPO })
    execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: REPO })
    record('scratch-repo:ready')

    const config = normalizePluginConfig()
    const run = createRunCommand({ subprocess: ctx.subprocess, cwd: REPO })
    const store = lazyFactStore(() => openFactStore({ facility: ctx.storageDomain, schemas: FACT_SCHEMAS }))
    const spawn = createSpawnDeps(ctx)
    const live = createLiveWorkers()

    const connected = await connectRepoForTool({ config, run, store }, { path: REPO, verifyCommands: ['true'] })
    record('repo_connect', { summary: connected.split('\n').slice(0, 2).join(' | ') })
    if (!connected.startsWith('Connected')) {
      record('stopped', { why: 'the repository was not connected', message: connected })
      finish(false, { message: connected })
      return
    }

    const created = await createIssueForTool({ store }, { title: 'Prove the loop end to end' })
    record('issue_create', { summary: created.split('\n')[0] })
    const issueId = /\b(iss-[0-9A-HJKMNP-TV-Z]{26})\b/.exec(created)?.[1]
    if (!issueId) {
      finish(false, { message: `no issue id in: ${created}` })
      return
    }

    const started = await startWorkerForTool({ run, store, spawn, config, live }, { issueId })
    record('worker_start', { summary: started.split('\n').slice(0, 6).join(' | ') })

    const board = await buildBoard({ store, config, activityOf: () => 'idle' })
    record('board', {
      counts: board.counts,
      lanes: Object.fromEntries(
        Object.entries(board.lenses.lanes).map(([lane, cards]) => [lane, cards.map((card) => card.title)]),
      ),
      statuses: Object.values(board.lenses.lanes)
        .flat()
        .map((card) => `${card.title} -> ${card.displayStatus}`),
    })
    finish(started.startsWith('Started'), {})
  } catch (error) {
    record('failed', { message: error instanceof Error ? error.message : String(error) })
    finish(false, { message: error instanceof Error ? error.message : String(error) })
  }
}

function finish(ok: boolean, detail: Record<string, unknown>): void {
  try {
    writeFileSync(RESULT, JSON.stringify({ ok, detail, steps }, null, 2))
  } catch {
    // As above.
  }
}
