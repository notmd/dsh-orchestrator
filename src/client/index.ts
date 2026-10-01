/**
 * DSH Orchestrator — client half.
 *
 * Shipped as a **classic script** in the `window.__ModuleLoader__` format, not an ES
 * module: that is how this harness loads a client bundle, and it is why this file is
 * compiled by its own config (`tsconfig.client.json`, `module: none`) rather than
 * with the host half.
 *
 * ## Self-contained on purpose
 *
 * `module: none` forbids imports, so the snapshot types below are declared here
 * rather than imported from `../host/board-service.ts`. They mirror that shape, and
 * the `dsho-client-shape` test asserts they stay in step — a drift would otherwise
 * show up as a silently blank board.
 *
 * ## Polling, not SSE
 *
 * The PRD's read path is one snapshot endpoint plus a stream. **SSE through
 * `ctx.webServer.register` is unverified** (Appendix A §A10 item 5) and the
 * documented fallback is polling, so the board polls `/dsho/api/board`. A stale
 * board is worse than a slightly late one, so the interval is short and the request
 * is uncached.
 *
 * ## Never serve HTML from the host
 *
 * The UI rules are binding, not stylistic: React in a slot, never an iframe; style
 * with `--dsw-alias-*` tokens; no `require` of a `dsh-client-ui-*` package. A
 * component that throws blanks the whole slot entry, which is why every render path
 * below is guarded and the error state is a real state rather than an exception.
 *
 * @module dsho/client
 */

/**
 * The module loader, declared here because this file is a **script**, not a module.
 *
 * A `declare global` block would need an import or export to be legal, and either
 * would make this a module and change what the compiler emits. Declaring `Window`
 * at the top level of a script merges with the DOM lib's own declaration instead.
 */
interface Window {
  __ModuleLoader__: {
    load(spec: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
  }
}

/** One card, as the endpoint serialises it. Mirrors `BoardCardView`. */
interface CardView {
  id: string
  updatedAt: number
  sessionId: string
  title: string
  column: string
  displayStatus: string
  status: string
  statusReadiness: string
  needsAttention: boolean
  showStatusLoader: boolean
  isFinished: boolean
  escalationReason?: string
  /** The worker's branch. Mirrors `BoardCardView.branch`. */
  branch?: string
  /** Humans who reviewed, never bots. Mirrors `BoardCardView.reviewers`. */
  reviewers?: ReadonlyArray<{ name: string; state: string }>
  /** Mirrors `BoardCardView.prs` (the slice the card face uses). */
  prs?: ReadonlyArray<{ url: string; number?: number }>
  /** Mirrors `CardReview`. Present only when a pass has run at this head. */
  review?: {
    round: number
    maxRounds: number
    verdict?: string
    findings: ReadonlyArray<{ severity: string; path?: string; line?: number; summary: string; detail: string }>
    githubReviewId?: string
  }
}

/** The board snapshot. Mirrors `BoardSnapshot`. */
interface BoardSnapshot {
  generatedAt: number
  lenses: { lanes: Record<string, CardView[]>; archive: CardView[] }
  counts: { total: number; needsAttention: number; byLane: Record<string, number> }
}

/** The lane order the board renders, and the labels it uses. */
const LANES: ReadonlyArray<{ key: string; labelKey: string }> = [
  { key: 'building', labelKey: 'orchestrator.lane.building' },
  { key: 'validating', labelKey: 'orchestrator.lane.validating' },
  { key: 'needs_review', labelKey: 'orchestrator.lane.needs_review' },
  { key: 'ready', labelKey: 'orchestrator.lane.ready' },
]

/** The endpoint this panel reads. The client's only coupling to the host. */
const BOARD_PATH = '/dsho/api/board'

/**
 * The English fallback, keyed by the locale namespace.
 *
 * Mirrors `locale/en.json`, and a test asserts the two agree -- so a string cannot be
 * edited in one place and not the other. It is a FALLBACK, not the source: the
 * platform's translate surface is consulted first when it is present.
 *
 * `module: none` forbids importing `en.json`, hence a duplicated table plus a test
 * rather than a build step.
 */
const FALLBACK: Record<string, string> = {
  'orchestrator.title': 'Orchestrator',
  'orchestrator.board.workerOne': '1 worker',
  'orchestrator.board.workerMany': '{count} workers',
  'orchestrator.board.needsAttention': '{count} needing attention',
  'orchestrator.board.loading': 'Loading the board...',
  'orchestrator.board.unavailable': 'The board is unavailable: {message}',
  'orchestrator.board.emptyTitle': 'No workers yet',
  'orchestrator.board.emptyBody': 'Ask a session to create an issue, then start a worker for it. Cards appear here and move as the work does.',
  'orchestrator.lane.building': 'Building',
  'orchestrator.lane.validating': 'Validating',
  'orchestrator.lane.needs_review': 'In review',
  'orchestrator.lane.ready': 'Ready',
  'orchestrator.lane.empty': 'Nothing here.',
  'orchestrator.archive': '{count} archived session(s), not a lane.',
  'orchestrator.card.details': 'Details for {title}',
  'orchestrator.card.reviewRound': 'auto review round {round}/{max}',
  'orchestrator.card.automationStopped': 'automation stopped: {reason}',
  'orchestrator.card.openPr': 'Open pull request #{number} in your browser',
  'orchestrator.card.reviewedBy': '{name}: {state}',
  'orchestrator.inspector.noReview': 'No automated review has run at this commit.',
  'orchestrator.inspector.noFindings': 'No findings recorded for this commit.',
  'orchestrator.inspector.review': 'review {id}',
  'orchestrator.inspector.close': 'Close',
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The locale surface, or undefined when it cannot be read.
 *
 * `undefined` is a REAL answer here, not a failure: the English table is the fallback,
 * and the panel must render in a host without the locale service.
 */
function readLocale(ctx: unknown): unknown {
  try {
    return (ctx as { locale?: unknown }).locale
  } catch {
    // Not injected. The panel loads in English rather than taking the shell down.
    return undefined
  }
}

/**
 * Substitutes `{name}` placeholders. A missing value leaves the placeholder VISIBLE,
 * which is how a missing key gets noticed rather than rendering a silent hole.
 */
function fill(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(new RegExp('[{]([A-Za-z0-9_]+)[}]', 'g'), (whole: string, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  )
}

/**
 * The translate function.
 *
 * The platform's surface is consulted first, duck-typed rather than imported
 * (`module: none` forbids imports, and the panel must load when the locale service is
 * absent). Without it the English fallback applies, so a missing locale degrades to
 * English rather than to raw keys.
 */
function makeTranslate(locale: unknown): Translate {
  const surface = locale as { t?: Translate } | undefined
  return (key, params) => {
    const translated = typeof surface?.t === 'function' ? surface.t(key, params) : undefined
    if (typeof translated === 'string' && translated.length > 0) return translated
    return fill(FALLBACK[key] ?? key, params)
  }
}

/** How often the board refreshes, since the stream is unverified. */
const POLL_MS = 5_000

/**
 * The loader, reached through an explicit cast.
 *
 * The `interface Window` above documents the shape, but this file is compiled with
 * `types: []` and no ambient augmentation, so the merge is not guaranteed — and a
 * cast that is visible is better than a declaration that silently does nothing.
 */
const loader = (window as unknown as {
  __ModuleLoader__: { load(spec: unknown): void }
}).__ModuleLoader__

loader.load({
  id: '@local/dsh-orchestrator',
  factory(require: (id: string) => unknown) {
    // React comes from the browser module table — never a second copy.
    const React = require('react') as {
      createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
      useState: <T>(initial: T) => [T, (next: T) => void]
      useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void
    }
    const h = React.createElement

    // ONE binding the components close over, assigned in `apply` when the locale is
    // known. Threading `t` through every component is what broke the first attempt.
    let translate: Translate = makeTranslate(undefined)

    /**
     * The panel's styles, applied inline.
     *
     * A `<style>` element would be simpler and is **not** allowed: the UI rules
     * forbid writing DOM outside the component, and a global stylesheet would also
     * risk colliding with the host's own rules. Inline styles are verbose and cannot
     * be wrong about their scope.
     *
     * Colours are `--dsw-alias-*` tokens so the panel follows the host's theme.
     */
    /**
     * The board's stylesheet.
     *
     * A `<style>` element inside this component's own tree, which is what the plugin
     * contract sanctions: "Copy markup/CSS/behaviour into the plugin, rename classes
     * under your prefix, keep only token references." An earlier version applied every
     * rule as an inline style prop -- compliant but crippling, because inline styles
     * cannot express `:hover`, `:focus-visible`, a media query, a keyframe, or
     * `-webkit-line-clamp`, which is most of what makes a board readable.
     *
     * **Every token here was verified to exist.** Four names the earlier version used do
     * NOT: `--dsw-alias-text`, `-surface`, `-border`, `-status-danger`. Literal fallbacks
     * meant nothing looked broken while the board followed the host theme in no respect
     * at all -- a silent no-op of exactly the kind this project keeps finding.
     *
     * Classes are prefixed `dsho-` because these rules enter the host's own document.
     */
    const CSS = `
/* Every token below was MEASURED in a live host, not guessed. The previous version used
   four names that do not exist -- --dsw-alias-text, -surface, -border, -status-danger --
   and because each had a literal fallback nothing looked broken while the board followed
   the theme in no respect at all. Also measured UNSET, so do not reintroduce them:
   --dsw-alias-fill-l1, -fill-l2, -fill-tertiary, -separator-primary.
   And --dsw-alias-brand-primary is #f9fafb, nearly white: it is NOT an accent, which is
   why a "busy" status came out white. The accent is -state-business-primary. */
.dsho-panel { box-sizing: border-box; height: 100%; overflow: auto; padding: var(--dsh-frame-top-clearance, 48px) 24px 24px;
  color: var(--dsw-alias-label-primary, inherit); }
.dsho-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
.dsho-title { font-size: 1.125rem; font-weight: 600; margin: 0; }
.dsho-sub { font-size: 0.8125rem; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-note { color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-note--error { color: var(--dsw-alias-state-error-primary, #e5484d); font-weight: 500; }

.dsho-lanes { display: grid; grid-template-columns: repeat(4, minmax(240px, 1fr)); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .dsho-lanes { grid-template-columns: repeat(2, minmax(220px, 1fr)); } }
.dsho-lane { min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18)); }
.dsho-lane__head { display: flex; align-items: center; gap: 8px; }
.dsho-lane__title { font-size: 0.8125rem; font-weight: 600; margin: 0; }
.dsho-lane__count { margin-left: auto; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary-dimmed, inherit);
  background: var(--dsw-alias-border-l1, rgba(127,127,127,0.14)); }
.dsho-lane__empty { margin: 0; font-size: 0.8125rem; color: var(--dsw-alias-label-primary-dimmed, inherit); opacity: 0.75; }
.dsho-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

/* The card. The border is a step stronger than the lane's because in LIGHT mode the
   host's bg-layer-1..3 are ALL #fff -- measured cardVsLane = 0 -- so a column and the
   card on it are distinguished by borders or not at all. Dark mode separates them by
   surface, so the stronger border costs nothing there.

   The click target is the OUTER element; a full-bleed button supplies the
   accessible name and the keyboard path. A button WRAPPING the card cannot contain the
   hover actions -- nesting buttons is invalid HTML -- which is why the reference does it
   this way and why the earlier version could never have grown an action. */
.dsho-card { position: relative; border: 1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35));
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2, transparent); cursor: pointer;
  transition: background-color 120ms ease-out, border-color 120ms ease-out, transform 120ms ease-out; }
.dsho-card:hover, .dsho-card:focus-within { background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12)); }
.dsho-card:active { transform: scale(0.995); }
.dsho-card--attention { border-color: var(--dsw-alias-state-warn-primary, #f5a524); }
.dsho-card--finished { opacity: 0.6; }
.dsho-card__hit { position: absolute; inset: 0; padding: 0; border: 0; border-radius: 10px;
  background: transparent; cursor: pointer; outline: none; pointer-events: none; }
.dsho-card__hit:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4c8dff); }
.dsho-card__body { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; }
.dsho-card__top { display: flex; align-items: flex-start; gap: 8px; }
.dsho-glyph { flex: none; margin-top: 2px; }
.dsho-card__title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 0.8125rem; font-weight: 600; line-height: 1.25; }
.dsho-card__branch { display: flex; align-items: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-card__branch > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsho-card__evidence { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-card__status { font-size: 0.75rem; font-weight: 600; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-card__status[data-tone='attention'] { color: var(--dsw-alias-state-warn-primary, #f5a524); }
.dsho-card__status[data-tone='error'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-card__status[data-tone='success'] { color: var(--dsw-alias-state-success-primary, #30a46c); }
.dsho-card__status[data-tone='busy'] { color: var(--dsw-alias-state-business-primary, #4c8dff); }
.dsho-card__meta { font-size: 0.6875rem; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary-dimmed, inherit); opacity: 0.8; }
/* Reviewer badges. The card is answering one question -- is this waiting on me? -- so a
   person who asked for changes is coloured, and our own reviewer is never here. */
.dsho-faces { display: flex; align-items: center; gap: 4px; }
.dsho-face { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  border-radius: 50%; font-size: 0.625rem; font-weight: 700; line-height: 1;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24));
  background: var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,0.16));
  color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-face[data-state='APPROVED'] { color: var(--dsw-alias-state-success-primary, #30a46c); }
.dsho-face[data-state='CHANGES_REQUESTED'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-face--more { width: auto; padding: 0 5px; border-radius: 999px; font-weight: 600; }
.dsho-card__actions { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; opacity: 0;
  transition: opacity 120ms ease-out; }
.dsho-card:hover .dsho-card__actions, .dsho-card:focus-within .dsho-card__actions { opacity: 1; }
.dsho-action { display: inline-flex; align-items: center; justify-content: center; padding: 4px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24));
  background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary-dimmed, inherit); cursor: pointer; }
.dsho-action:hover { color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,0.2)); }
.dsho-action:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4c8dff); }

.dsho-inspector { max-width: 52rem; margin-top: 16px; padding: 14px 16px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2)); background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); }
.dsho-inspector__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsho-inspector__findings { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dsho-finding { font-size: 0.8125rem; line-height: 1.35; }
.dsho-finding__where { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-sev { font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
.dsho-sev[data-sev='high'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-sev[data-sev='medium'] { color: var(--dsw-alias-state-warn-primary, #f5a524); }
.dsho-sev[data-sev='low'] { color: var(--dsw-alias-label-primary-dimmed, inherit); }
/* An empty board shows an EMPTY STATE, not four empty columns -- the reference centres a
   title and a body, and four grey boxes saying "Nothing here." is noise rather than
   information. */
.dsho-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; min-height: 40vh; text-align: center; padding: 0 16px; }
.dsho-empty__title { font-size: 0.9375rem; font-weight: 600; }
.dsho-empty__body { max-width: 34rem; font-size: 0.8125rem; line-height: 1.5;
  color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-archive { margin-top: 16px; font-size: 0.8125rem; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-btn { font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24)); background: transparent; color: inherit; }
.dsho-btn:hover { background: var(--dsw-alias-button-ghost-active-fill, rgba(127,127,127,0.2)); }
.dsho-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4c8dff); }
/* Copied from the reference's styles.css: an attention card gets a pulsing OVERLAY
   rather than only a border, because a border is easy to miss on a busy board. The
   reference pulses opacity 0.15 -> 1 on a 3.5s cubic-bezier over a 9% wash of its
   needs-you colour; both are reproduced with a measured token. */
@keyframes dsho-attention-pulse { 0%, 100% { opacity: 0.15; } 50% { opacity: 1; } }
@keyframes dsho-status-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.dsho-card--attention::before { position: absolute; inset: 0; content: ''; pointer-events: none;
  border-radius: inherit; background-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 9%, transparent);
  animation: dsho-attention-pulse 3.5s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
.dsho-card[data-tone='busy'] .dsho-glyph { animation: dsho-status-pulse 1.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .dsho-card, .dsho-card__actions { transition: none; }
  .dsho-card--attention::before { animation: none; opacity: 0.5; }
  .dsho-card[data-tone='busy'] .dsho-glyph { animation: none; }
}
`

    /** What the panel is currently showing. */
    type View =
      | { kind: 'loading' }
      | { kind: 'ready'; board: BoardSnapshot }
      | { kind: 'error'; message: string }

    /**
     * Reads the board once, uncached.
     *
     * Errors are returned rather than thrown: a throw inside an effect would leave the
     * panel on `loading` forever, which looks exactly like a hung host.
     */
    async function readBoard(): Promise<View> {
      try {
        const response = await fetch(BOARD_PATH, { cache: 'no-store' })
        if (!response.ok) {
          let detail = `HTTP ${response.status}`
          try {
            const body = (await response.json()) as { message?: string }
            if (body?.message) detail = body.message
          } catch {
            // A non-JSON error body is still an error; the status is enough.
          }
          return { kind: 'error', message: detail }
        }
        return { kind: 'ready', board: (await response.json()) as BoardSnapshot }
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : 'unreachable' }
      }
    }


    type Tone = 'attention' | 'error' | 'success' | 'busy' | 'neutral'

    /**
     * The card's tone: one colour per card, never several competing chips.
     *
     * **`needsAttention` is the authority for attention, not my reading of the status
     * text.** The reducer decides whether a person is needed, and it is tested; deciding
     * it again here produced a card reading `Needs review` with a NEUTRAL tone, because
     * the first version of this function was written from a partial list of statuses and
     * had never heard of that one. The lesson generalises: **do not re-derive a decision
     * that already exists upstream -- consult it.**
     *
     * Every other {@link DisplayStatus} is listed EXPLICITLY, neutral ones included, so
     * that adding a status to the contract forces a decision here instead of silently
     * defaulting. A test asserts the case labels cover the contract exactly.
     */
    /**
     * Each lane's tone, used when nothing about the card is more specific.
     *
     * Copied from the reference, which falls back to the column's own colour. Without a
     * fallback a card in `Needs review` -- which the reducer rightly says is NOT waiting
     * on a person -- rendered with no colour at all, so the board read as a list rather
     * than a board. The fallback is what gives every column a character.
     */
    const LANE_TONE: Record<string, Tone> = {
      building: 'busy',
      validating: 'busy',
      needs_review: 'attention',
      ready: 'success',
    }

    function toneOf(card: CardView): Tone {
      if (card.needsAttention === true) return 'attention'
      switch (card.displayStatus) {
        case 'CI failing':
          return 'error'
        case 'Mergeable':
        case 'Approved':
        case 'Merged':
          return 'success'
        case 'Working':
        case 'Reviewing':
        case 'Review scheduled':
        case 'Review pending':
        case 'Addressing comments':
        case 'Fixing CI failures':
          return 'busy'
        // Named one by one so that adding a status to the contract forces a decision
        // here, and coloured by their LANE -- which is the point of the fallback. An
        // earlier version returned a flat 'neutral' for this group, and because
        // `Needs review` is in it, the lane tone never applied and the card stayed
        // colourless: a fallback that a preceding branch makes unreachable.
        case 'Blocked':
        case 'No signal':
        case 'Exited':
        case 'Awaiting PR':
        case 'Needs review':
        case 'Review failed':
        case 'Draft':
        case 'Commented':
        case 'Changes requested':
        case 'Needs human review':
        case 'Closed without merge':
        case 'Terminated':
          return LANE_TONE[card.column] ?? 'neutral'
        default:
          return LANE_TONE[card.column] ?? 'neutral'
      }
    }

    /**
     * The one status glyph (PRD §11.2): a spinner while work is turning, a dot otherwise.
     *
     * Inline SVG rather than a font glyph or an icon package: no new dependency, no
     * `require` of a `dsh-client-ui-*` package, and it inherits `currentColor` so the
     * tone set on the parent colours it.
     */
    function Glyph(props: { tone: 'attention' | 'error' | 'success' | 'busy' | 'neutral'; spinning: boolean }) {
      if (props.spinning) {
        return h(
          'svg',
          { className: 'dsho-glyph', width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
          h('circle', { cx: 6, cy: 6, r: 4.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.3 }),
          h(
            'path',
            { d: 'M6 1.5a4.5 4.5 0 0 1 4.5 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
            h('animateTransform', {
              attributeName: 'transform', type: 'rotate', from: '0 6 6', to: '360 6 6', dur: '1s', repeatCount: 'indefinite',
            }),
          ),
        )
      }
      return h(
        'svg',
        { className: 'dsho-glyph', width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
        h('circle', { cx: 6, cy: 6, r: 4, fill: 'currentColor' }),
      )
    }

    /** The provider's own word, made readable: `CHANGES_REQUESTED` -> `changes requested`. */
    function prettyState(state: string): string {
      return state === '' ? 'reviewed' : state.toLowerCase().replace(/_/g, ' ')
    }

    /**
     * The reviewer badges: one letter per person, coloured by their latest verdict.
     *
     * Capped at four with a `+N`, because a card is not a place to enumerate a crowd.
     * The letter rather than an avatar URL: the provider's avatar host is not something
     * this plugin should be reaching for, and an initial reads fine at this size.
     */
    function Faces(props: { reviewers: ReadonlyArray<{ name: string; state: string }> }) {
      const shown = props.reviewers.slice(0, 4)
      const rest = props.reviewers.length - shown.length
      return h(
        'div',
        { className: 'dsho-faces' },
        ...shown.map((reviewer) =>
          h(
            'span',
            {
              key: reviewer.name,
              className: 'dsho-face',
              'data-state': reviewer.state,
              title: translate('orchestrator.card.reviewedBy', { name: reviewer.name, state: prettyState(reviewer.state) }),
              'aria-label': translate('orchestrator.card.reviewedBy', { name: reviewer.name, state: prettyState(reviewer.state) }),
            },
            (reviewer.name[0] ?? '?').toUpperCase(),
          ),
        ),
        rest > 0 ? h('span', { className: 'dsho-face dsho-face--more' }, `+${rest}`) : null,
      )
    }

    /** A compact age, because a board is read at a glance. */
    function formatAge(updatedAt: number, now: number): string {
      const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      return `${Math.round(hours / 24)}d`
    }

    /** A branch icon, inline, so the branch line reads as a branch. */
    function BranchIcon() {
      return h(
        'svg',
        { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { flex: 'none' } },
        h('path', {
          d: 'M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM5 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM3.5 5v6M12.5 5v1.5A2.5 2.5 0 0 1 10 9H5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      )
    }

    /**
     * One card, in the reference's information order: glyph + title, branch when it adds
     * identity, PR/review evidence when present, ONE derived status line, then compact
     * metadata. Two rules from the reference are load-bearing:
     *
     *   the status is ONE line with a colour per tone, never several competing chips;
     *   the branch appears only when it says something the title does not -- repeating it
     *   is noise on a board read at a glance.
     */
    function Card(props: { card: CardView; onOpen: (id: string) => void }) {
      const card = props.card
      const review = card.review
      const tone = toneOf(card)
      const pr = card.prs && card.prs.length > 0 ? card.prs[0] : undefined
      const showBranch = card.branch !== undefined && card.branch !== ''
      const className = ['dsho-card', card.needsAttention ? 'dsho-card--attention' : '', card.isFinished ? 'dsho-card--finished' : '']
        .filter((part) => part !== '')
        .join(' ')
      const evidence = [
        pr && pr.number ? `PR #${pr.number}` : undefined,
        review && review.verdict !== 'approved' ? `${review.round}/${review.maxRounds}` : undefined,
      ].filter((part): part is string => part !== undefined)

      return h(
        'li',
        null,
        h(
          'div',
          {
            className,
            onClick: () => props.onOpen(card.id),
            'data-worker': card.id,
            'data-column': card.column,
            'data-tone': tone,
          },
          // The accessible name and the keyboard path. `pointer-events: none` so it never
          // swallows a click meant for the action buttons; a click on it still reaches the
          // outer element's handler by bubbling, which is how Enter works.
          h('button', {
            type: 'button',
            className: 'dsho-card__hit',
            'aria-label': translate('orchestrator.card.details', { title: card.title }),
          }),
          h(
            'div',
            { className: 'dsho-card__body' },
            h(
              'div',
              { className: 'dsho-card__top' },
              h(Glyph, { tone, spinning: card.showStatusLoader === true }),
              h('span', { className: 'dsho-card__title', title: card.title }, card.title),
            ),
            showBranch
              ? h('div', { className: 'dsho-card__branch' }, h(BranchIcon, null), h('span', { title: card.branch }, card.branch))
              : null,
            evidence.length > 0 || (card.reviewers && card.reviewers.length > 0)
              ? h(
                  'div',
                  { className: 'dsho-card__evidence', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  evidence.length > 0 ? h('span', null, evidence.join(' · ')) : null,
                  card.reviewers && card.reviewers.length > 0 ? h(Faces, { reviewers: card.reviewers }) : null,
                )
              : null,
            h('div', { className: 'dsho-card__status', 'data-tone': tone }, card.displayStatus),
            card.escalationReason
              ? h('div', { className: 'dsho-card__meta' }, translate('orchestrator.card.automationStopped', { reason: card.escalationReason }))
              : null,
            h('div', { className: 'dsho-card__meta' }, formatAge(card.updatedAt, Date.now())),
          ),
          pr && pr.url
            ? h(
                'div',
                { className: 'dsho-card__actions' },
                h(
                  'a',
                  {
                    className: 'dsho-action',
                    href: pr.url,
                    target: '_blank',
                    rel: 'noreferrer',
                    'aria-label': translate('orchestrator.card.openPr', { number: pr.number ?? 0 }),
                    title: translate('orchestrator.card.openPr', { number: pr.number ?? 0 }),
                    onClick: (event: { stopPropagation?: () => void }) => event?.stopPropagation?.(),
                  },
                  h(
                    'svg',
                    { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                    h('path', {
                      d: 'M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2H14v4.5M14 2 7 9',
                      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
                    }),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    /**
     * The card detail view (PRD §11.2).
     *
     * Its reason is in the PRD rather than in aesthetics: the reviewer's findings must be
     * reachable from the card, with severity, file and line, because **"a machine review
     * the user cannot inspect is a machine review the user cannot trust"**.
     */
    function Inspector(props: { card: CardView; onClose: () => void }) {
      const card = props.card
      const review = card.review
      const findings = review?.findings ?? []
      const tone = toneOf(card)
      return h(
        'aside',
        { className: 'dsho-inspector', 'aria-label': translate('orchestrator.card.details', { title: card.title }) },
        h(
          'div',
          { className: 'dsho-inspector__head' },
          h('strong', null, card.title),
          h('span', { className: 'dsho-card__status', 'data-tone': tone }, card.displayStatus),
        ),
        h(
          'p',
          { className: 'dsho-sub' },
          review
            ? translate('orchestrator.card.reviewRound', { round: review.round, max: review.maxRounds }) +
              (review.verdict ? ` · ${review.verdict}` : '') +
              (review.githubReviewId ? ` · ${translate('orchestrator.inspector.review', { id: review.githubReviewId })}` : '')
            : translate('orchestrator.inspector.noReview'),
        ),
        findings.length === 0
          ? h('p', { className: 'dsho-note' }, translate('orchestrator.inspector.noFindings'))
          : h(
              'ul',
              { className: 'dsho-inspector__findings' },
              ...findings.map((finding, index) =>
                h(
                  'li',
                  { key: `${finding.path ?? ''}:${finding.line ?? index}`, className: 'dsho-finding' },
                  h(
                    'span',
                    { className: 'dsho-finding__where' },
                    h('span', { className: 'dsho-sev', 'data-sev': finding.severity }, finding.severity),
                    finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ''}` : '',
                  ),
                  `${finding.summary}: ${finding.detail}`,
                ),
              ),
            ),
        h('button', { type: 'button', className: 'dsho-btn', onClick: props.onClose }, translate('orchestrator.inspector.close')),
      )
    }

    /** One lane: a header with a count pill, then its cards. */
    function Lane(props: {
      lane: { key: string; labelKey: string }
      cards: CardView[]
      onOpen: (id: string) => void
    }) {
      return h(
        'section',
        { className: 'dsho-lane', 'data-lane': props.lane.key, 'aria-label': translate(props.lane.labelKey) },
        h(
          'div',
          { className: 'dsho-lane__head' },
          h('h3', { className: 'dsho-lane__title' }, translate(props.lane.labelKey)),
          h('span', { className: 'dsho-lane__count' }, String(props.cards.length)),
        ),
        props.cards.length === 0
          ? h('p', { className: 'dsho-lane__empty' }, translate('orchestrator.lane.empty'))
          : h(
              'ul',
              { className: 'dsho-list' },
              ...props.cards.map((card) => h(Card, { key: card.id, card, onOpen: props.onOpen })),
            ),
      )
    }

    /** The board panel. */
    function Board() {
      const [view, setView] = React.useState<View>({ kind: 'loading' })
      const [openId, setOpenId] = React.useState<string | undefined>(undefined)

      // Escape closes the inspector. A detail view dismissible only by finding the close
      // button is not keyboard reachable in practice.
      React.useEffect(() => {
        const onKey = (event: { key?: string }) => {
          if (event?.key === 'Escape') setOpenId(undefined)
        }
        window.addEventListener('keydown', onKey as never)
        return () => window.removeEventListener('keydown', onKey as never)
      }, [])

      React.useEffect(() => {
        let cancelled = false
        const tick = () => {
          void readBoard().then((next) => {
            if (!cancelled) setView(next)
          })
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      const style = h('style', null, CSS)
      const header = h(
        'header',
        { className: 'dsho-head' },
        h('h2', { className: 'dsho-title' }, translate('orchestrator.title')),
        view.kind === 'ready'
          ? h(
              'p',
              { className: 'dsho-sub', style: { margin: 0 } },
              view.board.counts.total === 1
                ? translate('orchestrator.board.workerOne')
                : translate('orchestrator.board.workerMany', { count: view.board.counts.total }),
              view.board.counts.needsAttention > 0
                ? ` · ${translate('orchestrator.board.needsAttention', { count: view.board.counts.needsAttention })}`
                : '',
            )
          : null,
      )

      if (view.kind === 'loading') {
        return h('div', { className: 'dsho-panel' }, style, header, h('p', { className: 'dsho-note' }, translate('orchestrator.board.loading')))
      }
      if (view.kind === 'error') {
        // A real state, not a blank panel: "the plugin is broken" and "there are no
        // workers" must not look the same.
        return h(
          'div',
          { className: 'dsho-panel' },
          style,
          header,
          h('p', { className: 'dsho-note dsho-note--error', role: 'status' }, translate('orchestrator.board.unavailable', { message: view.message })),
        )
      }

      const board = view.board
      return h(
        'div',
        { className: 'dsho-panel' },
        style,
        header,
        board.counts.total === 0
          ? h(
              'div',
              { className: 'dsho-empty' },
              h('p', { className: 'dsho-empty__title' }, translate('orchestrator.board.emptyTitle')),
              h('p', { className: 'dsho-empty__body' }, translate('orchestrator.board.emptyBody')),
            )
          : h(
              'div',
              { className: 'dsho-lanes' },
              ...LANES.map((lane) =>
                h(Lane, { key: lane.key, lane, cards: board.lenses.lanes[lane.key] ?? [], onOpen: setOpenId }),
              ),
            ),
        (() => {
          if (!openId) return null
          const all = Object.values(board.lenses.lanes).flat()
          const card = all.find((candidate) => candidate.id === openId)
          // The card can vanish between polls -- a worker finishing moves it. Closing
          // rather than showing a stale detail is the honest response.
          return card ? h(Inspector, { card, onClose: () => setOpenId(undefined) }) : null
        })(),
        board.lenses.archive.length > 0
          ? h('p', { className: 'dsho-archive' }, translate('orchestrator.archive', { count: board.lenses.archive.length }))
          : null,
      )
    }

    /** The sidebar navigation row: a board glyph, inline, so no font or icon package is needed. */
    function PanelIcon(props: { size?: number; active?: boolean }) {
      return h(
        'svg',
        {
          width: props.size ?? 16,
          height: props.size ?? 16,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M6 1.5v13M10.5 1.5v13', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.55 }),
      )
    }

    return {
      // `slots` is the only thing this half needs; the endpoint needs no service.
      inject: ['slots'],
      apply(ctx: {
        locale?: unknown
        slots: {
          inject: (owner: string, callback: () => unknown) => () => void
          register: (options: Record<string, unknown>, component: unknown) => () => void
        }
        effect: (callback: () => (() => void) | void, label?: string) => () => void
      }) {
        // Assigned once, here, where the locale is known.
        //
        // THE ACCESS IS WRAPPED, and not out of caution. A Cordis context THROWS on
        // reading a service that is not injected -- "cannot get property X without
        // inject" -- which is the same trap `ctx.agentRegistry` set on the host half.
        // Treating `locale` as optional in the TYPES is not enough: the read itself
        // throws, so `apply` never completes and the whole client entry fails to
        // activate ("web boot: 1 entry did not activate"), which takes the app's own
        // shell down with it and shows "Failed to load plugins".
        translate = makeTranslate(readLocale(ctx))
        ctx.effect(() => {
          const disposers: Array<() => void> = []
          // The same id addresses both seats: the panellist row selects the panel
          // whose `key` matches it.
          disposers.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: 'orchestrator', order: 20, label: 'Orchestrator' },
                PanelIcon,
              ),
            ),
          )
          disposers.push(
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'orchestrator' }, Board)),
          )
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'dsho: board panel')
      },
    }
  },
})
