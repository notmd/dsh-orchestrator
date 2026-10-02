/**
 * The plugin's settings page, EXERCISED.
 *
 * The page is the first surface this plugin puts in a slot it does not own: the sidebar's
 * Plugins page declares `plugins.bundle.config`, and a keyed slot renders nothing unless an
 * entry registers under the exact key the page dispatches by. Every failure here is silent —
 * a page that never appears, a form bound to a namespace nobody serves, a save that writes
 * the wrong field — so the file both pins the contract against the sources and runs the page
 * against fakes.
 *
 * Two techniques, matching the rest of the suite:
 *
 *   - **source parity** for the parts that cannot be imported. The client is a classic script
 *     (`module: none`), so its field table and its two identifiers are read out of the source
 *     and compared with the host's schema — the same guard `settings.test.ts` uses on the
 *     payload mirrors.
 *   - **a real hook runtime** for the form. A React shim that ignores `useState` can only
 *     assert that a component was constructed; staging, validation, the fenced write and the
 *     refusal path are all state transitions, so this file runs them: one component, hooks in
 *     call order, re-render on `setState`, effects on deps.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { readFileSync } from 'node:fs'

import { Config, CONFIG_ENTRY_ID, volatileFields } from '../../src/config/schema.ts'
import { PLUGIN_DEFAULTS } from '../../src/config/validate.ts'

const SOURCE = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
const MANIFEST = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string
}

/** One recorded slot registration. */
interface Registration {
  name: string
  options: Record<string, unknown>
  component: unknown
}

/** Boot counter: each boot needs its own module URL, or the loader's cached factory is reused. */
let boots = 0

/** The page's own rows, read out of the source the way the component table declares them. */
function clientFields(): Array<{ field: string; kind: string }> {
  const start = SOURCE.indexOf('const CONFIG_SECTIONS: readonly ConfigSectionView[] = [')
  assert.ok(start > 0, 'the page declares its field table')
  const table = SOURCE.slice(start, SOURCE.indexOf('\n]', start))
  const fields = [...table.matchAll(/\{ field: '([^']+)', kind: '([a-z]+)'/g)].map(([, field, kind]) => ({
    field: field!,
    kind: kind!,
  }))
  assert.ok(fields.length > 10, `parsed ${fields.length} rows`)
  return fields
}

test('the page edits exactly the fields the host allows it to, with the right editor', () => {
  // The host serves a namespace's VOLATILE fields only. A row for anything else would be a
  // control whose write the settings service refuses; a missing row is a setting a person can
  // no longer reach. The editor kind is checked too, because nothing else would notice a
  // boolean being rendered as a text field.
  const expectedKinds: Record<string, string> = { boolean: 'boolean', number: 'number', string: 'text' }
  const dict = (Config as unknown as { dict: Record<string, { type?: string }> }).dict

  const client = clientFields()
  assert.deepEqual(
    client.map((row) => row.field).sort(),
    volatileFields().sort(),
    'the page and the schema edit the same set',
  )
  for (const row of client) {
    assert.equal(row.kind, expectedKinds[dict[row.field]?.type ?? ''], `${row.field} editor kind`)
  }
})

test('the identifiers agree with the host and with the manifest', () => {
  // Three strings that must not drift, each with its own failure: the entry id is the settings
  // NAMESPACE, the key is the BUNDLE the page dispatches by, and both are invisible when wrong.
  const entry = /const CONFIG_ENTRY_ID = '([^']+)'/.exec(SOURCE)?.[1]
  assert.equal(entry, CONFIG_ENTRY_ID, 'the namespace is the entry id')

  const key = /const PLUGIN_PACKAGE_ID = '([^']+)'/.exec(SOURCE)?.[1]
  assert.equal(key, MANIFEST.name, 'the slot key is the package name the page dispatches by')

  const slot = /const BUNDLE_CONFIG_SLOT = '([^']+)'/.exec(SOURCE)?.[1]
  assert.equal(slot, 'plugins.bundle.config', 'the bundle-config slot the Plugins page declares')
})

/** One rendered element, as the shim builds it. */
interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** Every element in a tree, flattened. Function components are NOT invoked -- their props are
 * what these tests assert on, and calling them would need their own hook frames. */
function elements(tree: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(tree)) {
    for (const child of tree) elements(child, out)
    return out
  }
  if (tree === null || typeof tree !== 'object') return out
  const node = tree as Element
  if (node.type !== undefined && 'props' in node) out.push(node)
  if (node.children !== undefined) elements(node.children, out)
  return out
}

/** The elements whose element type has this name: a DOM tag, or a component function. */
function byName(tree: unknown, name: string): Element[] {
  return elements(tree).filter((element) =>
    typeof element.type === 'string' ? element.type === name : (element.type as { name?: string }).name === name,
  )
}

/** The one element matching a predicate, asserted to be the only one. */
function only(tree: unknown, predicate: (element: Element) => boolean, what: string): Element {
  const matches = elements(tree).filter(predicate)
  assert.equal(matches.length, 1, `exactly one ${what}`)
  return matches[0]!
}

/** A hook runtime: enough React for one component with state, effects and refs. */
function runtime() {
  interface Hook {
    value?: unknown
    deps?: unknown[]
    cleanup?: (() => void) | void
  }
  const hooks: Hook[] = []
  let cursor = 0
  let props: Record<string, unknown> = {}
  let component: ((props: never) => unknown) | undefined
  let tree: unknown

  const sameDeps = (left?: unknown[], right?: unknown[]): boolean =>
    left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const render = (): void => {
    cursor = 0
    tree = component!(props as never)
  }

  const React = {
    createElement: (type: unknown, elementProps?: unknown, ...children: unknown[]): Element => ({
      type,
      props: (elementProps ?? {}) as Record<string, unknown>,
      children,
    }),
    useState: <T,>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] => {
      const index = cursor++
      const hook = (hooks[index] ??= {})
      if (!('value' in hook)) hook.value = typeof initial === 'function' ? (initial as () => T)() : initial
      return [
        hook.value as T,
        (next) => {
          hook.value = typeof next === 'function' ? (next as (previous: T) => T)(hook.value as T) : next
          render()
        },
      ]
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]): void => {
      const index = cursor++
      const hook = (hooks[index] ??= {})
      if (deps === undefined && 'deps' in hook) return
      if (deps !== undefined && sameDeps(hook.deps, deps)) return
      hook.cleanup = effect()
      hook.deps = deps
    },
    useRef: <T,>(initial: T): { current: T } => {
      const index = cursor++
      const hook = (hooks[index] ??= {})
      if (!('value' in hook)) hook.value = { current: initial }
      return hook.value as { current: T }
    },
  }

  return {
    React,
    mount(next: (props: never) => unknown, initialProps: Record<string, unknown>): void {
      component = next
      props = initialProps
      render()
    },
    get tree(): unknown {
      return tree
    },
    /** Re-render after a state change made outside an event (a fake's own notification). */
    refresh: render,
  }
}

/** What the fake settings service records. */
interface FormHarness {
  form: Record<string, unknown>
  writes: Array<{ operations: ReadonlyArray<Record<string, unknown>>; revision: number | undefined }>
  /** Serve each staged field's write with this answer. */
  accept(next: boolean): void
  /** Replace the served values, as another editor's write would. */
  serve(values: Record<string, unknown>, overrides?: Record<string, unknown>): void
  listeners(): number
}

/** A stand-in for the settings service's shared configuration form. */
function fakeForm(): FormHarness {
  let values: Record<string, unknown> = { ...PLUGIN_DEFAULTS }
  let overrides: Record<string, unknown> = {}
  let revision = 5
  let accepted = true
  const listeners = new Set<() => void>()
  const writes: FormHarness['writes'] = []
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  return {
    writes,
    accept: (next) => {
      accepted = next
    },
    serve: (next, nextOverrides = {}) => {
      values = next
      overrides = nextOverrides
      notify()
    },
    listeners: () => listeners.size,
    form: {
      getSnapshot: () => ({ status: 'ready', writable: true, revision, value: values, base: { ...PLUGIN_DEFAULTS }, user: overrides }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: async (field: string, value: unknown) => {
        values = { ...values, [field]: value }
        return true
      },
      unset: async (field: string) => {
        values = { ...values, [field]: (PLUGIN_DEFAULTS as Record<string, unknown>)[field] }
        return true
      },
      mutate: async (operations: ReadonlyArray<Record<string, unknown>>, expected: number | undefined) => {
        writes.push({ operations, revision: expected })
        if (!accepted) return false
        // Fold the write in the way the service does, so "the host is the only source of what
        // is displayed" is actually exercised rather than assumed.
        for (const operation of operations) {
          const field = String((operation.path as string[])[0])
          if (operation.op === 'unset') values = { ...values, [field]: (PLUGIN_DEFAULTS as Record<string, unknown>)[field] }
          else values = { ...values, [field]: operation.value }
        }
        overrides = { ...overrides, ...Object.fromEntries(operations.map((operation) => [String((operation.path as string[])[0]), true])) }
        revision += 1
        notify()
        return true
      },
    },
  }
}

/** What one boot of the client half produces. */
interface Harness {
  /** Fire the `whileServed` watch, as the settings mirror does once the namespace is served. */
  serveNamespace(): boolean
  /** Declare the Plugins page's slot, as its own panel does. False when the client has not
   * asked for it yet -- which is itself a state the page has to tolerate. */
  declareSlot(): boolean
  registrations: Registration[]
  forms: ConfigFormsFake
  /** Every `ctx.inject` the client made, as the service names it asked for. */
  injected: string[][]
  /**
   * The hook runtime this boot handed the client as React.
   *
   * The page has to be mounted into THIS one, not a fresh one: the state setters the component
   * captures close over the runtime that created them, so a second runtime would re-render
   * nothing when a test dispatches an event.
   */
  rt: ReturnType<typeof runtime>
}

interface ConfigFormsFake {
  get(entryId: string): unknown
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
  /** Whether the client ever asked for a form at all. */
  asked: string[]
}

/**
 * Boot the captured factory against a fake context.
 *
 * The two seats the client uses are declared only when a test asks for them, because "the
 * page is registered before its slot exists" is one of the failures being guarded.
 */
async function boot(context: TestContext, options: { withConfigForms: boolean; form?: FormHarness }): Promise<Harness> {
  boots += 1
  // The client polls the project list on an interval, and an interval that is never cleared
  // keeps the process alive: an unmocked timer here means this file never finishes. The
  // timeout is mocked with it so a staged save's "Saved" receipt does not either.
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const registrations: Registration[] = []
  const seatCallbacks = new Map<string, () => unknown>()
  const collapse = new Map<string, () => void>()
  const asked: string[] = []
  const servedRegister: Array<(served: ReadonlySet<string>) => () => void> = []
  const harness = {} as Harness

  const forms: ConfigFormsFake = {
    asked,
    get: (entryId: string) => {
      asked.push(entryId)
      return options.form?.form ?? fakeForm().form
    },
    whileServed: (namespaces, register) => {
      assert.deepEqual([...namespaces], [CONFIG_ENTRY_ID], 'the page follows its own namespace')
      servedRegister.push(register)
      return () => {}
    },
  }

  const globals = globalThis as unknown as Record<string, unknown>
  let captured: ((require: (id: string) => unknown) => unknown) | undefined
  globals.window = {
    __ModuleLoader__: {
      load(spec: { factory: (require: (id: string) => unknown) => unknown }) {
        captured = spec.factory
      },
    },
  }
  globals.fetch = async () => ({ ok: true, json: async () => ({ generatedAt: 0, lenses: { lanes: {}, archive: [] }, counts: { total: 0, needsAttention: 0, byLane: {} }, projects: [] }) })

  await import(`../../src/client/index.ts?config=${boots}`)
  assert.ok(captured, 'the module loader captured the factory')

  // The hook runtime is shared with the page under test: the client takes React from the
  // module table, which is exactly how the browser hands it the real one.
  const runtimeInstance = runtime()
  const plugin = captured!((id: string) => {
    assert.equal(id, 'react', 'React is the only thing this half requires')
    return runtimeInstance.React
  }) as { apply(ctx: unknown): unknown }

  /** The child scope `ctx.inject` hands the settings page's plugin. */
  const scoped: Record<string, unknown> = {
    slots: undefined,
    effect: (callback: () => (() => void) | void) => {
      callback()
      return () => {}
    },
  }

  const slots = {
    inject: (seat: string, callback: () => unknown) => {
      seatCallbacks.set(seat, callback)
      return () => {}
    },
    register: (registration: Record<string, unknown>, component: unknown) => {
      const entry: Registration = { name: String(registration.name), options: registration, component }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }
  scoped.slots = slots
  // Where the service lives: the child scope, not the parent. Reading it on the parent is what
  // Cordis refuses -- the failure this harness now models by simply not putting it there.
  scoped.configForms = forms

  const injected: string[][] = []
  const ctx: Record<string, unknown> = {
    slots,
    effect: (callback: () => (() => void) | void) => {
      callback()
      return () => {}
    },
    inject: (services: string[], callback: (child: unknown) => void) => {
      injected.push([...services])
      // The settings service is only reachable inside the child scope the registry starts, so
      // an absent service is a child that never starts -- not a failed read.
      if (options.withConfigForms) callback(scoped)
    },
  }
  plugin.apply(ctx)

  const declare = (seat: string): boolean => {
    collapse.get(seat)?.()
    const callback = seatCallbacks.get(seat)
    if (callback === undefined) return false
    const disposer = callback()
    if (typeof disposer === 'function') collapse.set(seat, () => disposer())
    return true
  }

  return Object.assign(harness, {
    registrations,
    forms,
    injected,
    rt: runtimeInstance,
    serveNamespace: () => {
      for (const register of servedRegister) {
        const disposer = register(new Set([CONFIG_ENTRY_ID]))
        collapse.set('namespace', () => disposer())
      }
      return servedRegister.length > 0
    },
    declareSlot: () => declare('plugins.bundle.config'),
  })
}

/** The page's component, mounted with the form the registration injected. */
function mountPage(harness: Harness): { rt: ReturnType<typeof runtime>; entry: Registration } {
  const entry = harness.registrations.find((candidate) => candidate.name === 'plugins.bundle.config')
  assert.ok(entry, 'the page is registered')
  const inject = entry.options.inject as () => Record<string, unknown>
  harness.rt.mount(entry.component as (props: never) => unknown, inject())
  return { rt: harness.rt, entry }
}

const SAVE = (tree: unknown): Element => only(tree, (element) => element.props?.className === 'dsho-btn dsho-btn--primary', 'Save button')
const DISCARD = (tree: unknown): Element[] => elements(tree).filter((element) => element.props?.className === 'dsho-btn dsho-btn--quiet')
const ROW_NAMES = (tree: unknown): string[] => byName(tree, 'SettingsRow').map((row) => String(row.props.label))

test('nothing is registered when the deployment has no settings service', async (t) => {
  // The service is read through a guard and NOT declared in `inject`, because declaring an
  // absent service makes the whole client entry fail to activate -- which would take the board
  // panels down with it. A deployment without the Web settings UI keeps everything else.
  const harness = await boot(t, { withConfigForms: false })
  // The child scope that reaches the settings service never starts, which is how the page stays
  // absent without taking the rest of the client half with it.
  assert.deepEqual(harness.injected, [['configForms']], 'the child scope was asked for')
  assert.equal(harness.serveNamespace(), false, 'nothing follows a service that is not there')
  assert.equal(harness.declareSlot(), false, 'and no slot is asked for')
  assert.deepEqual(harness.registrations, [])
  assert.deepEqual(harness.forms.asked, [], 'and no form is asked for')
})

test('the page waits for the namespace AND the slot, then registers under the bundle key', async (t) => {
  const harness = await boot(t, { withConfigForms: true })
  assert.deepEqual(harness.injected, [['configForms']], 'the settings service is reached through a child scope')
  // Neither condition alone is enough: the slot is the Plugins page's declaration, and the
  // namespace is proof the host half is loaded WITH the schema that makes it configurable.
  assert.equal(harness.declareSlot(), false, 'the slot is not even asked for before the namespace is served')
  assert.deepEqual(harness.registrations, [], 'no served namespace, no page')
  assert.equal(harness.serveNamespace(), true, 'the namespace is served, so the slot is watched')
  assert.deepEqual(harness.registrations, [], 'no slot declaration, no page')

  assert.equal(harness.declareSlot(), true)
  const page = harness.registrations.filter((candidate) => candidate.name === 'plugins.bundle.config')
  assert.equal(page.length, 1, 'one entry in the keyed slot')
  assert.equal(page[0]!.options.key, MANIFEST.name, 'keyed by the bundle package name')
  assert.deepEqual(harness.forms.asked, [CONFIG_ENTRY_ID], 'and bound to the entry id')
})

test('the form renders one row per field, from the host values', async (t) => {
  const form = fakeForm()
  const harness = await boot(t, { withConfigForms: true, form })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  const labels = ROW_NAMES(rt.tree)
  assert.ok(labels.length >= 20, `rendered ${labels.length} rows`)
  // The switches and the editors carry the row's own label, so every control has an
  // accessible name without a second table of them.
  const switches = byName(rt.tree, 'Switch')
  const editors = byName(rt.tree, 'InlineEdit')
  assert.equal(switches.length + editors.length, labels.length, 'one editor per row')
  assert.ok(switches.length > 0 && editors.length > 0)
  for (const element of [...switches, ...editors]) assert.equal(typeof element.props.label, 'string')

  // The subscription is what keeps the page honest: the values it shows come from the host,
  // so a write elsewhere must appear here without a reload.
  assert.equal(form.listeners(), 1, 'the page subscribed to the shared form')
  form.serve({ ...PLUGIN_DEFAULTS, maxConcurrentWorkers: 9 })
  rt.refresh()
  const worker = byName(rt.tree, 'InlineEdit').find((element) => element.props.label === 'Concurrent workers')
  assert.equal(worker?.props.value, '9')

  assert.equal(SAVE(rt.tree).props.disabled, true, 'and nothing to save until something is staged')
})

test('a staged edit is one atomic write, fenced at the revision the draft started from', async (t) => {
  const form = fakeForm()
  const harness = await boot(t, { withConfigForms: true, form })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  const switchFor = (label: string): Element =>
    byName(rt.tree, 'Switch').find((element) => element.props.label === label)!
  const editorFor = (label: string): Element =>
    byName(rt.tree, 'InlineEdit').find((element) => element.props.label === label)!

  // Two edits, of two different kinds.
  ;(switchFor('Auto review pull requests').props.onChange as (next: boolean) => void)(false)
  ;(editorFor('Concurrent workers').props.onCommit as (next: string) => void)('6')
  rt.refresh()

  assert.deepEqual(form.writes, [], 'staging writes nothing')
  assert.equal(SAVE(rt.tree).props.disabled, false, 'and arms Save')
  assert.equal(DISCARD(rt.tree).length, 1, 'with a way to throw the draft away')

  ;(SAVE(rt.tree).props.onClick as () => void)()
  await Promise.resolve().then(() => Promise.resolve())

  assert.equal(form.writes.length, 1, 'ONE write for the whole draft, not one per field')
  assert.equal(form.writes[0]!.revision, 5, 'fenced at the revision the draft started from')
  assert.deepEqual(form.writes[0]!.operations, [
    { op: 'set', path: ['autoReview'], value: false },
    // A NUMBER, not the string the editor handed back. Measured live: sending "6" is refused by
    // the host's schema (`expected number but got 6`), so the coercion is part of the contract
    // rather than an implementation detail.
    { op: 'set', path: ['maxConcurrentWorkers'], value: 6 },
  ])
  rt.refresh()
  assert.equal(SAVE(rt.tree).props.disabled, true, 'and the draft is gone once accepted')
})

test('a draft that matches what the host already reports is not an edit', async (t) => {
  const form = fakeForm()
  const harness = await boot(t, { withConfigForms: true, form })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  const editor = byName(rt.tree, 'InlineEdit').find((element) => element.props.label === 'Concurrent workers')!
  ;(editor.props.onCommit as (next: string) => void)(String(PLUGIN_DEFAULTS.maxConcurrentWorkers))
  rt.refresh()

  // Without this, opening a row, changing nothing and leaving it would arm Save with a write
  // that changes nothing -- and "did I already save that?" has no answer from the page.
  assert.equal(SAVE(rt.tree).props.disabled, true)
  assert.deepEqual(form.writes, [])
})

test('a value the host would refuse blocks the save and says so on its own row', async (t) => {
  const form = fakeForm()
  const harness = await boot(t, { withConfigForms: true, form })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  const editor = byName(rt.tree, 'InlineEdit').find((element) => element.props.label === 'Concurrent workers')!
  ;(editor.props.onCommit as (next: string) => void)('0')
  rt.refresh()

  // The host's own rule is a positive integer, checked here so a round trip is not spent being
  // refused -- and the refusal that comes back names the whole mutation, not the row.
  assert.equal(SAVE(rt.tree).props.disabled, true, 'Save is disabled')
  const row = byName(rt.tree, 'SettingsRow').find((candidate) => candidate.props.label === 'Concurrent workers')
  assert.equal(row?.props.error, 'Enter a whole number of at least 1.', 'and the row carries the reason')
  assert.deepEqual(form.writes, [], 'nothing was sent')
})

test('an overridden field can be put back, and the write is an unset', async (t) => {
  const form = fakeForm()
  form.serve({ ...PLUGIN_DEFAULTS, autoReview: false }, { autoReview: true })
  const harness = await boot(t, { withConfigForms: true, form })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  const badges = elements(rt.tree).filter((element) => element.props?.className === 'dsho-tag')
  assert.equal(badges.length, 1, 'exactly the overridden field is badged')
  assert.equal(badges[0]!.children[0], 'Overridden')

  const reset = elements(rt.tree).find((element) => element.props?.className === 'dsho-inline__reset')!
  assert.equal(reset.children[0], 'Reset to default')
  ;(reset.props.onClick as () => void)()
  rt.refresh()
  ;(SAVE(rt.tree).props.onClick as () => void)()
  await Promise.resolve().then(() => Promise.resolve())

  // The unset is what restores inheritance; a `set` of the default value would pin the value
  // into the profile and it would stop following the schema.
  assert.deepEqual(form.writes[0]!.operations, [{ op: 'unset', path: ['autoReview'] }])
})

test('a refused save keeps the draft and reports it, because the values may have moved', async (t) => {
  const form = fakeForm()
  form.accept(false)
  const harness = await boot(t, { withConfigForms: true, form })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  const switchFor = byName(rt.tree, 'Switch').find((element) => element.props.label === 'Auto review pull requests')!
  ;(switchFor.props.onChange as (next: boolean) => void)(false)
  rt.refresh()
  ;(SAVE(rt.tree).props.onClick as () => void)()
  await Promise.resolve().then(() => Promise.resolve())
  rt.refresh()

  const status = elements(rt.tree).find((element) => element.props?.['data-status'] === 'error')
  assert.ok(status, 'the failure is shown')
  assert.match(String(status!.children[0]), /did not accept these values/)
  assert.equal(SAVE(rt.tree).props.disabled, false, 'the draft survives, so it can be corrected and saved again')
})

test('a deployment that stores settings read-only shows the values and disables the controls', async (t) => {
  const form = fakeForm()
  const readOnly = {
    ...form.form,
    getSnapshot: () => ({
      status: 'ready',
      writable: false,
      revision: 1,
      value: { ...PLUGIN_DEFAULTS },
      base: { ...PLUGIN_DEFAULTS },
      user: {},
    }),
  }
  const harness = await boot(t, { withConfigForms: true, form: { ...form, form: readOnly } })
  harness.serveNamespace()
  harness.declareSlot()
  const { rt } = mountPage(harness)

  assert.ok(elements(rt.tree).some((element) => String(element.children?.[0] ?? '').includes('read-only')))
  assert.equal((byName(rt.tree, 'Switch')[0]!.props as { disabled: boolean }).disabled, true)
  assert.equal(SAVE(rt.tree).props.disabled, true)
})
