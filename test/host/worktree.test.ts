/**
 * The worktree manager.
 *
 * Two things here are worth more than the rest combined: that the **slug cannot
 * escape anywhere** (it becomes both a git branch component *and* a directory
 * name), and that **cleanup is scoped to the worktree root** so it can never
 * remove the human's own checkout. Both are asserted directly.
 *
 * Acceptance criteria touched: A3 (two concurrent workers have two distinct
 * worktrees and branches), A9 (unloading leaves worktrees intact), R4 (disk use
 * is bounded and `.dsho/` is ignored), R7 (a worker cannot reach outside its tree).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BRANCH_NAMESPACE,
  DEFAULT_WORKTREE_ROOT,
  GitCommandError,
  MAX_SLUG_LENGTH,
  WorktreeManager,
  branchName,
  isIgnored,
  isGitRepository,
  parseWorktreeList,
  slugify,
  worktreeDirectoryName,
  worktreePath,
} from '../../src/host/worktree.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const ROOT = '/Users/me/code/myrepo'

/** A fake git that records argv and answers from a script. */
function fakeGit(answers: Array<Partial<CommandResult>> = []): {
  run: RunCommand
  readonly calls: string[][]
  readonly cwds: Array<string | undefined>
} {
  const calls: string[][] = []
  const cwds: Array<string | undefined> = []
  let index = 0
  const run: RunCommand = async (argv, options) => {
    calls.push([...argv])
    cwds.push(options?.cwd)
    const answer = answers[index++] ?? { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '', ...answer }
  }
  return {
    run,
    get calls() {
      return calls
    },
    get cwds() {
      return cwds
    },
  }
}

const OK = { exitCode: 0, stdout: '', stderr: '' }

// ---------------------------------------------------------------------------
// Slug and naming — the security-relevant part
// ---------------------------------------------------------------------------

test('slugify collapses anything outside [a-z0-9] to a single dash', () => {
  assert.equal(slugify('Fix the flaky auth test'), 'fix-the-flaky-auth-test')
  assert.equal(slugify('  Trim   me  '), 'trim-me')
  assert.equal(slugify('UPPER_case/and-mixed'), 'upper-case-and-mixed')
})

test('slugify makes traversal and shell metacharacters impossible, not escaped', () => {
  // The slug becomes both a branch component and a directory name, so the safe
  // move is to make dangerous input unrepresentable rather than to escape it.
  for (const hostile of [
    '../../etc/passwd',
    '..',
    'a/../b',
    '$(rm -rf /)',
    '`whoami`',
    'a;b&&c|d',
    '~/home',
    '\\..\\..\\windows',
    'new\nline',
  ]) {
    const slug = slugify(hostile)
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/, `${hostile} -> ${slug}`)
    assert.ok(!slug.includes('..'), `${hostile} produced a traversal segment`)
    assert.ok(!slug.includes('/'), `${hostile} produced a separator`)
  }
})

test('slugify never returns an empty segment', () => {
  for (const empty of ['', '   ', '!!!', '---', '···']) {
    assert.equal(slugify(empty), 'issue', JSON.stringify(empty))
  }
})

test('slugify bounds its length and does not leave a trailing dash', () => {
  const long = slugify('a'.repeat(200))
  assert.equal(long.length, MAX_SLUG_LENGTH)
  const exactly = slugify(`${'a'.repeat(MAX_SLUG_LENGTH)} tail`)
  assert.ok(exactly.length <= MAX_SLUG_LENGTH)
  assert.ok(!exactly.endsWith('-'), exactly)
})

test('branchName uses the dsho namespace and the issue segment', () => {
  assert.equal(branchName({ issueNumber: 3, title: 'Fix the flaky auth test' }), 'dsho/issue-3-fix-the-flaky-auth-test')
  assert.equal(BRANCH_NAMESPACE, 'dsho')
})

test('branchName inserts a configured prefix as a middle segment', () => {
  assert.equal(
    branchName({ issueNumber: 12, title: 'Add retries', prefix: 'web' }),
    'dsho/web/issue-12-add-retries',
  )
  assert.equal(
    branchName({ issueNumber: 12, title: 'Add retries', prefix: '  ' }),
    'dsho/issue-12-add-retries',
    'a blank prefix adds no segment',
  )
})

test('branchName refuses a nonsense issue number', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => branchName({ issueNumber: bad, title: 'x' }), /positive integer/)
  }
})

test('two issues never collide on a branch or a path, even with identical titles', () => {
  // A3: concurrent workers must not share a branch or a tree.
  const one = branchName({ issueNumber: 1, title: 'Same title' })
  const two = branchName({ issueNumber: 2, title: 'Same title' })
  assert.notEqual(one, two)
  assert.notEqual(worktreeDirectoryName(1, 'Same title'), worktreeDirectoryName(2, 'Same title'))
})

test('worktreePath defaults under the repo and honours an override', () => {
  assert.equal(worktreePath({ rootPath: ROOT, issueNumber: 3, title: 'Fix it' }), `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`)
  assert.equal(worktreePath({ rootPath: ROOT, issueNumber: 3, title: 'Fix it', worktreeRoot: '/tmp/wt' }), '/tmp/wt/issue-3-fix-it')
  assert.equal(worktreePath({ rootPath: `${ROOT}/`, issueNumber: 3, title: 'Fix it' }), `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`)
})

test('a hostile title cannot move the worktree out of its root', () => {
  const path = worktreePath({ rootPath: ROOT, issueNumber: 7, title: '../../../../tmp/evil' })
  assert.ok(path.startsWith(`${ROOT}/${DEFAULT_WORKTREE_ROOT}/`), path)
  assert.ok(!path.includes('..'), path)
})

// ---------------------------------------------------------------------------
// porcelain parsing
// ---------------------------------------------------------------------------

const PORCELAIN = [
  'worktree /Users/me/code/myrepo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /Users/me/code/myrepo/.dsho/worktrees/issue-3-fix-it',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/dsho/issue-3-fix-it',
  '',
  'worktree /Users/me/code/myrepo/.dsho/worktrees/detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n')

test('parseWorktreeList reads every field and strips the refs/heads prefix', () => {
  const entries = parseWorktreeList(PORCELAIN)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries[0], {
    path: '/Users/me/code/myrepo',
    head: '1111111111111111111111111111111111111111',
    branch: 'main',
  })
  assert.equal(entries[1]!.branch, 'dsho/issue-3-fix-it')
  assert.equal(entries[2]!.detached, true)
  assert.equal(entries[2]!.branch, undefined)
})

test('parseWorktreeList tolerates an empty or trailing-blank listing', () => {
  assert.deepEqual(parseWorktreeList(''), [])
  assert.deepEqual(parseWorktreeList('\n\n'), [])
  assert.equal(parseWorktreeList(`${PORCELAIN}\n\n`).length, 3)
})

test('parseWorktreeList marks a bare worktree', () => {
  const entries = parseWorktreeList('worktree /srv/repo.git\nbare\n')
  assert.equal(entries[0]!.bare, true)
})

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

test('create makes the branch as part of the add, in one call', async () => {
  const git = fakeGit([
    OK, // worktree list --porcelain
    { exitCode: 1 }, // show-ref: branch does not exist
    OK, // worktree add -b
  ])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  const created = await manager.create({ issueNumber: 3, title: 'Fix it', baseBranch: 'main' })

  assert.equal(created.branch, 'dsho/issue-3-fix-it')
  assert.equal(created.path, `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`)
  assert.equal(created.created, true)
  assert.deepEqual(git.calls.at(-1), [
    'git',
    'worktree',
    'add',
    '-b',
    'dsho/issue-3-fix-it',
    `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`,
    'main',
  ])
})

test('create attaches an existing branch instead of re-creating it', async () => {
  // A retry after a partial failure must resume, not fail on "branch exists".
  const git = fakeGit([OK, { exitCode: 0 }, OK])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  await manager.create({ issueNumber: 3, title: 'Fix it' })
  assert.deepEqual(git.calls.at(-1), [
    'git',
    'worktree',
    'add',
    `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`,
    'dsho/issue-3-fix-it',
  ])
})

test('create is idempotent when the worktree already exists', async () => {
  const git = fakeGit([{ exitCode: 0, stdout: PORCELAIN, stderr: '' }])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  const result = await manager.create({ issueNumber: 3, title: 'Fix it' })
  assert.equal(result.created, false)
  assert.equal(git.calls.length, 1, 'no add was attempted')
})

test('every git call carries a deadline and the right cwd', async () => {
  const git = fakeGit([OK, { exitCode: 1 }, OK])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT, timeoutMs: 5_000 })
  await manager.create({ issueNumber: 3, title: 'Fix it' })
  assert.deepEqual(git.cwds, [ROOT, ROOT, ROOT])
})

test('remove forces, because an archived worker may have left changes', async () => {
  const git = fakeGit([{ exitCode: 0, stdout: PORCELAIN, stderr: '' }, OK])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  const result = await manager.remove(`${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`)
  assert.equal(result.removed, true)
  assert.deepEqual(git.calls.at(-1), [
    'git',
    'worktree',
    'remove',
    '--force',
    `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`,
  ])
})

test('remove of a path git does not know is not an error', async () => {
  const git = fakeGit([OK])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  assert.deepEqual(await manager.remove('/tmp/never-existed'), { removed: false })
  assert.equal(git.calls.length, 1, 'nothing was removed')
})

test('pruneAll is scoped to the worktree root and can never remove the human checkout', async () => {
  const git = fakeGit([{ exitCode: 0, stdout: PORCELAIN, stderr: '' }, OK, OK])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  const result = await manager.pruneAll()

  assert.deepEqual(result.removed, [
    `${ROOT}/${DEFAULT_WORKTREE_ROOT}/issue-3-fix-it`,
    `${ROOT}/${DEFAULT_WORKTREE_ROOT}/detached`,
  ])
  for (const call of git.calls) {
    assert.ok(
      !call.includes(ROOT) || call.includes(DEFAULT_WORKTREE_ROOT),
      `a git call touched something outside the worktree root: ${call.join(' ')}`,
    )
  }
  assert.ok(
    !git.calls.some((call) => call.at(-1) === ROOT),
    'the human checkout is never a removal target',
  )
})

test('pruneAll reports nothing to do on a clean repository', async () => {
  const git = fakeGit([{ exitCode: 0, stdout: 'worktree /repo\nbranch refs/heads/main\n', stderr: '' }])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  assert.deepEqual(await manager.pruneAll(), { removed: [] })
})

test('a failed git call throws with the argv and git stderr in the message', async () => {
  const git = fakeGit([
    OK,
    { exitCode: 1 },
    { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\nmore detail' },
  ])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  await assert.rejects(() => manager.create({ issueNumber: 3, title: 'Fix it' }), (error) => {
    assert.ok(error instanceof GitCommandError)
    assert.equal(error.result.exitCode, 128)
    assert.match(error.message, /not a git repository/)
    assert.ok(!error.message.includes('more detail'), 'only the first line is used')
    assert.deepEqual(error.argv.slice(0, 3), ['git', 'worktree', 'add'])
    return true
  })
})

test('a git failure with no output still says something actionable', async () => {
  const git = fakeGit([OK, { exitCode: 1 }, { exitCode: 1, stdout: '', stderr: '' }])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  await assert.rejects(() => manager.create({ issueNumber: 3, title: 'Fix it' }), /no output/)
})

test('a relative rootPath is refused, because the worktree path is a session cwd', () => {
  assert.throws(() => new WorktreeManager({ run: fakeGit().run, rootPath: 'myrepo' }), /absolute path/)
  assert.throws(() => new WorktreeManager({ run: fakeGit().run, rootPath: '' }), /absolute path/)
})

test('worktreeRoot resolves relative to the repo and passes through an absolute one', () => {
  const relative = new WorktreeManager({ run: fakeGit().run, rootPath: ROOT })
  assert.equal(relative.worktreeRoot, `${ROOT}/.dsho/worktrees`)
  const absolute = new WorktreeManager({ run: fakeGit().run, rootPath: ROOT, worktreeRoot: '/tmp/wt' })
  assert.equal(absolute.worktreeRoot, '/tmp/wt')
})

// ---------------------------------------------------------------------------
// Repository preflight — R4 and R3
// ---------------------------------------------------------------------------

test('isGitRepository is true only for a clean, successful rev-parse', async () => {
  assert.equal(await isGitRepository(fakeGit([{ exitCode: 0, stdout: 'true\n' }]).run, ROOT), true)
  assert.equal(await isGitRepository(fakeGit([{ exitCode: 0, stdout: 'false\n' }]).run, ROOT), false)
  assert.equal(await isGitRepository(fakeGit([{ exitCode: 128 }]).run, ROOT), false)
})

test('isIgnored distinguishes "not ignored" from "git failed"', async () => {
  // `check-ignore` exits 0 when ignored, 1 when not, 128 on its own failure. Only
  // 0 may read as ignored: treating 128 as ignored would let an unignored
  // worktree root commit every worker's tree into the user's history.
  assert.equal(await isIgnored(fakeGit([{ exitCode: 0 }]).run, ROOT, '.dsho/'), true)
  assert.equal(await isIgnored(fakeGit([{ exitCode: 1 }]).run, ROOT, '.dsho/'), false)
  assert.equal(await isIgnored(fakeGit([{ exitCode: 128 }]).run, ROOT, '.dsho/'), false)
})

test('isWorktreeRootIgnored asks about the root with a trailing slash', async () => {
  const git = fakeGit([{ exitCode: 0 }])
  const manager = new WorktreeManager({ run: git.run, rootPath: ROOT })
  assert.equal(await manager.isWorktreeRootIgnored(), true)
  assert.deepEqual(git.calls[0], ['git', 'check-ignore', '--quiet', '.dsho/worktrees/'])
})
