/**
 * The settings page's shape, guarded at the places it can silently drift.
 *
 * The client is a classic script and cannot import the host's types, so the payload it
 * reads is a *mirror* -- the same arrangement the board's snapshot types have, and the same
 * risk: a field renamed on one side shows up as a blank row rather than as an error. These
 * tests read both sources and compare them, which is the technique `tone.test.ts` and the
 * locale parity test already use.
 *
 * The other two assertions guard decisions rather than data:
 *
 *   - the switch is a REAL checkbox, because a div with a click handler is not keyboard
 *     operable and a settings page whose controls cannot be reached is unusable;
 *   - the route path is the same string on both sides, because a typo there is a dialog
 *     that loads forever with no error anywhere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../src/host/settings-service.ts', import.meta.url), 'utf8')
const contract = readFileSync(new URL('../../src/host/repo-settings.ts', import.meta.url), 'utf8')
const route = readFileSync(new URL('../../src/host/settings-route.ts', import.meta.url), 'utf8')

/** The field names declared inside one interface body, in declaration order. */
function fieldsOf(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`)
  assert.ok(start > 0, `${name} is declared`)
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  // Comments are stripped first: a doc comment inside the body would otherwise contribute
  // words that look like field names.
  return [...body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\??:/gm)].map(
    (match) => match[1]!,
  )
}

/** The body of one function, brace-matched, so an inner object literal cannot end it early. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start > 0, `${signature} exists`)
  const open = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced ${signature}`)
}

test('the client mirrors the host project ref, field for field', () => {
  assert.deepEqual(fieldsOf(client, 'ProjectView'), fieldsOf(service, 'ProjectRef'))
})

test('the client mirrors the per-project settings, field for field', () => {
  // The inline literal inside `SettingsPayload` is the client's copy of `ProjectSettings`.
  const start = client.indexOf('interface SettingsPayload {')
  const settingsLiteral = client.slice(client.indexOf('settings: {', start), client.indexOf('} | null', start))
  const clientFields = [...settingsLiteral.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\??:/gm)]
    .map((match) => match[1]!)
    .filter((field) => field !== 'settings')
  assert.deepEqual(clientFields, fieldsOf(contract, 'ProjectSettings'))
})

test('the client mirrors the plugin defaults it displays', () => {
  const hostBody = functionBody(service, 'export function settingsDefaults(')
  const hostFields = [...hostBody.replace(/\s*:\s*[^,}]+/g, '').matchAll(/([A-Za-z][A-Za-z0-9_]*)/g)]
    .map((match) => match[1]!)
    .filter((field) => field !== 'return')

  const start = client.indexOf('defaults: {')
  const literal = client.slice(start, client.indexOf('}', start))
  const clientFields = [...literal.matchAll(/([A-Za-z][A-Za-z0-9_]*)\??:/g)]
    .map((match) => match[1]!)
    .filter((field) => field !== 'defaults')
  assert.deepEqual(clientFields, hostFields)
})

test('both halves address the same route', () => {
  const host = /export const SETTINGS_ROUTE_PATH = '([^']+)'/.exec(route)?.[1]
  const clientPath = /const SETTINGS_PATH = '([^']+)'/.exec(client)?.[1]
  assert.ok(host, 'the host declares the path')
  assert.equal(clientPath, host, 'a typo here is a dialog that never finishes loading')
})

test('the toggle is the HOST\'s switch, not a div and not a checkbox', () => {
  // Measured off the host's own settings dialog: a `<button role="switch" aria-checked>`.
  // `aria-checked` is what the stylesheet keys off, so there is no `:checked` mirror to
  // keep in step, and Space/Enter activation comes from the platform.
  const body = functionBody(client, 'function Switch(')
  assert.match(body, /'button'/, 'a button, so it is keyboard operable')
  assert.match(body, /role: 'switch'/)
  assert.match(body, /'aria-checked': props\.checked/, 'the state is on aria-checked')
  assert.doesNotMatch(body, /type: 'checkbox'/)
  assert.match(body, /onClick: \(\) => props\.onChange\(!props\.checked\)/)
})

test('the dialog is a labelled modal and every input has an accessible name', () => {
  assert.match(client, /role: 'dialog'/)
  assert.match(client, /'aria-modal': 'true'/)
  assert.match(client, /'aria-labelledby': 'dsho-settings-title'/)
  // The three inline editors each pass the row's own label as the input's aria-label.
  // Scoped to the DIALOG's own body: the plugin's settings page on the Plugins page has one
  // editor per config field, so a whole-file count is a number that moves whenever a row is
  // added anywhere -- an assertion that cannot be about the dialog any more. The page's own
  // editors are guarded in `plugin-config.test.ts`.
  const dialog = functionBody(client, 'function SettingsDialog(')
  const inlineEdits = [...dialog.matchAll(/h\(InlineEdit, \{[\s\S]*?\n\s*\}\)/g)]
  assert.equal(inlineEdits.length, 6, 'branch, prefix, assignee, worker permissions, reviewer and reviewer permissions')
  for (const [block] of inlineEdits) assert.match(block, /label: translate\('orchestrator\.settings\./)
})

test('focus goes in, is trapped, and comes back', () => {
  // All three are load-bearing, and only the first is obvious. The board behind the dialog
  // is still focusable -- our overlay covers the panel without making anything inert -- so
  // without the trap the next Tab lands on a card behind the modal.
  const dialog = functionBody(client, 'function SettingsDialog(')
  assert.match(dialog, /dialog\.current\?\.focus\(\)/, 'focus moves into the dialog')
  assert.match(dialog, /onKeyDown: trapTab/, 'and Tab is handled on the dialog')
  // The opener is passed IN. Reading `document.activeElement` alone would capture the menu
  // ITEM, which unmounts with the menu it belongs to -- so the restore would be a no-op.
  assert.match(dialog, /props\.restoreFocusTo \?\? document\.activeElement/)
  assert.match(dialog, /opener\.focus\(\)/, 'and focuses it again on close')
  assert.match(client, /settingsOpener\.current = opener/, 'the Board captures the "..." trigger')
  assert.match(client, /restoreFocusTo: settingsOpener\.current/, 'and hands it to the dialog')
  // The trap itself is shared, so it is asserted once, on the helper -- and both dialogs are
  // asserted to USE it, because the failure this guards is a second dialog that copies the
  // markup and forgets the keyboard rules.
  const trap = functionBody(client, 'function trapTabWithin(')
  assert.match(trap, /event\?\.key !== 'Tab'/)
  assert.match(trap, /event\.shiftKey === true/, 'Shift+Tab wraps backwards')
  assert.match(trap, /last\?\.focus\(\)/)
  assert.match(trap, /first\?\.focus\(\)/)
  assert.match(dialog, /trapTabWithin\(dialog\.current, event\)/, 'the settings dialog uses the shared trap')
  assert.match(
    functionBody(client, 'function NewTaskDialog('),
    /trapTabWithin\(dialog\.current, event\)/,
    'and the new-task dialog does too',
  )
})

test('every token the settings stylesheet uses is a token the host really defines', () => {
  // The project has shipped this bug before: four `--dsw-alias-*` names that did not exist,
  // each with a literal fallback, so nothing looked broken while the panel followed the
  // theme in no respect at all. The list below was read out of a LIVE host; a name not in
  // it is a guess.
  const measured = new Set([
    '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-mask-1', '--dsw-alias-bg-module-platform',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3',
    '--dsw-alias-brand-primary', '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-label-primary', '--dsw-alias-label-primary-dimmed', '--dsw-alias-label-tertiary',
    '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-scrollbar-hover-l2',
    '--dsw-alias-state-business-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary', '--dsw-alias-button-ghost-active-fill',
    '--dsw-alias-switch-thumb', '--dsw-alias-label-primary-foreground',
    '--dsw-elevation-prominent', '--dsw-focus-ring-color', '--dsw-focus-ring-width',
    '--dsw-mask-blur', '--dsw-menu-backdrop-filter', '--dsw-radius-lg', '--dsw-radius-md',
    '--dsw-radius-panel', '--dsw-radius-sm', '--dsw-radius-xl', '--dsw-radius-xs',
    '--dsw-specific-menu',
  ])
  const used = new Set([...client.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]!))
  assert.ok(used.size > 10, `parsed ${used.size} token references`)
  const unknown = [...used].filter((token) => !measured.has(token))
  assert.deepEqual(unknown, [], 'a token that does not exist is silently a no-op')
})

test('every settings section passes its rows as an ARRAY, because React does not', () => {
  // The bug this guards, found in a live host: React gives back a single element when a
  // component has ONE child and an array when it has several, so a `...(children ?? [])`
  // spread worked for the three-row sections and threw `Spread syntax requires ...iterable`
  // for the one-row section -- which blanked the whole panel through the slot's error
  // boundary. Passing the rows as one array argument removes the ambiguity at the call site.
  const sections = [...client.matchAll(/SettingsSection,\s*\n\s*\{[^\n]*\},\s*\n\s*(.)/g)].map((match) => match[1])
  assert.deepEqual(sections, ['[', '[', '[', '['], 'every section carries an array of rows')
  assert.match(functionBody(client, 'function SettingsSection('), /Array\.isArray\(props\.children\)/, 'and the component still normalizes')
})

test('the settings surface uses the HOST\'s mask and elevation, not a literal', () => {
  // The host's dialog is `bg-mask-1` + `mask-blur` over `elevation-prominent`. An earlier
  // version hand-mixed a scrim from a layer token and had no shadow at all, which read flat
  // against the board behind it.
  const css = client.slice(client.indexOf('.dsho-settings-scrim'), client.indexOf('.dsho-section '))
  assert.match(css, /background: var\(--dsw-alias-bg-mask-1/)
  assert.match(css, /backdrop-filter: var\(--dsw-mask-blur/)
  assert.match(css, /box-shadow: var\(--dsw-elevation-prominent/)
  assert.match(css, /border-radius: var\(--dsw-radius-panel/)
})

test('a failed save is reported on the row that caused it', () => {
  // The header message alone is easy to miss on a six-row dialog, and "it did not save" is
  // only actionable next to the thing that did not save. The host names the refused key in
  // the refusal, and each save sends exactly one key, so the row can be identified.
  const dialog = functionBody(client, 'function SettingsDialog(')
  assert.match(dialog, /const fields = Object\.keys\(patch\)/, 'the save records which keys it sent')
  assert.match(dialog, /status\.fields\?\.includes\(field\) === true/, 'and a row asks whether it was one of them')
  const wired = [...client.matchAll(/fieldError\('([A-Za-z]+)'\)/g)].map((match) => match[1])
  assert.deepEqual(wired.sort(), [
    'autoReview',
    'defaultBranch',
    'intakeEnabled',
    'reviewerAgentPreset',
    'reviewerPermissionPreset',
    'sessionPrefix',
    'workerAgentPreset',
    'workerPermissionPreset',
  ])
  // The row renders it in place of the hint, not below it: stacking both makes one row
  // taller than the rest and buries the message.
  const row = functionBody(client, 'function SettingsRow(')
  assert.match(row, /className: 'dsho-row__error', role: 'status'/)
  assert.match(row, /props\.error\s*\n?\s*\?/)
})

test('"Saved" clears itself, a failure does not', () => {
  const dialog = functionBody(client, 'function SettingsDialog(')
  assert.match(dialog, /setTimeout\(\(\) => setStatus\(\{ kind: 'idle' \}\), 2500\)/, 'the receipt fades')
  assert.match(dialog, /if \(savedKind !== 'saved'\) return/, 'and only the receipt fades')
  assert.match(dialog, /clearTimeout\(timer\)/, 'with no timer left behind if the dialog closes first')
})

test('the inline editor hands focus back to its pencil', () => {
  // Measured live: after Escape in the editor focus was on document.body, because the input
  // that held it is unmounted. The dialog survived; the next Tab started from the top of the
  // page, which reads as having lost your place.
  const editor = functionBody(client, 'function InlineEdit(')
  assert.match(editor, /const pencil = React\.useRef/)
  assert.match(editor, /ref: pencil/)
  assert.match(editor, /pencil\.current\?\.focus\(\)/)
})

test('the scrim closes the dialog, but only when the click is ON the scrim', () => {
  // The host's dialogs dismiss on a mask click. `target === currentTarget` is the load-
  // bearing part: a click that starts on a row and ends on the scrim is delivered to the
  // scrim as well (it is the common ancestor), so without the check a drag off a switch
  // would close the dialog and throw the edit away.
  const dialog = functionBody(client, 'function SettingsDialog(')
  assert.match(dialog, /onMouseDown: \(event: \{ target\?: unknown; currentTarget\?: unknown \}\) => \{/)
  assert.match(dialog, /if \(event\?\.target === event\?\.currentTarget\) props\.onClose\(\)/)
})

test('the "..." menu is a real menu button, not a mouse-only control', () => {
  // Measured live first: a click on the trigger followed by ArrowDown left focus on the
  // trigger -- the menu was advertising `aria-haspopup="menu"` and delivering none of it.
  // The host's own menus are no better (portaled, so Tab leaves them and the arrows do
  // nothing), so this follows the ARIA menu-button contract rather than copying the host.
  const menu = functionBody(client, 'function ProjectMenu(')
  assert.match(menu, /if \(!open\) openMenu\(key === 'ArrowDown' \? 0 : Number\.MAX_SAFE_INTEGER\)/, 'ArrowDown opens onto the first item, ArrowUp onto the last')
  assert.match(menu, /moveBy\(1\)/, 'and inside the menu the arrows move')
  assert.match(menu, /moveBy\(-1\)/)
  assert.match(menu, /\(current \+ delta \+ all\.length\) % all\.length/, 'wrapping at both ends')
  assert.match(menu, /key === 'Home' \|\| key === 'End'/, 'Home/End jump')
  assert.match(menu, /closeMenu\(true\)/, 'Escape closes and restores focus to the trigger')
  // Tab is deliberately NOT handled: closing on Tab while the focused item is unmounted is
  // how focus ends up on document.body. The focusout rule does it instead.
  assert.doesNotMatch(menu, /key === 'Tab'/)
  assert.match(menu, /const inList = next !== null &&/)
  assert.match(menu, /if \(!inList && next !== trigger\.current\) setOpen\(false\)/)
  assert.match(menu, /'aria-expanded': open \? 'true' : 'false'/)
})

test('the settings route and the board route are both registered under the plugin effect', () => {
  const entry = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /createSettingsRoutes\(\{ store, config: resolved \}\)/)
  assert.match(entry, /ctx\.webServer\.register\(route\)/, 'proving the settings route is not left to a second server')
})
