/**
 * The command seam: argv over `ctx.subprocess`, bounded in time and output.
 *
 * The tests that matter here are the adversarial ones. A seam like this is easy
 * to write and easy to get subtly wrong in ways nobody notices until a hung `gh`
 * holds a worker's slot forever or a truncated payload parses as valid JSON.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXEC_DEFAULTS,
  FailureKind,
  classifyCommandFailure,
  createRunCommand,
  describeFailure,
  retryAfterMs,
} from '../../src/host/exec.ts'
import type { CollectedRead, SubprocessHandleLike, SubprocessLike } from '../../src/host/exec.ts'
import type { CommandResult } from '../../src/host/worktree.ts'

const CWD = '/repo'

interface FakeSpawn {
  argv: readonly string[]
  cwd: string
  stdio: unknown
  graceMs?: number
  signal?: AbortSignal
}

/** A fake subprocess that records every spawn and answers from a script. */
function fakeSubprocess(
  answer: Partial<{ exitCode: number | null; stdout: string; stderr: string; lossy: boolean }> = {},
  options: { neverExits?: boolean; delayMs?: number } = {},
): SubprocessLike & { readonly spawns: FakeSpawn[]; readonly terminated: number } {
  const spawns: FakeSpawn[] = []
  let terminated = 0
  return {
    spawn(spec) {
      spawns.push(spec as FakeSpawn)
      const read = (text: string, lossy: boolean): CollectedRead => ({ text, nextOffset: text.length, lossy })
      const handle: SubprocessHandleLike = {
        done: options.neverExits
          ? new Promise((_resolve, reject) => {
              spec.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            })
          : new Promise((resolve) =>
              setTimeout(
                () => resolve({ exitCode: answer.exitCode ?? 0, signal: null }),
                options.delayMs ?? 0,
              ),
            ),
        collected: {
          stdout: { readFrom: () => read(answer.stdout ?? '', answer.lossy ?? false) },
          stderr: { readFrom: () => read(answer.stderr ?? '', false) },
        },
        terminate() {
          terminated += 1
        },
      }
      return handle
    },
    get spawns() {
      return spawns
    },
    get terminated() {
      return terminated
    },
  }
}

test('a successful command is returned with both streams', async () => {
  const subprocess = fakeSubprocess({ exitCode: 0, stdout: 'hello\n', stderr: 'warn\n' })
  const run = createRunCommand({ subprocess, cwd: CWD })
  const result = await run(['gh', 'pr', 'view', '3'])
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.stderr, 'warn\n')
  assert.equal(result.truncated, false)
  assert.equal(result.timedOut, undefined)
})

test('argv is passed as an array, so there is no shell and nothing to quote', async () => {
  // The whole reason for subprocess over shell: a branch name or path with
  // spaces or metacharacters must arrive as one argument, not be reinterpreted.
  const subprocess = fakeSubprocess()
  const run = createRunCommand({ subprocess, cwd: CWD })
  await run(['git', 'worktree', 'add', '/repo/.dsho/worktrees/issue-3-a b; rm -rf /'])
  const spawn = subprocess.spawns[0]!
  assert.deepEqual(spawn.argv, ['git', 'worktree', 'add', '/repo/.dsho/worktrees/issue-3-a b; rm -rf /'])
  assert.equal(Array.isArray(spawn.argv), true)
})

test('every disposition is explicit, because the seam applies no defaults', async () => {
  const subprocess = fakeSubprocess()
  const run = createRunCommand({ subprocess, cwd: CWD, maxOutputBytes: 1_024 })
  await run(['gh', '--version'])
  assert.deepEqual(subprocess.spawns[0]!.stdio, {
    stdin: 'ignore',
    stdout: { maxBytes: 1_024 },
    stderr: { maxBytes: 1_024 },
  })
  assert.equal(subprocess.spawns[0]!.graceMs, EXEC_DEFAULTS.graceMs)
})

test('the caller cwd overrides the default, and the default is used otherwise', async () => {
  const subprocess = fakeSubprocess()
  const run = createRunCommand({ subprocess, cwd: CWD })
  await run(['git', 'status'])
  await run(['git', 'status'], { cwd: '/elsewhere' })
  assert.equal(subprocess.spawns[0]!.cwd, CWD)
  assert.equal(subprocess.spawns[1]!.cwd, '/elsewhere')
})

test('a command that exceeds its deadline is terminated and flagged', async () => {
  const subprocess = fakeSubprocess({}, { neverExits: true })
  const run = createRunCommand({ subprocess, cwd: CWD })
  const result = await run(['gh', 'pr', 'view', '3'], { timeoutMs: 20 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.equal(subprocess.terminated, 1, 'the child is not left behind')
  assert.ok(subprocess.spawns[0]!.signal, 'a signal was supplied so the service can kill it too')
})

test('a deadline arrives as a result, never as a throw, however the child reports it', async () => {
  // Callers branch on `timedOut`. If the same condition sometimes threw, every
  // caller would need a try/catch as well, and the ones that forgot would read a
  // timeout as an unknown crash.
  const rejecting = fakeSubprocess({}, { neverExits: true })
  const viaRejection = createRunCommand({ subprocess: rejecting, cwd: CWD })
  // A child that exits *after* the deadline: the timer wins the race, so this
  // exercises the other path into the same uniform result.
  const viaExit = createRunCommand({
    subprocess: fakeSubprocess({ exitCode: 143 }, { delayMs: 40 }),
    cwd: CWD,
  })

  const first = await viaRejection(['gh', 'pr', 'view', '3'], { timeoutMs: 20 })
  const second = await viaExit(['gh', 'pr', 'view', '3'], { timeoutMs: 10 })
  assert.equal(first.timedOut, true)
  assert.equal(classifyCommandFailure(first).kind, 'timed-out')
  assert.equal(second.timedOut, true)
  assert.equal(classifyCommandFailure(second).kind, 'timed-out')
})

test('a non-timeout rejection still propagates, so it is not silently swallowed', async () => {
  const exploding: SubprocessLike = {
    spawn() {
      return {
        done: Promise.reject(new Error('stream tore')),
        collected: {},
        terminate() {},
      }
    },
  }
  const run = createRunCommand({ subprocess: exploding, cwd: CWD })
  await assert.rejects(() => run(['gh', '--version']), /stream tore/)
})

test('a truncated stream is reported, because a lossy payload parses as invalid JSON that looks valid', async () => {
  const subprocess = fakeSubprocess({ stdout: '{"state":"OPE', lossy: true })
  const run = createRunCommand({ subprocess, cwd: CWD })
  const result = await run(['gh', 'pr', 'view', '3', '--json', 'state'])
  assert.equal(result.truncated, true, 'the caller must be able to refuse to parse this')
})

test('a command that cannot be started throws CommandNotStartedError, distinct from a non-zero exit', async () => {
  const failing: SubprocessLike = {
    spawn() {
      throw new Error('spawn ENOENT')
    },
  }
  const run = createRunCommand({ subprocess: failing, cwd: CWD })
  await assert.rejects(() => run(['gh', '--version']), (error) => {
    assert.equal((error as Error).name, 'CommandNotStartedError')
    assert.match((error as Error).message, /could not run gh/)
    return true
  })
})

// ---------------------------------------------------------------------------
// Failure classification — what the caller retries, backs off on, or reports
// ---------------------------------------------------------------------------

const failed = (over: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 1,
  stdout: '',
  stderr: '',
  ...over,
})

test('a clean exit classifies as ok and invalidates nothing', () => {
  assert.deepEqual(classifyCommandFailure({ exitCode: 0, stdout: '', stderr: '' }), {
    kind: FailureKind.ok,
    invalidatesToken: false,
  })
})

test('a timeout is classified before any exit-code reading', () => {
  assert.equal(classifyCommandFailure(failed({ timedOut: true })).kind, FailureKind.timedOut)
})

test('a missing executable is classified as not-installed (R3)', async (t) => {
  for (const stderr of [
    'gh: command not found',
    'exec: "gh": executable file not found in $PATH',
    'Error: spawn gh ENOENT',
  ]) {
    await t.test(stderr.slice(0, 28), () => {
      assert.equal(classifyCommandFailure(failed({ stderr })).kind, FailureKind.notInstalled)
    })
  }
})

test('a rate limit is recognised even though GitHub answers 403 for it too', () => {
  // Ordering matters: the plain forbidden check would otherwise swallow this, and
  // a rate limit treated as a permission error is one that never backs off.
  const rateLimited = classifyCommandFailure(
    failed({ stderr: 'HTTP 403: API rate limit exceeded for user ID 1234' }),
  )
  assert.equal(rateLimited.kind, FailureKind.rateLimited)
  assert.equal(rateLimited.invalidatesToken, false, 'a rate limit is not a bad credential')

  const secondary = classifyCommandFailure(failed({ stderr: 'You have exceeded a secondary rate limit' }))
  assert.equal(secondary.kind, FailureKind.rateLimited)
})

test('a bad credential is unauthorised and invalidates the memoised token', () => {
  const result = classifyCommandFailure(failed({ stderr: 'gh: Bad credentials (HTTP 401)' }))
  assert.equal(result.kind, FailureKind.unauthorized)
  assert.equal(result.invalidatesToken, true)
})

test('a permission refusal is forbidden and also invalidates the token', () => {
  const result = classifyCommandFailure(failed({ stderr: 'HTTP 403: You must have push access' }))
  assert.equal(result.kind, FailureKind.forbidden)
  assert.equal(result.invalidatesToken, true)
})

test('a 404 is not-found and does not invalidate the token', () => {
  const result = classifyCommandFailure(failed({ stderr: 'HTTP 404: Not Found' }))
  assert.equal(result.kind, FailureKind.notFound)
  assert.equal(result.invalidatesToken, false)
})

test('an unrecognised failure is unknown and invalidates nothing', () => {
  assert.equal(classifyCommandFailure(failed({ stderr: 'something odd happened' })).kind, FailureKind.unknown)
})

test('retryAfterMs reads a Retry-After hint in seconds', () => {
  assert.equal(retryAfterMs(failed({ stderr: 'HTTP 403: retry-after: 30' })), 30_000)
  assert.equal(retryAfterMs(failed({ stderr: 'Retry-After 12' })), 12_000)
})

test('retryAfterMs reads a rate-limit reset epoch and never returns a negative wait', () => {
  const now = 1_700_000_000_000
  assert.equal(retryAfterMs(failed({ stderr: 'x-ratelimit-reset: 1700000060' }), now), 60_000)
  assert.equal(retryAfterMs(failed({ stderr: 'x-ratelimit-reset: 1699999999' }), now), 0)
})

test('retryAfterMs returns undefined when the service gave no hint', () => {
  assert.equal(retryAfterMs(failed({ stderr: 'plain failure' })), undefined)
})

test('every failure kind has a message that says what to do', async (t) => {
  const argv = ['gh', 'pr', 'view', '3']
  for (const kind of Object.values(FailureKind)) {
    await t.test(kind, () => {
      const message = describeFailure(kind, argv)
      assert.ok(message.length > 20)
      assert.match(message, /gh/, 'the message names the command')
    })
  }
})

test('the not-installed and unauthorised messages name the exact prerequisite', () => {
  // R3: "A missing `gh` fails `orchestrator_repo_connect` loudly with the exact
  // prerequisite." Vague advice here is the difference between a five-second fix
  // and a support thread.
  assert.match(describeFailure(FailureKind.notInstalled, ['gh']), /not installed or not on PATH/)
  assert.match(describeFailure(FailureKind.unauthorized, ['gh']), /gh auth login/)
})
