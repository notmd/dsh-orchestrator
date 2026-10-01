/**
 * M0 spike — does the tool restriction actually take effect per session?
 *
 * `ctx.tools.get(name)` "returns the definition the scope resolves, or `undefined`
 * when none is visible", so a probe from an **agent's own scoped ctx** answers the
 * only question that matters: does this session see this tool? That is far better
 * than reading the session log, which buffers while the session is live.
 *
 * It creates two sessions — one with the plugin's worker prefix and one ordinary —
 * and probes both. Probes run on a delay, because the plugin's `agent/created`
 * listener and this spike's are not ordered relative to each other, and reading too
 * early would see the unrestricted view and report a false negative.
 *
 * @module dsho/spike/restrict-spike
 */

import { writeFileSync } from 'node:fs'

export const name = 'restrict-spike'

export const inject = ['agents', 'tools', 'agentPresets', 'permissionPresets', 'workspaceRegistry', 'sessionTitle']

const RESULT = '/tmp/dsho-restrict-result.json'
const CWD = '/tmp/dsho-restrict'
const steps: Array<{ step: string; detail?: unknown }> = []

function record(step: string, detail?: unknown): void {
  steps.push({ step, ...(detail === undefined ? {} : { detail }) })
  try {
    writeFileSync(RESULT, JSON.stringify({ steps }, null, 2))
  } catch {
    // Never take the host down over bookkeeping.
  }
}

interface ProbeContext {
  on?(event: string, listener: (...args: unknown[]) => void): () => void
  agents: {
    create(options: {
      sessionId: string
      meta: { cwd: string; agentPreset: string }
      setup: (agentCtx: unknown) => Promise<void>
    }): Promise<{ agent: { session?: { id?: string } } }>
  }
  agentPresets: {
    resolve(name: string): Promise<{ id: string }>
    acquireScope(id: string): Promise<unknown>
    mount(agentCtx: unknown, id: string): Promise<void>
  }
  workspaceRegistry: { create(path: string, title?: string): Promise<{ path: string }> }
  tools: { get(name: string, scope?: unknown): unknown }
}

interface Seen {
  sessionId: string
  kind: string
  report: unknown
  reviewVerdict: unknown
  issueCreate: unknown
  board: unknown
}

/**
 * The agents, held until the delayed probe. Probing AT creation would read whichever
 * view existed before the plugin's own listener ran, and report a false negative --
 * so the agents are kept and probed later, which is the whole point of the delay.
 */
const held: Array<{ sessionId: string; kind: string; agent: unknown }> = []

export function apply(ctx: ProbeContext): void {
  // Recorded at creation, probed later: reading the view immediately could beat the
  // plugin's own listener and see an unrestricted tool set.
  ctx.on?.('agent/created', (...args: unknown[]) => {
    // `{ agent, source, signal }`, not the agent.
    const payload = args[0] as {
      agent?: { session?: { id?: string }; ctx?: { tools?: { get?: (name: string, scope?: unknown) => unknown } } }
    }
    const agent = (payload?.agent ?? args[0]) as {
      session?: { id?: string }
      ctx?: { tools?: { get?: (name: string, scope?: unknown) => unknown } }
    }
    const id = agent?.session?.id ?? '(none)'
    const kind = id.startsWith('dsho-wrk-') ? 'worker' : id.startsWith('dsho-rev-') ? 'reviewer' : 'other'
    held.push({ sessionId: id, kind, agent })
    record(`created:${kind}`, { sessionId: id })
  })
  void run(ctx)
}

/** Whether the agent's own scope resolves a tool. */
function probe(agent: { ctx?: { tools?: { get?: (name: string, scope?: unknown) => unknown } } }, name: string): unknown {
  const get = agent?.ctx?.tools?.get
  if (typeof get !== 'function') return 'no-scoped-get'
  try {
    return get.call(agent?.ctx?.tools, name) !== undefined
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function run(ctx: ProbeContext): Promise<void> {
  record('begin')
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(CWD, { recursive: true })
    const workspace = await ctx.workspaceRegistry.create(CWD, 'restrict-spike')
    const preset = await ctx.agentPresets.resolve('standard')
    await ctx.agentPresets.acquireScope(preset.id)

    // Unique per run: sessions are DURABLE, so a fixed id fails the second run with
    // "session already exists" and no `agent/created` fires at all -- which is exactly
    // how the previous attempt produced an empty probe list.
    const stamp = String(Date.now())
    for (const [label, sessionId] of [
      ['worker', `dsho-wrk-${stamp}`],
      ['other', `restrict-spike-ordinary-${stamp}`],
    ] as const) {
      try {
        await ctx.agents.create({
          sessionId,
          meta: { cwd: workspace.path, agentPreset: preset.id },
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.id)
          },
        })
        record(`created-session:${label}`, { sessionId })
      } catch (error) {
        record(`created-session:${label}:failed`, {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Prove the probe is being applied, not guessed: re-probe after a delay, when the
    // plugin's own listener has certainly run.
    setTimeout(() => {
      // THE DISCRIMINATOR. Apply a restriction here, from the spike, to ONE session --
      // then probe. If `orchestrator_board` then reads as invisible for that session,
      // the probe works and the plugin's wiring is the problem. If it still reads
      // visible, the PROBE is wrong (get() resolving globally rather than per scope),
      // and the plugin's wiring may have been fine all along.
      const subject = held.find((entry) => entry.kind === 'other')
      if (subject) {
        const scoped = (subject.agent as { ctx?: { tools?: { restrict?: (f: { deny: string[] }) => unknown } } })?.ctx
        const restrict = scoped?.tools?.restrict
        if (typeof restrict === 'function') {
          try {
            const disposer = restrict.call(scoped?.tools, { deny: ['orchestrator_board'] })
            record('spike-applied-restriction', { returned: typeof disposer })
          } catch (error) {
            record('spike-applied-restriction:threw', {
              message: error instanceof Error ? error.message : String(error),
            })
          }
        } else {
          record('spike-applied-restriction:unavailable', { hasCtx: !!scoped, hasTools: !!scoped?.tools })
        }
      }

      // NUDGE A TURN. Tool availability is announced when the system prompt is
      // assembled, and a session that runs no turn never assembles one -- which is
      // why the earlier log held only permission/sandbox/approval records. A turn
      // that fails still assembles the prompt, so this does not depend on a model
      // answering.
      for (const entry of held) {
        const agent = entry.agent as { followup?: (m: unknown) => void }
        try {
          agent?.followup?.({ content: [{ type: 'text', text: 'reply with the single word: ok' }], source: { kind: 'user' } })
          record(`nudged:${entry.kind}`, { ok: true })
        } catch (error) {
          record(`nudged:${entry.kind}:failed`, { message: error instanceof Error ? error.message : String(error) })
        }
      }

      const probed: Seen[] = held.map((entry) => ({
        sessionId: entry.sessionId,
        kind: entry.kind,
        report: probe(entry.agent as never, 'orchestrator_report'),
        reviewVerdict: probe(entry.agent as never, 'orchestrator_review_verdict'),
        issueCreate: probe(entry.agent as never, 'orchestrator_issue_create'),
        board: probe(entry.agent as never, 'orchestrator_board'),
      }))
      record('probes', probed)
      finish()
    }, 22_000)
  } catch (error) {
    record('failed', { message: error instanceof Error ? error.message : String(error) })
    finish(false)
  }
}

function finish(ok = true): void {
  try {
    writeFileSync(RESULT, JSON.stringify({ ok, steps }, null, 2))
  } catch {
    // As above.
  }
}
