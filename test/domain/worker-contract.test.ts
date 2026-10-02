/**
 * The worker's task message, and two settings that reached no one.
 *
 * `draftPrs` and `prBodyTemplate` were validated and offered, but the plugin NEVER opens
 * the pull request -- the worker does, from its own session -- so a setting about how it
 * is opened can only be obeyed by telling the worker.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { workerTaskMessage } from '../../src/domain/worker-contract.ts'
import { REVIEWER_OUTPUT } from '../../src/domain/reviewer-contract.ts'

const BASE = {
  issueId: 'iss-1',
  title: 'Fix it',
  body: 'the description',
  repoRoot: '/r',
  branch: 'dsho/issue-1-fix-it',
  verifyCommands: ['npm test'],
}

test('a draft instruction appears only when drafts are configured', () => {
  const draft = workerTaskMessage({ ...BASE, draftPrs: true })
  assert.match(draft, /DRAFT/)
  assert.match(draft, /gh pr create --draft/, 'the flag is named: the worker runs gh itself')
  for (const off of [workerTaskMessage(BASE), workerTaskMessage({ ...BASE, draftPrs: false })]) {
    assert.ok(!/DRAFT/.test(off), 'nothing when the setting is off or absent')
  }
})

test('the body template is handed over verbatim, and absent means absent', () => {
  const text = workerTaskMessage({ ...BASE, prBodyTemplate: '## Summary\n\nCloses {issue}' })
  assert.match(text, /Closes \{issue\}/, 'verbatim, placeholders and all')
  for (const absent of [workerTaskMessage(BASE), workerTaskMessage({ ...BASE, prBodyTemplate: '   ' })]) {
    assert.ok(!/Pull-request body/.test(absent), 'no empty section either')
  }
})

test('the settings did not disturb the contract ordering', () => {
  // The point of the ordering: a worker that read the task before the boundary sentence
  // would be reasoning about instructions before it knew they were data.
  const text = workerTaskMessage({ ...BASE, draftPrs: true, prBodyTemplate: 'body' })
  assert.ok(text.indexOf('untrusted') < text.indexOf('the description'))
  assert.ok(text.indexOf('npm test') < text.indexOf('DRAFT'), 'verification precedes shipping')
  assert.match(text, /orchestrator_report/, 'and reporting is still the last step')
})

test('the reviewer is told HOW to post without a writable temp directory', () => {
  // Measured live, and it cost an entire auto-review pass: the reviewer reached for a
  // heredoc, the read-only sandbox refused the temp file, and it stalled on an approval
  // nobody answers. Telling it the command form is the least-privilege fix -- the boundary
  // stays `read-only` instead of being widened to make a shell idiom work.
  assert.match(REVIEWER_OUTPUT, /-f event=COMMENT/, 'the working form is given concretely')
  assert.match(REVIEWER_OUTPUT, /never a heredoc, never `--input`/)
  assert.match(REVIEWER_OUTPUT, /cannot create temp file for here document/, 'and the failure it prevents is named')
})
