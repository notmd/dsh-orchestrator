/**
 * `/dsho/api/board` — the board's read endpoint (PRD §11.4).
 *
 * One snapshot endpoint, no per-card fan-out: the client fetches this once and
 * subscribes to one stream, rather than asking about each card in turn.
 *
 * ## One endpoint, scoped by a query parameter
 *
 * The page draws one board per project, so a read may name the project it wants with
 * `?repoId=<id>`; without it the answer is the whole install, which is what the project list
 * (and the `orchestrator_board` tool) needs. A second endpoint for the project list was the
 * alternative and was rejected: the list is already on every snapshot, and a scoped read still
 * carries every project, so one route serves both readers (see `BoardSnapshot.projects`).
 *
 * ## Why a plain Fetch route and not a Typert Remote API
 *
 * The PRD decides this (PRD §6.3): Remote needs `@Remote` decorators, generated
 * descriptors, and `pnpm run build:lib` — i.e. a DSH **source checkout and build
 * toolchain**. A feature-owned read endpoint is explicitly the supported
 * alternative, and it keeps the bundle installing from a plain directory.
 *
 * ## Handlers answer their own errors
 *
 * The web server answers a *throwing* handler with **400** and a warning, and it
 * never exits the process — but a 400 for a storage failure would be a lie, and it
 * would leave the client guessing. So every failure is caught here and answered
 * explicitly: `500` with a JSON body naming the problem. The client can then show
 * an error state instead of an empty board, which is the difference between "the
 * plugin is broken" and "there are no workers".
 *
 * ## Same-origin, loopback, no auth of its own
 *
 * The web server carries no TLS, authentication, or origin policy (Appendix A5), so
 * this route inherits the GUI's own auth gate. It must never be exposed on
 * `0.0.0.0` without one.
 *
 * @module dsho/host/board-route
 */

import { buildBoard } from './board-service.ts'
import type { BoardDeps } from './board-service.ts'
import { repoIdFromUrl } from './settings-route.ts'

/** The response surface this route uses. */
export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

/** The request surface this route uses. Only the URL matters, and only for `?repoId=`. */
export interface HttpRequestLike {
  url?: string
}

/** The route object the web server wants. */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: unknown, response: HttpResponseLike) => void | Promise<void>
}

/** The path the client reads, and the client's only coupling to the host. */
export const BOARD_ROUTE_PATH = '/dsho/api/board'

/**
 * Serves the board as JSON — every project, or the one named by `?repoId=`.
 *
 * Exported so the shape is testable without a socket, with the scope passed **explicitly**
 * rather than read from a request object: the URL parsing is the route's job (see
 * {@link createBoardRoute}), so this function stays a pure "answer this question".
 */
export async function handleBoardRequest(
  deps: BoardDeps,
  response: HttpResponseLike,
  repoId = '',
): Promise<void> {
  try {
    const snapshot = await buildBoard(deps, { repoId })
    send(response, 200, snapshot)
  } catch (error) {
    // Explicit, not a throw-to-400: a storage failure is not a bad request.
    send(response, 500, {
      error: 'board-unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function send(response: HttpResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The board is derived from live facts, so a cached copy is a stale board --
    // which is the one thing this endpoint must never serve.
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  response.end(text)
}

/** The route registration. */
export function createBoardRoute(deps: BoardDeps): WebRouteLike {
  return {
    kind: 'exact',
    path: BOARD_ROUTE_PATH,
    handler: (request, response) => handleBoardRequest(deps, response, repoIdOf(request)),
  }
}

/**
 * The `repoId` a board read carries in its query string.
 *
 * The same parameter name the settings route uses, from the same reader, so the page has one
 * spelling for "which project" across both endpoints. Absent or malformed is `''` — every
 * project — rather than an error: the unscoped board is a real answer, and a bad query string
 * must not turn into a panel that can only say "500".
 */
export function repoIdOf(request: unknown): string {
  const url = (request as HttpRequestLike | undefined)?.url
  return repoIdFromUrl(typeof url === 'string' ? url : undefined)
}
