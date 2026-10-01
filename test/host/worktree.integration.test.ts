/**
 * The worktree manager against **real git**.
 *
 * The unit tests assert the argv we *intend* to run. This asserts that git
 * accepts it — which is the part a fake cannot check, and the part that would
 * otherwise fail for the first time inside a user's repository.
 *
 * Skipped when `git` is unavailable rather than failing, so the suite stays
 * runnable on a machine without it. Everything happens in a fresh temporary
 * repository; nothing touches the checkout this test lives in.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { WorktreeManager, canonicalize } from '../../src/host/worktree.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const execFileAsync = promisify(execFile)

/** Real git, through the same seam the host uses. */
const runGit: RunCommand = async (argv, options): Promise<CommandResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd: options?.cwd,
      timeout: options?.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

/** A throwaway repository with one commit and a gitignored worktree root. */
async function scratchRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsho-worktree-'))
  await runGit(['git', 'init', '--initial-branch=main'], { cwd: root })
  await runGit(['git', 'config', 'user.email', 'test@example.invalid'], { cwd: root })
  await runGit(['git', 'config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# scratch\n')
  // The worktree root must be ignored, or every worker's tree would land in the
  // user's history (R4). Asserting the *check* works needs it to be true here.
  writeFileSync(join(root, '.gitignore'), '.dsho/\n')
  await runGit(['git', 'add', '.'], { cwd: root })
  await runGit(['git', 'commit', '-m', 'init'], { cwd: root })
  return root
}

async function hasGit(): Promise<boolean> {
  const result = await runGit(['git', '--version'])
  return result.exitCode === 0
}

const gitAvailable = await hasGit()

test('worktree lifecycle against real git', { skip: gitAvailable ? false : 'git is not installed' }, async (t) => {
  const root = await scratchRepository()
  const manager = new WorktreeManager({ run: runGit, rootPath: root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await t.test('the scratch repository is a work tree', async () => {
    assert.equal((await manager.git(['rev-parse', '--is-inside-work-tree'])).stdout.trim(), 'true')
  })

  await t.test('the worktree root is gitignored', async () => {
    assert.equal(await manager.isWorktreeRootIgnored(), true)
  })

  await t.test('an unignored worktree root is reported as not ignored', async () => {
    // The negative case matters more than the positive one: treating a failure as
    // "ignored" would let an unignored root commit every worker's tree.
    writeFileSync(join(root, '.gitignore'), 'nothing-here\n')
    assert.equal(await manager.isWorktreeRootIgnored(), false)
    writeFileSync(join(root, '.gitignore'), '.dsho/\n')
    assert.equal(await manager.isWorktreeRootIgnored(), true)
  })

  const created = await manager.create({ issueNumber: 3, title: 'Fix the flaky auth test', baseBranch: 'main' })

  await t.test('create makes a real directory on a real branch', async () => {
    assert.equal(created.created, true)
    assert.equal(created.branch, 'dsho/issue-3-fix-the-flaky-auth-test')
    assert.ok(existsSync(created.path), `expected ${created.path} to exist`)

    // The branch is what a PR will come from, so it must exist as a ref.
    const ref = await manager.git(['show-ref', '--verify', `refs/heads/${created.branch}`])
    assert.equal(ref.exitCode, 0, ref.stderr)
  })

  await t.test('the worktree is a usable checkout at the base commit', async () => {
    const inside = await runGit(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: created.path })
    assert.equal(inside.stdout.trim(), 'true')
    assert.ok(existsSync(join(created.path, 'README.md')), 'the base commit was checked out')
    const status = await runGit(['git', 'status', '--porcelain'], { cwd: created.path })
    assert.equal(status.stdout.trim(), '', 'the fresh worktree is clean')
  })

  await t.test('two issues get two distinct trees that cannot see each other', async () => {
    // A3. This is the whole reason the plugin uses worktrees.
    const second = await manager.create({ issueNumber: 4, title: 'Fix the flaky auth test', baseBranch: 'main' })
    assert.notEqual(second.path, created.path)
    assert.notEqual(second.branch, created.branch)

    writeFileSync(join(created.path, 'only-in-worker-3.txt'), 'x\n')
    assert.ok(existsSync(join(created.path, 'only-in-worker-3.txt')))
    assert.ok(
      !existsSync(join(second.path, 'only-in-worker-3.txt')),
      "worker 4 must not see worker 3's uncommitted file",
    )
    await manager.remove(second.path)
  })

  await t.test('create is idempotent against real git', async () => {
    const again = await manager.create({ issueNumber: 3, title: 'Fix the flaky auth test' })
    assert.equal(again.created, false)
    assert.equal(again.path, created.path)
  })

  await t.test('list reports the human checkout and the worker worktree', async () => {
    const entries = await manager.list()
    const paths = entries.map((entry) => entry.path)
    // git reports realpath-resolved paths, so compare canonical to canonical.
    assert.ok(paths.includes(canonicalize(root)), 'the human checkout is listed')
    assert.ok(paths.includes(created.path), 'the worker worktree is listed')
    assert.equal(entries.find((entry) => entry.path === created.path)?.branch, created.branch)
  })

  await t.test('remove forces past the uncommitted file the worker left behind', async () => {
    // The file written above makes a plain `git worktree remove` fail, which is
    // exactly why the manager passes --force.
    const plain = await runGit(['git', 'worktree', 'remove', created.path], { cwd: root })
    assert.notEqual(plain.exitCode, 0, 'git does refuse without --force')

    const removed = await manager.remove(created.path)
    assert.equal(removed.removed, true)
    assert.ok(!existsSync(created.path))
  })

  await t.test('the branch survives its worktree, so the PR can still be opened', async () => {
    // `git worktree remove` does not delete the branch: the commits are the work.
    const ref = await manager.git(['show-ref', '--verify', `refs/heads/${created.branch}`])
    assert.equal(ref.exitCode, 0)
  })

  await t.test('pruneAll removes only the worktrees under the root', async () => {
    const a = await manager.create({ issueNumber: 7, title: 'Kept' })
    const b = await manager.create({ issueNumber: 8, title: 'Removed too' })
    const result = await manager.pruneAll()
    assert.deepEqual(result.removed.sort(), [a.path, b.path].sort())
    assert.ok(existsSync(root), 'the human checkout is untouched')
    assert.ok(!result.removed.includes(canonicalize(root)), 'never the human checkout')
    assert.equal((await manager.git(['rev-parse', '--is-inside-work-tree'])).stdout.trim(), 'true')
  })

  await t.test('remove of an unknown path is not an error', async () => {
    assert.deepEqual(await manager.remove(join(root, 'never-existed')), { removed: false })
  })
})
