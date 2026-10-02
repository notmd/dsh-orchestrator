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
  /**
   * Cancels the active turn.
   *
   * The cause is the installed `AgentCancelCause`, read rather than guessed:
   * `{ kind: 'user' } | { kind: 'parent' } | { kind: 'hook', reason } |
   * { kind: 'disposed' }`. Note that **only `hook` carries a reason** — a
   * "reason" on a user cancellation is not part of the shape, so it is not passed.
   */
  cancel?(cause: { kind: string; reason?: string }, options?: unknown): void
}

/** The slice of a DSH Workspace this module uses. */
export interface WorkspaceLike {
  /** The registration id, for a caller that later removes the registration. */
  readonly id?: string
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
    /**
     * Removes a REGISTRATION; the directory and every session log are retained.
     *
     * OPTIONAL on purpose: a caller that only ever creates should not have to implement
     * removal, and a fake that does not offer it should still typecheck. Adding it as
     * required rippled into four unrelated fakes for no benefit.
     */
    delete?(id: string): Promise<boolean>
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
  /**
   * The deployment's default model route, for a worker whose caller named none.
   *
   * NOT optional in spirit. A created agent with no provider/model route cannot assemble a
   * prompt at all: the deployment persona is `You are a coding agent powered by the
   * {{model}} model.`, so `{{model}}` has no value and the worker's FIRST turn ends with
   * "prompt variable \"{{model}}\" has no value for this assembly (section
   * \"deployment:persona-prefix\")". The worker is then live, queued and completely inert —
   * the worst shape of failure, because every other signal says it started.
   *
   * Optional on the TYPE so a fake without it still compiles, and so a host that predates
   * the service degrades instead of refusing to activate. {@link resolveAgentOptions} warns
   * when the selection is missing, because that failure is otherwise silent at spawn time
   * and only shows up as a dead worker.
   */
  readonly agentDefaultModel?: {
    /** A detached `{ provider, model, reasoningEffort? }` for a newly created agent. */
    currentSelection(): AgentModelSelection | undefined
  }
  readonly logger?: { warn(message: string, error?: unknown): void }
}

/**
 * The provider/model route a created agent runs on.
 *
 * Both fields are required together: a route with a provider and no model is not a route,
 * and the prompt assembly needs the model to render `{{model}}`.
 */
export interface AgentModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** What to spawn. */
export interface SpawnRequest {
  /** The caller-generated, branded session id. */
  sessionId: string
  /** Absolute path to the worker's own worktree. Its `cwd`, and its workspace. */
  worktreePath: string
  /** Skip `attachSession`, so the worker stays out of the sidebar's grouping (R2). */
  hideFromWorkspace?: boolean
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
 * The `agentOptions` a worker is created with.
 *
 * Precedence: what the caller named, else the deployment's default selection. The second is
 * what makes an ordinary worker work at all — see {@link SpawnDeps.agentDefaultModel} for
 * what its absence costs.
 *
 * An empty `reasoningEffort` is OMITTED rather than passed through: the field is optional and
 * adapter-owned, and `''` is the ACP adapter's own sentinel for "provider default", which is
 * not the same statement as "no preference".
 */
export function resolveAgentOptions(
  deps: SpawnDeps,
  request: SpawnRequest,
): unknown {
  if (request.agentOptions !== undefined) return request.agentOptions

  const selection = deps.agentDefaultModel?.currentSelection()
  if (selection === undefined || selection.provider === '' || selection.model === '') {
    deps.logger?.warn(
      'orchestrator: no default model selection is available, so this worker was created ' +
        'without a provider/model route — its first turn will fail with a prompt-assembly ' +
        'error about {{model}}. Configure an `agent-default-model` row (provider and model) ' +
        'in the profile.',
    )
    return undefined
  }

  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined || selection.reasoningEffort === ''
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  }
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
    // Resolved before the create, so the warning names the problem at the moment the worker
    // is made rather than leaving a silent, inert agent behind.
    const agentOptions = resolveAgentOptions(deps, request)
    handle = await deps.agents.create({
      sessionId: request.sessionId,
      ...(request.signal ? { signal: request.signal } : {}),
      meta: { cwd: workspace.path, agentPreset: preset.id },
      ...(agentOptions !== undefined ? { agentOptions } : {}),
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
    // `hideWorktreeWorkspaces` — and the mechanism is NOT hiding, which is why this was
    // dead for so long. The PRD is specific: "keeps worker workspaces out of the repo's
    // session grouping by NOT ATTACHING them". The workspace registry offers no way to
    // hide an entry (`create(path, title)`, `list()`), so a search for a hiding API finds
    // nothing; the setting is obeyed by omitting the ATTACH.
    //
    // The cost is named in the PRD and is the reason the default is `false`: the worker
    // then has no DSH workspace grouping, so the board is the only way to reach it.
    if (request.hideFromWorkspace !== true) {
      await workspace.attachSession(request.sessionId)
    }
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
