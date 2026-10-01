/**
 * The connect route — the surface that makes a FIRST connection possible from the UI.
 *
 * The properties worth pinning down, each of which is a way this feature could be wrong
 * while looking right:
 *
 *   - the workspace list joins a registration to a project by PATH, and reports each as
 *     connected or not — the thing the board's own payload can never answer, because an
 *     unconnected project is absent from it by definition;
 *   - a connect goes through `connectRepo`, so a refusal carries the host's message that
 *     NAMES THE FIX rather than a bare status;
 *   - a reconnect is a REFRESH: the settings a person chose on the settings page survive it;
 *   - an install with no `list` on its registry still gets the list endpoint, empty, rather
 *     than a failure — a missing capability must not take the path field away.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizePluginConfig } from '../../src/config/validate.ts'
import { createMemoryFactStore, lazyFactStore } from '../../src/host/store.ts'
import { connectRepo } from '../../src/host/repo.ts'
import { updateProjectSettings } from '../../src/host/settings-service.ts'
import {
  CONNECT_ROUTE_PATH,
  WORKSPACES_ROUTE_PATH,
  createConnectRoutes,
  joinWorkspaces,
} from '../../src/host/connect-route.ts'
import type { ConnectDeps } from '../../src/host/connect-route.ts'
import { MAX_SETTINGS_BODY_BYTES, handleSettingsPost, readJsonBody } from '../../src/host/settings-route.ts'
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

/** A host that refuses at the first step, as a path outside a checkout does. */
const notARepoRun: RunCommand = async (argv) => {
  const joined = argv.join(' ')
  if (joined.startsWith('git rev-parse --is-inside-work-tree')) return result('false\n', 128)
  if (joined.startsWith('git check-ignore')) return result('', 0)
  return result('', 0)
}

function result(stdout = '', exitCode = 0): CommandResult {
  return { exitCode, stdout, stderr: '' }
}

/** Deps over an in-memory store, with a workspace registry that reports what it is given. */
async function deps(
  options: {
    config?: Record<string, unknown>
    workspaces?: Array<{ id: string; title?: string; path?: string }>
    /** Omit `list` entirely, as a host whose registry cannot enumerate. */
    noList?: boolean
    run?: RunCommand
  } = {},
): Promise<{ deps: ConnectDeps; store: ReturnType<typeof createMemoryFactStore> }> {
  const store = createMemoryFactStore()
  const connectDeps: ConnectDeps = {
    store: lazyFactStore(async () => store),
    config: normalizePluginConfig(options.config ?? {}),
    run: options.run ?? preflightRun,
    workspaces: options.noList === true ? {} : { list: () => options.workspaces ?? [] },
  }
  return { deps: connectDeps, store }
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

test('a workspace is reported connected by PATH, and unconnected otherwise', () => {
  const options = joinWorkspaces(
    [
      { id: 'w1', title: 'dsh-orchestrator', path: '/code/orchestrator' },
      { id: 'w2', title: 'DataLab', path: '/code/datalab' },
    ],
    [{ id: 'repo-1', repository: 'notmd/dsh-orchestrator', rootPath: '/code/orchestrator', defaultBranchDetected: true }],
  )

  assert.equal(options[0]?.repository, 'notmd/dsh-orchestrator', 'the connected one carries its repository')
  assert.equal(options[0]?.repoId, 'repo-1')
  assert.equal(options[1]?.repository, null, 'the other is offered, not claimed connected')
  assert.equal(options[1]?.repoId, null)
})

test('a workspace with no path is not offered, and a duplicate path is offered once', () => {
  // A registration with no path cannot be connected and cannot be labelled; offering it
  // would put a row in the panel whose button could only ever fail.
  const options = joinWorkspaces(
    [
      { id: 'w1', title: 'no path' },
      { id: 'w2', title: 'first', path: '/code/a' },
      { id: 'w3', title: 'again', path: '/code/a' },
      { id: 'w4', path: '/code/b' },
    ],
    [],
  )

  assert.deepEqual(
    options.map((option) => option.path),
    ['/code/a', '/code/b'],
  )
  assert.equal(options[1]?.title, '/code/b', 'an untitled workspace falls back to its path, never to an empty label')
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

/** A request whose body arrives on a MICROTASK, as a real socket's does. */
function fakeRequest(options: { method?: string; url?: string; body?: string; destroy?: () => void } = {}) {
  const listeners = new Map<string, Array<(argument?: unknown) => void>>()
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? WORKSPACES_ROUTE_PATH,
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

/** Drives one route by path, so the registration is what is exercised. */
async function call(deps: ConnectDeps, path: string, request: ReturnType<typeof fakeRequest>) {
  const route = createConnectRoutes(deps).find((candidate) => candidate.path === path)
  assert.ok(route, `a route is registered for ${path}`)
  const { response, out } = fakeResponse()
  await route.handler(request, response)
  return out
}

async function getWorkspaces(deps: ConnectDeps) {
  return call(deps, WORKSPACES_ROUTE_PATH, fakeRequest({ url: WORKSPACES_ROUTE_PATH }))
}

async function postConnect(deps: ConnectDeps, body: unknown) {
  return call(
    deps,
    CONNECT_ROUTE_PATH,
    fakeRequest({ method: 'POST', url: CONNECT_ROUTE_PATH, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  )
}

test('the read answers the workspaces AND the projects, uncached and as JSON', async () => {
  const { deps: connectDeps } = await deps({
    workspaces: [{ id: 'w1', title: 'orchestrator', path: '/code/orchestrator' }],
  })
  const out = await getWorkspaces(connectDeps)

  assert.equal(out.status, 200)
  assert.equal(out.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(out.headers['cache-control'], 'no-store', 'a live reading must not be cached')
  const payload = JSON.parse(out.body)
  assert.equal(payload.workspaces[0].path, '/code/orchestrator')
  assert.deepEqual(payload.projects, [], 'nothing is connected yet')
})

test('a registry that cannot list still answers, with no workspaces and no error', async () => {
  // A missing capability costs the one-click entries, not the panel: the path field is
  // still served, which is the difference between a degraded panel and no panel.
  const { deps: connectDeps } = await deps({ noList: true })
  const out = await getWorkspaces(connectDeps)

  assert.equal(out.status, 200)
  assert.deepEqual(JSON.parse(out.body).workspaces, [])
})

test('a connect stores the record and reports the project it made', async () => {
  const { deps: connectDeps, store } = await deps()
  const out = await postConnect(connectDeps, { path: '/code/orchestrator' })

  assert.equal(out.status, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, true)
  assert.match(payload.message, /Connected acme\/widgets/)
  assert.equal(payload.projects.length, 1, 'the answer carries the grown project list')
  assert.equal((await store.repos.list()).length, 1, 'and it was really written')
})

test('a refused connect answers 200 with the code and the host message that names the fix', async () => {
  // A REFUSAL is an answer, not a transport failure: the request was well-formed and the
  // host did what was asked. A 4xx here would make the dialog print a bare status for a
  // problem the user can actually fix.
  const { deps: connectDeps, store } = await deps({ run: notARepoRun })
  const out = await postConnect(connectDeps, { path: '/code/not-a-repo' })

  assert.equal(out.status, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'not-a-git-repository')
  assert.match(payload.message, /is not inside a git work tree/)
  assert.equal((await store.repos.list()).length, 0, 'a refusal writes NOTHING')
})

test('no path and no configured default is refused by name, not attempted with an empty string', async () => {
  const { deps: connectDeps } = await deps()
  const out = await postConnect(connectDeps, {})

  assert.equal(out.status, 200)
  assert.equal(JSON.parse(out.body).code, 'missing-path')
})

test('an absent path falls back to the configured defaultRepo', async () => {
  const { deps: connectDeps } = await deps({ config: { defaultRepo: '/code/orchestrator' } })
  const out = await postConnect(connectDeps, {})

  assert.equal(JSON.parse(out.body).ok, true)
})

test('a reconnect is a REFRESH: the settings a person chose survive it', async () => {
  // This is the regression the `previous` passthrough exists for. Without it, connecting
  // from the UI would silently wipe a branch prefix the settings page is the only place to
  // see — and nothing in the panel would say so.
  const { deps: connectDeps, store } = await deps()
  const first = await postConnect(connectDeps, { path: '/code/orchestrator' })
  const repoId = JSON.parse(first.body).projects[0].id

  const saved = await updateProjectSettings(connectDeps, { repoId, patch: { sessionPrefix: 'keep-me' } })
  assert.ok(saved.ok, 'the fixture saves a setting')

  const again = await postConnect(connectDeps, { path: '/code/orchestrator' })
  assert.equal(JSON.parse(again.body).ok, true)
  const stored = await store.repos.get(repoId)
  assert.equal((stored as { sessionPrefix?: string })?.sessionPrefix, 'keep-me')
  assert.equal((await store.repos.list()).length, 1, 'a reconnect does not create a second project')
})

test('the body cap is shared with the settings route, so a hostile body is refused once', async () => {
  // Two copies of a limit is one copy that gets raised and another that does not.
  const { deps: connectDeps } = await deps()
  let destroyed = false
  const huge = JSON.stringify({ path: 'x'.repeat(MAX_SETTINGS_BODY_BYTES + 1) })
  const out = await call(
    connectDeps,
    CONNECT_ROUTE_PATH,
    fakeRequest({ method: 'POST', url: CONNECT_ROUTE_PATH, body: huge, destroy: () => { destroyed = true } }),
  )

  assert.equal(out.status, 413)
  assert.equal(destroyed, true, 'the body is dropped rather than drained')
})

test('the settings reader exports the one bounded body reader both routes use', async () => {
  // A source-level guard, because the failure is invisible: a second reader in the connect
  // route would typecheck, pass every behavioural test above, and drift at the first
  // change to the limit.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../src/host/connect-route.ts', import.meta.url), 'utf8')
  assert.match(source, /readJsonBody.*from '\.\/settings-route\.ts'/, 'the connect route imports it')
  assert.match(source, /import \{ readJsonBody \} from '\.\/settings-route\.ts'/, 'rather than defining its own')
  assert.equal(typeof readJsonBody, 'function')
  assert.equal(typeof handleSettingsPost, 'function')
})
