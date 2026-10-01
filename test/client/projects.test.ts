/**
 * The page's per-project entry points, EXERCISED rather than text-matched.
 *
 * The client half is a classic script, so most of its tests read the source. This file runs it
 * instead: the factory is captured from `window.__ModuleLoader__`, React is a shim, `fetch` is
 * a stub, and `ctx.slots` is a fake that records registrations. That is the technique the
 * verification harness names for this half -- "everything else about the client half can be
 * asserted in Node against a React shim and a fake `ctx.slots`" -- and it is the only way to
 * test the part that matters here: **which entries exist for which project, and when they go
 * away**.
 *
 * What is guarded, concretely:
 *
 *   - one sidebar row AND one main panel per connected project, addressed by the SAME id,
 *     because that identity is what makes a row select its own board;
 *   - every panel scoped to ITS project, which is the whole point of replacing the global row;
 *   - a project that disappears takes its row and its panel with it;
 *   - a failed poll unregisters nothing;
 *   - the ONE global entry — the connect panel — which is present with NOTHING connected,
 *     because it is the surface that makes a first connection possible from the UI at all.
 *
 * Two hazards the fake deliberately models, both of which are silent in the browser:
 *
 *   - the seats are declared LATE, because `ctx.slots.inject` waits for a declaration, and a
 *     row must not be registered before its panel: the shell's `selectPanel` THROWS for a key
 *     no one registered, and that throw would happen inside the user's click;
 *   - the poll is an interval, so the tests drive it with mocked timers rather than waiting.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { readFileSync } from 'node:fs'

import { BOARD_ROUTE_PATH } from '../../src/host/board-route.ts'

const SOURCE = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')

/**
 * Boot counter, used to give each boot its own module URL.
 *
 * The client file registers itself with the module loader as it is EVALUATED, so an import of the
 * same URL twice would hand the second test the cached module and no factory. A query string
 * makes each URL a distinct module.
 */
let boots = 0
function nextBoot(): number {
  boots += 1
  return boots
}

/** One project, as the snapshot carries it. */
interface ProjectFixture {
  id: string
  repository: string
  rootPath: string
}

/** One recorded slot registration. */
interface Registration {
  name: string
  options: Record<string, unknown>
  component: unknown
}

/** `POLL_MS` in the client. Hard-coded here on purpose: a test that reads the interval from
 * the source could never fail, which is exactly the assertion a mocked timer is for. */
const POLL_MS = 5_000

/**
 * The connect entry's id, and the order it claims.
 *
 * Hard-coded for the same reason as `POLL_MS`: a test that read these from the source could
 * never fail. The `projects` id is NOT spelled `orchestrator:<repoId>` on purpose — the
 * connect row belongs to no project, so it must not be able to collide with one.
 */
const CONNECT_ID = 'orchestrator:projects'
const CONNECT_ORDER = 19

/** A React stand-in. `createElement` returns a plain object: nothing renders here. */
const React = {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => ({ type, props, children }),
  useState: <T,>(initial: T) => [initial, () => {}] as [T, (next: T) => void],
  useEffect: () => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
}

/** The fake `ctx` plus the levers a test pulls on it. */
interface Harness {  registrations: Registration[]
  /** The seats are declared (the shell rendered its sidebar / layout). */
  declareAll(): void
  /** Declare ONE seat, for the tests that depend on which lands first. */
  declare(seat: 'main' | 'sidebar.panellist'): void
  /** The project list the next board read will answer with. */
  serve(projects: ProjectFixture[]): void
  /** A poll that fails, as a restarting host answers. */
  fail(): void
  /** Run one poll interval and let it settle. */
  tick(): Promise<void>
  /** Ask for the label one registered row would render. */
  labelOf(id: string): string | undefined
  /**
   * The project each registered BOARD panel is scoped to.
   *
   * Connect panels are excluded: that entry belongs to no project, so it carries no
   * `repoId` and including it would put an `undefined` in the middle of a list whose whole
   * purpose is to prove no panel renders another project's board.
   */
  panelScopes(): string[]
  idsOf(seat: 'sidebar.panellist' | 'main'): string[]
  /**
   * The ids of the PROJECT entries in one seat — the connect entry removed.
   *
   * The distinction is load-bearing. "One row and one panel per project" and "the connect
   * entry exists even with nothing connected" are two invariants, and a helper that merged
   * them would let one be satisfied by breaking the other.
   */
  projectIdsOf(seat: 'sidebar.panellist' | 'main'): string[]
  rows(): number
}

/**
 * Boots the client factory against fakes.
 *
 * `mocks` is the test context, used for its timer mocks — the client's poll is an interval, and
 * a real one would make every assertion here a five-second wait.
 */
async function boot(
  context: TestContext,
  options: { locale?: unknown } = {},
): Promise<Harness> {
  context.mock.timers.enable({ apis: ['setInterval'] })

  const registrations: Registration[] = []
  const injectCallbacks = new Map<string, () => unknown>()
  const collapseDisposers = new Map<string, () => void>()
  let projects: ProjectFixture[] = []
  let failing = false

  const globals = globalThis as unknown as Record<string, unknown>
  /** What the client captures off `window` as it is evaluated. */
  interface LoaderSpec {
    factory: (require: (id: string) => unknown) => unknown
  }
  let captured: LoaderSpec['factory'] | undefined
  globals.window = {
    __ModuleLoader__: {
      load(spec: LoaderSpec) {
        captured = spec.factory
      },
    },
  }
  // Installed BEFORE `apply`, because the client issues its first read as the effect runs.
  globals.fetch = async () => {
    if (failing) throw new Error('host is restarting')
    return { ok: true, json: async () => snapshot(projects) }
  }

  // A fresh module instance per boot: the file registers itself with the loader as it is
  // evaluated, so the cached copy would never hand the second test a factory. The query string
  // is what makes each URL a distinct module here.
  await import(`../../src/client/index.ts?boot=${nextBoot()}`)
  assert.ok(captured, 'the module loader captured the factory')
  const plugin = captured((id: string) => {
    assert.equal(id, 'react', 'React is the only thing this half requires')
    return React
  }) as { apply(ctx: unknown): void }

  const ctx = {
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    slots: {
      inject: (seat: string, callback: () => unknown) => {
        injectCallbacks.set(seat, callback)
        return () => {}
      },
      register: (options2: Record<string, unknown>, component: unknown) => {
        const entry: Registration = { name: String(options2.name), options: options2, component }
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    effect: (callback: () => (() => void) | void) => {
      callback()
      return () => {}
    },
  }
  plugin.apply(ctx)

  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }
  await settle()

  const declare = (seat: string) => {
    // A re-declaration first tears the previous contribution down, which is what the real
    // `inject` does on a declaration epoch change.
    collapseDisposers.get(seat)?.()
    const callback = injectCallbacks.get(seat)
    assert.ok(callback, `${seat} was injected`)
    const disposer = callback!()
    if (typeof disposer === 'function') collapseDisposers.set(seat, () => disposer())
  }

  return {
    registrations,
    declare,
    declareAll: () => {
      declare('main')
      declare('sidebar.panellist')
    },
    serve: (next) => {
      projects = next
    },
    fail: () => {
      failing = true
    },
    tick: async () => {
      context.mock.timers.tick(POLL_MS)
      await settle()
    },
    labelOf: (id) => {
      const entry = registrations.find((candidate) => candidate.options.id === id)
      const label = entry?.options.label
      return typeof label === 'function' ? (label as () => string)() : (label as string | undefined)
    },
    panelScopes: () =>
      registrations
        .filter((entry) => entry.name === 'main')
        .map((entry) => ((entry.component as () => { props?: { repoId?: string } })()?.props ?? {}).repoId)
        .filter((repoId): repoId is string => typeof repoId === 'string'),
    idsOf: (seat) =>
      registrations
        .filter((entry) => entry.name === seat)
        .map((entry) => String(entry.options.id ?? entry.options.key ?? '')),
    projectIdsOf: (seat) =>
      registrations
        .filter((entry) => entry.name === seat)
        .map((entry) => String(entry.options.id ?? entry.options.key ?? ''))
        .filter((id) => id !== CONNECT_ID),
    rows: () =>
      registrations.filter((entry) => entry.name === 'sidebar.panellist' && entry.options.id !== CONNECT_ID)
        .length,
  }
}

/** One board snapshot carrying the given projects. */
function snapshot(projects: ProjectFixture[]): unknown {
  return {
    generatedAt: 0,
    lenses: { lanes: {}, archive: [] },
    counts: { total: 0, needsAttention: 0, byLane: {} },
    projects: projects.map((project) => ({ ...project, defaultBranchDetected: true })),
  }
}

const WIDGETS: ProjectFixture = { id: 'repo-1', repository: 'acme/widgets', rootPath: '/code/widgets' }
const GADGETS: ProjectFixture = { id: 'repo-2', repository: 'acme/gadgets', rootPath: '/code/gadgets' }

test('the client asks for the board path the host declares', () => {
  // A typo here is a panel that shows its error state for the life of the install.
  assert.equal(/const BOARD_PATH = '([^']+)'/.exec(SOURCE)?.[1], BOARD_ROUTE_PATH)
})

test('the scoped read names the project with the parameter the host reads', () => {
  // Both halves spell the parameter, and the host parses it with the settings route's reader.
  // A rename on one side alone would silently serve the WHOLE install to every project panel.
  assert.match(SOURCE, /\?repoId=\$\{encodeURIComponent\(repoId\)\}/, 'the client builds the scoped URL')
  const route = readFileSync(new URL('../../src/host/board-route.ts', import.meta.url), 'utf8')
  assert.match(route, /repoIdFromUrl\(/, 'the host reuses the settings route reader')
  assert.match(readFileSync(new URL('../../src/host/settings-route.ts', import.meta.url), 'utf8'), /key === 'repoId'/)
})

test('one row and one panel per project, addressed by the same id, each panel scoped to its project', async (t) => {
  const harness = await boot(t)
  harness.serve([WIDGETS, GADGETS])
  harness.declareAll()
  await harness.tick()

  const panels = harness.projectIdsOf('main')
  assert.deepEqual(panels, ['orchestrator:repo-1', 'orchestrator:repo-2'])
  assert.deepEqual(
    harness.projectIdsOf('sidebar.panellist'),
    panels,
    'the row id IS the panel key: that identity is what selects this project own board',
  )
  assert.deepEqual(harness.panelScopes(), ['repo-1', 'repo-2'], 'no panel renders another project board')
})

test('the rows keep the host order and are named for their own project', async (t) => {
  const harness = await boot(t)
  harness.serve([GADGETS, WIDGETS])
  harness.declareAll()
  await harness.tick()

  const rows = harness.registrations.filter(
    (entry) => entry.name === 'sidebar.panellist' && entry.options.id !== CONNECT_ID,
  )
  assert.deepEqual(harness.projectIdsOf('sidebar.panellist'), ['orchestrator:repo-2', 'orchestrator:repo-1'])
  const orders = rows.map((entry) => entry.options.order as number)
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right), 'the payload order is the display order')
  assert.equal(harness.labelOf('orchestrator:repo-1'), 'Orchestrator: acme/widgets')
  assert.equal(harness.labelOf('orchestrator:repo-2'), 'Orchestrator: acme/gadgets')
})

test('the label is translated, and a locale change is picked up without re-registering', async (t) => {
  // The label goes through a FUNCTION label so the shell re-resolves it. A frozen string would
  // keep the language it was registered in, which is the failure the locale namespace exists to
  // prevent -- and it would pass every other test in this file.
  let language = 'en'
  const harness = await boot(t, {
    locale: {
      t: (key: string, params?: Record<string, string>) =>
        key === 'orchestrator.project.label'
          ? `${language === 'zh' ? '编排器：' : 'Orchestrator: '}${params?.repository ?? ''}`
          : undefined,
    },
  })
  harness.serve([WIDGETS])
  harness.declareAll()
  await harness.tick()

  assert.equal(harness.labelOf('orchestrator:repo-1'), 'Orchestrator: acme/widgets')
  language = 'zh'
  assert.equal(harness.labelOf('orchestrator:repo-1'), '编排器：acme/widgets')
})

test('a disconnected project takes its row and its panel with it', async (t) => {
  const harness = await boot(t)
  harness.serve([WIDGETS, GADGETS])
  harness.declareAll()
  await harness.tick()
  assert.equal(harness.rows(), 2)

  harness.serve([GADGETS])
  await harness.tick()

  assert.deepEqual(harness.projectIdsOf('main'), ['orchestrator:repo-2'])
  assert.deepEqual(harness.projectIdsOf('sidebar.panellist'), ['orchestrator:repo-2'])
})

test('a failed poll unregisters nothing, because these rows are the only route to a board', async (t) => {
  const harness = await boot(t)
  harness.serve([WIDGETS])
  harness.declareAll()
  await harness.tick()
  assert.equal(harness.rows(), 1)

  harness.fail()
  await harness.tick()

  assert.deepEqual(harness.idsOf('main'), ['orchestrator:projects', 'orchestrator:repo-1'], 'a restarting host does not take the entry points away')
  assert.deepEqual(harness.projectIdsOf('sidebar.panellist'), ['orchestrator:repo-1'])
})

test('a project that gains a row later is ordered after the existing one', async (t) => {
  const harness = await boot(t)
  harness.serve([WIDGETS])
  harness.declareAll()
  await harness.tick()

  harness.serve([WIDGETS, GADGETS])
  await harness.tick()

  assert.deepEqual(harness.projectIdsOf('sidebar.panellist'), ['orchestrator:repo-1', 'orchestrator:repo-2'])
  const rows = harness.registrations.filter(
    (entry) => entry.name === 'sidebar.panellist' && entry.options.id !== CONNECT_ID,
  )
  assert.deepEqual(
    rows.map((entry) => entry.options.order),
    [20, 21],
    'the first project keeps its position rather than being re-registered below the new one',
  )
})

/**
 * The connect entry, which is the reason a FIRST connection is possible at all.
 *
 * Every test above starts from a served project list. That is precisely the state an install
 * does NOT have on its first run: the rows are built from the host's CONNECTED projects, so
 * with nothing connected there was nothing to click and therefore no way to connect. These
 * tests serve an empty list and assert the entry is still there.
 */
test('the connect entry exists with nothing connected, in both seats, under the same id', async (t) => {
  const harness = await boot(t)
  harness.serve([])
  harness.declareAll()
  await harness.tick()

  assert.equal(harness.rows(), 0, 'no project is connected')
  assert.deepEqual(harness.idsOf('sidebar.panellist'), [CONNECT_ID], 'the row survives an empty install')
  assert.deepEqual(harness.idsOf('main'), [CONNECT_ID], 'and its panel is registered under the same id')
})

test('the connect row leads every project row and keeps its order as projects arrive', async (t) => {
  const harness = await boot(t)
  harness.serve([])
  harness.declareAll()
  await harness.tick()

  harness.serve([WIDGETS, GADGETS])
  await harness.tick()

  const rows = harness.registrations.filter((entry) => entry.name === 'sidebar.panellist')
  const connect = rows.find((entry) => entry.options.id === CONNECT_ID)
  assert.ok(connect, 'the connect row is still registered once projects exist')
  assert.equal(connect.options.order, CONNECT_ORDER)
  for (const row of rows) {
    if (row.options.id === CONNECT_ID) continue
    assert.ok(
      (row.options.order as number) > CONNECT_ORDER,
      'a project row never outranks the entry point that creates it',
    )
  }
})

test('the connect row waits for its panel rather than for a seat order', async (t) => {
  // The hazard the fake models deliberately: `selectPanel` THROWS for a key no one
  // registered, and that throw would land inside the user's click. The two seats are
  // declared independently, so the row must not land before its panel exists.
  const harness = await boot(t)
  harness.serve([])
  harness.declare('sidebar.panellist')
  await harness.tick()

  assert.deepEqual(harness.idsOf('sidebar.panellist'), [], 'no row before its panel exists')

  harness.declare('main')
  await harness.tick()

  assert.deepEqual(harness.idsOf('sidebar.panellist'), [CONNECT_ID], 'the row lands once its panel does')
})
