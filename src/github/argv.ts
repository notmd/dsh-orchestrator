/**
 * `gh` and `git` argument construction.
 *
 * Pure string building, kept away from the code that runs it, for one reason: the
 * argv *is* the interface, and a wrong flag is a runtime failure with a confusing
 * message. Here it is an assertion.
 *
 * ## `gh pr view --json`, not GraphQL
 *
 * The reference reads pull requests through the **GraphQL API**
 * (`gh api graphql`, `backend/internal/adapters/scm/github/observer_provider.go`),
 * with a large typed field selection. This plugin uses the PRD's
 * `gh pr view --json …` instead (§7.4). Both work; the REST/`gh pr view` form is
 * simpler for a single PR, does not need a query string, and keeps the field list
 * next to the type it fills. The field list below is the union of what PRD §7.4
 * names and what the board reducer actually reads — no more, because every extra
 * field is more of the response to parse and more chance of a truncation mattering.
 *
 * @module dsho/github/argv
 */

/**
 * The fields `orchestrator_pr_sync` and the observer request.
 *
 * Deliberately explicit and ordered: this string is the contract between the
 * GitHub response and `PrSnapshot` (PRD §7.4), so a field added there must be
 * added here, and a reviewer can see both at once.
 */
export const PR_VIEW_FIELDS = [
  'number',
  'url',
  'state',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'headRefOid',
  'headRefName',
  'statusCheckRollup',
  'reviews',
  'comments',
  'updatedAt',
] as const

/** The repository identity fields `orchestrator_repo_connect` needs. */
export const REPO_VIEW_FIELDS = ['nameWithOwner', 'defaultBranchRef', 'url', 'isPrivate'] as const

/**
 * `gh pr view <n> --json <fields>`.
 *
 * `--repo owner/name` is passed explicitly rather than relying on the cwd's
 * remote: a worker's worktree shares `.git/config` with the human checkout, and
 * the association of a worker with a repository must be the plugin's decision,
 * not whatever remote happens to be configured.
 */
export function prViewArgv(options: {
  number: number
  repository: string
  fields?: readonly string[]
}): string[] {
  assertPullRequestNumber(options.number)
  return [
    'gh',
    'pr',
    'view',
    String(options.number),
    '--repo',
    options.repository,
    '--json',
    (options.fields ?? PR_VIEW_FIELDS).join(','),
  ]
}

/**
 * `gh pr list --json … --state open --limit <n>`.
 *
 * Used to recover PRs after a restart, and the `--limit` is required rather than
 * optional so an unbounded listing cannot happen by omission.
 */
export function prListArgv(options: {
  repository: string
  headBranch?: string
  limit?: number
  state?: 'open' | 'closed' | 'merged' | 'all'
}): string[] {
  const argv = [
    'gh',
    'pr',
    'list',
    '--repo',
    options.repository,
    '--state',
    options.state ?? 'open',
    '--limit',
    String(options.limit ?? 30),
    '--json',
    PR_VIEW_FIELDS.join(','),
  ]
  if (options.headBranch) argv.push('--head', options.headBranch)
  return argv
}

/** `gh repo view <repo> --json <fields>`. */
export function repoViewArgv(repository: string, fields: readonly string[] = REPO_VIEW_FIELDS): string[] {
  return ['gh', 'repo', 'view', repository, '--json', fields.join(',')]
}

/**
 * `gh auth status`.
 *
 * The preflight for R3. `gh auth status` exits non-zero when not logged in, so
 * the *exit code* is the answer — the message is only for the human reading the
 * failure, and is never parsed.
 */
export function authStatusArgv(): string[] {
  return ['gh', 'auth', 'status']
}

/**
 * `gh pr create`.
 *
 * `--body-file -` would need stdin; the PR body is built in-process and passed
 * with `--body`, which keeps the call to a single argv with no pipe. The body is
 * caller-authored text, and it arrives as **one argument** — the exec seam's argv
 * array is what makes that safe, and it is why no quoting appears here.
 */
export function prCreateArgv(options: {
  repository: string
  title: string
  body: string
  base: string
  head: string
  draft?: boolean
}): string[] {
  const argv = [
    'gh',
    'pr',
    'create',
    '--repo',
    options.repository,
    '--base',
    options.base,
    '--head',
    options.head,
    '--title',
    options.title,
    '--body',
    options.body,
  ]
  if (options.draft) argv.push('--draft')
  return argv
}

/**
 * `gh api` for posting a review with inline comments.
 *
 * The verdict **cannot** be a review state: the reviewer acts from the pull
 * request author's own account, and GitHub rejects both `APPROVE` and
 * `REQUEST_CHANGES` on your own PR (PRD §7.5, R17). So the event is always
 * `COMMENT` and the machine verdict travels out-of-band through
 * `orchestrator_review_verdict`. Passing an `event` here is therefore not merely
 * avoided — it is asserted against, because a caller that "helpfully" forwarded
 * the verdict would produce a 422 on every PR.
 */
export function prReviewArgv(options: {
  repository: string
  number: number
  body: string
  comments?: ReadonlyArray<{ path: string; line: number; body: string }>
}): string[] {
  assertPullRequestNumber(options.number)
  return [
    'gh',
    'api',
    '--method',
    'POST',
    `repos/${options.repository}/pulls/${options.number}/reviews`,
    // Always COMMENT. See the note above; this is R17, not a preference.
    '-f',
    'event=COMMENT',
    '-f',
    `body=${options.body}`,
    ...commentFields(options.comments ?? []),
  ]
}

/** One `-f comments[][…]` triple per finding, which is how `gh api` encodes arrays. */
function commentFields(comments: ReadonlyArray<{ path: string; line: number; body: string }>): string[] {
  const fields: string[] = []
  for (const comment of comments) {
    fields.push('-f', `comments[][path]=${comment.path}`)
    fields.push('-f', `comments[][line]=${comment.line}`)
    fields.push('-f', `comments[][body]=${comment.body}`)
  }
  return fields
}

/**
 * `gh api repos/…/issues/<n>` for issue mirroring.
 *
 * `--input -` would need stdin, so the fields are passed individually.
 */
export function issueCreateArgv(options: {
  repository: string
  title: string
  body?: string
  labels?: readonly string[]
}): string[] {
  const argv = [
    'gh',
    'api',
    '--method',
    'POST',
    `repos/${options.repository}/issues`,
    '-f',
    `title=${options.title}`,
  ]
  if (options.body) argv.push('-f', `body=${options.body}`)
  for (const label of options.labels ?? []) argv.push('-f', `labels[]=${label}`)
  return argv
}

/** `gh api repos/…/issues/<n>` to read an issue back. */
export function issueViewArgv(options: { repository: string; number: number }): string[] {
  if (!Number.isInteger(options.number) || options.number < 1) {
    throw new Error(`issueViewArgv: number must be a positive integer, got ${options.number}`)
  }
  return ['gh', 'api', `repos/${options.repository}/issues/${options.number}`]
}

/**
 * A `git push` for a worker's branch.
 *
 * **No `--force`, ever.** The PRD's authority rule is that the plugin never
 * force-pushes, and the worker contract forbids rewriting shared history. There is
 * no parameter to enable it, so it cannot be reached by configuration either.
 */
export function pushArgv(options: { branch: string; remote?: string; setUpstream?: boolean }): string[] {
  const argv = ['git', 'push', options.remote ?? 'origin', options.branch]
  if (options.setUpstream) argv.push('--set-upstream')
  return argv
}

/** `git rev-parse --is-inside-work-tree`, the repo preflight's first question. */
export function isWorkTreeArgv(): string[] {
  return ['git', 'rev-parse', '--is-inside-work-tree']
}

/** `git rev-parse --abbrev-ref HEAD`, for the base branch when it is not configured. */
export function currentBranchArgv(): string[] {
  return ['git', 'rev-parse', '--abbrev-ref', 'HEAD']
}

function assertPullRequestNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`expected a positive pull-request number, got ${number}`)
  }
}
