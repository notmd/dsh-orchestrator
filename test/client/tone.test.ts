/**
 * The card's tone map, and why it needs a test.
 *
 * The first version was written from a PARTIAL list of display statuses and had never
 * heard of `Needs review`, so a card reading exactly that got a neutral tone and no
 * colour -- found by looking at the rendered board, not by a test.
 *
 * The guard is exhaustiveness: every status in the contract must appear as a case label,
 * so adding one forces a decision rather than silently defaulting. The client is a
 * classic script and cannot import, so this reads the source -- the technique the locale
 * parity test uses for its duplicated fallback table.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DisplayStatus } from '../../src/contract/kanban.ts'

const source = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')

/** The `toneOf` body, brace-matched. */
function toneBody(): string {
  const start = source.indexOf('function toneOf(')
  assert.ok(start > 0, 'toneOf exists')
  const open = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced toneOf')
}

test('every display status is named in the tone map, so a new one cannot slip through', () => {
  const labelled = new Set([...toneBody().matchAll(/case '([^']+)':/g)].map((m) => m[1]!))
  const missing = Object.values(DisplayStatus).filter((status) => !labelled.has(status))
  assert.deepEqual(missing, [], 'each status needs an explicit case label')
})

test('no case label names a status the contract does not have', () => {
  // A renamed status would leave a stale label matching nothing: the map would look
  // exhaustive while covering less than it claims.
  const known = new Set<string>(Object.values(DisplayStatus))
  const stale = [...toneBody().matchAll(/case '([^']+)':/g)].map((m) => m[1]!).filter((label) => !known.has(label))
  assert.deepEqual(stale, [])
})

test('attention is read from the reducer, never re-derived from the status text', () => {
  // The bug this encodes: deciding attention here is what produced a neutral
  // `Needs review`. The reducer owns that decision and is tested; consult it.
  const body = toneBody()
  assert.match(body, /card\.needsAttention === true/, 'attention comes from the flag')
  // Strip every line mentioning the flag, then assert nothing else returns the tone --
  // a status-text test for attention would show up right here.
  const withoutGuard = body.split('\n').filter((line) => !line.includes('needsAttention')).join('\n')
  assert.ok(!/return 'attention'/.test(withoutGuard), 'and only from the flag')
})

test('no branch makes the lane fallback unreachable', () => {
  // The bug: an explicit `return 'neutral'` group containing `Needs review` returned
  // before the lane fallback could apply, so the fallback existed and never ran. Assert
  // the neutral-ish statuses RETURN the lane tone rather than a flat value.
  const body = toneBody()
  const group = body.slice(body.indexOf("case 'Blocked':"), body.indexOf('default:'))
  assert.match(group, /LANE_TONE\[card\.column\]/, 'the named group defers to the lane')
  assert.ok(!/return 'neutral'/.test(group), 'and does not short-circuit it')
})

test('the card cannot decide for itself whether work is turning', () => {
  // The loader is the one thing claiming work is happening, so it must come from the
  // presented flag -- the reducer already routes a settled card away from `Working`.
  assert.match(source, /spinning: card\.showStatusLoader === true/)
})


test('every lane has a tone, so no card is ever colourless', () => {
  // Without a lane fallback, a card whose status is legitimately not waiting on a person
  // (the reducer says `Needs review` is not) rendered with no colour at all.
  const lanes = [...source.matchAll(/\{ key: '([a-z_]+)', labelKey:/g)].map((m) => m[1]!)
  assert.ok(lanes.length >= 4, `found ${lanes.length} lanes`)
  const mapStart = source.indexOf('const LANE_TONE')
  assert.ok(mapStart > 0, 'LANE_TONE exists')
  const mapBody = source.slice(mapStart, source.indexOf('}', mapStart))
  for (const lane of lanes) {
    assert.match(mapBody, new RegExp(`${lane}:`), `lane ${lane} needs a tone`)
  }
})


test('an attention card animates, and every animation has a reduced-motion escape', () => {
  // The reference pulses an attention card rather than only tinting its border, because a
  // border is easy to miss on a busy board. An animation without a reduced-motion escape
  // is a accessibility defect, so both are asserted together.
  assert.match(source, /@keyframes dsho-attention-pulse/)
  assert.match(source, /animation: dsho-attention-pulse/, 'the attention overlay animates')
  const reduce = source.slice(source.indexOf('prefers-reduced-motion'))
  // Asserted on the SELECTORS, not the keyframe names: the reduced-motion block names the
  // element whose animation stops, and the keyframe name does not appear in it at all.
  assert.match(reduce, /\.dsho-card--attention::before\s*\{[^}]*animation: none/s, 'the overlay stops')
  assert.match(reduce, /\.dsho-card\[data-tone='busy'\] \.dsho-glyph\s*\{[^}]*animation: none/s, 'so does the glyph')
  assert.match(reduce, /opacity: 0\.5/, 'and the overlay keeps a static tint rather than vanishing')
})
