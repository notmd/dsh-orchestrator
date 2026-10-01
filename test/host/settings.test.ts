/**
 * The settings service and its route.
 *
 * The properties worth pinning down, each of which is a way this feature could be wrong
 * while looking right:
 *
 *   - a refusal writes NOTHING (an edit that half-applies is worse than one that fails);
 *   - an unknown repo id is refused rather than silently answered with another project;
 *   - a write survives as an ordinary record read, because every consumer reads the
 *     `Repo` record live -- there is no cache to invalidate and no second copy to drift.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizePluginConfig } from '../../src/config/validate.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { connectRepo, normalizeRepo } from '../../src/host/repo.ts'
import { buildBoard } from '../../src/host/board-service.ts'
import { listProjects, readSettingsView, selectProject, updateProjectSettings } from '../../src/host/settings-service.ts'
import type { SettingsDeps } from '../../src/host/settings-service.ts'
import {
  MAX_SETTINGS_BODY_BYTES,
  handleSettingsGet,
  handleSettingsPost,
  repoIdFromUrl,
} from '../../src/host/settings-route.ts'
import type { CommandResult, RunCommand } from '../../src/host/worktree.ts'

const REPO_JSON = JSON.stringify({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } })

/** A host that answers the preflight, so `connectRepo` can build a real record. */
const preflightRun: RunCommand = async (argv) => {
  const joined = argv.join(' ')
  if (joined.startsWith('git rev-parse --is-inside-work-tree')) return result('true\n')
  if (joined.startsWith('git check-ignore')) return result('', 0)
  if (joined.startsWith('gh auth status')) return result('')
  if (joined.startsWith('gh repo view')) return result(REPO_JSON)
  throw new Error(`unexpected command: ${joined}`)
}

function result(stdout = '', exitCode = 0): CommandResult {
  return { exitCode, stdout, stderr: '' }
}

/** A store holding one connected project. */
async function depsWithProject(options: { config?: Record<string, unknown>; connect?: boolean } = {}) {
  const store = createMemoryFactStore()
  const deps: SettingsDeps = {
    store: lazyFactStore(async () => store),
    config: normalizePluginConfig(options.config ?? {}),
  }
  if (options.connect !== false) {
    const connected = await connectRepo({ run: preflightRun, rootPath: '/code/widgets', id: 'repo-1', now: 1000 })
    assert.ok(connected.ok, 'the fixture connects')
    await store.repos.put(connected.repo.id, connected.repo)
  }
  return { store, deps }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('an install with nothing connected is an EMPTY payload, not an error', async () => {
  // The first run of the plugin looks exactly like this, and answering it with a failure
  // teaches the user the plugin is broken.
  const { deps } = await depsWithProject({ connect: false })
  const outcome = await readSettingsView(deps)
  assert.ok(outcome.ok)
  assert.deepEqual(outcome.view.projects, [])
  assert.equal(outcome.view.project, null)
  assert.equal(outcome.view.settings, null)
  assert.equal(outcome.view.defaults.autoReview, true, 'the plugin defaults travel with it')
})

test('the payload names the project and serializes its settings', async () => {
  const { deps } = await depsWithProject()
  const outcome = await readSettingsView(deps)
  assert.ok(outcome.ok)
  assert.equal(outcome.view.project?.repository, 'acme/widgets')
  assert.equal(outcome.view.project?.rootPath, '/code/widgets')
  assert.deepEqual(outcome.view.settings, {
    defaultBranch: 'main',
    sessionPrefix: '',
    intakeEnabled: true,
    workerAgentPreset: '',
    reviewerAgentPreset: '',
    autoReview: null,
  })
})

test('the default project is the configured one, then the oldest', async () => {
  const { store, deps } = await depsWithProject()
  const second = await connectRepo({ run: preflightRun, rootPath: '/code/other', id: 'repo-2', now: 2000 })
  assert.ok(second.ok)
  await store.repos.put(second.repo.id, second.repo)

  const projects = await listProjects(deps)
  assert.deepEqual(
    projects.map((project) => project.id),
    ['repo-1', 'repo-2'],
    'oldest first, so the picker does not reshuffle between polls',
  )
  // No request: the first project answers.
  assert.equal(chosen(projects, '', deps.config).id, 'repo-1')
  // The configured defaultRepo wins over the age order, because it is the install's intent.
  const configured: SettingsDeps = { ...deps, config: normalizePluginConfig({ defaultRepo: '/code/other' }) }
  assert.equal(chosen(projects, '', configured.config).id, 'repo-2')
  // An explicit id wins over everything.
  assert.equal(chosen(projects, 'repo-2', deps.config).id, 'repo-2')
})

/** The project a request selects, asserting that it selected one at all. */
function chosen(projects: Parameters<typeof selectProject>[0], requested: string, config: Parameters<typeof selectProject>[2]) {
  const outcome = selectProject(projects, requested, config)
  assert.ok('repo' in outcome, `expected a project for ${JSON.stringify(requested)}`)
  return outcome.repo
}

test('an unknown project id is REFUSED, never answered with another project', async () => {
  const { deps } = await depsWithProject()
  const outcome = await readSettingsView(deps, 'repo-does-not-exist')
  assert.ok(!outcome.ok)
  assert.equal(outcome.status, 404)
  assert.equal(outcome.code, 'project-not-found')
  assert.match(outcome.message, /orchestrator_repo_connect/, 'and it names the fix')
})

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test('a patch is written to the record and comes back in the payload', async () => {
  const { store, deps } = await depsWithProject()
  const saved = await updateProjectSettings(deps, {
    repoId: 'repo-1',
    patch: { sessionPrefix: 'web', intakeEnabled: false, autoReview: false, defaultBranch: 'develop' },
  })
  assert.ok(saved.ok)
  assert.equal(saved.view.settings?.sessionPrefix, 'web')
  assert.equal(saved.view.settings?.intakeEnabled, false)
  assert.equal(saved.view.settings?.autoReview, false)

  // The record on disk is the one every consumer reads, so read it back rather than
  // trusting the reply.
  const stored = normalizeRepo(await store.repos.get('repo-1'))
  assert.equal(stored.sessionPrefix, 'web')
  assert.equal(stored.defaultBranch, 'develop')
  assert.equal(stored.owner, 'acme', 'and the identity the page may not write is untouched')
  assert.equal(stored.rootPath, '/code/widgets')
})

test('a refused patch changes NOTHING', async () => {
  const { store, deps } = await depsWithProject()
  await updateProjectSettings(deps, { repoId: 'repo-1', patch: { sessionPrefix: 'web' } })

  // A patch with one good field and one bad: the whole write must be refused, or the user
  // gets a half-applied edit and no way to tell which half landed.
  const refused = await updateProjectSettings(deps, {
    repoId: 'repo-1',
    patch: { sessionPrefix: 'api', defaultBranch: 'not a branch' },
  })
  assert.ok(!refused.ok)
  assert.equal(refused.status, 400)
  assert.equal(refused.code, 'defaultBranch', 'the offending key is the code, so the page can point at the row')

  const stored = normalizeRepo(await store.repos.get('repo-1'))
  assert.equal(stored.sessionPrefix, 'web', 'the good field was not applied either')
})

test('a clear (null) is a write, and it survives a round trip', async () => {
  const { store, deps } = await depsWithProject()
  await updateProjectSettings(deps, { repoId: 'repo-1', patch: { autoReview: true } })
  const cleared = await updateProjectSettings(deps, { repoId: 'repo-1', patch: { autoReview: null } })
  assert.ok(cleared.ok)
  assert.equal(cleared.view.settings?.autoReview, null)
  assert.equal(normalizeRepo(await store.repos.get('repo-1')).autoReview, undefined)
})

test('a body without a patch object is refused with the shape it wants', async () => {
  const { deps } = await depsWithProject()
  for (const body of [{}, { patch: 'nope' }, { patch: [] }, null]) {
    const outcome = await updateProjectSettings(deps, body)
    assert.ok(!outcome.ok, `${JSON.stringify(body)} must be refused`)
    assert.equal(outcome.code, 'invalid-patch')
    assert.match(outcome.message, /"patch"/)
  }
})

test('a reconnect refreshes the facts and KEEPS the settings', async () => {
  // `orchestrator_repo_connect` is documented as idempotent and is invited to be re-run, so
  // without this a reconnect would silently wipe the branch prefix and the review override.
  const { store, deps } = await depsWithProject()
  await updateProjectSettings(deps, {
    repoId: 'repo-1',
    patch: { sessionPrefix: 'web', autoReview: false, workerAgentPreset: 'strict' },
  })
  const previous = await store.repos.get('repo-1')

  const again = await connectRepo({ run: preflightRun, rootPath: '/code/widgets', previous, id: 'repo-1', now: 1000 })
  assert.ok(again.ok)
  assert.equal(again.repo.sessionPrefix, 'web')
  assert.equal(again.repo.autoReview, false)
  assert.equal(again.repo.workerAgentPreset, 'strict')
  assert.equal(again.repo.defaultBranch, 'main', 'and the detected facts are still refreshed')
  assert.equal(again.repo.defaultBranchDetected, true)

  // The repository is re-connected but its id is reused, so the issues pointing at it are
  // not orphaned.
  assert.equal(again.repo.id, 'repo-1')
  assert.equal(deps.config.defaultRepo, '', 'the fixture config is untouched by a write')
})

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function fakeResponse(): { response: { writeHead(s: number, h?: Record<string, string>): void; end(b?: string): void }; out: FakeResponse } {
  const out: FakeResponse = { status: 0, headers: {}, body: '' }
  return {
    out,
    response: {
      writeHead(status, headers) {
        out.status = status
        out.headers = headers ?? {}
      },
      end(body) {
        out.body = body ?? ''
      },
    },
  }
}

/**
 * A request whose body arrives on a MICROTASK.
 *
 * That is exactly how a socket behaves from the handler's point of view: the listeners are
 * attached before any byte is delivered. Emitting synchronously in the constructor would
 * deliver the body before `readJsonBody` had subscribed, and the route would look correct
 * while never seeing a body at all.
 */
function fakeRequest(options: { method?: string; url?: string; body?: string; destroy?: () => void }) {
  const listeners = new Map<string, Array<(argument?: unknown) => void>>()
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? '/dsho/api/settings',
    on(event: 'data' | 'end' | 'error', listener: (argument?: unknown) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return request
    },
    destroy() {
      options.destroy?.()
    },
  }
  const emit = (event: string, argument?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(argument)
  }
  if (options.body !== undefined) {
    queueMicrotask(() => {
      emit('data', options.body)
      emit('end')
    })
  }
  return request
}

test('GET answers the payload as JSON, uncached', async () => {
  const { deps } = await depsWithProject()
  const { response, out } = fakeResponse()
  await handleSettingsGet(deps, fakeRequest({}), response)
  assert.equal(out.status, 200)
  assert.equal(out.headers['cache-control'], 'no-store')
  assert.equal(out.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(out.body) as { project?: { repository?: string } }
  assert.equal(body.project?.repository, 'acme/widgets')
})

test('GET carries repoId through the query string', async () => {
  assert.equal(repoIdFromUrl('/dsho/api/settings?repoId=repo-2'), 'repo-2')
  assert.equal(repoIdFromUrl('/dsho/api/settings'), '')
  assert.equal(repoIdFromUrl(undefined), '')

  const { deps } = await depsWithProject()
  const { response, out } = fakeResponse()
  await handleSettingsGet(deps, fakeRequest({ url: '/dsho/api/settings?repoId=nope' }), response)
  assert.equal(out.status, 404, 'an unknown project is answered as an error, not as an empty payload')
})

test('POST applies a patch', async () => {
  const { deps } = await depsWithProject()
  const { response, out } = fakeResponse()
  await handleSettingsPost(deps, fakeRequest({ method: 'POST', body: JSON.stringify({ repoId: 'repo-1', patch: { sessionPrefix: 'api' } }) }), response)
  assert.equal(out.status, 200)
  assert.equal((JSON.parse(out.body) as { settings?: { sessionPrefix?: string } }).settings?.sessionPrefix, 'api')
})

test('POST answers a malformed body with 400, not a thrown 400 by accident', async () => {
  const { deps } = await depsWithProject()
  const { response, out } = fakeResponse()
  await handleSettingsPost(deps, fakeRequest({ method: 'POST', body: '{oh no' }), response)
  assert.equal(out.status, 400)
  assert.equal((JSON.parse(out.body) as { error?: string }).error, 'invalid-json')
})

test('an oversized body is refused before it is buffered, and the socket is dropped', async () => {
  // A route that buffers whatever arrives can be made to allocate without limit.
  const { deps } = await depsWithProject()
  const { response, out } = fakeResponse()
  let destroyed = false
  const huge = `{"patch":{"sessionPrefix":"${'x'.repeat(MAX_SETTINGS_BODY_BYTES)}"}}`
  await handleSettingsPost(deps, fakeRequest({ method: 'POST', body: huge, destroy: () => { destroyed = true } }), response)
  assert.equal(out.status, 413)
  assert.equal((JSON.parse(out.body) as { error?: string }).error, 'body-too-large')
  assert.ok(destroyed, 'the connection is dropped rather than drained')
})

test('the board snapshot publishes the projects, oldest first', async () => {
  // The panel names the project whose menu it shows, and it does that from the poll it
  // already makes rather than a second request.
  const { store, deps } = await depsWithProject()
  const second = await connectRepo({ run: preflightRun, rootPath: '/code/other', id: 'repo-2', now: 2000 })
  assert.ok(second.ok)
  await store.repos.put(second.repo.id, second.repo)

  const board = await buildBoard({ store: deps.store, config: deps.config })
  assert.deepEqual(
    board.projects.map((project) => project.repository),
    ['acme/widgets', 'acme/widgets'],
  )
  assert.deepEqual(
    board.projects.map((project) => project.id),
    ['repo-1', 'repo-2'],
  )
})

test('the configured project is FIRST in the snapshot, so the header and the dialog agree', async () => {
  // The panel labels its menu with the first project and opens the dialog for THAT project.
  // If the snapshot ordered by age while the settings route preferred `defaultRepo`, the
  // header would name one project and the dialog would edit another -- with no visible sign.
  const { store, deps } = await depsWithProject()
  const second = await connectRepo({ run: preflightRun, rootPath: '/code/other', id: 'repo-2', now: 2000 })
  assert.ok(second.ok)
  await store.repos.put(second.repo.id, second.repo)

  const configured = normalizePluginConfig({ defaultRepo: '/code/other' })
  const board = await buildBoard({ store: deps.store, config: configured })
  assert.deepEqual(
    board.projects.map((project) => project.id),
    ['repo-2', 'repo-1'],
    'the configured defaultRepo leads, and the rest stay in age order',
  )

  // And the same rule answers for the settings route when it is asked to choose.
  const outcome = await readSettingsView({ store: deps.store, config: configured })
  assert.ok(outcome.ok)
  assert.equal(outcome.view.project?.id, board.projects[0]?.id, 'one rule, two readers')
})
