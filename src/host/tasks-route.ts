/**
 * `/dsho/api/tasks` — the panel's new-task write (the reference's New-task flow).
 *
 * ## Why a route and not a tool
 *
 * A tool is reachable by the *model*; a person typing a brief into the board has no
 * session in the loop. The reference's New Task is a UI write, and the same rules
 * apply here as for the settings page: the client sends what the user typed, the
 * host is the only place a task is created, and the host's refusal is what the user
 * sees.
 *
 * ## The body is bounded before it is parsed
 *
 * `./settings-route.ts` already owns that reader and its limit, so this route reuses
 * it rather than growing a second one. On top of the byte bound there is a
 * character bound on the brief, which is the reference's own `maxPromptLen`
 * (16 KiB): a brief is a prompt, and a prompt that large is a pasted document.
 *
 * @module dsho/host/tasks-route
 */

import { createTaskWithWorker } from './tasks-service.ts'
import type { TaskDeps } from './tasks-service.ts'
import { readJsonBody } from './settings-route.ts'
import type { HttpRequestLike } from './settings-route.ts'
import type { HttpResponseLike, WebRouteLike } from './board-route.ts'

/** The path the panel writes to. Its only coupling to the host for this feature. */
export const TASKS_ROUTE_PATH = '/dsho/api/tasks'

/** The reference's prompt cap, adopted as the brief cap. */
export const MAX_TASK_BRIEF_CHARS = 16 * 1024

/** Answers a new task. Exported so the shape is testable without a socket. */
export async function handleTaskCreate(deps: TaskDeps, request: HttpRequestLike, response: HttpResponseLike): Promise<void> {
  const body = await readJsonBody(request)
  if (!body.ok) {
    send(response, body.status, { error: body.code, message: body.message })
    return
  }

  const value = (body.value ?? {}) as { repoId?: unknown; brief?: unknown }
  const brief = typeof value.brief === 'string' ? value.brief : ''
  if (brief.length > MAX_TASK_BRIEF_CHARS) {
    send(response, 413, {
      error: 'brief-too-long',
      message: `A task brief must be at most ${MAX_TASK_BRIEF_CHARS} characters, got ${brief.length}.`,
    })
    return
  }

  try {
    const outcome = await createTaskWithWorker(deps, {
      repoId: typeof value.repoId === 'string' ? value.repoId : '',
      brief,
    })
    // 202, not 201: the task exists, and the reference answers its own delegate with
    // Accepted for the same reason -- the WRITE is committed, while the naming of it
    // is still in flight.
    send(response, outcome.ok ? 202 : 400, outcome)
  } catch (error) {
    send(response, 500, {
      error: 'task-create-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function send(response: HttpResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A task read is stale the moment it exists; a cached copy would let the panel
    // report a card that the host has already moved on.
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  response.end(text)
}

/** The route registration. POST only: there is nothing to read at this path. */
export function createTaskRoutes(deps: TaskDeps): WebRouteLike[] {
  return [
    {
      kind: 'exact',
      path: TASKS_ROUTE_PATH,
      handler: (request, response) => {
        const req = request as HttpRequestLike
        if ((req.method ?? 'POST').toUpperCase() !== 'POST') {
          send(response, 405, { error: 'method-not-allowed', message: 'New tasks are created with POST.' })
          return
        }
        return handleTaskCreate(deps, req, response)
      },
    },
  ]
}
