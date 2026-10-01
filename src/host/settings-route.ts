/**
 * `/dsho/api/settings` — the settings page's read and write endpoint (PRD §11.4).
 *
 * ## Why the write lives here and nowhere else
 *
 * Every surface that changes a project setting goes through
 * {@link updateProjectSettings}: this route, and nothing else. There is no second
 * implementation of the edit in the client, so the page cannot accept a value the
 * host would refuse — a whitespace branch, a prefix that is not a branch segment, a
 * key that does not exist. The client sends what the user typed and renders the
 * host's refusal verbatim.
 *
 * ## The body is bounded, and the bound is not decorative
 *
 * A route that buffers whatever arrives is a route that can be made to allocate
 * without limit. The cap is checked **before** the parse, and an oversized body is
 * answered with 413 and the connection dropped rather than being read to the end.
 *
 * ## Handlers answer their own errors
 *
 * Same rule as `./board-route.ts`: the web server answers a *throwing* handler with
 * 400 and a warning, and a 400 for a storage failure would be a lie. Every outcome
 * here is an explicit status with a JSON body naming the problem.
 *
 * @module dsho/host/settings-route
 */

import {
  readSettingsView,
  updateProjectSettings,
} from './settings-service.ts'
import type { SettingsDeps } from './settings-service.ts'
import type { HttpResponseLike } from './board-route.ts'

/**
 * The request slice this route uses.
 *
 * Declared structurally for the same reason {@link HttpResponseLike} is: the route is
 * exercised by a fake request in tests, without a socket and without a live service.
 */
export interface HttpRequestLike {
  method?: string
  url?: string
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  destroy?(): void
}

/** The path the client reads and writes. The settings page's only coupling to the host. */
export const SETTINGS_ROUTE_PATH = '/dsho/api/settings'

/**
 * The largest body this route will buffer.
 *
 * Generous for a settings patch (five scalar fields, the longest a path), and small
 * enough that a hostile or broken client cannot make the host hold a large buffer.
 */
export const MAX_SETTINGS_BODY_BYTES = 64 * 1024

/** Reads a JSON body, bounded. Returns a refusal rather than throwing. */
async function readJsonBody(
  request: HttpRequestLike,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = []
    let size = 0
    let settled = false
    const finish = (outcome: Parameters<typeof resolve>[0]): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    request.on('data', (chunk: unknown) => {
      if (settled) return
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      size += Buffer.byteLength(text)
      if (size > MAX_SETTINGS_BODY_BYTES) {
        // Dropped rather than drained: continuing to read a body the host has already
        // refused only spends the host's memory on the client's mistake.
        request.destroy?.()
        finish({
          ok: false,
          status: 413,
          code: 'body-too-large',
          message: `The request body is larger than ${MAX_SETTINGS_BODY_BYTES} bytes.`,
        })
        return
      }
      chunks.push(text)
    })
    request.on('end', () => {
      const raw = chunks.join('')
      if (raw.trim() === '') return finish({ ok: true, value: {} })
      try {
        finish({ ok: true, value: JSON.parse(raw) })
      } catch {
        finish({ ok: false, status: 400, code: 'invalid-json', message: 'The request body is not valid JSON.' })
      }
    })
    request.on('error', (error: unknown) => {
      finish({
        ok: false,
        status: 400,
        code: 'body-read-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  })
}

/** The `repoId` a GET carries in its query string. */
export function repoIdFromUrl(url: string | undefined): string {
  if (typeof url !== 'string') return ''
  const query = url.indexOf('?')
  if (query < 0) return ''
  for (const [key, value] of new URLSearchParams(url.slice(query + 1))) {
    if (key === 'repoId') return value
  }
  return ''
}

/** Serves the settings. Exported so the shape is testable without a socket. */
export async function handleSettingsGet(
  deps: SettingsDeps,
  request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  try {
    const outcome = await readSettingsView(deps, repoIdFromUrl(request.url))
    if (!outcome.ok) {
      send(response, outcome.status, { error: outcome.code, message: outcome.message })
      return
    }
    send(response, 200, outcome.view)
  } catch (error) {
    send(response, 500, {
      error: 'settings-unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Applies a patch. Exported for the same reason as the GET. */
export async function handleSettingsPost(
  deps: SettingsDeps,
  request: HttpRequestLike,
  response: HttpResponseLike,
): Promise<void> {
  const body = await readJsonBody(request)
  if (!body.ok) {
    send(response, body.status, { error: body.code, message: body.message })
    return
  }

  try {
    const outcome = await updateProjectSettings(deps, body.value)
    if (!outcome.ok) {
      send(response, outcome.status, { error: outcome.code, message: outcome.message })
      return
    }
    send(response, 200, outcome.view)
  } catch (error) {
    send(response, 500, {
      error: 'settings-write-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function send(response: HttpResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A settings payload is a live reading; a cached copy would let the page edit a
    // value the host has already changed.
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  response.end(text)
}

/** The route registration, for both methods on one path. */
export function createSettingsRoutes(deps: SettingsDeps): {
  kind: 'exact'
  path: string
  handler: (request: unknown, response: HttpResponseLike) => void | Promise<void>
}[] {
  const handler = (request: unknown, response: HttpResponseLike): void | Promise<void> => {
    const req = request as HttpRequestLike
    return (req.method ?? 'GET').toUpperCase() === 'POST'
      ? handleSettingsPost(deps, req, response)
      : handleSettingsGet(deps, req, response)
  }
  return [{ kind: 'exact', path: SETTINGS_ROUTE_PATH, handler }]
}
