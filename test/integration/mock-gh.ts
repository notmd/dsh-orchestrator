/**
 * A stand-in for the `gh` CLI, for end-to-end tests of the whole flow.
 *
 * The user's call: a real pull request needs write access to a repository somebody
 * owns, so the PR half is exercised against a **mock provider** instead of being left
 * unexercised. Written as a test seam rather than a throwaway spike, so it keeps
 * giving regression value.
 *
 * ## It intercepts `gh` and delegates everything else
 *
 * Git commands pass through to the REAL `git`. That matters: the worktree operations
 * are half the integration risk, and a mock that also faked git would verify nothing
 * about them -- the exact trap this project has fallen into repeatedly.
 *
 * Every argument list is recorded, so a test can assert the argv the plugin built
 * rather than only the effect it had.
 *
 * @module dsho/test/integration/mock-gh
 */

import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

/** One pull request the mock knows about. */
export interface MockPr {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  headRefName: string
  headRefOid: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  statusCheckRollup?: unknown[]
  reviews?: unknown[]
  comments?: unknown[]
}

/** The mock's world. */
export interface MockGitHub {
  run: RunCommand
  readonly calls: string[][]
  readonly prs: MockPr[]
  /** A human review, as the provider would report it. */
  addReview(prNumber: number, review: { id: string; state: string; author: string; body?: string; isBot?: boolean }): void
  addComment(prNumber: number, comment: { id: string; author: string; body: string; isBot?: boolean }): void
  setState(prNumber: number, state: MockPr['state']): void
  head(prNumber: number, sha: string): void
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' }
}

/** The mock, with a real `git` behind it for everything that is not `gh`. */
export function mockGitHub(options: {
  repository: string
  defaultBranch?: string
  /** The real runner, for `git` and for the verify commands. */
  passThrough: RunCommand
}): MockGitHub {
  const calls: string[][] = []
  const prs: MockPr[] = []
  let nextNumber = 100

  const run: RunCommand = async (argv, runOptions) => {
    calls.push([...argv])
    const joined = argv.join(' ')
    const [owner, name] = options.repository.split('/')

    // NOT gh: the real thing. Worktree operations are half the integration risk.
    if (argv[0] !== 'gh') return options.passThrough(argv, runOptions)

    if (joined.startsWith('gh auth status')) return ok('Logged in')
    if (joined.startsWith('gh repo view')) {
      return ok(
        JSON.stringify({
          nameWithOwner: options.repository,
          defaultBranchRef: { name: options.defaultBranch ?? 'main' },
          url: `https://github.com/${options.repository}`,
          isPrivate: true,
          owner: { login: owner },
          name,
        }),
      )
    }
    if (joined.startsWith('gh pr create')) {
      const branch = valueOf(argv, '--head') ?? 'unknown'
      const number = nextNumber++
      const pr: MockPr = {
        number,
        url: `https://github.com/${options.repository}/pull/${number}`,
        state: 'OPEN',
        headRefName: branch,
        headRefOid: 'sha-' + number,
      }
      prs.push(pr)
      return ok(pr.url)
    }
    if (joined.startsWith('gh pr list')) return ok(JSON.stringify(prs.map((pr) => ({ ...pr }))))
    if (joined.startsWith('gh pr view')) {
      const number = Number(argv[3])
      const pr = prs.find((candidate) => candidate.number === number)
      if (!pr) return { exitCode: 1, stdout: '', stderr: `no pull request ${number}` }
      return ok(JSON.stringify(pr))
    }
    if (joined.startsWith('gh pr merge')) {
      const number = Number(argv[3])
      const pr = prs.find((candidate) => candidate.number === number)
      if (pr) pr.state = 'MERGED'
      return ok('')
    }
    return { exitCode: 1, stdout: '', stderr: `the mock does not implement: ${joined}` }
  }

  return {
    run,
    calls,
    prs,
    addReview(prNumber, review) {
      const pr = prs.find((candidate) => candidate.number === prNumber)
      if (!pr) throw new Error(`no pull request ${prNumber}`)
      pr.reviews = [
        ...(pr.reviews ?? []),
        {
          id: review.id,
          state: review.state,
          author: { login: review.author, __typename: review.isBot === true ? 'Bot' : 'User' },
          ...(review.body ? { body: review.body } : {}),
        },
      ]
    },
    addComment(prNumber, comment) {
      const pr = prs.find((candidate) => candidate.number === prNumber)
      if (!pr) throw new Error(`no pull request ${prNumber}`)
      pr.comments = [
        ...(pr.comments ?? []),
        {
          id: comment.id,
          author: { login: comment.author, __typename: comment.isBot === true ? 'Bot' : 'User' },
          body: comment.body,
        },
      ]
    },
    setState(prNumber, state) {
      const pr = prs.find((candidate) => candidate.number === prNumber)
      if (pr) pr.state = state
    },
    head(prNumber, sha) {
      const pr = prs.find((candidate) => candidate.number === prNumber)
      if (pr) pr.headRefOid = sha
    },
  }
}

/** The value following a flag, if present. */
function valueOf(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}
