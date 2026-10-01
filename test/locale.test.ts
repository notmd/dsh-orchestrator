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
