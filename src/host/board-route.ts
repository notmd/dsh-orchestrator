/**
 * `/dsho/api/board` — the board's read endpoint (PRD §11.4).
 *
 * One snapshot endpoint, no per-card fan-out: the client fetches this once and
 * subscribes to one stream, rather than asking about each card in turn.
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

/** The response surface this route uses. */
export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

/** The route object the web server wants. */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: unknown, response: HttpResponseLike) => void | Promise<void>
}

/** The path the client reads, and the client's only coupling to the host. */
export const BOARD_ROUTE_PATH = '/dsho/api/board'

/** Serves the board as JSON. Exported so the shape is testable without a socket. */
export async function handleBoardRequest(
  deps: BoardDeps,
  response: HttpResponseLike,
): Promise<void> {
  try {
    const snapshot = await buildBoard(deps)
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
    handler: (_request, response) => handleBoardRequest(deps, response),
  }
}
