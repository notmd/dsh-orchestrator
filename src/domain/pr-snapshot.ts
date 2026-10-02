/**
 * The pull-request snapshot (PRD §7.4) and the parser for `gh pr view --json`.
 *
 * A **snapshot of provider facts, not a history**: the board's reducer reads only
 * current truth, so there is one row per PR and it is overwritten.
 *
 * ## The one invariant that matters
 *
 * `fetched` is `true` **only when the observation produced usable facts**. A failed
 * observation must leave the prior snapshot intact rather than writing an empty
 * one, because an empty snapshot reads as "PR closed" to the reducer — which would
 * archive a live worker. R13 calls that out, and the flag is how it is prevented.
 *
 * ## Bot detection never looks at the login
 *
 * R19: the tempting `login.includes('bot')` false-positives on `robothon` and
 * `lambot123`, silently dropping a **human's** review feedback — the worst
 * possible direction, because the worker never hears about it. Author type is read
 * from `__typename` or `type` when the provider supplies it, and reported as
 * **unknown** when it does not. Unknown is not "human": callers decide, and the
 * conservative direction is to treat a review as actionable.
 *
 * @module dsho/domain/pr-snapshot
 */

/** The provider's PR state. */
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED' | ''

/** Whether git can merge the branch. */
export type PrMergeability = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | ''

/** A provider review verdict, as the provider names it. */
export type PrReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | ''

/** Aggregate CI, derived from the rollup. */
export type CiState = 'passing' | 'pending' | 'failing' | 'unknown'

/** One provider review, reduced to what the board reads. */
export interface PrReview {
  id: string
  state: PrReviewState
  author: string
  /**
   * The review's text, when the provider supplied it.
   *
   * Carried because M4 must route a PERSON's feedback to the worker, and "someone
   * requested changes" without what they asked for is not actionable -- the worker
   * would have to go and read the provider to find out what to do.
   */
  body?: string
  /** `true` bot, `false` human, `undefined` when the provider did not say. */
  isBot: boolean | undefined
}

/** One provider comment. */
export interface PrComment {
  id: string
  author: string
  body: string
  createdAt: string
  isBot: boolean | undefined
}

/**
 * One INLINE review comment — the kind attached to a file and a line.
 *
 * Kept separate from {@link PrComment} rather than folded into it, because they come from
 * different endpoints with different shapes and only this one carries `path`/`line`:
 * `comments` is `gh pr view --json comments` (the PR conversation), while these come from
 * `gh api repos/{owner}/{repo}/pulls/{n}/comments`.
 *
 * **Why they had to be fetched at all.** A person reviewing a diff clicks a line and types
 * — GitHub submits that as a review whose *body* is empty, with the text living on the
 * inline comment. Reading only `reviews[].body` therefore missed every line comment: the
 * review was skipped for having nothing to say while the thing that was said sat in an
 * endpoint the plugin never called.
 */
export interface PrReviewComment {
  /**
   * The comment's node id, matching the id space `reviews[].id` uses.
   *
   * A node id rather than the numeric REST id, so a caller comparing comment ids with
   * review ids is comparing one space. `reviewId` is deliberately the numeric form,
   * because THAT is what the provider gives a comment for its parent review.
   */
  id: string
  /** The review this comment belongs to, in the REST id space. `''` when unreported. */
  reviewId: string
  /**
   * The REST database id, kept ONLY so a reply can be resolved to the comment it answers.
   *
   * GitHub gives a reply the numeric id of its parent in `in_reply_to_id`, but gives the
   * comment itself two ids; without this field the two cannot be compared and the thread
   * cannot be walked at all.
   */
  restId: string
  /**
   * The REST id of the comment this one replies to, when it is a reply.
   *
   * Replies are how a worker reports "Fixed in <sha>" on a finding. Those are the worker's
   * OWN words, and routing them back to it as though a person had written them is how a
   * review exchange becomes a nudge loop.
   */
  inReplyToId?: string
  author: string
  body: string
  /** The file the comment is anchored to. */
  path: string
  /** The line, when the provider supplied one (an outdated comment may not). */
  line: number | undefined
  createdAt: string
  isBot: boolean | undefined
}

/** The facts the board reads for one pull request. */
export interface PrSnapshot {
  number: number
  url: string
  state: PrState
  isDraft: boolean
  mergeable: PrMergeability
  mergeStateStatus: string
  reviewDecision: string
  ciState: CiState
  headSha: string
  headRefName: string
  reviews: readonly PrReview[]
  comments: readonly PrComment[]
  /**
   * Inline review comments, from a SECOND endpoint.
   *
   * Absent on a snapshot built before this field existed, so every reader treats
   * `undefined` as "not fetched" rather than "none".
   */
  reviewComments?: readonly PrReviewComment[]
  /** For actionable-feedback detection. */
  lastCommentId: string
  updatedAt: string
  /** Our clock, epoch ms. */
  observedAt: number
  /**
   * `true` only when every required call succeeded.
   *
   * A failed observation **must never** be written over a good snapshot: an empty
   * snapshot reads as "PR closed" and would archive a live worker (R13).
   */
  fetched: boolean
  /** Why the observation failed, when it did. */
  error?: string
}

/**
 * Reads an author's bot-ness from the provider's own typing.
 *
 * Returns `undefined` rather than guessing. GitHub's GraphQL types are `User` and
 * `Bot` (as `__typename`); its REST shape carries `type` with the same values.
 * **A login is never consulted** (R19).
 */
export function isBotAuthor(author: unknown): boolean | undefined {
  if (typeof author !== 'object' || author === null) return undefined
  const record = author as { __typename?: unknown; type?: unknown }
  const marker = typeof record.__typename === 'string' ? record.__typename : record.type
  if (typeof marker !== 'string' || marker === '') return undefined
  if (marker === 'Bot') return true
  if (marker === 'User' || marker === 'Organization' || marker === 'Mannequin') return false
  return undefined
}

/** A login from an author object, or `''`. */
function authorLogin(author: unknown): string {
  if (typeof author !== 'object' || author === null) return ''
  const login = (author as { login?: unknown }).login
  return typeof login === 'string' ? login : ''
}

/**
 * Derives the aggregate CI state from `statusCheckRollup`.
 *
 * A rollup with no checks at all is `unknown`, not `passing`: a repository with no
 * CI must not be reported as green, or a card would claim a check that never ran.
 * Any failure wins over any pending, because the worker has something to fix
 * either way and the failure is the more urgent fact.
 */
export function deriveCiState(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'unknown'
  let pending = false
  for (const entry of rollup) {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as {
      conclusion?: unknown
      state?: unknown
      status?: unknown
    }
    const conclusion = typeof record.conclusion === 'string' ? record.conclusion.toUpperCase() : ''
    const state = typeof record.state === 'string' ? record.state.toUpperCase() : ''
    const status = typeof record.status === 'string' ? record.status.toUpperCase() : ''

    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(conclusion)) {
      return 'failing'
    }
    if (state === 'FAILURE' || state === 'ERROR') return 'failing'
    if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(status)) pending = true
    if (state === 'PENDING' || state === 'EXPECTED') pending = true
    if (conclusion === '' && status === '') pending = true
  }
  return pending ? 'pending' : 'passing'
}

/**
 * Parses one `gh pr view --json …` payload.
 *
 * Tolerant by design: a missing field becomes its Go zero value rather than an
 * exception, because a provider that adds or omits a key must not take the
 * observer down. The normalizers in `../contract/kanban.ts` then fill what the
 * reducer needs.
 */
export function parsePrView(payload: unknown, observedAt: number): PrSnapshot {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const reviews = Array.isArray(record.reviews)
    ? (record.reviews as unknown[]).map((entry): PrReview => {
        const review = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
        return {
          id: typeof review.id === 'string' ? review.id : String(review.id ?? ''),
          state: (typeof review.state === 'string' ? review.state.toUpperCase() : '') as PrReviewState,
          author: authorLogin(review.author),
          ...(typeof review.body === 'string' ? { body: review.body } : {}),
          isBot: isBotAuthor(review.author),
        }
      })
    : []
  const comments = Array.isArray(record.comments)
    ? (record.comments as unknown[]).map((entry): PrComment => {
        const comment = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
        return {
          id: typeof comment.id === 'string' ? comment.id : String(comment.id ?? ''),
          author: authorLogin(comment.author),
          body: typeof comment.body === 'string' ? comment.body : '',
          createdAt: typeof comment.createdAt === 'string' ? comment.createdAt : '',
          isBot: isBotAuthor(comment.author),
        }
      })
    : []

  return {
    number: typeof record.number === 'number' ? record.number : 0,
    url: typeof record.url === 'string' ? record.url : '',
    state: (typeof record.state === 'string' ? record.state.toUpperCase() : '') as PrState,
    isDraft: record.isDraft === true,
    mergeable: (typeof record.mergeable === 'string' ? record.mergeable.toUpperCase() : '') as PrMergeability,
    mergeStateStatus: typeof record.mergeStateStatus === 'string' ? record.mergeStateStatus : '',
    reviewDecision: typeof record.reviewDecision === 'string' ? record.reviewDecision : '',
    ciState: deriveCiState(record.statusCheckRollup),
    headSha: typeof record.headRefOid === 'string' ? record.headRefOid : '',
    headRefName: typeof record.headRefName === 'string' ? record.headRefName : '',
    reviews,
    comments,
    lastCommentId: comments.length > 0 ? comments[comments.length - 1]!.id : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    observedAt,
    fetched: true,
  }
}

/**
 * Parses `gh api repos/{owner}/{repo}/pulls/{n}/comments`.
 *
 * A bare JSON **array**, unlike every other payload this module reads, because that is what
 * the REST endpoint returns.
 *
 * `isBot` comes from the REST `user.type` marker (`"Bot"` / `"User"`), which IS present
 * here — unlike `gh pr view --json reviews`, which gives no marker at all. It is still only
 * a hint for these comments, because our own reviewer posts from the pull request author's
 * own account (R17) and so has no bot identity: the reliable discriminator remains the
 * parent review's id.
 */
export function parseReviewComments(payload: unknown): PrReviewComment[] {
  if (!Array.isArray(payload)) return []
  const out: PrReviewComment[] = []
  for (const entry of payload as unknown[]) {
    const comment = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const user = typeof comment.user === 'object' && comment.user !== null ? (comment.user as Record<string, unknown>) : {}
    const login = typeof user.login === 'string' ? user.login : ''
    const type = typeof user.type === 'string' ? user.type : ''
    // An outdated comment loses `line` but keeps `original_line`; the line it was written
    // against is more useful to a worker than nothing at all.
    const line =
      typeof comment.line === 'number' ? comment.line : typeof comment.original_line === 'number' ? comment.original_line : undefined
    const replyTo =
      comment.in_reply_to_id === null || comment.in_reply_to_id === undefined
        ? undefined
        : String(comment.in_reply_to_id)
    out.push({
      id: typeof comment.node_id === 'string' ? comment.node_id : String(comment.id ?? ''),
      restId: comment.id === null || comment.id === undefined ? '' : String(comment.id),
      ...(replyTo === undefined ? {} : { inReplyToId: replyTo }),
      reviewId: comment.pull_request_review_id === null || comment.pull_request_review_id === undefined
        ? ''
        : String(comment.pull_request_review_id),
      author: login,
      body: typeof comment.body === 'string' ? comment.body : '',
      path: typeof comment.path === 'string' ? comment.path : '',
      line,
      createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
      isBot: type === '' ? undefined : type === 'Bot',
    })
  }
  return out
}

/**
 * The snapshot written when an observation **failed**.
 *
 * Carries `fetched: false` and the **prior** snapshot's identity, so a caller that
 * ignores the flag still cannot fabricate a transition to `CLOSED`/`MERGED`.
 */
export function unfetchedSnapshot(prior: PrSnapshot | undefined, error: string, observedAt: number): PrSnapshot {
  if (!prior) {
    return {
      number: 0,
      url: '',
      state: '',
      isDraft: false,
      mergeable: '',
      mergeStateStatus: '',
      reviewDecision: '',
      ciState: 'unknown',
      headSha: '',
      headRefName: '',
      reviews: [],
      comments: [],
      reviewComments: [],
      lastCommentId: '',
      updatedAt: '',
      observedAt,
      fetched: false,
      error,
    }
  }
  return { ...prior, observedAt, fetched: false, error }
}

/**
 * True when the PR is in a state that ends the worker's involvement.
 *
 * Requires a **fetched** snapshot (R13): an unfetched one carries the prior facts,
 * so this is only meaningful when the observation actually succeeded.
 */
export function isTerminalPr(snapshot: PrSnapshot): boolean {
  return snapshot.fetched && (snapshot.state === 'MERGED' || snapshot.state === 'CLOSED')
}
