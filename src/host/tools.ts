/**
 * The orchestrator tool table — the agent-facing surface (PRD §12.1).
 *
 * These tools ship in a **normal DSH session** (the user's), so the flow in PRD
 * §4.1 is expressible in plain language: *"create an issue to fix the flaky auth
 * test"*.
 *
 * ## What is here, and why only one tool
 *
 * The PRD's table has eleven tools, and ten of them need a service that does not
 * exist yet — the issue store, the worktree manager, the GitHub gateway. Shipping
 * a tool whose body says "not implemented" would be worse than not shipping it:
 * the model would call it, and the user would get a plausible-looking failure
 * from a tool that was never going to work.
 *
 * So the table grows **with** its services. Today it contains the one tool that is
 * fully backed by code that already exists, which also happens to be the most
 * useful thing to have during installation: a way to read back the resolved
 * configuration and confirm the three flags that define the requested flow.
 *
 * | Tool | Status | Blocked on |
 * |---|---|---|
 * | `orchestrator_config` | **shipped** | — |
 * | `orchestrator_repo_connect` | **shipped** | — |
 * | `orchestrator_issue_create` / `_list` / `_update` | **shipped** | — |
 * | `orchestrator_worker_start` | **shipped** | — |
 * | `orchestrator_report` (worker-side) | **shipped** | — |
 * | `orchestrator_worker_message` / `_stop` | **shipped** | — |
 * | `orchestrator_review_verdict` / `_review_failed` (reviewer-side) | **shipped** | — |
 * | `orchestrator_board` | **shipped** | — |
 * | `orchestrator_run_review` | **shipped** | — |
 * | `orchestrator_worker_start` / `_message` / `_stop` / `_attach_pr` | next | wiring the spawner into a tool |
 * | `orchestrator_board` | next | the issue + worker stores |
 * | `orchestrator_pr_sync` | next | the PR observer |
 * | `orchestrator_run_review` | next | the reviewer spawner |
 *
 * @module dsho/host/tools
 */

import { PLUGIN_DEFAULTS } from '../config/validate.ts'
import type { PluginConfig } from '../config/validate.ts'
import { defineTool } from './tool.ts'
import type { ToolDescriptor } from './tool.ts'
import { connectRepo, describeRepoConnect } from './repo.ts'
import { createIssueForTool, listIssuesForTool, updateIssueForTool } from './issues-service.ts'
import { messageWorkerForTool, startWorkerForTool, stopWorkerForTool } from './workers-service.ts'
import type { LiveWorkers } from './handle-registry.ts'
import { reportForTool } from './reports-service.ts'
import { reportReviewFailure, startReviewPass, submitVerdict } from './reviewer-service.ts'
import { buildBoard, renderBoard } from './board-service.ts'
import { OutputKind, ReportState } from '../domain/reports.ts'
import type { SpawnDeps } from './spawn.ts'
import { IssuePriority, IssueState } from '../domain/issues.ts'
import { normalizeWorker } from '../domain/workers.ts'
import type { Repo } from './repo.ts'
import type { LazyFactStore } from './store.ts'
import type { RunCommand } from './worktree.ts'

/**
 * The three flags that decide whether the requested flow happens (PRD §13).
 *
 * Named here because they are what `orchestrator_config` exists to confirm, and
 * because "is auto review actually on?" is the first question to ask when a PR
 * reaches a human without having been reviewed.
 */
export const REQUESTED_FLOW_FLAGS = ['autoReview', 'autoInjectReview', 'requireHumanApprovalBeforeReady'] as const

/** One line describing the divergence from AO's behaviour, for the tool output. */
const DIVERGENCE_NOTE =
  'requireHumanApprovalBeforeReady is our documented divergence from Agent Orchestrator: ' +
  'with it on, an auto-review-approved PR waits in In review / "Needs human review" ' +
  'instead of reaching Ready on mergeability alone.'

/**
 * Builds the orchestrator tools for one activation.
 *
 * Built per activation rather than exported as a static array, because the tools
 * close over the resolved configuration — and because a static array would tempt
 * a caller into registering a table that was never configured.
 */
export function buildOrchestratorTools(options: {
  config: PluginConfig
  /** The command seam. Supplied by the caller so this module stays testable. */
  run: RunCommand
  /** Opened on first use, so activation stays synchronous. */
  store: LazyFactStore
  /** The spawn recipe's dependencies, bound to the real services. */
  spawn: SpawnDeps
  /** Live handles, so a running worker can be messaged or stopped. */
  live?: LiveWorkers
}): Array<ToolDescriptor<never, unknown>> {
  const { config, run, store, spawn, live } = options
  const tools: Array<ToolDescriptor<never, unknown>> = [
    defineTool({
      name: 'orchestrator_config',
      description:
        'Read back the resolved DSH Orchestrator configuration for this session, including ' +
        'whether automated review, auto-injected review feedback, and the human-approval gate ' +
        'are on. Use it to confirm the plugin is installed and to answer "why did this PR ' +
        'reach me without an automated review?"',
      parameters: {},
      outputType: 'string',
      execute: () => describeConfig(config),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_repo_connect',
      description:
        'Register a local git checkout so workers can be spawned against it. Verifies that the ' +
        'path is a git work tree, that the worktree root is gitignored, and that `gh` is ' +
        'installed and authenticated. Call this before creating issues. Connecting an already ' +
        'connected repository is idempotent.',
      parameters: {
        path: {
          type: 'string',
          description: 'Absolute path to the local checkout. Defaults to the configured defaultRepo.',
        },
        worktreeRoot: {
          type: 'string',
          description: 'Where per-issue worktrees live, relative to the checkout. Defaults to .dsho/worktrees.',
        },
        verifyCommands: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The commands a worker must pass before opening a PR, e.g. ["pnpm typecheck", "pnpm test"].',
        },
      },
      outputType: 'string',
      execute: async (args) => connectRepoForTool({ config, run, store }, args),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_issue_create',
      description:
        'Create an issue: one unit of work for one worker. The repository is inferred when exactly ' +
        'one is connected, so a plain "create an issue to fix X" needs only a title. The issue is ' +
        'queued in `open` and appears on the board in Building until a worker is started.',
      parameters: {
        title: { type: 'string', required: true, description: 'What needs doing, in one line.' },
        body: { type: 'string', description: 'The full task description. Markdown is fine.' },
        repoId: {
          type: 'string',
          description: 'The connected repository id or path. Needed only when several are connected.',
        },
        priority: {
          type: 'string',
          enum: Object.values(IssuePriority),
          description: 'Queue order. Defaults to normal.',
        },
        labels: { type: 'array', items: { type: 'string' }, description: 'Free-form labels.' },
      },
      outputType: 'string',
      execute: async (args) => createIssueForTool({ store }, args as never),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_issue_list',
      description:
        'List issues in queue order — highest priority first, then oldest first, so nothing starves. ' +
        'Filter by state, repository, or owning worker.',
      parameters: {
        state: {
          type: 'string',
          enum: Object.values(IssueState),
          description: 'Only issues in this state.',
        },
        repoId: { type: 'string', description: 'Only issues in this repository.' },
        workerId: { type: 'string', description: 'Only issues worked by this worker.' },
      },
      outputType: 'string',
      execute: async (args) => listIssuesForTool({ store }, args as never),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_issue_update',
      description:
        'Edit an issue: title, body, priority, labels, or state. Re-sending the current values is a ' +
        'no-op and does not move the issue in the queue.',
      parameters: {
        id: { type: 'string', required: true, description: 'The issue id, e.g. iss-01J8ZQ…. ' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body.' },
        priority: { type: 'string', enum: Object.values(IssuePriority), description: 'New priority.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replaces the label list.' },
        state: { type: 'string', enum: Object.values(IssueState), description: 'New issue state.' },
      },
      outputType: 'string',
      execute: async (args) => updateIssueForTool({ store, run }, args as never),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_worker_start',
      description:
        'Start a worker on an issue: creates its own git worktree and branch, spawns a DSH ' +
        'session in it with the worker contract, and binds the two together. Pass an `issueId`, ' +
        'or a `title` for an ad-hoc task. One issue has one worker at a time.',
      parameters: {
        issueId: { type: 'string', description: 'The issue to work, e.g. iss-01J8ZQ….' },
        title: { type: 'string', description: 'For an ad-hoc task: what needs doing, in one line.' },
        description: { type: 'string', description: 'For an ad-hoc task: the full description.' },
        repoId: { type: 'string', description: 'For an ad-hoc task: which connected repository.' },
      },
      outputType: 'string',
      execute: async (args) => startWorkerForTool({ run, store, spawn, config }, args as never),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_report',
      description:
        'Report to the orchestrator. This is the only channel that reaches it, and the only source of ' +
        'phase truth: nothing is inferred from your transcript. Use `needs_input` when you are waiting ' +
        'on an answer, `stuck` when you cannot proceed without a decision, `done` when the task is ' +
        'finished. Attach an artifact as soon as it exists, not at the end.',
      parameters: {
        state: {
          type: 'string',
          enum: Object.values(ReportState),
          description: 'checkpoint | needs_input | stuck | done. Optional if you are only attaching an output.',
        },
        note: {
          type: 'string',
          description:
            'What changed, or the question you need answered. Be brief: report transitions, decisions, ' +
            'blockers, outputs and completion — not routine commands.',
        },
        outputs: {
          type: 'array',
          description: 'Things you produced.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: Object.values(OutputKind),
                required: true,
                description: 'artifact | pr_created | pr_reviewed.',
              },
              ref: {
                type: 'string',
                required: true,
                description: 'For artifact, a path; for pr_created, the pull-request number or URL.',
              },
            },
          },
        },
      },
      outputType: 'string',
      execute: async (args, exec) => reportForTool({ store, run }, args as never, exec?.agent?.session?.id),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_worker_message',
      description:
        'Send a follow-up turn to a worker: review feedback, a correction, an answer to its question. ' +
        'Queues an ordinary turn and wakes the worker. Only workers spawned in this process can be ' +
        'reached; a worker from before a restart must be reattached first.',
      parameters: {
        workerId: { type: 'string', required: true, description: 'The worker id, e.g. wrk-01J8ZQ….' },
        message: { type: 'string', required: true, description: 'What to tell the worker.' },
      },
      outputType: 'string',
      execute: async (args) =>
        messageWorkerForTool({ run, store, spawn, config, ...(live ? { live } : {}) }, args as never),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_worker_stop',
      description:
        "Stop a worker's active turn. Its session and worktree are left intact — stopping work is not " +
        'terminating a session, which is the user\'s act.',
      parameters: {
        workerId: { type: 'string', required: true, description: 'The worker id.' },
        reason: { type: 'string', description: 'Why, for the record.' },
      },
      outputType: 'string',
      execute: async (args) =>
        stopWorkerForTool({ run, store, spawn, config, ...(live ? { live } : {}) }, args as never),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_review_verdict',
      description:
        'Submit the machine verdict for the commit you reviewed. This is the ONLY thing that moves the ' +
        'board — prose is ignored, however clear it is. The commit is pinned by the plugin: a verdict ' +
        'naming another commit is rejected.',
      parameters: {
        verdict: {
          type: 'string',
          required: true,
          enum: ['approved', 'changes_requested'],
          description: 'approved | changes_requested.',
        },
        summary: { type: 'string', description: 'One paragraph of rationale.' },
        findings: {
          type: 'array',
          description: 'One entry per finding. Prefer a few high-confidence findings over nitpicks.',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', required: true, description: 'high | medium | low.' },
              path: { type: 'string', description: 'File the finding is on.' },
              line: { type: 'number', description: 'Line number.' },
              summary: { type: 'string', required: true, description: 'One line.' },
              detail: { type: 'string', required: true, description: 'What is wrong and why it matters.' },
            },
          },
        },
        githubReviewId: { type: 'string', description: 'The id of the PR review you posted.' },
        headSha: { type: 'string', description: 'The commit you reviewed. Must match the pinned one.' },
      },
      outputType: 'string',
      execute: async (args, exec) =>
        submitVerdict({ store, spawn, config, ...(live ? { live } : {}) }, args as never, exec?.agent?.session?.id),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_review_failed',
      description:
        'Report that you could not complete the review. The pass is retried (up to a limit per commit) ' +
        'rather than hanging the loop.',
      parameters: { reason: { type: 'string', description: 'Why the review could not be completed.' } },
      outputType: 'string',
      execute: async (args, exec) =>
        reportReviewFailure({ store, spawn, config, ...(live ? { live } : {}) }, args as never, exec?.agent?.session?.id),
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_run_review',
      description:
        'Force an extra review pass on a worker\'s current pull-request head, bypassing the ' +
        '"already reviewed this head" guard and the round cap. Use it when you want a second opinion ' +
        'on a commit the automated pass has already judged, or on one it gave up on. The run is ' +
        'recorded as manual, so it does not consume the automatic retry budget.',
      parameters: {
        workerId: {
          type: 'string',
          required: true,
          description: 'The worker whose pull request should be reviewed again, e.g. wrk-01J8ZQ….',
        },
      },
      outputType: 'string',
      execute: async (args) => {
        const wanted = (args as { workerId?: string }).workerId
        if (!wanted) return 'A workerId is required.'
        let stored
        try {
          stored = await (await store.get()).workers.get(wanted)
        } catch (error) {
          return `The plugin could not open its storage: ${error instanceof Error ? error.message : String(error)}`
        }
        if (stored === undefined) return `No worker with id ${JSON.stringify(wanted)}.`
        return startReviewPass({ store, spawn, config, ...(live ? { live } : {}) }, normalizeWorker(stored), {
          force: true,
        })
      },
    }) as ToolDescriptor<never, unknown>,

    defineTool({
      name: 'orchestrator_board',
      description:
        'Read the derived board: every worker, the lane it is in, what its card says, and whether it ' +
        'needs a person. This is the same reading the GUI shows — the board is derived from durable ' +
        'facts, never dragged, so there is nothing to keep in sync.',
      parameters: {
        format: {
          type: 'string',
          enum: ['summary', 'json'],
          description: 'summary (default) is readable; json is the whole snapshot.',
        },
      },
      outputType: 'string',
      execute: async (args) => {
        const snapshot = await buildBoard({
          store,
          config,
          ...(live
            ? {
                activityOf: (workerId: string) => {
                  const status = live.byWorker(workerId)?.handle.agent.status
                  return status === 'running' ? 'active' : status === 'idle' ? 'idle' : 'unknown'
                },
              }
            : {}),
        })
        return (args as { format?: string }).format === 'json'
          ? JSON.stringify(snapshot, null, 2)
          : renderBoard(snapshot)
      },
    }) as ToolDescriptor<never, unknown>,
  ]
  return tools
}

/** The `orchestrator_repo_connect` body, split out so it is testable directly. */
export async function connectRepoForTool(
  options: { config: PluginConfig; run: RunCommand; store: LazyFactStore },
  args: { path?: string; worktreeRoot?: string; verifyCommands?: readonly string[] },
): Promise<string> {
  const rootPath = (args.path ?? options.config.defaultRepo ?? '').trim()
  if (!rootPath) {
    return (
      'No repository path given, and no defaultRepo is configured.\n\n' +
      'Pass the absolute path to a local git checkout, or set `defaultRepo` in the plugin config.'
    )
  }

  let existing: Repo | undefined
  let store: Awaited<ReturnType<LazyFactStore['get']>> | undefined
  try {
    store = await options.store.get()
    // Idempotence: reconnecting the same checkout must reuse its record, or every
    // call would mint a new repo id and orphan the issues pointing at the old one.
    existing = (await store.repos.list()).filter(isRepoRecord).find((record) => record.rootPath === rootPath)
  } catch (error) {
    return (
      'The plugin could not open its storage, so the repository cannot be registered.\n\n' +
      `Storage error: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const result = await connectRepo({
    run: options.run,
    rootPath,
    ...(args.worktreeRoot ? { worktreeRoot: args.worktreeRoot } : {}),
    ...(args.verifyCommands ? { verifyCommands: args.verifyCommands } : {}),
    ...(existing ? { id: existing.id, now: existing.createdAt } : {}),
  })
  if (result.ok) await store.repos.put(result.repo.id, result.repo)
  return describeRepoConnect(result)
}

/** Narrows an opaque stored record to a `Repo` well enough to compare roots. */
function isRepoRecord(value: unknown): value is Repo {
  return typeof value === 'object' && value !== null && typeof (value as Repo).rootPath === 'string'
}

/**
 * Renders the resolved configuration as the text the model reads.
 *
 * Exported for the tests: the ordering and the flag wording are the substance of
 * the tool, so they are asserted rather than eyeballed.
 */
export function describeConfig(config: PluginConfig): string {
  const flags = REQUESTED_FLOW_FLAGS.map((flag) => {
    const value = config[flag]
    const defaulted = value === PLUGIN_DEFAULTS[flag] ? ' (default)' : ' (overridden)'
    return `  ${flag}: ${value}${defaulted}`
  })

  return [
    'DSH Orchestrator — resolved configuration',
    '',
    'Requested flow:',
    ...flags,
    '',
    DIVERGENCE_NOTE,
    '',
    'Loop bounds:',
    `  maxReviewRounds: ${config.maxReviewRounds}`,
    `  autoReviewFailedRetryLimit: ${config.autoReviewFailedRetryLimit}`,
    `  reviewSweepIntervalMs: ${config.reviewSweepIntervalMs}`,
    `  reviewIdleThresholdMs: ${config.reviewIdleThresholdMs}`,
    `  noSignalGraceMs: ${config.noSignalGraceMs}`,
    '',
    'Runtime:',
    `  pollIntervalMs: ${config.pollIntervalMs}`,
    `  maxConcurrentWorkers: ${config.maxConcurrentWorkers}`,
    `  workerPermissionPreset: ${config.workerPermissionPreset}`,
    `  reviewerPermissionPreset: ${config.reviewerPermissionPreset}`,
    `  planGate: ${config.planGate}`,
    `  defaultRepo: ${config.defaultRepo === '' ? '(none configured)' : config.defaultRepo}`,
    `  webhook: ${config.webhook.enabled ? `enabled (secret from ${config.webhook.secretEnv})` : 'disabled'}`,
  ].join('\n')
}


// ---------------------------------------------------------------------------
// Restricting the protocol tools to their session kinds (PRD §12.2)
// ---------------------------------------------------------------------------

/**
 * The worker-protocol tools, available only in a worker session.
 *
 * One tool, because `state` and `outputs` are orthogonal: `outputs` applies to any
 * state, so a worker can attach an artifact mid-task without changing what the board
 * thinks it is doing.
 */
export const WORKER_TOOLS: readonly string[] = ['orchestrator_report']

/** The reviewer-protocol tools, available only in a reviewer session. */
export const REVIEWER_TOOLS: readonly string[] = ['orchestrator_review_verdict', 'orchestrator_review_failed']

/**
 * Every tool this plugin registers. A constant rather than a derivation from the
 * table, because `restrictionFor` has to answer before anything is built -- and a
 * test asserts the two agree, so the constant cannot drift.
 */
export const ORCHESTRATOR_TOOL_NAMES: readonly string[] = [
  'orchestrator_config',
  'orchestrator_repo_connect',
  'orchestrator_issue_create',
  'orchestrator_issue_list',
  'orchestrator_issue_update',
  'orchestrator_worker_start',
  'orchestrator_worker_message',
  'orchestrator_worker_stop',
  'orchestrator_run_review',
  'orchestrator_board',
  'orchestrator_report',
  'orchestrator_review_verdict',
  'orchestrator_review_failed',
]

/**
 * The tools that belong to the user's own session: every orchestrator tool except
 * the two protocol groups, which are for workers and reviewers.
 */
export const USER_TOOLS: readonly string[] = ORCHESTRATOR_TOOL_NAMES.filter(
  (name) => !WORKER_TOOLS.includes(name) && !REVIEWER_TOOLS.includes(name),
)

/** The session kinds this plugin creates, and the default for everything else. */
export type SessionKind = 'worker' | 'reviewer' | 'other'

/**
 * Which kind of session an id belongs to.
 *
 * The prefixes are the plugin's own (`dsho-wrk-`, `dsho-rev-`), so this is a fact
 * about identities the plugin minted rather than a guess about someone else's.
 * Anything unrecognised is `other`, which is the **safe** default: a session we do
 * not recognise keeps its normal tools and is denied only the protocol tools.
 */
export function sessionKind(sessionId: string | undefined): SessionKind {
  if (typeof sessionId !== 'string') return 'other'
  if (sessionId.startsWith('dsho-wrk-')) return 'worker'
  if (sessionId.startsWith('dsho-rev-')) return 'reviewer'
  return 'other'
}

/**
 * The `deny` list for one kind of session.
 *
 * **A deny-list, never an allow-list.** `restrict` is a *global-tool mask* whose
 * `allow` means **keep only** — so an allow-list for a worker would strip `read`,
 * `bash` and `edit`, every tool the worker actually needs. Denying the protocol
 * groups leaves the ordinary surface untouched.
 */
export function restrictionFor(kind: SessionKind): { deny: string[] } {
  switch (kind) {
    case 'worker':
      return { deny: [...USER_TOOLS, ...REVIEWER_TOOLS] }
    case 'reviewer':
      return { deny: [...USER_TOOLS, ...WORKER_TOOLS] }
    default:
      return { deny: [...WORKER_TOOLS, ...REVIEWER_TOOLS] }
  }
}
