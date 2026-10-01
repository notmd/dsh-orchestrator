/**
 * The new-task title (the reference's "New task" flow).
 *
 * **The problem this solves is perceived latency.** A worker spawn is a few
 * seconds of git and process work, and a person who has just typed a paragraph
 * wants a card with a name on it, not a spinner. So the task is named
 * *immediately* from its own brief, and that name is **provisional**: a concise
 * title is asked for afterwards, in the background, and replaces it only if it
 * arrives in time and nothing else has renamed the task meanwhile.
 *
 * Every rule here is ported from the reference's `delegation.go`, and the
 * constants are theirs:
 *
 *   - the provisional title is the brief with whitespace collapsed, capped at
 *     100 characters, and `Untitled task` when there is nothing to collapse —
 *     which is a real state, because a promptless worker is allowed;
 *   - the generated title is only the FIRST LINE, with leading markdown bullets
 *     and surrounding quotes/punctuation stripped, and it must contain a letter
 *     or a digit — a model answering `"###"` has not named anything;
 *   - refinement is **best effort**: it is dropped past a small concurrency cap,
 *     abandoned after a minute, and never allowed to hold a response open.
 *
 * The alternative — waiting for the model before showing the card — is the
 * behaviour this feature exists to remove, so the provisional title is never
 * softened into an empty string.
 *
 * @module dsho/domain/task-title
 */

/**
 * The longest a task title may be — the reference's `maxDisplayNameLen`.
 *
 * Deliberately shorter than this plugin's `MAX_TITLE_LENGTH` (200, which also has
 * to survive as a branch segment): this is a *name*, and a name that wraps four
 * times on a card is not one.
 */
export const TASK_TITLE_LIMIT = 100

/** What a task is called when its brief names nothing. The reference's own string. */
export const UNTITLED_TASK = 'Untitled task'

/**
 * The instruction a refinement request carries (the reference's, verbatim).
 *
 * "Do not use tools, change files, or explain the answer" is the load-bearing
 * clause: a title request that is answered with a paragraph has to be parsed, and
 * parsing a paragraph is where a title like "Sure! Here's a title:" comes from.
 */
export const TASK_TITLE_SYSTEM_PROMPT =
  'Return only a concise task title of at most 100 characters. Do not use tools, change files, or explain the answer.'

/** How long a provisional title stays replaceable (the reference's one minute). */
export const TASK_REFINEMENT_TIMEOUT_MS = 60_000

/**
 * How many refinements may be outstanding at once.
 *
 * At the cap the request is DROPPED rather than queued, which is the reference's
 * decision and the right one: a title is cosmetic, and a queue of cosmetic work
 * behind a busy board is a queue that grows while nobody is watching it.
 */
export const TASK_REFINEMENT_LIMIT = 4

/**
 * Removes control characters, keeping the three that are layout.
 *
 * Ported from the reference's `domain.SanitizeControlChars`: a title is echoed
 * into a session title, a card and a branch slug, so a stray escape sequence is
 * not merely ugly — it is a string that steers a terminal.
 */
export function sanitizeControlCharacters(value: string): string {
  return (value ?? '').replace(/[\p{Cc}]/gu, (character) => (character === '\n' || character === '\r' || character === '\t' ? character : ''))
}

/** Truncates to {@link TASK_TITLE_LIMIT}, by CODE POINTS rather than UTF-16 units. */
function capped(title: string): string {
  const characters = [...title]
  return characters.length <= TASK_TITLE_LIMIT ? title : characters.slice(0, TASK_TITLE_LIMIT).join('').trim()
}

/**
 * The title a task gets the moment it is created.
 *
 * Whitespace is collapsed because a brief is typed into a textarea and arrives
 * with newlines and runs of spaces that read as a broken card title.
 */
export function provisionalTaskTitle(brief: string): string {
  const title = sanitizeControlCharacters(brief ?? '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ')
  return title === '' ? UNTITLED_TASK : capped(title)
}

/**
 * The title a model's answer yields, or `''` when it named nothing.
 *
 * The order is the reference's: sanitize, keep the first line, drop the leading
 * markdown bullet/heading markers, trim the surrounding quotes and punctuation,
 * then require a letter or a digit. `''` is a REFUSAL rather than an empty title,
 * so the caller keeps the provisional one instead of writing a blank.
 */
export function generatedTaskTitle(raw: string): string {
  const firstLine = sanitizeControlCharacters(raw ?? '').split('\n')[0] ?? ''
  const deBulleted = firstLine.replace(/^[#*>\-+ \t\r]+/, '')
  const trimmed = deBulleted
    .replace(/^[\s"'\u0060\u201C\u201D\u2018\u2019.,;:!\u3002]+/, '')
    .replace(/[\s"'\u0060\u201C\u201D\u2018\u2019\t\r.,;:!\u3002]+$/, '')
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return ''
  return provisionalTaskTitle(trimmed)
}
