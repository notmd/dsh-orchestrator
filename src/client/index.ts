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
const LANES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'building', label: 'Building' },
  { key: 'validating', label: 'Validating' },
  { key: 'needs_review', label: 'In review' },
  { key: 'ready', label: 'Ready' },
]

/** The endpoint this panel reads. The client's only coupling to the host. */
const BOARD_PATH = '/dsho/api/board'

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
    const S = {
      panel: {
        padding: 'var(--dsh-frame-top-clearance, 48px) 24px 24px',
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-text, inherit)',
        overflow: 'auto',
        height: '100%',
      },
      title: { fontSize: '1.125rem', fontWeight: 600, margin: 0 },
      meta: { margin: '4px 0 16px', opacity: 0.7, fontSize: '0.8125rem' },
      note: { opacity: 0.75 },
      errorNote: { color: 'var(--dsw-alias-status-danger, inherit)', opacity: 1, fontWeight: 500 },
      lanes: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' },
      lane: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
      laneTitle: { fontSize: '0.8125rem', fontWeight: 600, margin: 0, opacity: 0.8 },
      laneCount: { opacity: 0.6, fontWeight: 400 },
      laneEmpty: { margin: 0, opacity: 0.45, fontSize: '0.8125rem' },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
      card: { border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px' },
      cardAttention: { border: '2px solid var(--dsw-alias-status-danger, #d05)' },
      cardFinished: { opacity: 0.6 },
      cardHead: { display: 'flex', alignItems: 'center', gap: '6px' },
      cardStatus: { fontSize: '0.75rem', fontWeight: 600 },
      spinner: { width: '8px', height: '8px', borderRadius: '50%', background: 'currentColor', opacity: 0.5 },
      cardTitle: { fontSize: '0.8125rem' },
      cardReason: { fontSize: '0.75rem', opacity: 0.75 },
      archive: { marginTop: '16px', fontSize: '0.8125rem', opacity: 0.6 },
      // The card body is a BUTTON, not a div with an onClick: that is what makes it
      // keyboard reachable and announces itself, and it costs nothing. Reset to look
      // like the card it was.
      cardButton: {
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        font: 'inherit', color: 'inherit', background: 'transparent',
      },
      tabular: { fontSize: '0.75rem', opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
      inspector: {
        marginTop: '16px', padding: '12px 14px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))',
        maxWidth: '46rem',
      },
      inspectorHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      finding: { marginBottom: '8px', fontSize: '0.8125rem' },
      findingWhere: { fontVariantNumeric: 'tabular-nums', opacity: 0.75 },
    } as const

    /** What the panel is currently showing. */
    type View =
      | { kind: 'loading' }
      | { kind: 'ready'; board: BoardSnapshot }
      | { kind: 'error'; message: string }

    /**
     * Reads the board once, uncached.
     *
     * Errors are returned rather than thrown: a throw inside an effect would leave
     * the panel on `loading` forever, which looks exactly like a hung host.
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

    function Card(props: { card: CardView; onOpen: (id: string) => void }) {
      const card = props.card
      const style = {
        ...S.card,
        ...S.cardButton,
        ...(card.needsAttention ? S.cardAttention : {}),
        ...(card.isFinished ? S.cardFinished : {}),
      }
      const review = card.review
      return h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            style,
            'data-worker': card.id,
            'data-column': card.column,
            'aria-label': `Details for ${card.title}`,
            onClick: () => props.onOpen(card.id),
          },
          h(
            'span',
            { style: S.cardHead },
            // Never convey state by colour alone: the phrase IS the state, and the
            // border only reinforces it.
            h('span', { style: S.cardStatus }, card.displayStatus),
            card.showStatusLoader ? h('span', { style: S.spinner, 'aria-hidden': 'true' }) : null,
          ),
          h('span', { style: S.cardTitle }, card.title),
          // The round is on the card face while the loop runs, so the BOUND is visible
          // rather than arriving as a surprise when it trips.
          review && review.verdict !== 'approved'
            ? h('span', { style: S.tabular }, `auto review round ${review.round}/${review.maxRounds}`)
            : null,
          card.escalationReason
            ? h('span', { style: S.cardReason }, `automation stopped: ${card.escalationReason}`)
            : null,
        ),
      )
    }

    /**
     * The card detail view (PRD §11.2).
     *
     * Its reason is in the PRD rather than in aesthetics: "the reviewer's findings are
     * reachable from the card -- one click to the latest `ReviewRun`, with severity,
     * file, and line per finding. **A machine review the user cannot inspect is a
     * machine review the user cannot trust.**"
     */
    function Inspector(props: { card: CardView; onClose: () => void }) {
      const card = props.card
      const review = card.review
      const findings = review?.findings ?? []
      return h(
        'aside',
        { style: S.inspector, 'aria-label': `Details for ${card.title}` },
        h(
          'div',
          { style: S.inspectorHead },
          h('strong', null, card.title),
          h('span', { style: S.tabular }, card.displayStatus),
        ),
        h(
          'p',
          { style: S.tabular },
          review
            ? `auto review round ${review.round}/${review.maxRounds}` +
              (review.verdict ? ` \u00b7 ${review.verdict}` : '') +
              (review.githubReviewId ? ` \u00b7 review ${review.githubReviewId}` : '')
            : 'No automated review has run at this commit.',
        ),
        findings.length === 0
          ? h('p', { style: S.note }, 'No findings recorded for this commit.')
          : h(
              'ul',
              { style: S.list },
              ...findings.map((finding, index) =>
                h(
                  'li',
                  { key: `${finding.path ?? ''}:${finding.line ?? index}`, style: S.finding },
                  h(
                    'span',
                    { style: S.findingWhere },
                    `${finding.severity}${finding.path ? ` \u00b7 ${finding.path}${finding.line ? `:${finding.line}` : ''}` : ''}`,
                  ),
                  ` \u2014 ${finding.summary}: ${finding.detail}`,
                ),
              ),
            ),
        h('button', { type: 'button', onClick: props.onClose }, 'Close'),
      )
    }

    function Lane(props: { lane: { key: string; label: string }; cards: CardView[]; onOpen: (id: string) => void }) {
      return h(
        'section',
        { style: S.lane, 'data-lane': props.lane.key, 'aria-label': props.lane.label },
        h(
          'h3',
          { style: S.laneTitle },
          props.lane.label,
          h('span', { style: S.laneCount }, ` ${props.cards.length}`),
        ),
        props.cards.length === 0
          ? h('p', { style: S.laneEmpty }, 'Nothing here.')
          : h(
              'ul',
              { style: S.list },
              ...props.cards.map((card) => h(Card, { key: card.id, card, onOpen: props.onOpen })),
            ),
      )
    }

    function Board() {
      const [view, setView] = React.useState<View>({ kind: 'loading' })
      const [openId, setOpenId] = React.useState<string | undefined>(undefined)

      // Escape closes the inspector. A detail view that can only be dismissed by
      // finding the close button is not keyboard reachable in practice.
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

      const header = h(
        'header',
        { className: 'dsho-header' },
        h('h2', { style: S.title }, 'Orchestrator'),
        view.kind === 'ready'
          ? h(
              'p',
              { style: S.meta },
              `${view.board.counts.total} worker(s)`,
              view.board.counts.needsAttention > 0 ? ` · ${view.board.counts.needsAttention} needing attention` : '',
            )
          : null,
      )

      if (view.kind === 'loading') {
        return h('div', { style: S.panel }, header, h('p', { style: S.note }, 'Loading the board\u2026'))
      }
      if (view.kind === 'error') {
        // A real state, not a blank panel: "the plugin is broken" and "there are no
        // workers" must not look the same.
        return h(
          'div',
          { style: S.panel },
          header,
          h('p', { style: S.errorNote, role: 'status' }, `The board is unavailable: ${view.message}`),
        )
      }

      const board = view.board
      return h(
        'div',
        { style: S.panel },
        header,
        board.counts.total === 0
          ? h('p', { style: S.note }, 'No workers yet. Create an issue in a session to start one.')
          : h(
              'div',
              { style: S.lanes },
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
          ? h(
              'p',
              { style: S.archive },
              `${board.lenses.archive.length} archived session(s) — not a lane.`,
            )
          : null,
      )
    }

    /** The sidebar navigation row. */
    function PanelIcon(props: { size?: number; active?: boolean }) {
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: { fontSize: `${props.size ?? 16}px`, lineHeight: 1, display: 'block', textAlign: 'center' },
        },
        '▦',
      )
    }

    return {
      // `slots` is the only thing this half needs; the endpoint needs no service.
      inject: ['slots'],
      apply(ctx: {
        slots: {
          inject: (owner: string, callback: () => unknown) => () => void
          register: (options: Record<string, unknown>, component: unknown) => () => void
        }
        effect: (callback: () => (() => void) | void, label?: string) => () => void
      }) {
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
