/**
 * GitHub credential resolution for the local path.
 *
 * PORTED from Agent Orchestrator `backend/internal/adapters/scm/github/auth.go`
 * (`EnvTokenSource`, `GHTokenSource`, `FallbackTokenSource`, `ErrNoToken`). See
 * NOTICE. The chain is the PRD's:
 *
 *   `AO_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`
 *
 * **No GitHub App, no OAuth, no PAT store** (PRD §5.3): the plugin reuses the
 * credential the developer already has. That is a deliberate scope decision, and
 * it is why a missing credential has to produce a message naming `gh auth login`
 * rather than a generic auth failure.
 *
 * Two behaviours are the whole point of this module, and both are easy to get
 * subtly wrong:
 *
 *   1. **`gh auth token` is memoised, not called per request.** The reference
 *      memoises for five minutes so it does not fork-exec on every call.
 *   2. **An auth-class failure invalidates the memo.** Otherwise a rotated token
 *      is never picked up until the daemon restarts, and every subsequent call
 *      fails with a credential the user has already replaced.
 *
 * A source that yields *no* token is skipped; any other error is remembered and
 * surfaced only if no later source produces a token. That ordering is the
 * reference's, and it is what lets "not configured here" differ from
 * "configuration is broken".
 *
 * @module dsho/github/auth
 */

import type { CommandResult, RunCommand } from '../host/worktree.ts'

/** The reference's `ErrNoToken`: a source had nothing to offer. */
export class NoTokenError extends Error {
  constructor(message = 'no GitHub token configured') {
    super(message)
    this.name = 'NoTokenError'
  }
}

/** A source of credentials. Throws {@link NoTokenError} when it has none. */
export type TokenSource = () => Promise<string>

/** The default memo window, matching the reference's `defaultGHTokenCacheTTL`. */
export const GH_TOKEN_CACHE_TTL_MS = 5 * 60 * 1_000

/** Environment, read through an injected map so precedence is testable. */
export type EnvLike = Readonly<Record<string, string | undefined>>

/**
 * Reads the first non-empty value from `names`, then `GITHUB_TOKEN`.
 *
 * Ported from `EnvTokenSource.Token`. **The order is the feature:** a
 * project-scoped variable (`AO_GITHUB_TOKEN`) must win over the developer's
 * global default, or a per-repo credential could never be used.
 *
 * Values are trimmed, so a variable set to whitespace counts as unset — the
 * reference does the same, and it turns a common CI misconfiguration from a
 * confusing 401 into an honest "not configured".
 */
export function envTokenSource(env: EnvLike, names: readonly string[]): TokenSource {
  return async () => {
    for (const name of names) {
      const value = env[name]?.trim()
      if (value) return value
    }
    const global = env.GITHUB_TOKEN?.trim()
    if (global) return global
    throw new NoTokenError()
  }
}

/** A clock, injected so memoization is testable without waiting. */
export type Clock = () => number

/** The memoising `gh auth token` source. */
export interface GhTokenSource extends TokenSource {
  /** Drops the memo so the next call re-reads it. */
  invalidate(): void
  /** How many times the underlying command actually ran. */
  readonly calls: () => number
}

/**
 * Resolves a token by running `gh auth token`, memoised for `ttlMs`.
 *
 * Ported from `GHTokenSource`. The command is injectable (the reference has a
 * `GH` shell-out hook for the same reason), so the suite never needs a real `gh`.
 *
 * A blank stdout is `NoTokenError`, not a token of `""`: `gh auth token` prints
 * nothing when the user is not logged in, and treating that as a credential
 * would send an empty `Authorization` header and produce a 401 that looks like a
 * permissions problem.
 */
export function ghTokenSource(options: {
  run: RunCommand
  now?: Clock
  ttlMs?: number
}): GhTokenSource {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? GH_TOKEN_CACHE_TTL_MS
  let cached: { token: string; expiresAt: number } | undefined
  let callCount = 0

  const source = (async () => {
    if (cached && cached.expiresAt > now()) return cached.token
    callCount += 1
    const result: CommandResult = await options.run(['gh', 'auth', 'token'])
    if (result.exitCode !== 0) throw new NoTokenError('gh auth token failed; run `gh auth login`')
    const token = result.stdout.trim()
    if (token === '') throw new NoTokenError('gh auth token returned nothing; run `gh auth login`')
    cached = { token, expiresAt: now() + ttlMs }
    return token
  }) as GhTokenSource

  source.invalidate = () => {
    cached = undefined
  }
  Object.defineProperty(source, 'calls', { value: () => callCount })
  return source
}

/**
 * Returns the first token any source can produce.
 *
 * Ported from `FallbackTokenSource.Token`. The subtle part is the error
 * handling: `NoTokenError` means "try the next source", while any *other* error
 * is remembered and surfaced **only if nothing later succeeds**. That distinction
 * is what keeps "you have not configured a token" from being reported as "your
 * token is broken", and it is worth the handful of lines.
 */
export async function firstToken(sources: readonly (TokenSource | undefined)[]): Promise<string> {
  let firstError: unknown
  for (const source of sources) {
    if (!source) continue
    try {
      return await source()
    } catch (error) {
      if (error instanceof NoTokenError) continue
      if (firstError === undefined) firstError = error
    }
  }
  if (firstError !== undefined) throw firstError
  throw new NoTokenError()
}

/**
 * The local-path credential chain: `AO_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`.
 *
 * Returned together with an `invalidate` that forwards to whichever source can
 * drop a memo, so the caller has one thing to call on an auth-class failure
 * (`FailureKind.unauthorized` / `forbidden` from the exec seam).
 */
export function githubTokenChain(options: {
  env: EnvLike
  run: RunCommand
  now?: Clock
  ttlMs?: number
}): { token: TokenSource; invalidate(): void; describe(): string } {
  const fromEnv = envTokenSource(options.env, ['AO_GITHUB_TOKEN'])
  const fromGh = ghTokenSource({ run: options.run, ...(options.now ? { now: options.now } : {}), ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) })
  return {
    token: () => firstToken([fromEnv, fromGh]),
    invalidate: () => fromGh.invalidate(),
    describe: () =>
      'credential chain: AO_GITHUB_TOKEN, then GITHUB_TOKEN, then `gh auth token` ' +
      '(memoised for 5 minutes, dropped when GitHub rejects it)',
  }
}
