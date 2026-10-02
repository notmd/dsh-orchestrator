/**
 * The command seam: `ctx.subprocess` behind a promise-returning `RunCommand`.
 *
 * Everything that shells out — git, `gh` — goes through here, so the bounded-work
 * NFR ("every `gh`/`git` call has a deadline and an output cap") is enforced in
 * one place rather than remembered at each call site.
 *
 * ## Why `ctx.subprocess` and not `ctx.shell`
 *
 * `ctx.shell.resolve()` takes a **command string**, which would mean
 * shell-quoting argv built from user-controlled text: branch names, titles, file
 * paths. `ctx.subprocess.spawn()` takes an **argv array**, so there is no shell
 * and therefore nothing to quote. Injection becomes unrepresentable rather than
 * escaped, which is the same reasoning `slugify` uses.
 *
 * ## Why output is capped and `lossy` is propagated
 *
 * The collected stream reports `lossy` when it hit its byte cap. A truncated
 * `gh pr view --json` is *invalid JSON that looks like valid input*, so a caller
 * that ignored the flag would parse half a document and act on it. The flag is
 * therefore carried into {@link CommandResult} and callers must check it before
 * trusting a parse.
 *
 * @module dsho/host/exec
 */

import type { CommandResult, RunCommand } from './worktree.ts'

/** One collected stream, as the subprocess service reports it. */
export interface CollectedRead {
  text: string
  nextOffset: number
  /** True when the stream exceeded its byte cap; `text` is then incomplete. */
  lossy: boolean
  spillPath?: string
}

/** The slice of `SubprocessHandle` this module uses. */
export interface SubprocessHandleLike {
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  readonly collected: {
    readonly stdout?: { readFrom(offset: number): CollectedRead } | undefined
    readonly stderr?: { readFrom(offset: number): CollectedRead } | undefined
  }
  terminate(): void
}

/** The slice of `ctx.subprocess` this module uses. */
export interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs?: number
    signal?: AbortSignal
    /**
     * Explicit environment entries, merged onto the service's scrubbed ambient one.
     *
     * Required for one thing: **a credential**. `dsh-subprocess` deliberately strips
     * credential-shaped names (`*_TOKEN`, `*_SECRET`, …) from a child's environment, and
     * its own documentation says a credential must travel through the spec's explicit
     * `env`. Without this the ported token chain was dead code (finding G6): a
     * project-scoped `AO_GITHUB_TOKEN` could not reach `gh` at all, so the module's
     * documented precedence was a statement about a variable nothing read.
     */
    env?: NodeJS.ProcessEnv
  }): SubprocessHandleLike
}

/** A credential the seam may inject, and may invalidate when GitHub rejects it. */
export interface TokenProvider {
  token(): Promise<string>
  /** Drops any memo, so the next call re-reads the credential. */
  invalidate(): void
}

/** Raised when the command could not be started at all — distinct from a non-zero exit. */
export class CommandNotStartedError extends Error {
  readonly argv: readonly string[]

  constructor(argv: readonly string[], cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`could not run ${argv[0]}: ${message}`)
    this.name = 'CommandNotStartedError'
    this.argv = argv
  }
}

/** Defaults, chosen to satisfy the bounded-work NFR rather than to be generous. */
export const EXEC_DEFAULTS = Object.freeze({
  /** A hung `gh` must not hold a worker's slot indefinitely. */
  timeoutMs: 60_000,
  /** Enough for `gh pr view --json` on a busy PR; small enough to bound memory. */
  maxOutputBytes: 4 * 1024 * 1024,
  /** How long a terminated child has to exit before it is killed outright. */
  graceMs: 2_000,
})

/**
 * Builds a {@link RunCommand} over `ctx.subprocess`.
 *
 * The deadline is enforced with an `AbortController` **and** an explicit
 * `terminate()`, because the service's abort handling and a stubborn child are
 * different failure modes: one may not cover the other, and a timeout that leaves
 * a process behind is worse than no timeout.
 */
export function createRunCommand(options: {
  subprocess: SubprocessLike
  /** Working directory when the caller does not supply one. */
  cwd: string
  timeoutMs?: number
  maxOutputBytes?: number
  graceMs?: number
  /**
   * The GitHub credential chain, when there is one (finding G6).
   *
   * Used for `gh` only, and failure to resolve it is **not** fatal: `gh` has its own
   * configured credential, so an install with no `AO_GITHUB_TOKEN`, no `GITHUB_TOKEN` and
   * no `gh auth` behaves exactly as it did before — the call simply runs without an
   * injected `GH_TOKEN`.
   */
  token?: TokenProvider
}): RunCommand {
  const timeoutMs = options.timeoutMs ?? EXEC_DEFAULTS.timeoutMs
  const maxOutputBytes = options.maxOutputBytes ?? EXEC_DEFAULTS.maxOutputBytes
  const graceMs = options.graceMs ?? EXEC_DEFAULTS.graceMs

  return async (argv, runOptions): Promise<CommandResult> => {
    const deadlineMs = runOptions?.timeoutMs ?? timeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, deadlineMs)

    // The credential, resolved for `gh` and injected explicitly. Done before the spawn so
    // the child starts with it, and a failure here falls back to the ambient credential
    // rather than failing the command: the chain's own contract is that a missing token is
    // `NoTokenError` ("try the next source"), not a broken command.
    const env = await injectedEnvFor(argv, options.token)

    let handle: SubprocessHandleLike
    try {
      handle = options.subprocess.spawn({
        argv: [...argv],
        cwd: runOptions?.cwd ?? options.cwd,
        ...(env ? { env } : {}),
        // Every disposition explicit: the seam applies no defaults of its own, so
        // an unset one is not "the service's choice" but an error or a surprise.
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs,
        signal: controller.signal,
      })
    } catch (cause) {
      clearTimeout(timer)
      throw new CommandNotStartedError(argv, cause)
    }

    try {
      let outcome: { exitCode: number | null; signal: string | null }
      try {
        outcome = await handle.done
      } catch (cause) {
        // A deadline that surfaces as a rejected `done` must still terminate the
        // child, and must still arrive as a *result* rather than a throw. Callers
        // branch on `timedOut`; if the same condition sometimes threw, every one
        // of them would need a try/catch as well, and the ones that forgot would
        // treat a timeout as an unknown crash. A test caught the missing
        // terminate; the uniform-result half is the same fix.
        if (timedOut) {
          handle.terminate()
          return { exitCode: null, stdout: '', stderr: '', timedOut: true }
        }
        throw cause
      }

      // A parent whose child ignored the signal: make sure it is gone.
      if (timedOut) handle.terminate()
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      const result: CommandResult = {
        exitCode: outcome.exitCode,
        stdout: stdout?.text ?? '',
        stderr: stderr?.text ?? '',
        truncated: Boolean(stdout?.lossy || stderr?.lossy),
      }
      if (timedOut) result.timedOut = true
      // An auth-class rejection drops the credential memo, so a rotated token is picked up
      // without a restart. Ported from the reference's `invalidate` forwarding; until the
      // chain was wired into this seam the behaviour could never run (finding G6).
      if (argv[0] === 'gh' && classifyCommandFailure(result).invalidatesToken) options.token?.invalidate()
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The explicit environment for one command, or `undefined` when there is nothing to add.
 *
 * Only `gh` gets a credential: `git` authenticates through the remote's configured helper,
 * and injecting `GH_TOKEN` into a `git push` would be a second credential path nobody asked
 * for. The variable is `GH_TOKEN`, which is the one `gh` documents as "use this
 * credential, ignore the stored login" — the same variable the reference's local path sets.
 */
async function injectedEnvFor(
  argv: readonly string[],
  token: TokenProvider | undefined,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (!token || argv[0] !== 'gh') return undefined
  try {
    const value = await token.token()
    return value === '' ? undefined : { GH_TOKEN: value }
  } catch {
    // No credential from any source: run without one and let `gh` use its own
    // configuration, which is exactly what happened before this existed.
    return undefined
  }
}

/** How a failed command failed. Drives retry, backoff, and token invalidation. */
export const FailureKind = Object.freeze({
  /** The command ran and succeeded. */
  ok: 'ok',
  /** The executable is not on PATH. R3: a missing `gh` must fail loudly. */
  notInstalled: 'not-installed',
  /** Authentication is missing or rejected. */
  unauthorized: 'unauthorized',
  /** Authenticated but not permitted. */
  forbidden: 'forbidden',
  /** Rate limited. Back off deterministically; never retry tightly. */
  rateLimited: 'rate-limited',
  /** The resource does not exist. */
  notFound: 'not-found',
  /** Exceeded its deadline. */
  timedOut: 'timed-out',
  /** Anything else. */
  unknown: 'unknown',
})

/** The classified shape of a command's failure. */
export interface ClassifiedFailure {
  kind: string
  /** True when the failure invalidates a memoized credential. */
  invalidatesToken: boolean
  /** Milliseconds to wait, when the service told us. */
  retryAfterMs?: number
}

/**
 * Classifies a command result.
 *
 * **Bot-aware substring matching is deliberately avoided elsewhere** (R19: a
 * login containing "bot" is a false positive), but here the strings come from
 * `gh`'s own error vocabulary, not from user data. The rate-limit check runs
 * before the plain forbidden check because GitHub reports 403 for both and only
 * the body distinguishes them — and getting that backwards means retrying a rate
 * limit in a tight loop, which is the failure the NFR names explicitly.
 */
export function classifyCommandFailure(result: CommandResult): ClassifiedFailure {
  if (result.timedOut) return { kind: FailureKind.timedOut, invalidatesToken: false }
  if (result.exitCode === 0) return { kind: FailureKind.ok, invalidatesToken: false }

  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()

  if (
    text.includes('command not found') ||
    text.includes('executable file not found') ||
    text.includes('no such file or directory') ||
    text.includes('enoent')
  ) {
    return { kind: FailureKind.notInstalled, invalidatesToken: false }
  }

  // Before `forbidden`: GitHub answers 403 for rate limits too.
  if (text.includes('api rate limit exceeded') || text.includes('secondary rate limit')) {
    return { kind: FailureKind.rateLimited, invalidatesToken: false }
  }

  if (text.includes('bad credentials') || text.includes('http 401') || text.includes('401 unauthorized')) {
    return { kind: FailureKind.unauthorized, invalidatesToken: true }
  }

  if (text.includes('http 403') || text.includes('forbidden') || text.includes('must have push access')) {
    return { kind: FailureKind.forbidden, invalidatesToken: true }
  }

  if (text.includes('http 404') || text.includes('could not resolve to a repository') || text.includes('not found')) {
    return { kind: FailureKind.notFound, invalidatesToken: false }
  }

  return { kind: FailureKind.unknown, invalidatesToken: false }
}

/**
 * Parses the `Retry-After` / rate-limit reset hint `gh` prints, when it prints one.
 *
 * Deterministic backoff is an NFR, so this returns a number the caller can sleep
 * on rather than leaving it to guesswork. `undefined` means "no hint" — the
 * caller must still back off, just from its own schedule.
 */
export function retryAfterMs(result: CommandResult, now = Date.now()): number | undefined {
  const text = `${result.stderr}\n${result.stdout}`

  const seconds = /retry[- ]after[:\s]+(\d+)/i.exec(text)
  if (seconds?.[1]) return Number(seconds[1]) * 1_000

  const resetSeconds = /x-ratelimit-reset[:\s]+(\d+)/i.exec(text)
  if (resetSeconds?.[1]) {
    const resetAt = Number(resetSeconds[1]) * 1_000
    return resetAt > now ? resetAt - now : 0
  }

  return undefined
}

/** How long the observer waits after a rate-limit rejection, when GitHub gives no hint. */
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  /** The reference's `defaultRateLimitCooldown`. */
  defaultCooldownMs: 60_000,
  /** A parsed `X-RateLimit-Reset` is honoured, but not for a whole day. */
  maxCooldownMs: 15 * 60_000,
})

/**
 * A deterministic back-off clock for GitHub rate limits (finding G7).
 *
 * The teardown's finding was blunt: `describeFailure(rateLimited)` tells the user "the plugin
 * backs off rather than retrying", `retryAfterMs` parses the provider's own hint — and
 * **nothing implemented a back-off and nothing called `retryAfterMs`**, so the honest
 * behaviour was "retries every tick against an already-exhausted budget". A message that
 * overstates the mechanism is the same class of defect as a board that claims a loop nobody
 * is running.
 *
 * This is that mechanism, and it is deliberately a plain object with no timers: the observer
 * asks whether it may run, and the answer is a timestamp. A cooldown that slept would hold a
 * worker's slot, which is the failure the bounded-work NFR exists to prevent.
 */
export interface RateLimitCooldown {
  /** Epoch ms when the cooldown clears, or `undefined` when nothing is cooling down. */
  clearsAt(now?: number): number | undefined
  /** Records the outcome of one command: starts a cooldown, or clears one on success. */
  record(result: CommandResult, now?: number): void
  /** Forgets any cooldown, for a caller that wants to force a pass. */
  clear(): void
}

/** Builds a {@link RateLimitCooldown}. */
export function createRateLimitCooldown(options: {
  defaultCooldownMs?: number
  maxCooldownMs?: number
} = {}): RateLimitCooldown {
  const defaultMs = options.defaultCooldownMs ?? RATE_LIMIT_DEFAULTS.defaultCooldownMs
  const maxMs = options.maxCooldownMs ?? RATE_LIMIT_DEFAULTS.maxCooldownMs
  let until: number | undefined

  return {
    clearsAt(now = Date.now()) {
      if (until === undefined) return undefined
      if (until <= now) {
        until = undefined
        return undefined
      }
      return until
    },
    record(result, now = Date.now()) {
      const failure = classifyCommandFailure(result)
      if (failure.kind !== FailureKind.rateLimited) {
        // Any completed call proves the budget is usable again. Clearing on success is what
        // keeps a cooldown from outliving the condition that caused it.
        if (failure.kind === FailureKind.ok) until = undefined
        return
      }
      // The provider's own hint wins; the default is what keeps a hint-less rejection
      // (`api rate limit exceeded` with no headers) from being retried immediately.
      const hinted = retryAfterMs(result, now) ?? defaultMs
      until = now + Math.min(Math.max(hinted, 0), maxMs)
    },
    clear() {
      until = undefined
    },
  }
}

/** The message a human should read for a classified failure. */
export function describeFailure(kind: string, argv: readonly string[]): string {
  const command = argv.join(' ')
  switch (kind) {
    case FailureKind.notInstalled:
      return `\`${argv[0]}\` is not installed or not on PATH. Install it and retry — the plugin shells out to it for every GitHub operation.`
    case FailureKind.unauthorized:
      return `\`${command}\` was rejected: no valid GitHub credential. Run \`gh auth login\`, or set GITHUB_TOKEN.`
    case FailureKind.forbidden:
      return `\`${command}\` was refused: the credential lacks permission for this repository.`
    case FailureKind.rateLimited:
      return `\`${command}\` hit a GitHub rate limit. The plugin backs off rather than retrying; no work was lost.`
    case FailureKind.notFound:
      return `\`${command}\` found nothing. The repository, issue, or pull request may not exist, or the credential cannot see it.`
    case FailureKind.timedOut:
      return `\`${command}\` exceeded its deadline and was terminated.`
    default:
      return `\`${command}\` failed.`
  }
}
