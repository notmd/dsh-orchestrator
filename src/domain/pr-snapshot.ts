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

/**
 * Whether git can merge the branch.
 *
 * The reference's vocabulary is `unknown | mergeable | conflicting | blocked | unstable`,
 * and this type carries the subset the provider's `mergeable` field can actually hold.
 * `BLOCKED` is reachable here only by **synthesis** (see {@link synthesizeMergeability}) —
 * GitHub reports the blocked state through `mergeStateStatus`, not through `mergeable` —
 * and `unstable` is **not** here at all: it is a `mergeStateStatus` value, and that field
 * is carried verbatim as its own string rather than flattened into this one.
 */
export type PrMergeability = 'MERGEABLE' | 'CONFLICTING' | 'BLOCKED' | 'UNKNOWN' | ''

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

/**
 * Why a pull request cannot be merged yet — as a list of reasons, not a boolean.
 *
 * Ported in shape from Agent Orchestrator's `mergeBlockersFromLocal`: AO composes its
 * mergeability from nine prioritised rules and **synthesizes `blocked` locally** from
 * draft, failing CI and changes-requested, then feeds a merge-readiness card the *reasons*
 * it cannot merge. This plugin passed the provider's `mergeable`/`mergeStateStatus`
 * through untouched, so a PR the provider reports as `mergeStateStatus: BLOCKED` with
 * `mergeable: UNKNOWN` arrived as an empty mergeability — the same *lane* by a different
 * route, but with nothing to tell the user *why*.
 *
 * The order is the reading order of a merge-readiness card: the things the worker or the
 * author must act on first, then the things a reviewer must, then the provider's own
 * verdict, then honest uncertainty.
 */
export const MergeBlocker = Object.freeze({
  /** The branch no longer applies cleanly to its base. */
  conflicting: 'conflicting',
  /** A draft is not mergeable by definition. */
  draft: 'draft',
  /** A failing check must be fixed. */
  ciFailing: 'ci_failing',
  /** Someone asked for changes. */
  changesRequested: 'changes_requested',
  /** The repository requires a review that has not happened. */
  reviewRequired: 'review_required',
  /** The provider says `BLOCKED` and no local fact explains it. */
  providerBlocked: 'provider_blocked',
  /** The provider has not computed mergeability yet — GitHub's recompute window. */
  unknownState: 'unknown_state',
} as const)

/** The union of every merge blocker. */
export type MergeBlocker = (typeof MergeBlocker)[keyof typeof MergeBlocker]

/** Every blocker, in the order a merge-readiness card reads them. */
export const MERGE_BLOCKERS: readonly MergeBlocker[] = Object.freeze([
  MergeBlocker.conflicting,
  MergeBlocker.draft,
  MergeBlocker.ciFailing,
  MergeBlocker.changesRequested,
  MergeBlocker.reviewRequired,
  MergeBlocker.providerBlocked,
  MergeBlocker.unknownState,
])

/** The locally-known facts mergeability is composed from. */
export interface MergeBlockerInput {
  state: PrState
  isDraft: boolean
  /** The provider's own answer, before synthesis. */
  mergeable: PrMergeability
  mergeStateStatus: string
  ciState: CiState
  reviewDecision: string
}

/**
 * One local rule per blocker.
 *
 * `known` is the list the rules before this one have already produced, which is what the two
 * fallbacks need: they may only speak when nothing else explains the state. Passing it in
 * keeps the ORDER in one place ({@link MERGE_BLOCKERS}) rather than in the sequence of `if`
 * statements — the order is part of the contract (it is the reading order of a
 * merge-readiness card), so it should be writable once.
 */
const MERGE_BLOCKER_RULES: Readonly<
  Record<MergeBlocker, (input: MergeBlockerInput, known: readonly MergeBlocker[]) => boolean>
> = Object.freeze({
  // `CONFLICTING` is the provider's own word; `DIRTY` is the merge-state equivalent.
  [MergeBlocker.conflicting]: (input) => input.mergeable === 'CONFLICTING' || input.mergeStateStatus === 'DIRTY',
  [MergeBlocker.draft]: (input) => input.isDraft,
  [MergeBlocker.ciFailing]: (input) => input.ciState === 'failing',
  [MergeBlocker.changesRequested]: (input) => input.reviewDecision === 'CHANGES_REQUESTED',
  [MergeBlocker.reviewRequired]: (input) => input.reviewDecision === 'REVIEW_REQUIRED',
  // The provider said blocked and nothing above explains it: say so rather than inventing a
  // cause, which is what a synthesized reason list must never do.
  [MergeBlocker.providerBlocked]: (input, known) => input.mergeStateStatus === 'BLOCKED' && known.length === 0,
  // No reason and no answer: GitHub recomputes mergeability asynchronously after a push or a
  // retarget, so `UNKNOWN` means "not yet", not "fine".
  [MergeBlocker.unknownState]: (input, known) =>
    input.mergeable !== 'MERGEABLE' && input.mergeable !== 'CONFLICTING' && known.length === 0,
})

/**
 * The reasons this pull request is not mergeable, from facts already held.
 *
 * A landed pull request has nothing left to block, so it returns an empty list: reporting
 * "conflicting" on a merged PR would be true about the branch and useless about the work.
 */
export function mergeBlockersFromLocal(input: MergeBlockerInput): MergeBlocker[] {
  if (input.state === 'MERGED' || input.state === 'CLOSED') return []
  const blockers: MergeBlocker[] = []
  for (const blocker of MERGE_BLOCKERS) {
    if (MERGE_BLOCKER_RULES[blocker](input, blockers)) blockers.push(blocker)
  }
  return blockers
}

/**
 * Composes the mergeability this plugin records.
 *
 * Three rules, and all of them exist so a *lane* cannot change on a fact nobody verified:
 *
 *   - `MERGEABLE` and `CONFLICTING` are kept verbatim. These are the provider's **positive
 *     answers** — it computed them — and overriding a computed conflict with locally-derived
 *     confidence is how a card promises a merge that then fails.
 *   - **`UNKNOWN` is not an answer.** It means GitHub has not finished composing one (it
 *     recomputes asynchronously after a push or a retarget), so when a local reason explains
 *     the state, that reason decides and the result is `BLOCKED` — AO's own synthesis.
 *   - When there is no reason *and* no answer, the result stays `UNKNOWN`. Turning "we do not
 *     know yet" into "you are blocked", or into green, is the same class of lie as an empty
 *     payload reading as `CLOSED`.
 */
export function synthesizeMergeability(base: PrMergeability, blockers: readonly MergeBlocker[]): PrMergeability {
  if (base === 'MERGEABLE' || base === 'CONFLICTING') return base
  if (blockers.includes(MergeBlocker.conflicting)) return 'CONFLICTING'
  const actionable = blockers.filter((blocker) => blocker !== MergeBlocker.unknownState)
  return actionable.length > 0 ? 'BLOCKED' : 'UNKNOWN'
}

/**
 * One review thread, reduced to what the board and the feedback loop read.
 *
 * GitHub models a review as a **thread** of comments with a resolution state; neither
 * `gh pr view --json reviews` nor `pulls/{n}/comments` exposes that state, which is why
 * finding G4 is about threads rather than about comments. Without it "is this discussion
 * still outstanding?" is not a decidable fact.
 */
export interface PrReviewThread {
  id: string
  /** The discussion is finished — nobody needs to answer it again. */
  isResolved: boolean
  /**
   * The **REST database ids** of the thread's comments.
   *
   * `databaseId` on purpose: `PrReviewComment.restId` and `inReplyToId` are REST ids, so
   * this is the only id space in which a thread and a comment can be matched at all.
   */
  commentRestIds: readonly string[]
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
  /**
   * Why this pull request cannot be merged yet, in reading order.
   *
   * Derived locally from the facts above (see {@link mergeBlockersFromLocal}), and
   * carried so the card can say *why* rather than only showing the phrase. Absent on a
   * record written before this existed, so every reader treats `undefined` as "not
   * computed" rather than "nothing blocks it".
   */
  mergeBlockers?: readonly MergeBlocker[]
  /**
   * The review threads and their resolution state, from a THIRD call.
   *
   * Absent on a snapshot built before this field existed — and absent is deliberately
   * **not** "everything is unresolved": no reader may skip a person's comment on the
   * strength of a list that was never fetched, so absence means "resolution unknown" and
   * every consumer fails open toward routing.
   */
  reviewThreads?: readonly PrReviewThread[]
  /**
   * When the thread list was last refreshed, epoch ms.
   *
   * Threads refresh on their own, slower cadence than the PR facts (the reference's is two
   * minutes), so this is what lets the observer skip the extra call without losing the list
   * it already has. Finding G1: the missing cadence is why we make every call every tick.
   */
  reviewThreadsAt?: number
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

  const state = (typeof record.state === 'string' ? record.state.toUpperCase() : '') as PrState
  const providerMergeable = (typeof record.mergeable === 'string' ? record.mergeable.toUpperCase() : '') as PrMergeability
  const mergeStateStatus = typeof record.mergeStateStatus === 'string' ? record.mergeStateStatus : ''
  const reviewDecision = typeof record.reviewDecision === 'string' ? record.reviewDecision : ''
  const ciState = deriveCiState(record.statusCheckRollup)
  const mergeBlockers = mergeBlockersFromLocal({
    state,
    isDraft: record.isDraft === true,
    mergeable: providerMergeable,
    mergeStateStatus,
    ciState,
    reviewDecision,
  })

  return {
    number: typeof record.number === 'number' ? record.number : 0,
    url: typeof record.url === 'string' ? record.url : '',
    state,
    isDraft: record.isDraft === true,
    // Synthesized from the local reasons when the provider had no answer: AO's
    // `mergeBlockersFromLocal` + composition, which we were missing (finding G3).
    mergeable: synthesizeMergeability(providerMergeable, mergeBlockers),
    mergeStateStatus,
    reviewDecision,
    ciState,
    mergeBlockers,
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
 * Parses `gh api graphql`'s review-thread payload.
 *
 * Tolerant in the same way every other parser here is: the shape is
 * `{data:{repository:{pullRequest:{reviewThreads:{nodes:[…]}}}}}`, and a missing level
 * yields an empty list rather than an exception. An empty list is *not* the same as an
 * unfetched one — a caller that could not fetch does not call this at all — so a
 * genuinely thread-less pull request reads as "nothing outstanding", which is correct.
 */
export function parseReviewThreads(payload: unknown): PrReviewThread[] {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const data = (typeof record.data === 'object' && record.data !== null ? record.data : {}) as Record<string, unknown>
  const repository = (typeof data.repository === 'object' && data.repository !== null ? data.repository : {}) as Record<string, unknown>
  const pullRequest = (typeof repository.pullRequest === 'object' && repository.pullRequest !== null ? repository.pullRequest : {}) as Record<string, unknown>
  const threads = (typeof pullRequest.reviewThreads === 'object' && pullRequest.reviewThreads !== null ? pullRequest.reviewThreads : {}) as Record<string, unknown>
  if (!Array.isArray(threads.nodes)) return []

  const out: PrReviewThread[] = []
  for (const entry of threads.nodes as unknown[]) {
    const thread = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const comments = (typeof thread.comments === 'object' && thread.comments !== null ? thread.comments : {}) as Record<string, unknown>
    const ids = Array.isArray(comments.nodes)
      ? (comments.nodes as unknown[])
          .map((comment) =>
            typeof comment === 'object' && comment !== null && (comment as { databaseId?: unknown }).databaseId !== null
              ? String((comment as { databaseId?: unknown }).databaseId ?? '')
              : '',
          )
          .filter((id) => id !== '')
      : []
    out.push({
      id: typeof thread.id === 'string' ? thread.id : '',
      // The ONLY state that answers "is this discussion still waiting on the worker?".
      // GitHub also reports `isOutdated` (the head moved past these lines); the reference
      // carries it and does **not** use it to skip a thread, so neither do we — an outdated
      // comment is still a person's unanswered question. Not requested, because a field no
      // rule reads is a field that will drift.
      isResolved: thread.isResolved === true,
      commentRestIds: ids,
    })
  }
  return out
}

/**
 * The REST ids of comments that sit in a **resolved** thread.
 *
 * Empty when the thread list was never fetched, which is the fail-open direction
 * deliberately: the failure that matters is dropping a person's comment, not routing a
 * resolved one. Finding G4 records the same reasoning for the reference's client-side skip.
 */
export function resolvedCommentRestIds(snapshot: { reviewThreads?: readonly PrReviewThread[] }): Set<string> {
  const resolved = new Set<string>()
  for (const thread of snapshot.reviewThreads ?? []) {
    if (!thread.isResolved) continue
    for (const id of thread.commentRestIds) resolved.add(id)
  }
  return resolved
}

/**
 * Whether a comment's discussion is finished.
 *
 * A comment is resolved only when its thread says so. An unknown thread — an odd payload, a
 * comment the thread list did not carry — reads as **unresolved**, because the conservative
 * direction for "should a person's feedback reach the worker?" is yes.
 */
export function isResolvedComment(snapshot: { reviewThreads?: readonly PrReviewThread[] }, restId: string): boolean {
  if (restId === '') return false
  return resolvedCommentRestIds(snapshot).has(restId)
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
