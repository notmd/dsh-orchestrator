/**
 * Repository preflight.
 *
 * The whole value of `orchestrator_repo_connect` is finding out that something is
 * wrong **before** a worker is spawned against a repository rather than during, so
 * every test here is about *refusing well*: the right reason code, and a message
 * that names the fix.
 *
 * Acceptance criteria touched: R3 (a missing `gh` fails loudly with the exact
 * prerequisite), R4 (an unignored worktree root cannot be connected).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RepoRefusal, connectRepo, describeRepoConnect } from '../../src/host/repo.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const ROOT = '/Users/me/code/myrepo'
const NOW = 1_700_000_000_000
const REPO_JSON = JSON.stringify({
  nameWithOwner: 'acme/widgets',
  defaultBranchRef: { name: 'main' },
})

interface Scripted {
  /** Answer `git rev-parse --is-inside-work-tree`. */
  isWorkTree?: boolean
  /** Exit code for `git check-ignore --quiet`. */
  checkIgnore?: number
  /** Answer `gh auth status`. */
  auth?: Partial<CommandResult>
  /** Answer `gh repo view . --json …`. */
  repoView?: Partial<CommandResult>
}

/** A fake host that answers by argv, so the script reads like the preflight. */
function fakeRun(script: Scripted): { run: RunCommand; readonly calls: string[][] } {
  const calls: string[][] = []
  const run: RunCommand = async (argv, options) => {
    calls.push([...argv])
    assert.ok(options?.cwd, `every preflight call needs a cwd: ${argv.join(' ')}`)
    const joined = argv.join(' ')

    if (joined.startsWith('git rev-parse --is-inside-work-tree')) {
      return { exitCode: 0, stdout: script.isWorkTree === false ? 'false\n' : 'true\n', stderr: '' }
    }
    if (joined.startsWith('git check-ignore')) {
      return { exitCode: script.checkIgnore ?? 0, stdout: '', stderr: '' }
    }
    if (joined.startsWith('gh auth status')) {
      return { exitCode: 0, stdout: '', stderr: '', ...script.auth }
    }
    if (joined.startsWith('gh repo view')) {
      return { exitCode: 0, stdout: REPO_JSON, stderr: '', ...script.repoView }
    }
    throw new Error(`unexpected command: ${joined}`)
  }
  return {
    run,
    get calls() {
      return calls
    },
  }
}

function connect(script: Scripted = {}, overrides: Partial<Parameters<typeof connectRepo>[0]> = {}) {
  const fake = fakeRun(script)
  return { fake, result: connectRepo({ run: fake.run, rootPath: ROOT, id: 'repo-1', now: NOW, ...overrides }) }
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a healthy repository connects, with the identity read from gh', async () => {
  const { result } = connect()
  const outcome = await result
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.repo.owner, 'acme')
  assert.equal(outcome.repo.name, 'widgets')
  assert.equal(outcome.repo.defaultBranch, 'main')
  assert.equal(outcome.repo.rootPath, ROOT)
  assert.equal(outcome.repo.id, 'repo-1')
  assert.equal(outcome.repo.createdAt, NOW)
  assert.deepEqual(outcome.notes, [])
})

test('the preflight runs in the cheapest-first order', async () => {
  // git before gh, and check-ignore before auth: each step is cheap, and failing
  // at the first stops the later, more expensive calls.
  const { fake, result } = connect()
  await result
  assert.deepEqual(
    fake.calls.map((argv) => argv.slice(0, 3).join(' ')),
    [
      'git rev-parse --is-inside-work-tree',
      'git check-ignore --quiet',
      'gh auth status',
      'gh repo view',
    ],
  )
})

test('the default worktree root is used, and an override is honoured', async () => {
  const first = await connect().result
  assert.equal(first.ok && first.repo.worktreeRoot, '.dsho/worktrees')
  const second = await connect({}, { worktreeRoot: '/tmp/wt' }).result
  assert.equal(second.ok && second.repo.worktreeRoot, '/tmp/wt')
})

test('verify commands are carried onto the record', async () => {
  const outcome = await connect({}, { verifyCommands: ['pnpm typecheck', 'pnpm test'] }).result
  assert.ok(outcome.ok)
  assert.deepEqual(outcome.repo.verifyCommands, ['pnpm typecheck', 'pnpm test'])
})

test('a missing default branch is a note, not a refusal', async () => {
  // The repository is usable; only the base branch is unknown. Refusing would be
  // disproportionate, and the user can still set it explicitly.
  const outcome = await connect({
    repoView: { stdout: JSON.stringify({ nameWithOwner: 'acme/widgets' }) },
  }).result
  assert.ok(outcome.ok)
  assert.equal(outcome.repo.defaultBranch, '')
  assert.match(outcome.notes.join(' '), /default branch could not be read/)
})

// ---------------------------------------------------------------------------
// Refusals — each names the fix
// ---------------------------------------------------------------------------

test('a missing path is refused before running anything', async () => {
  const fake = fakeRun({})
  const outcome = await connectRepo({ run: fake.run, rootPath: '  ' })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.missingPath)
  assert.deepEqual(fake.calls, [], 'nothing was run')
})

test('a directory that is not a git work tree is refused', async () => {
  const { fake, result } = connect({ isWorkTree: false })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.notARepository)
  assert.match(!outcome.ok ? outcome.message : '', /not inside a git work tree/)
  assert.equal(fake.calls.length, 1, 'gh was never reached')
})

test('an unignored worktree root is refused, with the .gitignore line named', async () => {
  // R4. Not a warning: an unignored worktree root commits every worker's tree into
  // the user's history, and they would find out at their next commit.
  const { result } = connect({ checkIgnore: 1 })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.worktreeRootNotIgnored)
  assert.match(!outcome.ok ? outcome.message : '', /\.dsho\/worktrees\//)
  assert.match(!outcome.ok ? outcome.message : '', /\.gitignore/)
})

test('a failing check-ignore is not read as "ignored"', async () => {
  // Exit 128 means git itself failed. Treating it as ignored would let an
  // unignored worktree root through -- the exact bug the check exists to prevent.
  const { result } = connect({ checkIgnore: 128 })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.worktreeRootNotIgnored)
})

test('a missing gh is refused with the exact prerequisite (R3)', async () => {
  const { result } = connect({
    auth: { exitCode: 127, stderr: 'gh: command not found' },
  })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.ghMissing)
  assert.equal(!outcome.ok && outcome.kind, 'not-installed')
  assert.match(!outcome.ok ? outcome.message : '', /not installed or not on PATH/)
})

test('an unauthenticated gh is refused and says how to log in', async () => {
  const { result } = connect({
    auth: { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.' },
  })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.ghUnauthenticated)
  assert.match(!outcome.ok ? outcome.message : '', /gh auth login/)
})

test('a gh repo view failure is classified and explained', async () => {
  const { result } = connect({
    repoView: { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' },
  })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.kind, 'rate-limited')
  assert.match(!outcome.ok ? outcome.message : '', /rate limit/)
})

test('unreadable repository JSON is refused rather than guessed at', async () => {
  const { result } = connect({ repoView: { stdout: 'not json' } })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.badRepoView)
})

test('a repository identity without owner/name is refused', async () => {
  const { result } = connect({ repoView: { stdout: JSON.stringify({ nameWithOwner: 'justaname' }) } })
  const outcome = await result
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.reason, RepoRefusal.badRepoView)
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('a connected repository renders its identity and its isolation promise', async () => {
  const outcome = await connect({}, { verifyCommands: ['pnpm test'] }).result
  const text = describeRepoConnect(outcome)
  assert.match(text, /Connected acme\/widgets/)
  assert.match(text, /worktree root: \.dsho\/worktrees\/ \(gitignored\)/)
  assert.match(text, /verify commands: pnpm test/)
  assert.match(text, /their own git worktree/)
})

test('a refusal renders the reason and the fix', async () => {
  const outcome = await connect({ checkIgnore: 1 }).result
  const text = describeRepoConnect(outcome)
  assert.match(text, /Repository not connected/)
  assert.match(text, /worktree-root-not-ignored/)
  assert.match(text, /\.gitignore/)
})

test('an unknown default branch renders honestly rather than blank', async () => {
  const outcome = await connect({
    repoView: { stdout: JSON.stringify({ nameWithOwner: 'acme/widgets' }) },
  }).result
  assert.match(describeRepoConnect(outcome), /default branch: \(unknown\)/)
})
