/**
 * The new-task title rules (the reference's delegation.go, ported).
 *
 * These are the cases that make the difference between a card that reads well and a card
 * that reads like a model clearing its throat. Every one of them is a rule the reference
 * had to learn, so each is asserted rather than assumed:
 *
 *   - the provisional title must never be empty (a promptless worker is a real state, and
 *     an empty title is an unnamed card);
 *   - a generated title is the FIRST LINE only, with the markdown and the quotes stripped;
 *   - a title with no letter or digit is a REFUSAL, not an empty title.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  TASK_REFINEMENT_LIMIT,
  TASK_REFINEMENT_TIMEOUT_MS,
  TASK_TITLE_LIMIT,
  UNTITLED_TASK,
  generatedTaskTitle,
  provisionalTaskTitle,
  sanitizeControlCharacters,
} from '../../src/domain/task-title.ts'

test('the constants are the reference ones, not round numbers of our own', () => {
  // 100 is its maxDisplayNameLen and its own prompt says 100; a minute is its timeout; four
  // is its concurrency cap. A drift here is silent, which is why it is asserted.
  assert.equal(TASK_TITLE_LIMIT, 100)
  assert.equal(UNTITLED_TASK, 'Untitled task')
  assert.equal(TASK_REFINEMENT_TIMEOUT_MS, 60_000)
  assert.equal(TASK_REFINEMENT_LIMIT, 4)
})

test('a brief becomes a one-line title', () => {
  // Typed into a textarea, so newlines and runs of spaces arrive as a matter of course.
  assert.equal(provisionalTaskTitle('  Fix the flaky\n\n   auth test  '), 'Fix the flaky auth test')
  assert.equal(provisionalTaskTitle('one\ttwo'), 'one two')
})

test('a brief that names nothing is still named', () => {
  // A promptless worker is allowed by the reference, and `Untitled task` is its string: an
  // empty title would be an unnamed card, which is worse than an honest one.
  assert.equal(provisionalTaskTitle(''), UNTITLED_TASK)
  assert.equal(provisionalTaskTitle('   \n\t '), UNTITLED_TASK)
})

test('the provisional title is capped by CODE POINTS, not UTF-16 units', () => {
  const long = 'x'.repeat(140)
  assert.equal(provisionalTaskTitle(long).length, TASK_TITLE_LIMIT)
  // An emoji is two UTF-16 units; slicing by those would cut one in half and leave a lone
  // surrogate in a branch slug and a session title.
  const emoji = '\u{1F600}'.repeat(140)
  const capped = provisionalTaskTitle(emoji)
  assert.equal([...capped].length, TASK_TITLE_LIMIT, 'exactly the cap, counted in code points')
  // A slice by UTF-16 units at 100 would leave a lone surrogate here.
  assert.equal(capped, '\u{1F600}'.repeat(TASK_TITLE_LIMIT))
})

test('control characters are dropped, except the three that are layout', () => {
  assert.equal(sanitizeControlCharacters('a\u0007b'), 'ab')
  assert.equal(sanitizeControlCharacters('a\u001b[31m'), 'a[31m')
  assert.equal(sanitizeControlCharacters('a\nb\tc\rd'), 'a\nb\tc\rd')
})

test('a generated title keeps the first line and strips the markdown', () => {
  assert.equal(generatedTaskTitle('## Fix the **flaky** auth test\n\nDetails follow'), 'Fix the **flaky** auth test')
  assert.equal(generatedTaskTitle('- "Fix login"'), 'Fix login')
  assert.equal(generatedTaskTitle('> Retry the upload'), 'Retry the upload')
  assert.equal(generatedTaskTitle('* Add a README'), 'Add a README')
})

test('a generated title that names nothing is a refusal, not an empty title', () => {
  // The reference's rule: at least one letter or digit. `###` and a bare punctuation mark are
  // what a model answers when it has nothing to say, and writing that over a real title is
  // the failure this guards.
  assert.equal(generatedTaskTitle('###'), '')
  assert.equal(generatedTaskTitle('   '), '')
  assert.equal(generatedTaskTitle('...'), '')
  assert.equal(generatedTaskTitle(''), '')
})

test('a generated title obeys the same cap and the same control-character rule', () => {
  assert.equal(generatedTaskTitle('y'.repeat(140)).length, TASK_TITLE_LIMIT)
  assert.equal(generatedTaskTitle('Fix\u0007 the thing'), 'Fix the thing')
})
