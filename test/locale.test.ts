/**
 * The shipped dictionaries (M7, PRD §11.5).
 *
 * A locale file is the easiest artefact in a project to let rot, because nothing
 * breaks when a key is missing -- the UI simply shows the key, or falls back, and
 * nobody notices until a user does. These assertions are the cheapest possible guard
 * and they cover the failure that actually happens in practice: one language gets a
 * new key and the other does not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const LOCALES = ['en', 'zh'] as const

function dict(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>
}

/** `{placeholder}` names inside a template. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
}

test('the locales the PRD requires are actually shipped', () => {
  // §11.5: "en and zh at minimum". An empty `locale/` directory satisfied no one.
  const shipped = readdirSync(new URL('../locale/', import.meta.url))
  for (const locale of LOCALES) {
    assert.ok(shipped.includes(`${locale}.json`), `${locale}.json is shipped`)
  }
})

test('every locale covers exactly the same keys', () => {
  // The failure that actually happens: one language gains a key and the other does
  // not, and the gap shows up as a raw key in someone else's UI.
  const reference = Object.keys(dict('en')).sort()
  assert.ok(reference.length > 0, 'english has keys at all')
  for (const locale of LOCALES.slice(1)) {
    assert.deepEqual(Object.keys(dict(locale)).sort(), reference, `${locale} matches en`)
  }
})

test('every key is namespaced, so the lookup chain can find it', () => {
  for (const locale of LOCALES) {
    for (const key of Object.keys(dict(locale))) {
      assert.match(key, /^orchestrator\./, `${locale}: ${key}`)
    }
  }
})

test('a translation carries every placeholder its English original has', () => {
  // A dropped `{count}` renders a sentence with a hole in it -- the most common way a
  // translation is subtly wrong, and invisible to a key-parity check.
  const en = dict('en')
  for (const locale of LOCALES.slice(1)) {
    const other = dict(locale)
    for (const [key, value] of Object.entries(en)) {
      assert.deepEqual(placeholders(other[key]!), placeholders(value), `${locale}: ${key}`)
    }
  }
})

test('no translation is empty or left as its own key', () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(dict(locale))) {
      assert.ok(value.trim().length > 0, `${locale}: ${key} is empty`)
      assert.notEqual(value, key, `${locale}: ${key} was never translated`)
    }
  }
})

test('a translation actually differs from English, or it is not a translation', () => {
  // A zh file that is a copy of en would pass every check above. It is worth
  // distinguishing "translated" from "duplicated", which is why this exists.
  const en = dict('en')
  const zh = dict('zh')
  const identical = Object.keys(en).filter((key) => en[key] === zh[key])
  assert.ok(
    identical.length <= 1,
    `zh is still English for ${identical.length} keys: ${identical.slice(0, 4).join(', ')}`,
  )
})


test("the client's fallback table agrees with en.json", () => {
  // The client cannot import en.json (`module: none` makes it a classic script), so it
  // carries a duplicated table. This is the guard that makes the duplication safe: a
  // string edited in one place and not the other fails here rather than silently
  // showing English to a Chinese user.
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const table = source.slice(source.indexOf('const FALLBACK: Record<string, string> = {'), source.indexOf('function fill('))
  const entries = [...table.matchAll(/'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g)]
  assert.ok(entries.length > 10, `parsed ${entries.length} fallback entries`)

  const fallback: Record<string, string> = {}
  for (const [, key, value] of entries) fallback[key!] = value!.replace(/\\u2026/g, '\u2026')
  const en = dict('en')

  // The separator characters differ deliberately (the client uses ASCII for the
  // loading ellipsis and the archive dash, since the source is a plain script); so the
  // comparison is on the KEY SET and on the placeholder shape, not on punctuation.
  // A SUBSET, not an equality: `en.json` also holds the panellist label, which is
  // passed to the slot registration and never goes through `translate`. Every key the
  // client DOES translate must exist in the dictionary, and vice versa is not required.
  const missing = Object.keys(fallback).filter((key) => !(key in en))
  assert.deepEqual(missing, [], 'every client string exists in en.json')
  assert.ok(Object.keys(en).length >= Object.keys(fallback).length, 'and the dictionary is not behind')
  for (const [key, value] of Object.entries(fallback)) {
    assert.deepEqual(placeholders(value), placeholders(en[key]!), `${key} placeholders`)
  }
})

test('the client does not import its dictionary, because it cannot', () => {
  // A regression guard for the shape, not the content: `module: none` means the client
  // is a classic script, and an `import` or `export` in it silently changes the emitted
  // bundle from a script into a module -- which the loader then fails to find.
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const moduleStatements = source.split('\n').filter((line) => /^(import|export)\s/.test(line))
  assert.deepEqual(moduleStatements, [], 'the client must stay a script')
})
