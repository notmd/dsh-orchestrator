/**
 * The new-task surface, guarded where it can silently drift.
 *
 * The client is a classic script: it cannot import the host's constants or its components,
 * so the route path is duplicated and the dialog is written against a shape it cannot
 * typecheck. Both are what this reads back and compares.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
const route = readFileSync(new URL('../../src/host/tasks-route.ts', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../src/host/tasks-service.ts', import.meta.url), 'utf8')

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
  throw new Error(`unbalanced braces after ${signature}`)
}

test('both halves address the same route', () => {
  // A typo here is a dialog that says "could not create the task" forever, with the real
  // reason nowhere: the host is fine, nothing ever called it.
  assert.match(route, /export const TASKS_ROUTE_PATH = '\/dsho\/api\/tasks'/)
  assert.match(client, /const TASKS_PATH = '\/dsho\/api\/tasks'/)
})

test('the dialog is a labelled modal, and the brief is a real labelled field', () => {
  const dialog = functionBody(client, 'function NewTaskDialog(')
  assert.match(dialog, /role: 'dialog'/)
  assert.match(dialog, /'aria-modal': 'true'/)
  assert.match(dialog, /'aria-labelledby': 'dsho-task-title'/)
  assert.match(dialog, /h\('h2', \{ className: 'dsho-settings__title', id: 'dsho-task-title'/)
  // A label tied by `htmlFor`, not a placeholder standing in for one: the placeholder here
  // is an example, and an example is not a name.
  assert.match(dialog, /h\('label', \{ className: 'dsho-task__label', htmlFor: 'dsho-task-brief' \}/)
  assert.match(dialog, /h\('textarea', \{/)
  assert.match(dialog, /placeholder: translate\('orchestrator\.task\.placeholder'\)/)
})

test('the brief is focused on open, and focus comes back to the button that opened it', () => {
  const dialog = functionBody(client, 'function NewTaskDialog(')
  assert.match(dialog, /field\.current\?\.focus\(\)/)
  assert.match(dialog, /opener\.focus\(\)/,'and the trigger gets it back on close')
  const board = functionBody(client, 'function Board(')
  assert.match(board, /taskOpener\.current = event\?\.currentTarget/, 'the Board captures the trigger')
  assert.match(board, /restoreFocusTo: taskOpener\.current/, 'and hands it to the dialog')
})

test('the task cannot be started with an empty brief', () => {
  const dialog = functionBody(client, 'function NewTaskDialog(')
  assert.match(dialog, /disabled: brief\.trim\(\) === '' \|\| status\.kind === 'starting'/)
  assert.match(dialog, /if \(brief\.trim\(\) === '' \|\| status\.kind === 'starting'\) return/)
})

test('a created task is read back at once, not on the next poll', () => {
  // The card IS the feedback. Waiting up to a poll interval for it reads as "nothing
  // happened", which is how a working feature gets reported as broken.
  const board = functionBody(client, 'function Board(')
  assert.match(board, /setRefreshNonce\(\(previous\) => previous \+ 1\)/)
  assert.match(board, /\}, \[props\.repoId, refreshNonce\]\)/)
})

test('the entry point is offered only where a task can go', () => {
  const board = functionBody(client, 'function Board(')
  assert.match(board, /activeProject === undefined\s*\n\s*\? null\s*\n\s*: h\(\s*\n\s*'button'/)
  assert.match(board, /taskOpen && activeProject !== undefined/)
})

test('the host answers with the fields the client reads', () => {
  // `ok`, `message`, `title` and `workerId` are the client's whole contract with the host.
  const outcome = service.slice(service.indexOf('export interface NewTaskOutcome'))
  for (const field of ['ok: boolean', 'message: string', 'title?: string', 'workerId?: string']) {
    assert.ok(outcome.includes(field), `NewTaskOutcome carries ${field}`)
  }
  assert.match(service, /title: issue\.title,/, 'and the host answers with the title it wrote')
})
