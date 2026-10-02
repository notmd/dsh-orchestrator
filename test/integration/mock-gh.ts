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
  /** Inline review comments, as the REST `/pulls/{n}/comments` endpoint returns them. */
  reviewComments?: unknown[]
  /**
   * Review threads, as the GraphQL `reviewThreads` field returns them.
   *
   * A separate list from the comments, because that is how GitHub models it: the comments
   * endpoint has no resolution state, and the thread endpoint has nothing else. Finding G4.
   */
  reviewThreads?: Array<{ id: string; isResolved: boolean; isOutdated: boolean; commentRestIds: Array<string | number> }>
}

/** The mock's world. */
export interface MockGitHub {
  run: RunCommand
  readonly calls: string[][]
  readonly prs: MockPr[]
  /** A human review, as the provider would report it. */
  addReview(prNumber: number, review: { id: string; state: string; author: string; body?: string; isBot?: boolean }): void
  addComment(prNumber: number, comment: { id: string; author: string; body: string; isBot?: boolean }): void
  /**
   * A review comment anchored to a file and line, as GitHub stores one.
   *
   * `reviewId` is the numeric id of the review it belongs to — the field the plugin uses
   * to recognise its OWN reviewer's inline comments, since our reviewer posts from the pull
   * request author's account and so cannot be filtered by author.
   */
  /** Returns the comment's REST database id, which is what a thread references. */
  addReviewComment(
    prNumber: number,
    comment: { id: string; reviewId?: string; author: string; body: string; path: string; line?: number; isBot?: boolean },
  ): number
  /**
   * A review thread and its resolution state, as GraphQL reports it.
   *
   * `commentRestIds` are the **REST** ids of the thread's comments — the id space
   * `PrReviewComment.restId` and `in_reply_to_id` use, and the only one in which a thread
   * and a comment can be matched. `addReviewComment` returns the REST id to use here.
   */
  addReviewThread(prNumber: number, thread: { id: string; isResolved?: boolean; isOutdated?: boolean; commentRestIds?: Array<string | number> }): void
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
    // The inline review comments. A SECOND endpoint, because `gh pr view --json` has no
    // field for them -- which is why a person's line comment was invisible to the plugin.
    // The review threads and their resolution state. A THIRD endpoint, GraphQL this time,
    // because neither `gh pr view --json` nor the comments endpoint carries `isResolved`.
    if (joined.startsWith('gh api graphql')) {
      const number = Number(argv.find((arg) => arg.startsWith('number='))?.slice('number='.length) ?? '')
      const pr = prs.find((candidate) => candidate.number === number)
      if (!pr) return { exitCode: 1, stdout: '', stderr: `no pull request ${number}` }
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: (pr.reviewThreads ?? []).map((thread) => ({
                    id: thread.id,
                    isResolved: thread.isResolved,
                    isOutdated: thread.isOutdated,
                    comments: { nodes: thread.commentRestIds.map((databaseId) => ({ databaseId })) },
                  })),
                },
              },
            },
          },
        }),
      )
    }
    if (joined.startsWith('gh api') && joined.includes('/comments')) {
      const number = Number(/pulls\/(\d+)\/comments/.exec(joined)?.[1] ?? '')
      const pr = prs.find((candidate) => candidate.number === number)
      if (!pr) return { exitCode: 1, stdout: '', stderr: `no pull request ${number}` }
      return ok(JSON.stringify(pr.reviewComments ?? []))
    }
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
    addReviewComment(prNumber, comment) {
      const pr = prs.find((candidate) => candidate.number === prNumber)
      if (!pr) throw new Error(`no pull request ${prNumber}`)
      // The REST id is a **number** on GitHub, and `restId` is derived from it — so a thread
      // referencing this comment references a number too. Derived rather than counted so the
      // mock cannot hand out two ids that collide across pull requests.
      const restId = 1000 + prNumber * 100 + (pr.reviewComments?.length ?? 0)
      pr.reviewComments = [
        ...(pr.reviewComments ?? []),
        {
          // REST shape, not GraphQL: this endpoint returns `node_id` and a numeric
          // `pull_request_review_id`, and `user.type` as the bot marker.
          id: restId,
          node_id: comment.id,
          pull_request_review_id: comment.reviewId === undefined ? null : Number(comment.reviewId),
          user: { login: comment.author, type: comment.isBot === true ? 'Bot' : 'User' },
          body: comment.body,
          path: comment.path,
          line: comment.line ?? null,
          created_at: '2026-10-01T00:00:00Z',
        },
      ]
      return restId
    },
    addReviewThread(prNumber, thread) {
      const pr = prs.find((candidate) => candidate.number === prNumber)
      if (!pr) throw new Error(`no pull request ${prNumber}`)
      pr.reviewThreads = [
        ...(pr.reviewThreads ?? []),
        {
          id: thread.id,
          isResolved: thread.isResolved === true,
          isOutdated: thread.isOutdated === true,
          commentRestIds: [...(thread.commentRestIds ?? [])],
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
