/**
 * The worker spawner — creating one resumable root Session per issue.
 *
 * This is the single most important host technique in the plugin (PRD §6.2), and
 * it is a **transcription of the one audited implementation of it**: the recipe
 * `@deepseek-ai/dsh-webhook` uses to turn a webhook delivery into a live agent
 * session (`packages/webhook/webhook/src/session.ts`). Every step, and the order
 * of every step, is theirs. Where this file differs it says so.
 *
 * The recipe, and why each step is where it is:
 *
 *   1. **Validate before any `await`.** `permissionPresets.resolve()` throws on an
 *      unknown preset, and doing it first means an unusable configuration costs
 *      nothing rather than leaving a half-created session behind.
 *   2. **Resolve and acquire the agent-preset scope** before creating anything.
 *   3. **`signal.throwIfAborted()`** at each boundary — creation is cancellable,
 *      and a cancelled request must not leave a workspace or an agent.
 *   4. **Create the workspace** (canonicalizes via `fs.realpath`, and a session's
 *      `cwd` *is* its workspace path — see Appendix A4).
 *   5. **`agents.create()`** with `meta.cwd` pointing at that workspace.
 *   6. **Publish in order:** attach, permission, title, then prompt. The prompt is
 *      last because a worker that can be seen before it can act is better than one
 *      that acts before it is visible.
 *   7. **`followup()`** — not `inject()`, not `steer()`. `followup()` queues an
 *      ordinary turn and wakes the driver, which is what "start working" means.
 *      `inject()` would sit until other input arrived; `steer()` is consumed at the
 *      next step boundary of a *running* turn, which does not exist yet.
 *
 * **Rollback discipline, also theirs:** a failed `attachSession` disposes the
 * agent rather than leaking it, and a failure *during* rollback is logged without
 * replacing the original error. The original error is what the user needs.
 *
 * @module dsho/host/spawn
 */

/** A disposable lease on a resource. */
export interface Disposable {
  dispose(): void | Promise<void>
}

/** The live agent handle. Retained after spawn: it is how we detect idle and
 * deliver review feedback (PRD §7.3, §10.3). */
export interface AgentHandle {
  agent: AgentLike
  dispose(): Promise<void>
}

/** The slice of DSH's `Agent` this module uses. */
export interface AgentLike {
  readonly session: { readonly id?: string }
  readonly status?: 'idle' | 'running'
  followup(message: unknown): void
}

/** The slice of a DSH Workspace this module uses. */
export interface WorkspaceLike {
  readonly path: string
  attachSession(sessionId: string): Promise<void>
}

/** The message a spawned worker is woken with. */
export interface WorkerMessage {
  content: Array<{ type: 'text'; text: string }>
  source: { kind: string }
}

/** Everything the spawner needs from the host. */
export interface SpawnDeps {
  readonly permissionPresets: {
    /** Throws on an unknown preset. Called before any `await`. */
    resolve(name: string): unknown
    set(session: unknown, name: string): void
  }
  readonly agentPresets: {
    resolve(name: string): Promise<{ id: string }>
    acquireScope(id: string): Promise<Disposable>
    mount(agentCtx: unknown, id: string): Promise<void>
  }
  readonly workspaceRegistry: {
    create(path: string, title?: string): Promise<WorkspaceLike>
  }
  readonly sessionTitle: {
    rename(session: unknown, title: string): unknown
  }
  readonly agents: {
    create(options: {
      sessionId: string
      signal?: AbortSignal
      meta: { cwd: string; agentPreset: string }
      agentOptions?: unknown
      setup: (agentCtx: unknown) => Promise<void>
    }): Promise<AgentHandle>
  }
  /** Builds the user message. Injected so the message shape stays in one place. */
  userMessage(text: string): WorkerMessage
  readonly logger?: { warn(message: string, error?: unknown): void }
}

/** What to spawn. */
export interface SpawnRequest {
  /** The caller-generated, branded session id. */
  sessionId: string
  /** Absolute path to the worker's own worktree. Its `cwd`, and its workspace. */
  worktreePath: string
  /** The session title, e.g. `#3 Fix the flaky auth test`. */
  title: string
  /** The admitted first message: the worker contract plus the task. */
  prompt: string
  /** A `ctx.permissionPresets` name. `workspace-write` for a worker. */
  permissionPreset: string
  /** A `ctx.agentPresets` name. `standard` in Phase 1. */
  agentPreset: string
  agentOptions?: unknown
  signal?: AbortSignal
}

/** A spawned worker. */
export interface SpawnedWorker {
  sessionId: string
  title: string
  worktreePath: string
  handle: AgentHandle
  /**
   * The agent-preset scope lease.
   *
   * The reference adds this to the *calling function's* disposables, which frees
   * it when that function returns. That cannot be right for a worker that must
   * outlive the call, so the lease is returned to the caller instead, to be
   * released when the worker ends. **Flagged as needing confirmation in M0 spike
   * 2** — this is the one step of the recipe whose lifetime is not obvious from
   * the reference.
   */
  scope: Disposable | undefined
}

/**
 * Creates a worker session, or throws with nothing left behind.
 *
 * @throws The original error from any failed step, after rolling back.
 */
export async function spawnWorker(deps: SpawnDeps, request: SpawnRequest): Promise<SpawnedWorker> {
  // 1. Validate before any `await`: an unusable preset must cost nothing.
  deps.permissionPresets.resolve(request.permissionPreset)

  // 2. Resolve and lease the agent preset.
  const preset = await deps.agentPresets.resolve(request.agentPreset)
  const scope = await deps.agentPresets.acquireScope(preset.id)

  // 3./4./5. Cancellation, the workspace, and the agent — one rollback boundary.
  //
  // Every abort check is *inside* this boundary, which matters: the reference can
  // let `throwIfAborted()` escape here because its framework registers the lease
  // as a disposable resource and releases it when the enclosing scope unwinds. We
  // hand the lease to the caller instead, so an abort between acquiring it and
  // creating the agent would leak it. A test caught exactly that.
  let workspace: WorkspaceLike
  let handle: AgentHandle
  try {
    request.signal?.throwIfAborted()
    workspace = await deps.workspaceRegistry.create(request.worktreePath, request.title)
    request.signal?.throwIfAborted()
    handle = await deps.agents.create({
      sessionId: request.sessionId,
      ...(request.signal ? { signal: request.signal } : {}),
      meta: { cwd: workspace.path, agentPreset: preset.id },
      ...(request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {}),
      setup: async (agentCtx) => {
        await deps.agentPresets.mount(agentCtx, preset.id)
      },
    })
  } catch (cause) {
    await releaseScope(deps, scope, cause)
    throw cause
  }

  // 6. Publish: attach, permission, title — in that order.
  try {
    await workspace.attachSession(request.sessionId)
  } catch (cause) {
    // A spawn that cannot publish must not leave a live agent behind. The
    // original error survives any rollback failure: it is the one the user can
    // act on.
    await disposeQuietly(deps, handle, cause)
    await releaseScope(deps, scope, cause)
    throw cause
  }
  deps.permissionPresets.set(handle.agent.session, request.permissionPreset)
  deps.sessionTitle.rename(handle.agent.session, request.title)

  // 7. Wake it. `followup` queues an ordinary turn and wakes the driver.
  handle.agent.followup(deps.userMessage(request.prompt))

  return {
    sessionId: request.sessionId,
    title: request.title,
    worktreePath: workspace.path,
    handle,
    scope,
  }
}

/**
 * Releases a lease, containing a disposal failure.
 *
 * The reference logs a rollback failure "without replacing the original error" —
 * this is that rule. A second failure while cleaning up after a first one is
 * noise, and surfacing it would hide the cause the user needs.
 */
async function releaseScope(deps: SpawnDeps, scope: Disposable | undefined, cause: unknown): Promise<void> {
  if (!scope) return
  try {
    await scope.dispose()
  } catch (rollbackError) {
    deps.logger?.warn('orchestrator: releasing the agent-preset scope failed during rollback', {
      cause,
      rollbackError,
    })
  }
}

/** Disposes a handle, containing a disposal failure. See {@link releaseScope}. */
async function disposeQuietly(deps: SpawnDeps, handle: AgentHandle, cause: unknown): Promise<void> {
  try {
    await handle.dispose()
  } catch (rollbackError) {
    deps.logger?.warn('orchestrator: disposing the agent failed during rollback', {
      cause,
      rollbackError,
    })
  }
}
