/**
 * `/dsho/api/workspaces` and `/dsho/api/connect` — the connect surface's endpoints.
 *
 * ## Why this exists at all
 *
 * Connecting a project was, until now, only reachable from a **session**:
 * `orchestrator_repo_connect` is a tool, and the board's rows and panels are built from
 * the host's *connected project list*. That is circular for a first run — with nothing
 * connected there are no rows, so there is no panel, so there is no settings dialog, so
 * there is nowhere to connect from. An install with an empty store renders **nothing at
 * all**, which reads as "the plugin does nothing" rather than "nothing is connected yet".
 *
 * This route closes the loop: it lets the UI enumerate the workspaces a person already
 * uses and offer to connect them, without an agent in the middle.
 *
 * ## The write goes through `connectRepo`, not a second implementation
 *
 * Same rule as `./settings-route.ts`: one implementation of the edit. `connectRepo`
 * already runs the whole preflight — git work tree, gitignored worktree root, `gh`
 * present and authenticated — and returns a refusal whose message **names the fix**.
 * Re-running it for a path that is already connected is a refresh, not a reset, because
 * the stored record is passed through as `previous`.
 *
 * ## A refusal answers 200, and that is deliberate
 *
 * `./settings-route.ts` answers a refusal with a status (`404` for a project that does
 * not exist) because that request asked about the wrong thing. A *connect attempt* is
 * different: the request is well-formed and the host did exactly what was asked — it
 * checked the path and the path did not qualify. That is an answer, not a transport
 * failure, so it comes back as `200 { ok: false, code, message }` and the dialog renders
 * the message inline next to the field the user just typed in. A `4xx` would make the
 * client's shared `failureMessage` path print a bare status for a fixable problem.
 *
 * @module dsho/host/connect-route
 */

import { connectRepo } from './repo.ts'
import type { RunCommand } from './worktree.ts'
import { listProjects, toProjectRef } from './settings-service.ts'
import type { ProjectRef, SettingsDeps } from './settings-service.ts'
import { readJsonBody } from './settings-route.ts'
import type { HttpRequestLike } from './settings-route.ts'
import type { HttpResponseLike } from './board-route.ts'

/** The workspace list. Read by the connect panel when it opens. */
export const WORKSPACES_ROUTE_PATH = '/dsho/api/workspaces'

/** The connect write. */
export const CONNECT_ROUTE_PATH = '/dsho/api/connect'

/** One workspace registration, as the registry reports it. */
export interface WorkspaceRecord {
  id: string
  title?: string
  path?: string
}

/**
 * The workspace registry, as far as listing is concerned.
 *
 * `list` is OPTIONAL, matching how `./spawn-deps.ts` treats `delete`: the real registry
 * has it, and a host that does not should leave the list empty rather than throw. A
 * missing list costs the user the one-click entries, not the path field — so the panel
 * stays useful.
 */
export interface WorkspaceListerLike {
  list?(): WorkspaceRecord[]
}

/** Everything this route needs. */
export interface ConnectDeps {
  store: SettingsDeps['store']
  config: SettingsDeps['config']
  run: RunCommand
  workspaces: WorkspaceListerLike
}

/** One workspace, joined with whatever is connected at its path. */
export interface WorkspaceOption {
  id: string
  title: string
  path: string
  /** `owner/name` of the connected project, or `null` when nothing is connected here. */
  repository: string | null
  /** The connected project's id, or `null`. */
  repoId: string | null
}

/** The read payload: every workspace, plus the connected projects for cross-reference. */
export interface WorkspacesView {
  workspaces: WorkspaceOption[]
  projects: ProjectRef[]
}

/** What a connect attempt answers with. */
export type ConnectOutcome =
  | { ok: true; message: string; projects: ProjectRef[] }
  | { ok: false; code: string; message: string; projects: ProjectRef[] }

/**
 * Every connected project, as the page reads it.
 *
 * A storage failure here is NOT swallowed into an empty list: "nothing is connected" and
 * "the store could not be read" look identical in the UI and mean opposite things, which
 * is the distinction `./board-route.ts` refuses to lose as well.
 */
async function readProjects(deps: ConnectDeps): Promise<ProjectRef[]> {
  const repos = await listProjects(deps)
  return repos.map(toProjectRef)
}

/**
 * Joins the registry's workspaces with the connected projects.
 *
 * The match is on `rootPath` because that is the path `connectRepo` was given, and it is
 * the only thing the two sides have in common — the registry knows nothing about GitHub
 * and the repo record knows nothing about workspace ids. A path is compared as the
 * registry spells it, so both sides are trimmed rather than normalized into a form
 * neither service would recognise.
 */
export function joinWorkspaces(
  records: readonly WorkspaceRecord[],
  projects: readonly ProjectRef[],
): WorkspaceOption[] {
  const byPath = new Map<string, ProjectRef>()
  for (const project of projects) byPath.set(project.rootPath.trim(), project)

  const seen = new Set<string>()
  const options: WorkspaceOption[] = []
  for (const record of records) {
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    // A registration with no path cannot be connected and cannot be labelled; it is not
    // an option. Skipping it here keeps the panel from offering a row that cannot work.
    if (path === '') continue
    if (seen.has(path)) continue
    seen.add(path)
    const project = byPath.get(path)
    options.push({
      id: typeof record.id === 'string' ? record.id : path,
      title: (typeof record.title === 'string' ? record.title.trim() : '') || path,
      path,
      repository: project?.repository ?? null,
      repoId: project?.id ?? null,
    })
  }
  return options
}

/** Serves the workspace list. Exported so the shape is testable without a socket. */
export async function handleWorkspacesGet(
  deps: ConnectDeps,
  _request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  try {
    const projects = await readProjects(deps)
    const options = joinWorkspaces(readWorkspaceRecords(deps), projects)
    send(response, 200, { workspaces: options, projects } satisfies WorkspacesView)
  } catch (error) {
    send(response, 500, {
      error: 'workspaces-unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Applies a connect. Exported for the same reason as the GET. */
export async function handleConnectPost(
  deps: ConnectDeps,
  request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  const body = await readJsonBody(request)
  if (!body.ok) {
    send(response, body.status, { error: body.code, message: body.message })
    return
  }

  const input = (body.value ?? {}) as Record<string, unknown>
  // An absent path falls back to the install's configured `defaultRepo`, which is what
  // the tool does. Both empty is a refusal the user can act on, not an empty-string
  // attempt that fails later inside git with a confusing message.
  const requested = typeof input.path === 'string' ? input.path.trim() : ''
  const rootPath = requested !== '' ? requested : (deps.config.defaultRepo ?? '').trim()

  try {
    if (rootPath === '') {
      send(response, 200, {
        ok: false,
        code: 'missing-path',
        message: 'A repository path is required. Type the absolute path to a local checkout.',
        projects: await readProjects(deps),
      } satisfies ConnectOutcome)
      return
    }

    const existing = (await readProjects(deps)).find((project) => project.rootPath.trim() === rootPath)
    const stored = existing === undefined ? undefined : await findStored(deps, existing.id)

    const worktreeRoot = typeof input.worktreeRoot === 'string' ? input.worktreeRoot : undefined
    const verifyCommands = Array.isArray(input.verifyCommands)
      ? input.verifyCommands.filter((entry): entry is string => typeof entry === 'string')
      : undefined

    const result = await connectRepo({
      run: deps.run,
      rootPath,
      ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
      ...(verifyCommands === undefined ? {} : { verifyCommands }),
      // A reconnect refreshes facts and KEEPS the settings the user chose. Without this,
      // connecting from the UI would silently wipe the branch prefix and intake switch
      // that the settings page is the only place to see.
      ...(stored === undefined ? {} : { previous: stored, id: existing!.id }),
    })

    if (!result.ok) {
      send(response, 200, {
        ok: false,
        code: result.reason,
        message: result.message,
        projects: await readProjects(deps),
      } satisfies ConnectOutcome)
      return
    }

    const store = await deps.store.get()
    await store.repos.put(result.repo.id, result.repo)

    const repository =
      result.repo.owner !== '' && result.repo.name !== ''
        ? `${result.repo.owner}/${result.repo.name}`
        : result.repo.rootPath
    send(response, 200, {
      ok: true,
      message: `Connected ${repository}.`,
      projects: await readProjects(deps),
    } satisfies ConnectOutcome)
  } catch (error) {
    send(response, 500, {
      error: 'connect-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** The raw stored record, so a reconnect can pass it through as `previous`. */
async function findStored(deps: ConnectDeps, id: string): Promise<unknown> {
  const store = await deps.store.get()
  return store.repos.get(id)
}

/** The registry's records, or none when the host exposes no list. */
export function readWorkspaceRecords(deps: ConnectDeps): WorkspaceRecord[] {
  const list = deps.workspaces.list
  if (typeof list !== 'function') return []
  try {
    const records = list.call(deps.workspaces)
    return Array.isArray(records) ? records : []
  } catch {
    // A registry that cannot list is not a reason to fail the read: the projects and the
    // path field are still worth serving, and the board's own route does not depend on it.
    return []
  }
}

function send(response: HttpResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A live reading: a cached copy would let the panel offer a project someone else has
    // already connected, or hide one that was just connected in another window.
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  response.end(text)
}

/** The route registrations, one per path. */
export function createConnectRoutes(deps: ConnectDeps): {
  kind: 'exact'
  path: string
  handler: (request: unknown, response: HttpResponseLike) => void | Promise<void>
}[] {
  return [
    {
      kind: 'exact',
      path: WORKSPACES_ROUTE_PATH,
      handler: (request, response) => handleWorkspacesGet(deps, request as HttpRequestLike, response),
    },
    {
      kind: 'exact',
      path: CONNECT_ROUTE_PATH,
      handler: (request, response) => handleConnectPost(deps, request as HttpRequestLike, response),
    },
  ]
}
