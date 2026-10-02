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

/** One connected project, as the snapshot and the settings payload serialise it. Mirrors `ProjectRef`. */
interface ProjectView {
  id: string
  repository: string
  rootPath: string
  defaultBranchDetected: boolean
}

/** The settings payload. Mirrors `SettingsView`. */
interface SettingsPayload {
  projects: ProjectView[]
  project: ProjectView | null
  /** `null` when no project is connected — a state the dialog renders, not an error. */
  settings: {
    defaultBranch: string
    sessionPrefix: string
    intakeEnabled: boolean
    workerAgentPreset: string
    /** The boundary a worker runs under. Empty = the plugin default. */
    workerPermissionPreset: string
    /** The preset this project's reviewer runs as. Empty = the plugin default. */
    reviewerAgentPreset: string
    /** `null` means "inherit the plugin default"; it is not `false`. */
    autoReview: boolean | null
  } | null
  /** The plugin defaults an unset per-project override falls back to, so the page can name them. */
  defaults: {
    autoReview: boolean
    workerAgentPreset: string
    workerPermissionPreset: string
    reviewerAgentPreset: string
  }
}

/** One workspace the person already uses, as `/dsho/api/workspaces` serialises it. */
interface WorkspaceOptionView {
  id: string
  title: string
  path: string
  /** `owner/name` of the project connected at this path, or `null` when none is. */
  repository: string | null
  repoId: string | null
}

/**
 * The connect panel's read payload.
 *
 * Every field is OPTIONAL in the type because the panel must survive a host that predates
 * this endpoint: a profile running an older build answers the request with its own shape
 * or not at all, and "no workspaces" is the honest rendering of that — not a crash inside
 * a render, which takes the plugin's whole client entry down with it.
 */
interface WorkspacesPayload {
  workspaces?: WorkspaceOptionView[]
  projects?: ProjectView[]
}

/** One connect attempt's answer, as `/dsho/api/connect` serialises it. */
interface ConnectPayload {
  ok?: boolean
  message?: string
  code?: string
}

/** The board snapshot. Mirrors `BoardSnapshot`. */
interface BoardSnapshot {
  generatedAt: number
  lenses: { lanes: Record<string, CardView[]>; archive: CardView[] }
  counts: { total: number; needsAttention: number; byLane: Record<string, number> }
  /** The connected projects. Absent on a snapshot from a host that predates the settings page. */
  projects?: ProjectView[]
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

/** The settings dialog's endpoint. Fetched only when the dialog opens. */
const SETTINGS_PATH = '/dsho/api/settings'

/**
 * The connect panel's endpoints.
 *
 * A separate path from the board because it answers a different question: the board
 * carries projects that ARE connected, and this carries the workspaces that COULD be.
 * Reading the board could never answer the second -- an unconnected project is absent
 * from it by definition, which is exactly the circularity this panel exists to break.
 */
const WORKSPACES_PATH = '/dsho/api/workspaces'

/** The connect write. One POST per attempt, so the host's refusal is what the user sees. */
const CONNECT_PATH = '/dsho/api/connect'

/**
 * The new-task write. One POST, and the task exists the moment the host answers:
 * the panel does not create anything itself, so a refusal (no repository connected,
 * storage down) is shown as the host phrased it rather than guessed at here.
 */
const TASKS_PATH = '/dsho/api/tasks'

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
  // The sidebar row's label. It IS translated (through a function label, so the shell
  // re-resolves it on a locale change), which is why it is in this table rather than only in
  // `en.json`.
  'orchestrator.project.label': 'Orchestrator: {repository}',
  'orchestrator.board.workerOne': '1 worker',
  'orchestrator.board.workerMany': '{count} workers',
  'orchestrator.board.needsAttention': '{count} needing attention',
  'orchestrator.board.loading': 'Loading the board\u2026',
  'orchestrator.board.unavailable': 'The board is unavailable: {message}',
  'orchestrator.board.stale': 'The board could not be refreshed: {message}. Showing the last reading.',
  'orchestrator.board.emptyTitle': 'No workers yet',
  'orchestrator.board.emptyBody': 'Ask a session to create an issue, then start a worker for it. Cards appear here and move as the work does.',
  'orchestrator.lane.building': 'Building',
  'orchestrator.lane.validating': 'Validating',
  'orchestrator.lane.needs_review': 'In review',
  'orchestrator.lane.ready': 'Ready',
  'orchestrator.lane.empty': 'Nothing here.',
  'orchestrator.archive.summary': 'Archived ({count})',
  'orchestrator.card.details': 'Details for {title}',
  'orchestrator.card.reviewRound': 'auto review round {round}/{max}',
  'orchestrator.card.automationStopped': 'automation stopped: {reason}',
  'orchestrator.card.openPr': 'Open pull request #{number} in your browser',
  'orchestrator.card.reviewedBy': '{name}: {state}',
  'orchestrator.card.openSession': 'Open the worker session for {title}',
  'orchestrator.card.findings': 'Review findings for {title}',
  'orchestrator.inspector.noReview': 'No automated review has run at this commit.',
  'orchestrator.inspector.noFindings': 'No findings recorded for this commit.',
  'orchestrator.inspector.review': 'review {id}',
  'orchestrator.inspector.close': 'Close',
  'orchestrator.connect.title': 'Orchestrator projects',
  'orchestrator.connect.sub': 'Connect a checkout to start orchestrating it.',
  'orchestrator.connect.workspaces': 'Your workspaces',
  'orchestrator.connect.pathTitle': 'Connect another checkout',
  'orchestrator.connect.placeholder': '/absolute/path/to/checkout',
  'orchestrator.connect.action': 'Connect',
  'orchestrator.connect.connected': 'Connected as {repository}',
  'orchestrator.connect.loading': 'Loading your workspaces\u2026',
  'orchestrator.connect.unavailable': 'Your workspaces are unavailable: {message}',
  'orchestrator.connect.emptyTitle': 'No workspaces to offer',
  'orchestrator.connect.emptyBody': 'No workspaces are registered in this profile. Type the absolute path to a local checkout instead.',
  'orchestrator.settings.open': 'Project options',
  'orchestrator.settings.menuItem': 'Project settings\u2026',
  'orchestrator.settings.title': 'Project settings',
  'orchestrator.settings.loading': 'Loading project settings\u2026',
  'orchestrator.settings.unavailable': 'Project settings are unavailable: {message}',
  'orchestrator.settings.noProject': 'No repository is connected yet. Open the Orchestrator projects panel to connect one, then open this dialog again.',
  'orchestrator.settings.worktrees': 'Worktrees',
  'orchestrator.settings.issues': 'Issues',
  'orchestrator.settings.pullRequests': 'Pull requests',
  'orchestrator.settings.defaultBranch': 'Default branch',
  'orchestrator.settings.defaultBranchHint': 'Base for worktrees and pull requests.',
  'orchestrator.settings.defaultBranchAuto': 'auto',
  'orchestrator.settings.sessionPrefix': 'Session prefix',
  'orchestrator.settings.sessionPrefixHint': 'Namespaces every branch this project pushes.',
  'orchestrator.settings.intake': 'Enable issue intake',
  'orchestrator.settings.intakeHint': 'Auto-spawn workers for matching issues.',
  'orchestrator.settings.repository': 'Repository',
  'orchestrator.settings.assignee': 'Assignee',
  'orchestrator.settings.assigneeHint': 'Agent preset for this project\u2019s workers.',
  'orchestrator.settings.assigneeDefault': 'default',
  'orchestrator.settings.workerPermissions': 'Worker permissions',
  'orchestrator.settings.workerPermissionsHint': 'Sandbox and approval boundary this project\u2019s workers run under. A worker commits and pushes, and a linked worktree\u2019s git data lives in the parent repository, so a worktree-scoped sandbox cannot complete a stage.',
  'orchestrator.settings.workerPermissionsDefault': 'default',
  'orchestrator.settings.autoReview': 'Auto review PRs',
  'orchestrator.settings.reviewers': 'Reviewers',
  'orchestrator.settings.defaultReviewer': 'Default reviewer',
  'orchestrator.settings.reviewerHint': 'Agent preset that reviews this project\u2019s pull requests.',
  'orchestrator.settings.autoReviewHint': 'Our read-only reviewer runs on every PR head.',
  'orchestrator.settings.autoReviewInherited': 'Inheriting the plugin default ({value}).',
  'orchestrator.settings.autoReviewReset': 'Use the plugin default',
  'orchestrator.settings.on': 'on',
  'orchestrator.settings.off': 'off',
  'orchestrator.settings.edit': 'Edit {label}',
  'orchestrator.settings.saving': 'Saving\u2026',
  'orchestrator.settings.saved': 'Saved',
  'orchestrator.settings.saveFailed': 'Could not save: {message}',
  'orchestrator.settings.close': 'Close project settings',
  // The new-task flow (the reference's New task). The hint is the one string worth reading
  // twice: it is where the provisional title is explained, and a card that renames itself
  // with no explanation looks like a bug.
  'orchestrator.task.new': 'New task',
  'orchestrator.task.title': 'New task',
  'orchestrator.task.close': 'Close the new-task dialog',
  'orchestrator.task.brief': 'What needs doing?',
  'orchestrator.task.placeholder': 'Describe the task in your own words. A worker starts on it immediately.',
  'orchestrator.task.hint': 'The card is named from your first line straight away, and renamed once the worker has named the task.',
  'orchestrator.task.cancel': 'Cancel',
  'orchestrator.task.start': 'Start task',
  'orchestrator.task.starting': 'Starting…',
  'orchestrator.task.failed': 'Could not create the task: {message}',
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The locale surface, or undefined when it cannot be read.
 *
 * `undefined` is a REAL answer here, not a failure: the English table is the fallback,
 * and the panel must render in a host without the locale service.
 */
/**
 * The workspace navigation service, or undefined when it cannot be read.
 *
 * `ctx.uiWorkspace.openSession(id)` is the harness's own way to "select a Session and
 * show its Conversation as one UI navigation action" -- found by grepping the CALL SITES
 * rather than guessing a key, because guessing a service name is how `ctx.agentRegistry`
 * crashed the host. A shipped plugin declares `inject: ["slots", "uiWorkspace"]`.
 *
 * Read through a guard all the same: an undeclared service THROWS when read, and this
 * half must load on a host that has no workspace UI. When it is absent the card keeps
 * opening the inspector, so the degradation is a working panel rather than a dead click.
 */
function readUiWorkspace(ctx: unknown): { openSession(target: unknown): void } | undefined {
  try {
    const service = (ctx as { uiWorkspace?: { openSession?: unknown } }).uiWorkspace
    return typeof service?.openSession === 'function' ? (service as { openSession(target: unknown): void }) : undefined
  } catch {
    return undefined
  }
}

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
/**
 * The Tab trap every dialog in this plugin uses.
 *
 * Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last,
 * and the focusable list is read from the DOM at each keypress rather than cached -- the
 * list changes as rows are added and an inline editor is opened. It is a module-level
 * function rather than two copies inside two components, because a dialog whose trap is
 * subtly different from the other one is a bug nobody notices until they keyboard through
 * it.
 */
/** The focusable surface a dialog offers to the trap. */
type FocusRoot = { querySelectorAll(selector: string): ArrayLike<{ focus(): void }> } | null

/** The key event the trap reads. Structural, because this script has no DOM lib types. */
type TrapKeyEvent = { key?: string; shiftKey?: boolean; preventDefault?: () => void }

function trapTabWithin(root: FocusRoot, event: TrapKeyEvent): void {
  if (event?.key !== 'Tab') return
  if (!root) return
  const focusable = Array.from(
    root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  // `unknown`, because the DOM's `activeElement` is an `Element` and the two sides of this
  // comparison are structural shapes: the compiler refuses the overlap it cannot see, and
  // the comparison is exactly right at runtime.
  const active: unknown = document.activeElement
  if (event.shiftKey === true && (active === first || active === root)) {
    event.preventDefault?.()
    last?.focus()
    return
  }
  if (event.shiftKey !== true && active === last) {
    event.preventDefault?.()
    first?.focus()
  }
}

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
      useState: <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void]
      useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void
      useRef: <T>(initial: T) => { current: T }
    }
    const h = React.createElement

    // ONE binding the components close over, assigned in `apply` when the locale is
    // known. Threading `t` through every component is what broke the first attempt.
    let translate: Translate = makeTranslate(undefined)
    /** The workspace navigation service, when the host has one. */
    let openSession: ((sessionId: string) => void) | undefined

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
.dsho-panel, .dsho-panel * { box-sizing: border-box; }
.dsho-panel { height: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative;
  padding: var(--dsh-frame-top-clearance, 48px) 24px 24px; color: var(--dsw-alias-label-primary, inherit); }
/* The reference's board topbar: a fixed-height row with an icon and a title, a flexible
   spacer, and actions at the right, closed by a BOTTOM BORDER so the chrome and the board
   are visibly different surfaces. It is flex-none, so it does not scroll away with the
   cards -- the board scrolls beneath it.
   It sits BELOW the frame clearance, which the panel keeps: a non-conversation main panel
   must clear the window chrome or its first row lands under it. */
.dsho-topbar { display: flex; align-items: center; gap: 10px; flex: none;
  padding-bottom: 10px; margin-bottom: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24)); }
.dsho-topbar__icon { flex: none; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-topbar__title { font-size: 1rem; font-weight: 600; margin: 0; }
.dsho-topbar__spacer { flex: 1; min-width: 8px; }
.dsho-sub { font-size: 0.8125rem; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-note { color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-note--error { color: var(--dsw-alias-state-error-primary, #e5484d); font-weight: 500; }
/* The reference's degraded-state row: a bordered surface with a warning glyph, a
   message, and room for an action -- kept ABOVE the board so the board's height does not
   move when a warning appears. */
.dsho-banner { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding: 6px 10px;
  border-radius: 8px; font-size: 0.75rem; color: var(--dsw-alias-label-primary-dimmed, inherit);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24)); background: var(--dsw-alias-bg-layer-2, transparent); }
.dsho-banner svg { flex: none; color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsho-banner > span { min-width: 0; flex: 1; }

/* The reference's board model, adopted: a horizontally scrolling container with a
   MINIMUM width, four full-height columns, and each column scrolling its OWN cards.
   Three consequences, all of them the point:
     columns never get cramped, because a narrow panel scrolls instead of squeezing;
     a column with fifty cards does not push the other three off screen;
     the board fills the panel instead of being as tall as its last card. */
.dsho-board-scroll { flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; }
.dsho-lanes { display: grid; grid-template-columns: repeat(4, minmax(15rem, 1fr)); gap: 16px;
  height: 100%; min-width: 60rem; align-items: stretch; }
@media (min-width: 1200px) { .dsho-lanes { min-width: 0; } }
.dsho-lane { min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 12px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06)); }
/* A WASH OF THE LANE TONE, 5%. The reference leaves its columns neutral; this is a
   deliberate step past it, because the goal is more colour and a lane's tone is the one
   fact a column actually has. Five percent keeps it a tint -- the cards on top must stay
   the brightest thing on screen, and anything stronger turns four lanes into four blocks
   of colour that fight the status lines. */

.dsho-lane__head { display: flex; align-items: center; gap: 8px; }
/* The reference colours the lane's dot AND its label by the lane's tone, which is what
   makes a four-column board scannable without reading any of it. */
.dsho-lane__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.dsho-lane__title { font-size: 0.8125rem; font-weight: 600; margin: 0; color: inherit; }
/* The tone goes on the HEAD, not on each child. The dot, the label and the count pill
   then all inherit it -- and the pill's own background mixes from currentColor, so the
   whole header row is one coloured unit. Colouring the children individually left the
   pill inheriting the default white. (No backticks in this block -- that mistake has now
   cost three builds, so the check below runs BEFORE the compile.) */
.dsho-lane__head[data-tone='busy'] { color: var(--dsw-alias-state-business-primary, #7aaaff); }
.dsho-lane__head[data-tone='attention'] { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsho-lane__head[data-tone='success'] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsho-lane__count { margin-left: auto; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: inherit; background: color-mix(in srgb, currentColor 10%, transparent); }
.dsho-lane__empty { margin: 0; font-size: 0.8125rem; color: var(--dsw-alias-label-primary-dimmed, inherit); opacity: 0.75; }
.dsho-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px;
  flex: 1; min-height: 0; overflow-y: auto; }
.dsho-lane__empty { flex: 1; }

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
/* The reference opens a card with a substantial avatar -- a rounded square around 26px --
   not a 12px dot, and the size is what makes the title line read as a heading. Tinted by
   the tone, so the card still carries exactly one status colour. */
.dsho-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 26%, transparent);
  background: color-mix(in srgb, currentColor 10%, var(--dsw-alias-bg-layer-2, #2c2c2e)); }
.dsho-avatar[data-tone='busy'] { color: var(--dsw-alias-state-business-primary, #7aaaff); }
.dsho-avatar[data-tone='attention'] { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsho-avatar[data-tone='error'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-avatar[data-tone='success'] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsho-avatar[data-tone='neutral'] { color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-glyph { flex: none; }
.dsho-card__title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 0.8125rem; font-weight: 600; line-height: 1.25; }
.dsho-card__branch { display: flex; align-items: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem; color: var(--dsw-alias-label-primary-dimmed, inherit); }
/* The icon carries the colour; the text does not. Copying the reference exactly here --
   a green glyph beside a muted label is legible and lively, whereas colouring both makes
   the card fight its own status line for attention. */
.dsho-card__branch > svg { color: var(--dsw-alias-state-success-primary, #22c55e); }
/* DESCENDANT, not direct child: the icon sits inside a span beside its label, so a
   direct-child selector matched nothing and the glyph stayed grey -- measured, not
   assumed. (No backticks in this block: it is a template literal, and a backtick here
   closes the stylesheet. That is exactly how this rule failed the first time.) */
.dsho-card__evidence svg { color: var(--dsw-alias-state-success-primary, #22c55e); flex: none; }
.dsho-card__branch > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsho-card__evidence { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-card__status { font-size: 0.75rem; font-weight: 600; color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-card__status[data-tone='attention'] { color: var(--dsw-alias-state-warn-primary, #f5a524); }
.dsho-card__status[data-tone='error'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-card__status[data-tone='success'] { color: var(--dsw-alias-state-success-primary, #30a46c); }
.dsho-card__status[data-tone='busy'] { color: var(--dsw-alias-state-business-primary, #4c8dff); }
/* Status and age on ONE row, the age pushed right -- the reference's footer. Stacking
   them costs a line per card and makes the board taller for no extra information. */
.dsho-card__footer { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsho-card__meta { font-size: 0.6875rem; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary-dimmed, inherit); opacity: 0.8; }
.dsho-card__footer .dsho-card__meta { flex: none; }
.dsho-card__stopped { font-size: 0.6875rem; font-weight: 600;
  color: var(--dsw-alias-state-warn-primary, #f59e0b); }
/* Reviewer badges. The card is answering one question -- is this waiting on me? -- so a
   person who asked for changes is coloured, and our own reviewer is never here. */
.dsho-faces { display: flex; align-items: center; gap: 4px; }
.dsho-face { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  border-radius: 50%; font-size: 0.625rem; font-weight: 700; line-height: 1;
  color: var(--dsw-alias-label-primary-dimmed, inherit);
  border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
  background: color-mix(in srgb, currentColor 13%, transparent); }
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
.dsho-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; min-height: 40vh; text-align: center; padding: 0 16px; }
.dsho-empty__title { font-size: 0.9375rem; font-weight: 600; }
.dsho-empty__body { max-width: 34rem; font-size: 0.8125rem; line-height: 1.5;
  color: var(--dsw-alias-label-primary-dimmed, inherit); }
/* The reference keeps the archive as a collapsible panel rather than a line of text.
   The details element gives that natively -- keyboard operable, no JS state, and the
   browser announces it -- so the count is a summary you can open instead of a fact you
   cannot act on.
   NOTE: no backticks in these comments. This stylesheet is a template literal, so a
   backtick in PROSE closes the string and the following words become code -- which is
   exactly how the word "details" ended up parsed as an identifier. */
.dsho-archive { flex: none; margin-top: 12px; font-size: 0.8125rem;
  color: var(--dsw-alias-label-primary-dimmed, inherit); }
.dsho-archive > summary { cursor: pointer; padding: 4px 0; font-weight: 600; }
.dsho-archive > summary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4c8dff);
  border-radius: 4px; }
.dsho-archive__list { max-height: 12rem; overflow-y: auto; margin-top: 8px; }
.dsho-archive__row { display: flex; align-items: baseline; gap: 10px; padding: 4px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16)); }
.dsho-archive__row > .dsho-card__title { flex: 1; min-width: 0; font-weight: 500; }
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
/* The new-task dialog: the settings dialog's own surface and head, sized for one field
   rather than a list of rows. Sharing them is the point -- two dialogs in one panel that
   looked different would read as two plugins. NOTE, as above: no backticks in this prose,
   because the stylesheet is a template literal. */
.dsho-task { width: min(34rem, 100%); max-height: 100%; display: flex; flex-direction: column;
  border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-alias-bg-layer-2, #232324);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 40px rgba(0,0,0,0.35)); overflow: hidden;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.dsho-task:focus { outline: none; }
.dsho-task__label { display: block; padding: 14px 0 6px; font-size: 0.75rem; font-weight: 500;
  line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit); }
.dsho-task__input { box-sizing: border-box; width: 100%; min-height: 7rem; resize: vertical;
  font: inherit; font-size: 0.875rem; line-height: 22px; padding: 10px 12px;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24));
  border-radius: var(--dsw-radius-md, 12px); }
.dsho-task__input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid
  var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 1px; }
.dsho-task__hint { margin: 8px 0 0; font-size: 0.75rem; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, inherit); }
.dsho-task__footer { flex: none; display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 14px 20px 18px; }
.dsho-btn--quiet { min-height: 28px; padding: 4px 12px; border-color: transparent; }
.dsho-btn--primary { display: inline-flex; align-items: center; gap: 6px; min-height: 28px;
  padding: 4px 12px; border-color: transparent; background: var(--dsw-alias-brand-primary, #f9fafb);
  color: var(--dsw-alias-label-primary-foreground, #111); font-weight: 500; }
.dsho-btn--primary:hover { opacity: 0.9; }
.dsho-btn--primary:disabled { cursor: default; opacity: 0.45; }

@media (prefers-reduced-motion: reduce) {
  .dsho-card, .dsho-card__actions { transition: none; }
  .dsho-card--attention::before { animation: none; opacity: 0.5; }
  .dsho-card[data-tone='busy'] .dsho-glyph { animation: none; }
}

/* ---------------------------------------------------------------------------
   The project row in the topbar, and the settings dialog it opens.

   The dialog is ABSOLUTE inside the panel rather than fixed over the window. The host's
   own Settings dialog covers the whole window because it belongs to the whole app; this
   panel is one column of a shell, and a fixed overlay would blank the sidebar and the
   conversation a user may still need while reading a setting.

   EVERY rule below is transcribed from the host's own Settings dialog, measured in a
   live one rather than guessed: the mask (bg-mask-1 + mask-blur), the panel surface
   (bg-layer-2, radius-panel, elevation-prominent), the row (a hairline divider, a
   label column that takes the slack with a 48px gutter, a 14px/22px title over a
   12px/18px tertiary description), the 36x20 switch, and the 28px outline button.
   An earlier version used the REFERENCE's bordered card group instead; the reference is
   the right shape for a form, but the host's is the right shape for THIS host, and the
   difference is visible in every row. */
.dsho-project { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsho-project__name { display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 0.875rem; font-weight: 600; }
.dsho-project__name > svg { flex: none; color: var(--dsw-alias-label-tertiary, inherit); }
.dsho-project__name > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsho-menu { position: relative; flex: none; }
.dsho-menu__trigger { display: inline-flex; align-items: center; justify-content: center; padding: 4px 6px;
  border-radius: var(--dsw-radius-md, 6px); cursor: pointer; color: var(--dsw-alias-label-tertiary, inherit);
  border: 0; background: transparent; }
.dsho-menu__trigger:hover, .dsho-menu__trigger[aria-expanded='true'] {
  color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.2)); }
.dsho-menu__trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 2px; }
/* The host's menu, measured off one: a 16px radius (radius-lg) carrying the menu's
   translucent material (specific-menu over menu-backdrop-filter) inside a 4px pad,
   lifted by the same prominent elevation and stroked with its elevation stroke colour.
   Items are 34px tall at 13px/20px with a 12px radius (radius-md) -- the item radius is
   HALF the surface's, which is what makes the highlight read as a pill inside the panel
   rather than a second panel. The fallbacks are the values the tokens resolve to, because
   a fallback that disagrees is a second, wrong answer that only shows up when the token is
   missing -- which is exactly when it is trusted. */
.dsho-menu__list { position: absolute; top: calc(100% + 4px); right: 0; z-index: 30; min-width: 144px; padding: 4px;
  border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-specific-menu, rgba(67, 69, 74, 0.45));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(1.5));
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 40px rgba(0,0,0,0.35)); }
.dsho-menu__item { display: flex; align-items: center; width: 100%; min-height: 34px; text-align: left;
  font: inherit; font-size: 0.8125rem; line-height: 20px; padding: 6px 8px;
  border-radius: var(--dsw-radius-md, 12px); cursor: pointer; color: inherit; border: 0; background: transparent; }
.dsho-menu__item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.2)); }
/* Focus and hover show the same highlight, so a keyboard user sees the item the mouse user
   would, and the ring is drawn INSIDE the item's own radius rather than around it. */
.dsho-menu__item:focus { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.2)); outline: none; }
.dsho-menu__item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: -1px; }

.dsho-settings-scrim { position: absolute; inset: 0; z-index: 40; display: flex; align-items: center;
  justify-content: center; padding: clamp(12px, 4vh, 32px) 16px;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45)); backdrop-filter: var(--dsw-mask-blur, none); }
/* The host's panel: radius-panel, bg-layer-2, and the prominent elevation. It is a fixed
   header over a scrolling body, which is what keeps the title and the close button still
   while a long list moves. */
.dsho-settings { width: min(46rem, 100%); max-height: 100%; display: flex; flex-direction: column;
  border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-alias-bg-layer-2, #232324);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 40px rgba(0,0,0,0.35)); overflow: hidden;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.dsho-settings:focus { outline: none; }
.dsho-settings__head { flex: none; display: flex; align-items: center; gap: 8px; padding: 18px 14px 10px 20px; }
.dsho-settings__titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsho-settings__title { margin: 0; font-size: 1rem; font-weight: 500; line-height: 24px;
  color: var(--dsw-alias-label-primary, inherit); }
.dsho-settings__sub { font-size: 0.75rem; line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsho-settings__spacer { flex: 1; min-width: 8px; }
.dsho-settings__status { flex: none; font-size: 0.75rem; line-height: 18px; color: var(--dsw-alias-label-tertiary, inherit); }
.dsho-settings__status[data-status='error'] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-settings__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 20px 20px; }
/* The host's close button: a 28px square, no border, filled only on hover. */
.dsho-settings__close { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; cursor: pointer; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-label-primary, inherit); background: transparent; }
.dsho-settings__close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.2)); }
.dsho-settings__close:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 2px; }

/* One section: a caption over its rows. The host's General page is a flat list, but the
   reference groups by concern and the user's screenshot shows it, so the group survives
   -- as a caption in the host's own caption colour rather than a card. */
.dsho-section { display: flex; flex-direction: column; }
.dsho-section + .dsho-section { margin-top: 8px; }
.dsho-section__title { margin: 0; padding: 14px 0 0; font-size: 0.75rem; font-weight: 500; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, inherit); }
/* The host's row, measured: a .5px hairline under every row but the last, the label column
   taking the slack with a 48px gutter so a long description never runs into the control,
   and the title/description pair on the host's own type scale. */
.dsho-row { display: flex; align-items: center; gap: 8px; padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.24)); }
.dsho-row:last-child { border-bottom: 0; }
.dsho-row__label { display: flex; flex-direction: column; flex: 1 1 0%; gap: 4px; min-width: 0; padding-right: 48px; }
.dsho-row__label > span:first-child { font-size: 0.875rem; font-weight: 400; line-height: 22px;
  color: var(--dsw-alias-label-primary, inherit); }
.dsho-row__hint { font-size: 0.75rem; font-weight: 400; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, inherit); }
/* A row that failed to save says so in its own label column, in the host's error tone.
   The message is the host's, verbatim -- a paraphrase here would be a second explanation
   to keep in step with the first, and the host's names the key that was refused. */
.dsho-row__error { font-size: 0.75rem; font-weight: 400; line-height: 18px;
  color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsho-row__control { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.dsho-row__value { font-size: 0.875rem; line-height: 22px; color: var(--dsw-alias-label-tertiary, inherit);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* The inline edit: the value and a pencil, which swaps for an input in place, because a
   dialog of always-open inputs reads as a form to fill in rather than a list to change.
   The trigger is the host's small outline button; the input is its 36px selector. */
.dsho-inline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsho-inline__value { font-size: 0.875rem; line-height: 22px; color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 18rem; }
.dsho-inline__input { font: inherit; font-size: 0.875rem; line-height: 22px; height: 36px; padding: 0 12px;
  min-width: 14rem; border-radius: var(--dsw-radius-md, 6px); color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-3, transparent)); border: 0; }
.dsho-inline__input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 2px; }
.dsho-inline__edit, .dsho-inline__reset { display: inline-flex; align-items: center; gap: 5px; flex: none;
  height: 28px; padding: 0 10px; font: inherit; font-size: 0.75rem; line-height: 18px; cursor: pointer;
  color: var(--dsw-alias-label-primary, inherit); background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16)); border-radius: var(--dsw-radius-sm, 8px); }
.dsho-inline__edit:hover, .dsho-inline__reset:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.2)); }
.dsho-inline__edit:focus-visible, .dsho-inline__reset:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 2px; }
/* The switch, the host's own: a 36x20 button with aria-checked, a 2px inset thumb, and
   the BRAND tone rather than the success tone. Green is a status colour here -- the host
   reserves it for state, and a green switch reads as "the thing is healthy" rather than
   "the thing is on".
   The THUMB changes colour WITH the state, which is the part that is easy to miss: its
   base tone is label-primary-foreground (near-black against the near-white brand track)
   and only the OFF state swaps in the grey switch-thumb. One colour for both states
   leaves a grey dot on a white track -- which is what this did until the host's own rule
   was read out of the CSSOM. */
.dsho-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px;
  padding: 2px; border: 0; border-radius: 999px; corner-shape: round; cursor: pointer;
  background: var(--dsw-alias-border-l3, rgba(127,127,127,0.35)); }
.dsho-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary, #f9fafb); }
.dsho-switch:disabled { cursor: default; opacity: 0.5; }
.dsho-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 2px; }
.dsho-switch__thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground, #151517); transition: transform 0.12s; }
.dsho-switch[aria-checked='false'] .dsho-switch__thumb { background: var(--dsw-alias-switch-thumb, #adb2b8); }
.dsho-switch[aria-checked='true'] .dsho-switch__thumb { transform: translateX(16px); }
@media (prefers-reduced-motion: reduce) {
  .dsho-switch__thumb { transition: none; }
}
`

    /** What the panel is currently showing. */
    type View =
      | { kind: 'loading' }
      /** `stale` is the last poll's failure, when a board is being shown without one. */
      | { kind: 'ready'; board: BoardSnapshot; stale?: string }
      | { kind: 'error'; message: string }

    /**
     * Fold a poll's outcome into what is on screen.
     *
     * A failed poll must NOT blank a board that is already showing. The reference keeps
     * its board at a stable height and puts a banner above it for a degraded state --
     * mine replaced the whole panel with an error, so one dropped request wiped out the
     * board and told the user the plugin was broken. A failure with nothing to show is
     * still a full error state; a failure with a last good reading is a stale banner.
     */
    function mergeView(previous: View, next: View): View {
      if (next.kind === 'ready') return next
      // `loading` is the initial state, not an outcome: it never replaces what is shown.
      if (next.kind === 'loading') return previous
      if (previous.kind === 'ready') return { kind: 'ready', board: previous.board, stale: next.message }
      return next
    }

    /**
     * Reads the board once, uncached.
     *
     * `repoId` scopes the read to ONE project (`?repoId=`), which is what each panel wants;
     * `''` is the whole install, which is what the project list wants. The host filters, not
     * this side: the lanes, the archive sheet and the counts all derive from the worker set,
     * and filtering the cards here would leave the header's own count disagreeing with the
     * board underneath it.
     *
     * Errors are returned rather than thrown: a throw inside an effect would leave the
     * panel on `loading` forever, which looks exactly like a hung host.
     */
    async function readBoard(repoId: string): Promise<View> {
      const path = repoId === '' ? BOARD_PATH : `${BOARD_PATH}?repoId=${encodeURIComponent(repoId)}`
      try {
        const response = await fetch(path, { cache: 'no-store' })
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

    /**
     * The connected projects, from the same snapshot the panels read.
     *
     * A failure answers `undefined` rather than an empty list, and the difference matters: an
     * empty list would UNREGISTER every row on one dropped request, and a host that is
     * restarting would take the user's entry points away with it. A failure leaves the
     * registration exactly as it was.
     */
    async function readProjects(): Promise<ProjectView[] | undefined> {
      const view = await readBoard('')
      return view.kind === 'ready' ? view.board.projects ?? [] : undefined
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
          { className: 'dsho-glyph', width: 14, height: 14, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
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
    function Card(props: { card: CardView; onOpen: (id: string) => void; onFindings: (id: string) => void }) {
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
              h('span', { className: 'dsho-avatar', 'data-tone': tone }, h(Glyph, { tone, spinning: card.showStatusLoader === true })),
              h('span', { className: 'dsho-card__title', title: card.title }, card.title),
            ),
            showBranch
              ? h('div', { className: 'dsho-card__branch' }, h(BranchIcon, null), h('span', { title: card.branch }, card.branch))
              : null,
            evidence.length > 0 || (card.reviewers && card.reviewers.length > 0)
              ? h(
                  'div',
                  { className: 'dsho-card__evidence', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  evidence.length > 0
                    ? h(
                        'span',
                        { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
                        // A pull-request glyph, coloured like the branch one: the two
                        // affordances are the same kind of fact.
                        h(
                          'svg',
                          { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                          // A MERGE glyph, deliberately NOT the branch glyph: two
                          // identical marks for two different facts is worse than no mark.
                          h('path', { d: 'M4.5 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12.5 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM4.5 6.5v6M6 9.5h3a2 2 0 0 0 2-2v-.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
                        ),
                        evidence.join(' · '),
                      )
                    : null,
                  card.reviewers && card.reviewers.length > 0 ? h(Faces, { reviewers: card.reviewers }) : null,
                )
              : null,
            h(
              'div',
              { className: 'dsho-card__footer' },
              h('span', { className: 'dsho-card__status', 'data-tone': tone }, card.displayStatus),
              h('span', { className: 'dsho-card__meta' }, formatAge(card.updatedAt, Date.now())),
            ),
            card.escalationReason
              ? h(
                  'div',
                  { className: 'dsho-card__stopped' },
                  translate('orchestrator.card.automationStopped', { reason: card.escalationReason }),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dsho-card__actions' },
            // The findings live behind an explicit action: §11.2 gives the card's BODY to
            // the worker's session and puts the review one click further.
            h(
              'button',
              {
                type: 'button',
                className: 'dsho-action',
                'aria-label': translate('orchestrator.card.findings', { title: card.title }),
                title: translate('orchestrator.card.findings', { title: card.title }),
                onClick: (event: { stopPropagation?: () => void }) => {
                  event?.stopPropagation?.()
                  props.onFindings(card.id)
                },
              },
              h(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                h('path', { d: 'M3 2.5h10v11H3z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
                h('path', { d: 'M5.5 6h5M5.5 8.5h5M5.5 11h3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
              ),
            ),
            pr && pr.url
            ? h(
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
                  )
              : null,
          ),
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
        {
          className: 'dsho-inspector',
          'data-tone': tone,
          'aria-label': translate('orchestrator.card.details', { title: card.title }),
        },
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
      onFindings: (id: string) => void
    }) {
      return h(
        'section',
        {
          className: 'dsho-lane',
          'data-lane': props.lane.key,
          'data-tone': LANE_TONE[props.lane.key] ?? 'neutral',
          'aria-label': translate(props.lane.labelKey),
        },
        h(
          'div',
          { className: 'dsho-lane__head', 'data-tone': LANE_TONE[props.lane.key] ?? 'neutral' },
          h('span', { className: 'dsho-lane__dot', 'aria-hidden': 'true' }),
          h('h3', { className: 'dsho-lane__title' }, translate(props.lane.labelKey)),
          h('span', { className: 'dsho-lane__count' }, String(props.cards.length)),
        ),
        props.cards.length === 0
          ? h('p', { className: 'dsho-lane__empty' }, translate('orchestrator.lane.empty'))
          : h(
              'ul',
              { className: 'dsho-list' },
              ...props.cards.map((card) => h(Card, { key: card.id, card, onOpen: props.onOpen, onFindings: props.onFindings })),
            ),
      )
    }

    /**
     * The settings page's transport.
     *
     * Errors are RETURNED, never thrown: these run inside effects and promise chains that
     * have nowhere to catch, and a throw would leave the dialog on "loading" forever --
     * which is indistinguishable from a hung host.
     */
    type SettingsResult = { ok: true; payload: SettingsPayload } | { ok: false; message: string }

    /** The host's own words for a failure, so the page shows the refusal verbatim. */
    async function failureMessage(response: Response): Promise<string> {
      try {
        const body = (await response.json()) as { message?: string }
        if (body && typeof body.message === 'string' && body.message !== '') return body.message
      } catch {
        // A non-JSON error body is still an error; the status is the answer.
      }
      return `HTTP ${response.status}`
    }

    async function readSettings(repoId: string): Promise<SettingsResult> {
      const query = repoId === '' ? '' : `?repoId=${encodeURIComponent(repoId)}`
      try {
        const response = await fetch(`${SETTINGS_PATH}${query}`, { cache: 'no-store' })
        if (!response.ok) return { ok: false, message: await failureMessage(response) }
        return { ok: true, payload: (await response.json()) as SettingsPayload }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'unreachable' }
      }
    }

    /**
     * One edit, one round trip.
     *
     * The host answers with the WHOLE payload after a write, and the dialog renders what
     * came back rather than what it sent. That is what keeps a control from showing a
     * value the host refused or normalized -- a branch with its whitespace stripped, a
     * prefix the validator rejected -- and it is why there is no optimistic local copy to
     * reconcile.
     */
    async function writeSettings(repoId: string, patch: Record<string, unknown>): Promise<SettingsResult> {
      try {
        const response = await fetch(SETTINGS_PATH, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(repoId === '' ? { patch } : { repoId, patch }),
        })
        if (!response.ok) return { ok: false, message: await failureMessage(response) }
        return { ok: true, payload: (await response.json()) as SettingsPayload }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'unreachable' }
      }
    }

    /**
     * Creates a task from a brief, and starts a worker on it.
     *
     * No optimistic card is drawn: the next board read carries the real one, and the board
     * is derived from durable facts -- a locally invented card would be a card the host
     * never created, which is exactly the class of lie this plugin exists to avoid.
     */
    async function createTask(
      repoId: string,
      brief: string,
    ): Promise<{ ok: true; title: string; workerId?: string } | { ok: false; message: string }> {
      try {
        const response = await fetch(TASKS_PATH, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoId, brief }),
        })
        const payload = (await response.json().catch(() => undefined)) as
          | { ok?: boolean; message?: string; title?: string; workerId?: string }
          | undefined
        if (!response.ok || payload?.ok !== true) {
          return { ok: false, message: payload?.message ?? (await failureMessage(response)) }
        }
        return {
          ok: true,
          title: typeof payload.title === 'string' ? payload.title : '',
          ...(typeof payload.workerId === 'string' ? { workerId: payload.workerId } : {}),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'unreachable' }
      }
    }

    /**
     * The switch.
     *
     * A `<button role="switch">` with `aria-checked`, which is the host's own control --
     * measured at 36x20 with a 2px inset thumb. A checkbox with `role="switch"` is equally
     * valid ARIA, and this was one until the host's markup was read: matching it buys the
     * exact geometry, `aria-checked` (which is what styling keys off, so there is no
     * `:checked` mirror to keep in step), and Space/Enter activation from the platform.
     */
    function Switch(props: {
      id: string
      checked: boolean
      label: string
      disabled?: boolean
      onChange: (next: boolean) => void
    }) {
      return h(
        'button',
        {
          id: props.id,
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled === true,
          className: 'dsho-switch',
          onClick: () => props.onChange(!props.checked),
        },
        h('span', { className: 'dsho-switch__thumb', 'aria-hidden': 'true' }),
      )
    }

    /** One row: label (and optional hint) on the left, the control pushed right. */
    function SettingsRow(props: { label: string; hint?: string; error?: string; children?: unknown }) {
      // The error REPLACES the hint rather than joining it: a row that failed to save has
      // one thing to say, and stacking the two pushes the row taller than its neighbours
      // for no gain.
      return h(
        'div',
        { className: 'dsho-row', 'data-error': props.error ? 'true' : 'false' },
        h(
          'div',
          { className: 'dsho-row__label' },
          h('span', null, props.label),
          props.error
            ? h('span', { className: 'dsho-row__error', role: 'status' }, props.error)
            : props.hint
              ? h('span', { className: 'dsho-row__hint' }, props.hint)
              : null,
        ),
        h('div', { className: 'dsho-row__control' }, props.children),
      )
    }

    /**
     * One section: a caption over its rows.
     *
     * The rows are the section's DIRECT children, with no wrapper element, because the
     * host's rows carry their own hairline divider and `:last-child` has to be able to see
     * the last one. A wrapper would make every row a last child and draw a divider under
     * all of them.
     *
     * `props.children` is normalized rather than spread, and that is not defensiveness:
     * React hands back **a single element for one child and an array for several**, so
     * `...(props.children ?? [])` worked for the three-row sections and threw `Spread syntax
     * requires ...iterable[Symbol.iterator] to be a function` for the one section holding a
     * single row. Caught in a live host, where it blanked the whole panel through the slot's
     * error boundary. The type says array; React does not promise one.
     */
    function SettingsSection(props: { title: string; children?: unknown }) {
      const rows = Array.isArray(props.children) ? props.children : props.children === undefined ? [] : [props.children]
      return h(
        'section',
        { className: 'dsho-section', 'aria-label': props.title },
        h('h3', { className: 'dsho-section__title' }, props.title),
        ...rows,
      )
    }

    /**
     * A value with a pencil, which swaps for an input in place.
     *
     * Enter commits, Escape abandons, blur commits -- and the commit is skipped when
     * nothing changed, so opening and closing the editor is never a write. Copied from the
     * reference's `ProjectSettingsInputRow`, including the focus-and-select on open, which
     * is what makes the pencil a one-keystroke edit rather than a click into an empty box.
     *
     * The pencil is kept in a ref and focused again when the editor closes, because the
     * input is the focused element and it is unmounted. Without this the keyboard user is
     * dropped on `document.body`, which is where a measured Escape-in-editor left them --
     * the dialog survived, but the next Tab started again from the top of the page.
     */
    function InlineEdit(props: {
      id: string
      label: string
      value: string
      display: string
      placeholder: string
      disabled?: boolean
      onCommit: (next: string) => void
    }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(props.value)
      const input = React.useRef<{ focus(): void; select(): void } | null>(null)
      const pencil = React.useRef<{ focus(): void } | null>(null)

      React.useEffect(() => {
        if (!editing) return
        input.current?.focus()
        input.current?.select()
      }, [editing])

      const close = (): void => {
        setEditing(false)
        // The editor owned focus; give it back to the control that opened it. Deferred by a
        // microtask because the pencil does not exist in the DOM until React has re-rendered
        // the read-only branch.
        void Promise.resolve().then(() => pencil.current?.focus())
      }
      const open = (): void => {
        setDraft(props.value)
        setEditing(true)
      }
      const commit = (): void => {
        const next = draft
        close()
        if (next !== props.value) props.onCommit(next)
      }
      // Escape must not close the dialog underneath: the editor owns the key while it is
      // open, which is why the event is stopped rather than merely handled.
      const onKeyDown = (event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }): void => {
        if (event?.key === 'Enter') {
          event.preventDefault?.()
          commit()
        } else if (event?.key === 'Escape') {
          event.preventDefault?.()
          event.stopPropagation?.()
          setDraft(props.value)
          close()
        }
      }

      if (editing) {
        return h(
          'div',
          { className: 'dsho-inline' },
          h('input', {
            ref: input,
            id: props.id,
            className: 'dsho-inline__input',
            value: draft,
            placeholder: props.placeholder,
            'aria-label': props.label,
            onChange: (event: { target?: { value?: string } }) => setDraft(event?.target?.value ?? ''),
            onBlur: commit,
            onKeyDown,
          }),
        )
      }
      return h(
        'div',
        { className: 'dsho-inline' },
        h('span', { className: 'dsho-inline__value', title: props.display }, props.display),
        h(
          'button',
          {
            ref: pencil,
            type: 'button',
            className: 'dsho-inline__edit',
            disabled: props.disabled === true,
            'aria-label': translate('orchestrator.settings.edit', { label: props.label }),
            title: translate('orchestrator.settings.edit', { label: props.label }),
            onClick: open,
          },
          h(
            'svg',
            { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
            h('path', {
              d: 'M11.5 2.5l2 2L5 13l-2.8.8L3 11l8.5-8.5Z',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinejoin: 'round',
            }),
          ),
        ),
      )
    }

    /** The three-dot glyph. Inline, like every other icon here, so no icon package is required. */
    function DotsIcon() {
      return h(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', { cx: 3.5, cy: 8, r: 1.4, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 8, r: 1.4, fill: 'currentColor' }),
        h('circle', { cx: 12.5, cy: 8, r: 1.4, fill: 'currentColor' }),
      )
    }

    /** The project glyph: the same repository mark the panel's own topbar uses. */
    function ProjectIcon() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 4.5A1.5 1.5 0 0 1 4 3h2.2l1.2 1.6H12a1.5 1.5 0 0 1 1.5 1.5v5.4A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * The project name and its "..." menu.
     *
     * The menu holds one item today, and it is a menu rather than a bare button because
     * that is the affordance the reference uses and the one a later item has a place in --
     * a lone settings button invites the next action to be a second lone button.
     *
     * The dismissal listener is registered only while open, and the trigger stops the
     * mousedown from reaching it: otherwise the same click that opens the menu would
     * close it again, which is the classic way this control ends up needing a double click.
     *
     * The TRIGGER is handed to `onOpenSettings` so the dialog can give focus back to it.
     * Reading `document.activeElement` in the dialog instead would capture the menu ITEM,
     * which unmounts with the menu -- so the restore would be a silent no-op and the user
     * would be dropped at the top of the document.
     */
    function ProjectMenu(props: { repository: string; onOpenSettings: (opener: unknown) => void }) {
      const [open, setOpen] = React.useState(false)
      const trigger = React.useRef<unknown>(null)
      const list = React.useRef<unknown>(null)
      // An index to focus once the open menu is actually in the DOM. A ref rather than
      // state: it is a message to the effect below, not something the render depends on.
      const pending = React.useRef<number | null>(null)

      const items = (): Array<{ focus(): void }> => {
        const root = list.current as { querySelectorAll(selector: string): ArrayLike<{ focus(): void }> } | null
        return root ? Array.from(root.querySelectorAll('.dsho-menu__item')) : []
      }
      const focusAt = (index: number): void => {
        const all = items()
        if (all.length === 0) return
        all[Math.max(0, Math.min(all.length - 1, index))]?.focus()
      }
      /** Move from whatever holds focus now, wrapping at both ends. */
      const moveBy = (delta: number): void => {
        const all = items()
        if (all.length === 0) return
        const current = all.indexOf(document.activeElement as never)
        focusAt(current === -1 ? 0 : (current + delta + all.length) % all.length)
      }

      const openMenu = (index: number): void => {
        pending.current = index
        setOpen(true)
      }
      const closeMenu = (restoreFocus: boolean): void => {
        setOpen(false)
        if (!restoreFocus) return
        // Same microtask trick as the inline editor: the trigger is always mounted, but
        // focus has to move after the menu's own focusout handling has settled.
        void Promise.resolve().then(() => (trigger.current as { focus(): void } | null)?.focus())
      }

      React.useEffect(() => {
        if (!open) return
        const index = pending.current
        pending.current = null
        if (index !== null) focusAt(index)
      }, [open])

      React.useEffect(() => {
        if (!open) return
        const onPointerDown = (): void => setOpen(false)
        window.addEventListener('mousedown', onPointerDown as never)
        return () => window.removeEventListener('mousedown', onPointerDown as never)
      }, [open])

      /**
       * The menu button the host does not have.
       *
       * The host's own "..." menus are portaled to the end of the body, so Tab leaves them
       * and the arrow keys do nothing -- measured live on its workspace menu, where
       * ArrowDown with the trigger focused did not move focus at all. Ours is NOT portaled
       * (it is positioned in the topbar), so Tab reaches it naturally; what was missing was
       * everything else. This is the WAI-ARIA menu-button contract: ArrowDown/ArrowUp open
       * it onto the first/last item, move through them with wrapping, Home/End jump, Escape
       * closes and hands focus back to the trigger, and Tab is deliberately NOT handled --
       * the browser moves focus and the focusout rule below closes the menu, which avoids
       * the classic bug of unmounting the focused item and stranding focus on the body.
       */
      const onKeyDown = (event: {
        key?: string
        defaultPrevented?: boolean
        preventDefault?: () => void
        stopPropagation?: () => void
      }): void => {
        const key = event?.key
        if (key === 'Escape') {
          if (!open) return
          event.preventDefault?.()
          event.stopPropagation?.()
          closeMenu(true)
          return
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          event.preventDefault?.()
          // On the closed trigger this opens the menu; inside it, it moves. ArrowUp opens
          // onto the LAST item, which is why the index is clamped rather than named: the
          // item list is read from the DOM, so the caller cannot know its length here.
          if (!open) openMenu(key === 'ArrowDown' ? 0 : Number.MAX_SAFE_INTEGER)
          else if (key === 'ArrowDown') moveBy(1)
          else moveBy(-1)
          return
        }
        if (open && (key === 'Home' || key === 'End')) {
          event.preventDefault?.()
          focusAt(key === 'Home' ? 0 : items().length - 1)
        }
      }

      /** Close when focus leaves the menu -- see the Tab note above. */
      const onBlur = (event: { relatedTarget?: unknown }): void => {
        const next = event?.relatedTarget ?? null
        // Anything that is not inside the menu or back on the trigger closes it. A null
        // target (focus left the document) closes it too.
        const inList = next !== null && (list.current as { contains(node: unknown): boolean } | null)?.contains(next) === true
        if (!inList && next !== trigger.current) setOpen(false)
      }

      const swallow = (event: { stopPropagation?: () => void }): void => event?.stopPropagation?.()

      return h(
        'div',
        { className: 'dsho-menu', onMouseDown: swallow, onKeyDown, onBlur },
        h(
          'button',
          {
            ref: trigger,
            type: 'button',
            className: 'dsho-menu__trigger',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': translate('orchestrator.settings.open'),
            title: translate('orchestrator.settings.open'),
            onClick: () => (open ? closeMenu(false) : setOpen(true)),
          },
          h(DotsIcon, null),
        ),
        open
          ? h(
              'div',
              { ref: list, className: 'dsho-menu__list', role: 'menu' },
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsho-menu__item',
                  onClick: () => {
                    setOpen(false)
                    props.onOpenSettings(trigger.current)
                  },
                },
                translate('orchestrator.settings.menuItem'),
              ),
            )
          : null,
      )
    }

    /**
     * The project settings dialog.
     *
     * Four states, and each is designed rather than improvised: loading, unavailable,
     * nothing connected, and ready. "No repository is connected" is deliberately NOT the
     * error state -- an install that has not connected a project yet is the normal first
     * run, and showing it a failure would teach the user the plugin is broken.
     *
     * ## Focus, which is the part a dialog usually gets wrong
     *
     * Three things have to hold, and only the first is obvious:
     *
     *   - focus moves INTO the dialog on open, or a keyboard user is still typing into the
     *     page behind it;
     *   - **Tab cycles within the dialog**, because the board behind it is still in the DOM
     *     and focusable -- our overlay covers the panel without making anything inert, so
     *     without a trap the next Tab lands on a card behind the modal;
     *   - focus returns to the control that opened it on close, or the user is dropped at
     *     the top of the document with no idea where they were.
     */
    function SettingsDialog(props: { repoId: string; restoreFocusTo?: unknown; onClose: () => void }) {
      type State =
        | { kind: 'loading' }
        | { kind: 'ready'; payload: SettingsPayload }
        | { kind: 'error'; message: string }
      const [state, setState] = React.useState<State>({ kind: 'loading' })
      const [status, setStatus] = React.useState<{
        kind: 'idle' | 'saving' | 'saved' | 'error'
        message?: string
        /** The keys this save touched, so a failure can be shown on its own row. */
        fields?: string[]
      }>({ kind: 'idle' })
      const dialog = React.useRef<{ focus(): void; querySelectorAll(selector: string): ArrayLike<{ focus(): void }> } | null>(null)

      React.useEffect(() => {
        let cancelled = false
        void readSettings(props.repoId).then((result) => {
          if (cancelled) return
          setState(result.ok ? { kind: 'ready', payload: result.payload } : { kind: 'error', message: result.message })
        })
        return () => {
          cancelled = true
        }
      }, [props.repoId])

      React.useEffect(() => {
        // The trigger the Board captured, falling back to whatever held focus. The fallback
        // matters for the paths that do not come through the menu; the explicit value
        // matters because the menu ITEM -- the real `document.activeElement` at this moment
        // -- unmounts with the menu, so restoring to it would do nothing at all.
        const opener = (props.restoreFocusTo ?? document.activeElement) as { focus?(): void } | null
        dialog.current?.focus()
        return () => {
          if (opener && typeof opener.focus === 'function' && document.contains(opener as never)) opener.focus()
        }
      }, [])

      React.useEffect(() => {
        const onKey = (event: { key?: string }): void => {
          if (event?.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey as never)
        return () => window.removeEventListener('keydown', onKey as never)
      }, [])

      // The Tab trap is shared with the new-task dialog: two copies of a focus rule is one
      // copy that gets fixed and another that keeps trapping Tab behind the dialog.
      const trapTab = (event: TrapKeyEvent): void => trapTabWithin(dialog.current, event)

      const save = (patch: Record<string, unknown>): void => {
        const fields = Object.keys(patch)
        setStatus({ kind: 'saving', fields })
        void writeSettings(props.repoId, patch).then((result) => {
          if (result.ok) {
            setState({ kind: 'ready', payload: result.payload })
            setStatus({ kind: 'saved', fields })
            return
          }
          setStatus({ kind: 'error', message: result.message, fields })
        })
      }

      // "Saved" is a receipt, not a state: it clears itself so the header goes quiet again
      // instead of reporting the same thing for the rest of the dialog's life. A FAILURE
      // does not clear -- it has to stay until the user does something about it.
      const savedKind = status.kind
      React.useEffect(() => {
        if (savedKind !== 'saved') return
        const timer = setTimeout(() => setStatus({ kind: 'idle' }), 2500)
        return () => clearTimeout(timer)
      }, [savedKind])

      /**
       * The failure for one row, or nothing.
       *
       * The host names the rejected key in the refusal's `code`, and the save call site
       * sends exactly one key, so this puts the message where the user is looking. A
       * failure that names no key (storage down, project gone) stays in the header only,
       * because marking six rows would blame the wrong thing.
       */
      const fieldError = (field: string): string | undefined =>
        status.kind === 'error' && status.fields?.includes(field) === true ? status.message : undefined

      const statusNode =
        status.kind === 'idle'
          ? null
          : h(
              'span',
              {
                className: 'dsho-settings__status',
                'data-status': status.kind === 'error' ? 'error' : 'info',
                role: 'status',
              },
              status.kind === 'saving'
                ? translate('orchestrator.settings.saving')
                : status.kind === 'saved'
                  ? translate('orchestrator.settings.saved')
                  : translate('orchestrator.settings.saveFailed', { message: status.message ?? '' }),
            )

      // The project's LOCAL PATH sits under its name, because two checkouts of the same
      // repository are indistinguishable by `owner/name` alone -- and the one thing a user
      // must be sure of before editing is which one they are editing.
      const head = h(
        'div',
        { className: 'dsho-settings__head' },
        h(
          'div',
          { className: 'dsho-settings__titles' },
          h('h2', { className: 'dsho-settings__title', id: 'dsho-settings-title' }, translate('orchestrator.settings.title')),
          state.kind === 'ready' && state.payload.project
            ? h('span', { className: 'dsho-settings__sub', title: state.payload.project.rootPath }, state.payload.project.repository)
            : null,
        ),
        h('span', { className: 'dsho-settings__spacer' }),
        statusNode,
        h(
          'button',
          {
            type: 'button',
            className: 'dsho-settings__close',
            'aria-label': translate('orchestrator.settings.close'),
            title: translate('orchestrator.settings.close'),
            onClick: props.onClose,
          },
          h(
            'svg',
            { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
            h('path', { d: 'M4 4l8 8M12 4l-8 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
          ),
        ),
      )

      // Variadic on purpose: the dialog's body is a list of sections, and a single
      // `children` parameter would silently drop all but the first once a section is added.
      //
      // The scrim closes on click, which is what the host's own dialogs do, and the check is
      // `target === currentTarget`: a click that started on a row and ended on the scrim
      // fires here too (a click targets the common ancestor), and without the check a
      // slightly-too-long drag off a switch would dismiss the dialog and lose the edit.
      const shell = (...children: unknown[]): unknown =>
        h(
          'div',
          {
            className: 'dsho-settings-scrim',
            onMouseDown: (event: { target?: unknown; currentTarget?: unknown }) => {
              if (event?.target === event?.currentTarget) props.onClose()
            },
          },
          h(
            'div',
            {
              className: 'dsho-settings',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'dsho-settings-title',
              tabIndex: -1,
              ref: dialog,
              onKeyDown: trapTab,
            },
            head,
            h('div', { className: 'dsho-settings__body' }, ...children),
          ),
        )

      if (state.kind === 'loading') return shell(h('p', { className: 'dsho-note' }, translate('orchestrator.settings.loading')))
      if (state.kind === 'error') {
        return shell(
          h(
            'p',
            { className: 'dsho-note dsho-note--error', role: 'status' },
            translate('orchestrator.settings.unavailable', { message: state.message }),
          ),
        )
      }

      const payload = state.payload
      if (!payload.settings || !payload.project) {
        return shell(h('p', { className: 'dsho-note' }, translate('orchestrator.settings.noProject')))
      }

      const settings = payload.settings
      // The hint shows the branch shape the prefix actually produces, which is the one fact
      // a user cannot guess from the word "prefix" -- and only while one is set, since a
      // pattern with an empty segment in it explains nothing.
      const prefixHint =
        settings.sessionPrefix === ''
          ? translate('orchestrator.settings.sessionPrefixHint')
          : `dsho/${settings.sessionPrefix}/issue-<n>-<slug>`

      return shell(
        h(
          SettingsSection,
          { title: translate('orchestrator.settings.worktrees') },
          [
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.defaultBranch'),
                hint: translate('orchestrator.settings.defaultBranchHint'),
                error: fieldError('defaultBranch'),
              },
              h(InlineEdit, {
                id: 'dsho-default-branch',
                label: translate('orchestrator.settings.defaultBranch'),
                value: settings.defaultBranch,
                display: settings.defaultBranch === '' ? translate('orchestrator.settings.defaultBranchAuto') : settings.defaultBranch,
                placeholder: translate('orchestrator.settings.defaultBranchAuto'),
                onCommit: (next: string) => save({ defaultBranch: next }),
              }),
            ),
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.sessionPrefix'),
                hint: prefixHint,
                error: fieldError('sessionPrefix'),
              },
              h(InlineEdit, {
                id: 'dsho-session-prefix',
                label: translate('orchestrator.settings.sessionPrefix'),
                value: settings.sessionPrefix,
                display: settings.sessionPrefix === '' ? translate('orchestrator.settings.defaultBranchAuto') : settings.sessionPrefix,
                placeholder: translate('orchestrator.settings.defaultBranchAuto'),
                onCommit: (next: string) => save({ sessionPrefix: next }),
              }),
            ),
          ],
        ),
        h(
          SettingsSection,
          { title: translate('orchestrator.settings.issues') },
          [
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.intake'),
                hint: translate('orchestrator.settings.intakeHint'),
                error: fieldError('intakeEnabled'),
              },
              h(Switch, {
                id: 'dsho-intake',
                label: translate('orchestrator.settings.intake'),
                checked: settings.intakeEnabled,
                onChange: (next: boolean) => save({ intakeEnabled: next }),
              }),
            ),
            h(
              SettingsRow,
              { label: translate('orchestrator.settings.repository') },
              h('span', { className: 'dsho-row__value', title: payload.project.rootPath }, payload.project.repository),
            ),
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.assignee'),
                hint: translate('orchestrator.settings.assigneeHint'),
                error: fieldError('workerAgentPreset'),
              },
              h(InlineEdit, {
                id: 'dsho-assignee',
                label: translate('orchestrator.settings.assignee'),
                value: settings.workerAgentPreset,
                display:
                  settings.workerAgentPreset === ''
                    ? `${translate('orchestrator.settings.assigneeDefault')} (${payload.defaults.workerAgentPreset})`
                    : settings.workerAgentPreset,
                placeholder: payload.defaults.workerAgentPreset,
                onCommit: (next: string) => save({ workerAgentPreset: next }),
              }),
            ),
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.workerPermissions'),
                hint: translate('orchestrator.settings.workerPermissionsHint'),
                error: fieldError('workerPermissionPreset'),
              },
              h(InlineEdit, {
                id: 'dsho-worker-permissions',
                label: translate('orchestrator.settings.workerPermissions'),
                value: settings.workerPermissionPreset,
                display:
                  settings.workerPermissionPreset === ''
                    ? `${translate('orchestrator.settings.workerPermissionsDefault')} (${payload.defaults.workerPermissionPreset})`
                    : settings.workerPermissionPreset,
                placeholder: payload.defaults.workerPermissionPreset,
                onCommit: (next: string) => save({ workerPermissionPreset: next }),
              }),
            ),
          ],
        ),
        h(
          SettingsSection,
          { title: translate('orchestrator.settings.reviewers') },
          [
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.defaultReviewer'),
                hint: translate('orchestrator.settings.reviewerHint'),
                error: fieldError('reviewerAgentPreset'),
              },
              h(InlineEdit, {
                id: 'dsho-reviewer-preset',
                label: translate('orchestrator.settings.defaultReviewer'),
                value: settings.reviewerAgentPreset,
                display:
                  settings.reviewerAgentPreset === ''
                    ? `${translate('orchestrator.settings.assigneeDefault')} (${payload.defaults.reviewerAgentPreset})`
                    : settings.reviewerAgentPreset,
                placeholder: payload.defaults.reviewerAgentPreset,
                onCommit: (next: string) => save({ reviewerAgentPreset: next }),
              }),
            ),
          ],
        ),
        h(
          SettingsSection,
          { title: translate('orchestrator.settings.pullRequests') },
          [
            h(
              SettingsRow,
              {
                label: translate('orchestrator.settings.autoReview'),
                hint: translate('orchestrator.settings.autoReviewHint'),
                error: fieldError('autoReview'),
              },
              settings.autoReview === null
                ? h(
                    'span',
                    { className: 'dsho-row__value' },
                    translate('orchestrator.settings.autoReviewInherited', {
                      value: payload.defaults.autoReview ? translate('orchestrator.settings.on') : translate('orchestrator.settings.off'),
                    }),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsho-inline__reset',
                      onClick: () => save({ autoReview: null }),
                    },
                    translate('orchestrator.settings.autoReviewReset'),
                  ),
              h(Switch, {
                id: 'dsho-auto-review',
                label: translate('orchestrator.settings.autoReview'),
                checked: settings.autoReview === null ? payload.defaults.autoReview : settings.autoReview,
                onChange: (next: boolean) => save({ autoReview: next }),
              }),
            ),
          ],
        ),
      )
    }

    /**
     * The New-task dialog (the reference's New Task).
     *
     * A brief, and a button. Nothing else is asked for, and both omissions are deliberate:
     *
     *   - the PROJECT is the panel's own, so the row the person clicked and the task that
     *     appears cannot disagree -- which is the reference's own reason for scoping a board
     *     to one project in the first place;
     *   - the TITLE is derived. The host names the task from the brief the moment it exists
     *     and asks the worker for a better name afterwards, so there is no title field to
     *     fill in -- and a person describing work in their own words is not worse at it than
     *     a form is.
     */
    function NewTaskDialog(props: {
      repoId: string
      repository: string
      onClose: () => void
      onCreated: (title: string) => void
      /** The button that opened it, so closing hands focus back instead of dropping it. */
      restoreFocusTo?: unknown
    }) {
      const [brief, setBrief] = React.useState('')
      const [status, setStatus] = React.useState<{ kind: 'idle' | 'starting' | 'error'; message?: string }>({
        kind: 'idle',
      })
      const dialog = React.useRef<{ focus(): void; querySelectorAll(selector: string): ArrayLike<{ focus(): void }> } | null>(
        null,
      )
      const field = React.useRef<{ focus(): void } | null>(null)

      // The BRIEF is focused, not the dialog: a dialog that opens with nothing focused makes
      // the person press Tab before they can type, and typing is the only thing to do here.
      React.useEffect(() => {
        field.current?.focus()
      }, [])

      React.useEffect(() => {
        // Focus returns to the trigger, which is what the settings dialog does and what a
        // keyboard user needs: without it focus lands on the body and the next Tab starts
        // from the top of the page.
        const opener = (props.restoreFocusTo ?? null) as { focus?(): void } | null
        return () => {
          if (opener && typeof opener.focus === 'function' && document.contains(opener as never)) opener.focus()
        }
      }, [])

      React.useEffect(() => {
        const onKey = (event: { key?: string }): void => {
          if (event?.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey as never)
        return () => window.removeEventListener('keydown', onKey as never)
      }, [])

      const start = (): void => {
        if (brief.trim() === '' || status.kind === 'starting') return
        setStatus({ kind: 'starting' })
        void createTask(props.repoId, brief).then((result) => {
          if (!result.ok) {
            // The host's own words, because it is the only side that knows WHY: nothing is
            // connected, storage is down, or every slot is taken.
            setStatus({ kind: 'error', message: result.message })
            return
          }
          props.onCreated(result.title)
          props.onClose()
        })
      }

      const head = h(
        'div',
        { className: 'dsho-settings__head' },
        h(
          'div',
          { className: 'dsho-settings__titles' },
          h('h2', { className: 'dsho-settings__title', id: 'dsho-task-title' }, translate('orchestrator.task.title')),
          h('span', { className: 'dsho-settings__sub' }, props.repository),
        ),
        h('span', { className: 'dsho-settings__spacer' }),
        status.kind === 'error'
          ? h(
              'span',
              { className: 'dsho-settings__status', 'data-status': 'error', role: 'status' },
              translate('orchestrator.task.failed', { message: status.message ?? '' }),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsho-settings__close',
            'aria-label': translate('orchestrator.task.close'),
            title: translate('orchestrator.task.close'),
            onClick: props.onClose,
          },
          h(
            'svg',
            { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
            h('path', { d: 'M4 4l8 8M12 4l-8 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
          ),
        ),
      )

      return h(
        'div',
        {
          className: 'dsho-settings-scrim',
          // `target === currentTarget`, for the reason the settings dialog gives: a click
          // that started inside the dialog and ended on the scrim fires here too, and
          // without the check a slightly-too-long drag would throw the brief away.
          onMouseDown: (event: { target?: unknown; currentTarget?: unknown }) => {
            if (event?.target === event?.currentTarget) props.onClose()
          },
        },
        h(
          'div',
          {
            className: 'dsho-task',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsho-task-title',
            tabIndex: -1,
            ref: dialog,
            onKeyDown: (event: TrapKeyEvent) => trapTabWithin(dialog.current, event),
          },
          head,
          h(
            'div',
            { className: 'dsho-settings__body' },
            h('label', { className: 'dsho-task__label', htmlFor: 'dsho-task-brief' }, translate('orchestrator.task.brief')),
            h('textarea', {
              id: 'dsho-task-brief',
              className: 'dsho-task__input',
              rows: 6,
              value: brief,
              placeholder: translate('orchestrator.task.placeholder'),
              ref: field,
              onChange: (event: { target?: { value?: string } }) => {
                setBrief(event?.target?.value ?? '')
                // A new brief clears the previous refusal: leaving it up would blame the
                // text the user has already replaced.
                if (status.kind === 'error') setStatus({ kind: 'idle' })
              },
              onKeyDown: (event: { key?: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void }) => {
                if (event?.key === 'Enter' && (event.metaKey === true || event.ctrlKey === true)) {
                  event.preventDefault?.()
                  start()
                }
              },
            }),
            h('p', { className: 'dsho-task__hint' }, translate('orchestrator.task.hint')),
          ),
          h(
            'div',
            { className: 'dsho-task__footer' },
            h(
              'button',
              { type: 'button', className: 'dsho-btn dsho-btn--quiet', onClick: props.onClose },
              translate('orchestrator.task.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsho-btn dsho-btn--primary',
                disabled: brief.trim() === '' || status.kind === 'starting',
                onClick: start,
              },
              status.kind === 'starting' ? translate('orchestrator.task.starting') : translate('orchestrator.task.start'),
            ),
          ),
        ),
      )
    }
    /**
     * The connect panel — the plugin's ONE global surface, and the reason it exists.
     *
     * The board's rows are built from the host's **connected project list**, so an install
     * with nothing connected rendered no rows, no panels and therefore no settings dialog
     * either. Connecting was only ever reachable from a session, which is circular for a
     * first run: the plugin looked like it did nothing at all.
     *
     * This panel is registered UNCONDITIONALLY, so it is present before anything is
     * connected and remains as the list of workspaces afterwards.
     *
     * Why a global row is right HERE when the board's own docstring rejects one: that
     * rejection is about answering "which project's board is this?". A connect list has one
     * answer for every project — it is about the workspaces the person uses, not about a
     * project's work — so it is genuinely global, and the board rows stay one-per-project
     * and project-scoped.
     *
     * `onConnected` is the panel's only outbound effect. After a successful connect the
     * host's project list has grown, and refreshing it immediately means the new project's
     * row and board appear at once instead of up to a poll interval later.
     */
    function Connect(props: { onConnected: () => void }) {
      const style = h('style', null, CSS)
      type ConnectView =
        | { kind: 'loading' }
        | { kind: 'ready'; workspaces: WorkspaceOptionView[] }
        | { kind: 'error'; message: string }
      const [view, setView] = React.useState<ConnectView>({ kind: 'loading' })
      const [typed, setTyped] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; message: string } | null>(null)

      const read = (): void => {
        void (async () => {
          try {
            const response = await fetch(WORKSPACES_PATH, { cache: 'no-store' })
            if (!response.ok) {
              setView({ kind: 'error', message: `HTTP ${response.status}` })
              return
            }
            const payload = (await response.json()) as WorkspacesPayload
            setView({ kind: 'ready', workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [] })
          } catch (error) {
            setView({ kind: 'error', message: error instanceof Error ? error.message : 'unreachable' })
          }
        })()
      }

      React.useEffect(() => {
        read()
      }, [])

      /**
       * One attempt, one round trip, and the HOST's message is what is shown.
       *
       * A refusal is not paraphrased here: `connectRepo` already names the fix ("is not
       * inside a git work tree", "gh is not authenticated"), and a second explanation in
       * the client would be one more thing to keep in step with the first.
       */
      const connect = (path: string): void => {
        if (busy) return
        setBusy(true)
        setNotice(null)
        void (async () => {
          try {
            const response = await fetch(CONNECT_PATH, {
              method: 'POST',
              cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            })
            const payload = (await response.json().catch(() => ({}))) as ConnectPayload
            const message =
              typeof payload.message === 'string' && payload.message !== ''
                ? payload.message
                : `HTTP ${response.status}`
            setBusy(false)
            if (!response.ok || payload.ok !== true) {
              setNotice({ tone: 'error', message })
              return
            }
            setNotice({ tone: 'ok', message })
            setTyped('')
            props.onConnected()
            read()
          } catch (error) {
            setBusy(false)
            setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'unreachable' })
          }
        })()
      }

      const workspaces = view.kind === 'ready' ? view.workspaces : []
      const header = h(
        'header',
        { className: 'dsho-topbar' },
        h(PanelIcon, { size: 15, active: true }),
        h('h2', { className: 'dsho-topbar__title' }, translate('orchestrator.connect.title')),
        h('span', { className: 'dsho-topbar__spacer' }),
        h('p', { className: 'dsho-sub', style: { margin: 0 } }, translate('orchestrator.connect.sub')),
      )

      const manual = h(
        'div',
        { className: 'dsho-inline' },
        h('input', {
          className: 'dsho-inline__input',
          type: 'text',
          value: typed,
          placeholder: translate('orchestrator.connect.placeholder'),
          'aria-label': translate('orchestrator.connect.placeholder'),
          onChange: (event: { target?: { value?: string } }) => setTyped(event?.target?.value ?? ''),
          onKeyDown: (event: { key?: string; preventDefault?: () => void }) => {
            if (event?.key !== 'Enter') return
            event.preventDefault?.()
            connect(typed)
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsho-btn',
            disabled: busy || typed.trim() === '',
            onClick: () => connect(typed),
          },
          translate('orchestrator.connect.action'),
        ),
      )

      const body =
        view.kind === 'loading'
          ? h('p', { className: 'dsho-note' }, translate('orchestrator.connect.loading'))
          : view.kind === 'error'
            ? h(
                'p',
                { className: 'dsho-note dsho-note--error', role: 'status' },
                translate('orchestrator.connect.unavailable', { message: view.message }),
              )
            : h(
                'div',
                { className: 'dsho-section' },
                h('h3', { className: 'dsho-section__title' }, translate('orchestrator.connect.workspaces')),
                workspaces.length === 0
                  ? h(
                      'div',
                      { className: 'dsho-empty' },
                      h('p', { className: 'dsho-empty__title' }, translate('orchestrator.connect.emptyTitle')),
                      h('p', { className: 'dsho-empty__body' }, translate('orchestrator.connect.emptyBody')),
                    )
                  : h('div', null, ...workspaces.map(rowFor)),
              )

      function rowFor(option: WorkspaceOptionView): unknown {
        return h(
          'div',
          { className: 'dsho-row', key: option.id },
          h(
            'div',
            { className: 'dsho-row__label' },
            h('span', null, option.title),
            h('span', { className: 'dsho-row__hint', title: option.path }, option.path),
          ),
          h(
            'div',
            { className: 'dsho-row__control' },
            option.repository === null
              ? h(
                  'button',
                  { type: 'button', className: 'dsho-btn', disabled: busy, onClick: () => connect(option.path) },
                  translate('orchestrator.connect.action'),
                )
              : h(
                  'span',
                  { className: 'dsho-row__value', title: option.repository },
                  translate('orchestrator.connect.connected', { repository: option.repository }),
                ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsho-panel' },
        style,
        header,
        notice === null
          ? null
          : h(
              'p',
              { className: notice.tone === 'ok' ? 'dsho-note' : 'dsho-note dsho-note--error', role: 'status' },
              notice.message,
            ),
        h(
          'div',
          { className: 'dsho-section' },
          h('h3', { className: 'dsho-section__title' }, translate('orchestrator.connect.pathTitle')),
          manual,
        ),
        body,
      )
    }

    /**
     * The board panel — ONE project's board.
     *
     * `repoId` is fixed at registration (there is one panel per project, and the sidebar row
     * for that project selects it), so the panel has no project picker and no "which project
     * does this menu act on?" ambiguity: the name in the topbar, the cards beneath it and the
     * settings dialog behind the "..." menu are the same project by construction.
     */
    function Board(props: { repoId: string }) {
      const [view, setView] = React.useState<View>({ kind: 'loading' })
      const [openId, setOpenId] = React.useState<string | undefined>(undefined)
      /** Whether the project settings dialog is open. */
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      /** The "..." trigger that opened it, so closing can put focus back where it was. */
      const settingsOpener = React.useRef<unknown>(null)
      /** Whether the new-task dialog is open. */
      const [taskOpen, setTaskOpen] = React.useState(false)
      /** The button that opened it, for the same focus reason. */
      const taskOpener = React.useRef<unknown>(null)
      /**
       * Bumped after a task is created, so the board reads again AT ONCE.
       *
       * The dialog closing is not feedback: the card it produced is the feedback, and
       * waiting up to a poll interval to show it would look like nothing happened. It is a
       * counter rather than a boolean because a second task must trigger a second read.
       */
      const [refreshNonce, setRefreshNonce] = React.useState(0)

      // Escape closes the inspector. A detail view dismissible only by finding the close
      // button is not keyboard reachable in practice.
      //
      // It must NOT also fire while the settings dialog is open: the dialog handles its own
      // Escape, and both listeners are on the window, so without this guard one keypress
      // would close the inspector behind a dialog the user was still reading. The state is
      // in the dependency list for exactly that reason -- an empty list would capture the
      // first render's `settingsOpen` forever.
      React.useEffect(() => {
        const onKey = (event: { key?: string }) => {
          if (event?.key === 'Escape' && !settingsOpen && !taskOpen) setOpenId(undefined)
        }
        window.addEventListener('keydown', onKey as never)
        return () => window.removeEventListener('keydown', onKey as never)
      }, [settingsOpen, taskOpen])

      React.useEffect(() => {
        let cancelled = false
        const tick = () => {
          void readBoard(props.repoId).then((next) => {
            if (!cancelled) setView((previous) => mergeView(previous, next))
          })
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
        // `refreshNonce` is a dependency on purpose: a created task re-runs this effect, which
        // reads once immediately instead of waiting for the next interval.
      }, [props.repoId, refreshNonce])

      /**
       * What a card's body click does.
       *
       * §11.2: "Clicking the card body opens the worker's DSH session (the real working
       * room), not a plugin-drawn chat." The harness's own navigation service does that.
       * Without it -- a host with no workspace UI -- the click falls back to the
       * inspector, so the card is never a dead end.
       */
      const openCard = (id: string): void => {
        const card = Object.values(view.kind === 'ready' ? view.board.lenses.lanes : {}).flat().find((c) => c.id === id)
        const sessionId = card?.sessionId
        if (openSession !== undefined && sessionId) openSession(sessionId)
        else setOpenId(id)
      }

      const style = h('style', null, CSS)
      // A snapshot from a host that predates the settings page carries no projects, so the
      // panel renders its plain title rather than a broken project row.
      const projects = view.kind === 'ready' ? view.board.projects ?? [] : []
      /**
       * The project this panel is FOR — the one it was registered for.
       *
       * Not "the first project", which is what this used to be: with one panel per project the
       * row the user clicked and the board they see are the same project by construction. A
       * project that has just been disconnected can leave a panel briefly pointing at a project
       * the host no longer lists; the host's layout prunes such a panel as soon as the key is
       * gone, and until then the name falls back to nothing rather than to another project.
       */
      const activeProject = projects.find((project) => project.id === props.repoId)
      const header = h(
        'header',
        { className: 'dsho-topbar' },
        h(
          'svg',
          { className: 'dsho-topbar__icon', width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M6 1.5v13M10.5 1.5v13', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.55 }),
        ),
        h('h2', { className: 'dsho-topbar__title' }, translate('orchestrator.title')),
        activeProject === undefined
          ? null
          : h(
              'div',
              { className: 'dsho-project' },
              h(
                'span',
                { className: 'dsho-project__name', title: activeProject.rootPath },
                h(ProjectIcon, null),
                h('span', null, activeProject.repository),
              ),
              h(ProjectMenu, {
                repository: activeProject.repository,
                onOpenSettings: (opener: unknown) => {
                  settingsOpener.current = opener
                  setSettingsOpen(true)
                },
              }),
            ),
        // The new-task entry point. Rendered only with a project: a task belongs to one, and
        // a button whose only possible answer is a refusal is worse than no button.
        activeProject === undefined
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dsho-btn dsho-btn--primary',
                onClick: (event: { currentTarget?: unknown }) => {
                  taskOpener.current = event?.currentTarget
                  setTaskOpen(true)
                },
              },
              h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                h('path', {
                  d: 'M8 3.5v9M3.5 8h9',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.5,
                  strokeLinecap: 'round',
                }),
              ),
              translate('orchestrator.task.new'),
            ),
        h('span', { className: 'dsho-topbar__spacer' }),
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
        view.stale
          ? h(
              'div',
              { className: 'dsho-banner', role: 'status' },
              h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                h('path', { d: 'M8 2 15 14H1L8 2Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
                h('path', { d: 'M8 6.5v3.5M8 11.6v.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
              ),
              h('span', null, translate('orchestrator.board.stale', { message: view.stale })),
            )
          : null,
        board.counts.total === 0
          ? h(
              'div',
              { className: 'dsho-empty' },
              h('p', { className: 'dsho-empty__title' }, translate('orchestrator.board.emptyTitle')),
              h('p', { className: 'dsho-empty__body' }, translate('orchestrator.board.emptyBody')),
            )
          : h(
              'div',
              { className: 'dsho-board-scroll' },
              h(
                'div',
                { className: 'dsho-lanes' },
                ...LANES.map((lane) =>
                  h(Lane, {
                    key: lane.key,
                    lane,
                    cards: board.lenses.lanes[lane.key] ?? [],
                    onOpen: openCard,
                    onFindings: setOpenId,
                  }),
                ),
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
          ? h(
              'details',
              { className: 'dsho-archive' },
              h('summary', null, translate('orchestrator.archive.summary', { count: board.lenses.archive.length })),
              h(
                'ul',
                { className: 'dsho-list dsho-archive__list' },
                ...board.lenses.archive.map((card) =>
                  h(
                    'li',
                    { key: card.id, className: 'dsho-archive__row' },
                    h('span', { className: 'dsho-card__title', title: card.title }, card.title),
                    h('span', { className: 'dsho-card__meta' }, card.displayStatus),
                    h('span', { className: 'dsho-card__meta' }, formatAge(card.updatedAt, Date.now())),
                  ),
                ),
              ),
            )
          : null,
        // The dialog is the LAST child and absolutely positioned, so it covers the board
        // rather than pushing it: a modal that reflows what is behind it is a layout, not a
        // dialog. It is inside the panel's own tree, which is what keeps every style and
        // token here scoped to this component.
        // The new-task dialog, for the same reasons: inside the panel's own tree, absolutely
        // positioned, and last, so it covers the board rather than reflowing it.
        taskOpen && activeProject !== undefined
          ? h(NewTaskDialog, {
              repoId: props.repoId,
              repository: activeProject.repository,
              restoreFocusTo: taskOpener.current,
              onClose: () => setTaskOpen(false),
              onCreated: () => setRefreshNonce((previous) => previous + 1),
            })
          : null,
        settingsOpen
          ? h(SettingsDialog, {
              // The panel's OWN project, explicitly -- never "the first one", which is how the
              // dialog and the name above it could previously disagree.
              repoId: props.repoId,
              restoreFocusTo: settingsOpener.current,
              onClose: () => setSettingsOpen(false),
            })
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

    /**
     * The panel list's order, and the first order a project row may take.
     *
     * `sidebar.panellist` is shared with every other plugin's panel row, so the plugin keeps
     * to one band (20 upwards) rather than ordering itself against rows it does not own. A
     * project's row and its panel use the SAME id (`orchestrator:<repoId>`) because that is
     * what makes the row select its own board, and the index keeps the payload's order --
     * the install's configured project first, then oldest first.
     */
    const PANEL_ORDER = 20

    /** One project's two registrations, plus the signature that makes them stale. */
    interface ProjectEntry {
      signature: string
      dispose: () => void
    }

    /**
     * The sidebar row id and the main panel key for one project.
     *
     * One string addresses both seats, which is the contract `sidebar.panellist` documents:
     * the row selects the main entry whose `key` matches its `id`. Repo ids are ULIDs
     * (alphanumerics and dashes), so the prefix cannot collide with a key another plugin
     * spells, and `orchestrator:` cannot be mistaken for a project id.
     */
    function entryIdOf(projectId: string): string {
      return `orchestrator:${projectId}`
    }

    /**
     * The connect panel's row id and main panel key.
     *
     * Deliberately NOT `entryIdOf(...)`: that function's value means "the project with this
     * repository id", and this entry is not a project. Reusing it would make a repository
     * whose id happened to be `projects` collide with a row that belongs to no project.
     *
     * It sits BELOW `PANEL_ORDER` so it leads the plugin's band: it is the entry point that
     * creates the project rows, and a list of workspaces is not worth reaching past boards
     * that already exist.
     */
    const CONNECT_ID = 'orchestrator:projects'
    const CONNECT_ORDER = PANEL_ORDER - 1

    /**
     * Everything that makes a project's registrations stale when it changes.
     *
     * The label and the order are fixed at REGISTRATION, and both come from data that can
     * move: connecting a project shifts every later row's index, and a renamed repository
     * changes the name on the row. Comparing signatures turns both into a re-registration
     * instead of a row that quietly says the wrong thing.
     */
    function signatureOf(project: ProjectView, index: number): string {
      return `${index}\u0000${project.repository}\u0000${project.rootPath}`
    }

    return {
      // `uiWorkspace` is what makes a card open the worker's real session (PRD §11.2:
      // "the real working room, not a plugin-drawn chat"). Declared exactly as a shipped
      // plugin declares it -- `inject: ["slots", "uiWorkspace"]`.
      inject: ['slots', 'uiWorkspace'],
      apply(ctx: {
        uiWorkspace?: unknown
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
        // Bound once, at activation, so a render never probes the service.
        const workspaceUi = readUiWorkspace(ctx)
        openSession = workspaceUi === undefined ? undefined : (sessionId) => workspaceUi.openSession(sessionId)

        /**
         * The plan: **one panel per project, and one navigation row for each of those panels.**
         *
         * This replaced a single global row. A global row cannot answer "which project's board
         * is this?" -- the panel it opened showed EVERY project's workers at once, with a
         * project name in its topbar that only selected what the "..." settings menu acted
         * on. Now the board is scoped by construction: the host filters the cards by the
         * project the panel was registered for, and the row, the panel and the settings dialog
         * are all the same project by construction.
         *
         * The cost, stated plainly: **the entry points come from the host's project list**, so
         * a board is reachable only after a project is connected (`orchestrator_repo_connect`),
         * and a project with no workers shows an empty board rather than no button.
         *
         * Why the list is polled rather than read once: connecting a project is a host-side
         * action taken by a SESSION, and nothing in the client is told about it. The read is
         * the board endpoint the panels already use -- the snapshot carries every project, on
         * a scoped read too -- so this adds no endpoint and no new payload shape.
         */
        let projects: ProjectView[] = []
        /** Registered rows and panels, by project id. */
        const rows = new Map<string, ProjectEntry>()
        const panels = new Map<string, ProjectEntry>()
        /** Whether each seat has been DECLARED yet (`ctx.slots.inject` waits for that). */
        let rowsSeat = false
        let panelsSeat = false
        /** The connect row's disposer, once it has been registered. */
        let connectRow: (() => void) | undefined
        /**
         * Set by the poll effect below, so the connect panel can refresh the project list the
         * moment a connection lands.
         *
         * A no-op until then, which is correct rather than sloppy: the poll effect is
         * registered during activation, and a click cannot arrive before activation finishes.
         */
        let refreshProjects: () => void = () => {}

        function disposeAll(entries: Map<string, ProjectEntry>): void {
          for (const entry of entries.values()) entry.dispose()
          entries.clear()
        }

        /**
         * Bring one seat in line with `projects`.
         *
         * Driven by signatures rather than by diffing project ids, so a label or order that
         * moved re-registers that one project and leaves the rest alone; ids that are gone are
         * disposed. A row waits for its PANEL (`requiresPanel`): a row whose main key is missing
         * would throw on click, because the shell's `selectPanel` refuses a key no one
         * registered.
         */
        function reconcile(
          entries: Map<string, ProjectEntry>,
          ready: boolean,
          create: (project: ProjectView, index: number) => () => void,
          requiresPanel = false,
        ): void {
          if (!ready) return
          const live = new Set<string>()
          projects.forEach((project, index) => {
            if (requiresPanel && !panels.has(project.id)) return
            live.add(project.id)
            const signature = signatureOf(project, index)
            const existing = entries.get(project.id)
            if (existing !== undefined && existing.signature === signature) return
            existing?.dispose()
            entries.set(project.id, { signature, dispose: create(project, index) })
          })
          for (const [id, entry] of [...entries]) {
            if (live.has(id)) continue
            entry.dispose()
            entries.delete(id)
          }
        }

        /** Reconcile both seats. Panels first, so a row never lands before its panel. */
        function reconcileAll(): void {
          reconcile(panels, panelsSeat, (project) =>
            ctx.slots.register({ name: 'main', key: entryIdOf(project.id) }, () => h(Board, { repoId: project.id })),
          )
          reconcile(
            rows,
            rowsSeat,
            (project, index) =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: entryIdOf(project.id),
                  order: PANEL_ORDER + index,
                  // A FUNCTION, not a string: the row's label is data (the repository) inside a
                  // translated sentence, and the shell re-resolves a function label whenever the
                  // locale or the row list changes. A string would freeze the language it was
                  // registered in, which is exactly what the locale namespace exists to avoid.
                  label: () => translate('orchestrator.project.label', { repository: project.repository }),
                },
                PanelIcon,
              ),
            true,
          )
          reconcileConnectRow()
        }

        /**
         * The connect row, registered only once its panel exists.
         *
         * The same rule the project rows follow through `requiresPanel`: `selectPanel` THROWS
         * for a key no one registered, and that throw would land inside the user's click. The
         * connect panel is registered in the `main` inject and the row in the
         * `sidebar.panellist` one, and neither seat can be assumed to be declared first — so
         * the row waits for the panel rather than for a particular seat order.
         *
         * It is NOT part of the `rows` map: reconcile disposes that map wholesale on every
         * poll, and this row's lifetime is the seat's, not a project list's.
         */
        function reconcileConnectRow(): void {
          if (!rowsSeat || !panelsSeat || connectRow !== undefined) return
          connectRow = ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: CONNECT_ID,
              order: CONNECT_ORDER,
              label: () => translate('orchestrator.connect.title'),
            },
            PanelIcon,
          )
        }

        ctx.effect(() => {
          const disposeRows = ctx.slots.inject('sidebar.panellist', () => {
            rowsSeat = true
            reconcileAll()
            return () => {
              rowsSeat = false
              connectRow?.()
              connectRow = undefined
              disposeAll(rows)
            }
          })
          const disposePanels = ctx.slots.inject('main', () => {
            panelsSeat = true
            // The connect panel is registered BEFORE the project panels are reconciled, so the
            // row the user reaches for first can never point at a key that does not exist yet.
            const disposeConnectPanel = ctx.slots.register({ name: 'main', key: CONNECT_ID }, () =>
              h(Connect, { onConnected: () => refreshProjects() }),
            )
            reconcileAll()
            return () => {
              panelsSeat = false
              disposeConnectPanel()
              disposeAll(panels)
            }
          })
          return () => {
            disposeRows()
            disposePanels()
          }
        }, 'dsho: project rows and panels')

        /**
         * Keep the project list current.
         *
         * A failed read leaves the registrations EXACTLY as they were: the entry points are the
         * only way to reach a board, so a host that is restarting must not take them away and
         * put them back. The interval matches the panels' own poll.
         */
        ctx.effect(() => {
          let cancelled = false
          const refresh = () => {
            void readProjects().then((next) => {
              if (cancelled || next === undefined) return
              projects = next
              reconcileAll()
            })
          }
          refresh()
          refreshProjects = refresh
          const timer = setInterval(refresh, POLL_MS)
          return () => {
            cancelled = true
            clearInterval(timer)
            refreshProjects = () => {}
          }
        }, 'dsho: project list')
      },
    }
  },
})
