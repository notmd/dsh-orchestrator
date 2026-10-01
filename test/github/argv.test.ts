/**
 * GitHub credential resolution and `gh`/`git` argv construction.
 *
 * Both modules are pure and both are named in the PRD's test plan:
 *
 *   "Integration (fake `ctx.subprocess`): git/`gh` argv construction, deadline and
 *    output caps, failure classification, and token-precedence resolution
 *    (`AO_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token` → memoized → 401
 *    invalidates)."
 *
 * The two behaviours worth the most attention are the ones a plausible-looking
 * implementation gets wrong: **precedence** (a per-repo token must beat the global
 * default) and **invalidation** (a rotated token must be picked up without a
 * restart).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GH_TOKEN_CACHE_TTL_MS,
  NoTokenError,
  envTokenSource,
  firstToken,
  ghTokenSource,
  githubTokenChain,
} from '../../src/github/auth.ts'
import {
  PR_VIEW_FIELDS,
  authStatusArgv,
  currentBranchArgv,
  isWorkTreeArgv,
  issueCreateArgv,
  prCreateArgv,
  prListArgv,
  prReviewArgv,
  prViewArgv,
  pushArgv,
  repoViewArgv,
} from '../../src/github/argv.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' })

/** A fake `gh` that answers `gh auth token` from a script and counts calls. */
function fakeGh(tokens: Array<string | CommandResult>): { run: RunCommand; readonly calls: number } {
  let calls = 0
  const run: RunCommand = async () => {
    const answer = tokens[Math.min(calls, tokens.length - 1)]
    calls += 1
    if (typeof answer === 'string') return ok(answer)
    return answer ?? ok()
  }
  return {
    run,
    get calls() {
      return calls
    },
  }
}

// ---------------------------------------------------------------------------
// Token precedence
// ---------------------------------------------------------------------------

test('AO_GITHUB_TOKEN wins over GITHUB_TOKEN', async () => {
  const source = envTokenSource({ AO_GITHUB_TOKEN: 'repo-scoped', GITHUB_TOKEN: 'global' }, [
    'AO_GITHUB_TOKEN',
  ])
  assert.equal(await source(), 'repo-scoped')
})

test('GITHUB_TOKEN is the fallback when the project-scoped name is unset', async () => {
  const source = envTokenSource({ GITHUB_TOKEN: 'global' }, ['AO_GITHUB_TOKEN'])
  assert.equal(await source(), 'global')
})

test('a whitespace-only variable counts as unset', async () => {
  // The reference trims. Without this, a CI variable set to a space sends an
  // empty Authorization header and the user sees a permissions error instead of
  // "not configured".
  const source = envTokenSource({ AO_GITHUB_TOKEN: '   ', GITHUB_TOKEN: 'global' }, ['AO_GITHUB_TOKEN'])
  assert.equal(await source(), 'global')
  await assert.rejects(() => envTokenSource({ AO_GITHUB_TOKEN: '  ' }, ['AO_GITHUB_TOKEN'])(), NoTokenError)
})

test('envTokenSource reports NoTokenError, not an empty token', async () => {
  await assert.rejects(() => envTokenSource({}, ['AO_GITHUB_TOKEN'])(), NoTokenError)
})

test('the chain prefers the environment and never shells out when it can avoid it', async () => {
  const gh = fakeGh(['from-gh'])
  const chain = githubTokenChain({ env: { AO_GITHUB_TOKEN: 'env-token' }, run: gh.run })
  assert.equal(await chain.token(), 'env-token')
  assert.equal(gh.calls, 0, 'gh was not run')
})

test('the chain falls through to gh auth token', async () => {
  const gh = fakeGh(['from-gh'])
  const chain = githubTokenChain({ env: {}, run: gh.run })
  assert.equal(await chain.token(), 'from-gh')
  assert.equal(gh.calls, 1)
})

test('the chain names every source, so a failure can explain itself', () => {
  const chain = githubTokenChain({ env: {}, run: fakeGh(['t']).run })
  assert.match(chain.describe(), /AO_GITHUB_TOKEN/)
  assert.match(chain.describe(), /GITHUB_TOKEN/)
  assert.match(chain.describe(), /gh auth token/)
})

// ---------------------------------------------------------------------------
// Memoization and invalidation
// ---------------------------------------------------------------------------

test('gh auth token is memoised rather than run per request', async () => {
  const gh = fakeGh(['token-1'])
  let now = 1_000
  const source = ghTokenSource({ run: gh.run, now: () => now, ttlMs: 60_000 })
  assert.equal(await source(), 'token-1')
  assert.equal(await source(), 'token-1')
  assert.equal(await source(), 'token-1')
  assert.equal(gh.calls, 1, 'fork-exec once, not three times')
})

test('the memo expires after its TTL', async () => {
  const gh = fakeGh(['token-1', 'token-2'])
  let now = 1_000
  const source = ghTokenSource({ run: gh.run, now: () => now, ttlMs: 60_000 })
  assert.equal(await source(), 'token-1')
  now += 60_001
  assert.equal(await source(), 'token-2')
  assert.equal(gh.calls, 2)
})

test('invalidate drops the memo so a rotated token is picked up', async () => {
  // The whole reason the memo is droppable: after a 401 the user may have
  // replaced the credential, and without this every later call keeps failing
  // with the old one until the process restarts.
  const gh = fakeGh(['stale', 'rotated'])
  const source = ghTokenSource({ run: gh.run, now: () => 1_000, ttlMs: 60_000 })
  assert.equal(await source(), 'stale')
  source.invalidate()
  assert.equal(await source(), 'rotated')
  assert.equal(gh.calls, 2)
})

test('the default TTL is the reference five minutes', () => {
  assert.equal(GH_TOKEN_CACHE_TTL_MS, 300_000)
})

test('an empty gh auth token is NoTokenError, never a blank credential', async () => {
  // `gh auth token` prints nothing when logged out. Treating that as a token
  // sends an empty Authorization header, and GitHub answers 401 -- which reads
  // as "your token is wrong" when the truth is "you have no token".
  await assert.rejects(() => ghTokenSource({ run: fakeGh(['']).run })() , NoTokenError)
  await assert.rejects(() => ghTokenSource({ run: fakeGh([{ exitCode: 1, stdout: '', stderr: 'not logged in' }]).run })(), NoTokenError)
})

test('a failed gh auth token says what to run', async () => {
  await assert.rejects(
    () => ghTokenSource({ run: fakeGh([{ exitCode: 1, stdout: '', stderr: 'x' }]).run })(),
    /gh auth login/,
  )
})

test('a failing gh source is retried after the failure, not memoised as a failure', async () => {
  const gh = fakeGh([{ exitCode: 1, stdout: '', stderr: 'transient' }, 'recovered'])
  const source = ghTokenSource({ run: gh.run, now: () => 1_000 })
  await assert.rejects(() => source(), NoTokenError)
  assert.equal(await source(), 'recovered')
})

// ---------------------------------------------------------------------------
// Fallback semantics — the reference's error distinction
// ---------------------------------------------------------------------------

test('firstToken skips a source that has nothing and takes the next', async () => {
  const empty = async () => {
    throw new NoTokenError()
  }
  const real = async () => 'found'
  assert.equal(await firstToken([empty, real]), 'found')
})

test('firstToken surfaces a real error when no source succeeds', async () => {
  // Distinct from NoTokenError on purpose: "not configured" and "your
  // configuration is broken" need different messages.
  const broken = async () => {
    throw new Error('gh exploded')
  }
  const empty = async () => {
    throw new NoTokenError()
  }
  await assert.rejects(() => firstToken([empty, broken]), /gh exploded/)
})

test('a remembered error does not mask a later success', async () => {
  const broken = async () => {
    throw new Error('gh exploded')
  }
  const real = async () => 'found'
  assert.equal(await firstToken([broken, real]), 'found')
})

test('the first real error is the one reported, and AllEmpty is NoTokenError', async () => {
  const first = async () => {
    throw new Error('first failure')
  }
  const second = async () => {
    throw new Error('second failure')
  }
  await assert.rejects(() => firstToken([first, second]), /first failure/)
  await assert.rejects(() => firstToken([undefined, undefined]), NoTokenError)
})

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

test('gh pr view asks for exactly the fields the snapshot needs', () => {
  const argv = prViewArgv({ number: 42, repository: 'o/r' })
  assert.deepEqual(argv.slice(0, 3), ['gh', 'pr', 'view'])
  assert.equal(argv[3], '42')
  assert.deepEqual(argv.slice(4, 6), ['--repo', 'o/r'])
  assert.deepEqual(argv.slice(6, 7), ['--json'])
  const fields = argv[7]!.split(',')
  for (const required of ['state', 'isDraft', 'mergeable', 'reviewDecision', 'headRefOid', 'statusCheckRollup', 'reviews', 'comments', 'updatedAt']) {
    assert.ok(fields.includes(required), `PRD 7.4 needs ${required}`)
  }
})

test('the repository is always passed explicitly, never inferred from a remote', () => {
  // A worker's worktree shares .git/config with the human checkout, so the
  // worker-to-repository association must be the plugin's decision.
  for (const argv of [
    prViewArgv({ number: 1, repository: 'o/r' }),
    prListArgv({ repository: 'o/r' }),
    repoViewArgv('o/r'),
  ]) {
    assert.ok(argv.includes('--repo') || argv.includes('o/r'), argv.join(' '))
  }
})

test('pr list is bounded by an explicit limit', () => {
  const argv = prListArgv({ repository: 'o/r' })
  assert.ok(argv.includes('--limit'), 'an unbounded listing must not be reachable by omission')
  assert.equal(argv[argv.indexOf('--limit') + 1], '30')
  assert.equal(prListArgv({ repository: 'o/r', limit: 5 })[argv.indexOf('--limit') + 1], '5')
  assert.equal(prListArgv({ repository: 'o/r', state: 'all' })[argv.indexOf('--state') + 1], 'all')
  assert.ok(prListArgv({ repository: 'o/r', headBranch: 'dsho/issue-1-x' }).includes('--head'))
})

test('a review is always posted as COMMENT, because GitHub rejects the alternatives on your own PR', () => {
  // R17. This is a hard provider constraint, not a preference: the reviewer acts
  // from the PR author's account, and APPROVE/REQUEST_CHANGES on your own PR is a
  // 422. A caller that "helpfully" forwarded the verdict would break every PR.
  const argv = prReviewArgv({ repository: 'o/r', number: 7, body: 'findings' })
  const events = argv.filter((_, index) => argv[index - 1] === '-f' && argv[index]!.startsWith('event='))
  assert.deepEqual(events, ['event=COMMENT'])
  assert.deepEqual(argv.slice(0, 5), ['gh', 'api', '--method', 'POST', 'repos/o/r/pulls/7/reviews'])
  assert.ok(!argv.join(' ').includes('REQUEST_CHANGES'))
  assert.ok(!argv.join(' ').includes('APPROVE'))
})

test('inline review comments are encoded one field at a time', () => {
  const argv = prReviewArgv({
    repository: 'o/r',
    number: 7,
    body: 'two findings',
    comments: [
      { path: 'src/a.ts', line: 12, body: 'off by one' },
      { path: 'src/b.ts', line: 3, body: 'missing await' },
    ],
  })
  assert.ok(argv.includes('comments[][path]=src/a.ts'))
  assert.ok(argv.includes('comments[][line]=12'))
  assert.ok(argv.includes('comments[][path]=src/b.ts'))
  assert.equal(argv.filter((f) => f === 'comments[][line]=3').length, 1)
})

test('body text is one argv element, so no quoting is involved', () => {
  const hostile = 'delete everything; `rm -rf /` && echo "$(whoami)"'
  const argv = prCreateArgv({ repository: 'o/r', title: 't', body: hostile, base: 'main', head: 'b' })
  assert.ok(argv.includes(hostile), 'the body arrives verbatim as a single argument')
  assert.equal(argv[argv.indexOf('--body') + 1], hostile)
})

test('pr create adds --draft only when asked', () => {
  const base = { repository: 'o/r', title: 't', body: 'b', base: 'main', head: 'h' }
  assert.ok(!prCreateArgv(base).includes('--draft'))
  assert.ok(prCreateArgv({ ...base, draft: true }).includes('--draft'))
})

test('push can never force', () => {
  // The plugin never force-pushes (PRD authority rule) and the worker contract
  // forbids rewriting shared history. There is deliberately no parameter for it.
  const argv = pushArgv({ branch: 'dsho/issue-1-x' })
  assert.deepEqual(argv, ['git', 'push', 'origin', 'dsho/issue-1-x'])
  assert.ok(!argv.join(' ').includes('--force'))
  assert.ok(!pushArgv({ branch: 'b', setUpstream: true }).join(' ').includes('--force'))
  assert.ok(pushArgv({ branch: 'b', setUpstream: true }).includes('--set-upstream'))
})

test('issue creation and reading build the right routes', () => {
  const create = issueCreateArgv({ repository: 'o/r', title: 'Fix it', body: 'detail', labels: ['bug'] })
  assert.deepEqual(create.slice(0, 5), ['gh', 'api', '--method', 'POST', 'repos/o/r/issues'])
  assert.ok(create.includes('title=Fix it'))
  assert.ok(create.includes('labels[]=bug'))
  assert.deepEqual(issueCreateArgv({ repository: 'o/r', title: 't' }).filter((a) => a.startsWith('body=')), [])
})

test('a nonsense number is refused rather than passed to gh', () => {
  assert.throws(() => prViewArgv({ number: 0, repository: 'o/r' }), /positive/)
  assert.throws(() => prViewArgv({ number: 1.5, repository: 'o/r' }), /positive/)
  assert.throws(() => prReviewArgv({ repository: 'o/r', number: -1, body: 'b' }), /positive/)
})

test('the preflight argv is exactly what git and gh expect', () => {
  assert.deepEqual(isWorkTreeArgv(), ['git', 'rev-parse', '--is-inside-work-tree'])
  assert.deepEqual(currentBranchArgv(), ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  assert.deepEqual(authStatusArgv(), ['gh', 'auth', 'status'])
})

test('the PR_VIEW_FIELDS list is stable and ordered', () => {
  assert.equal(PR_VIEW_FIELDS.length, 13)
  assert.equal(new Set(PR_VIEW_FIELDS).size, PR_VIEW_FIELDS.length, 'no duplicates')
})
