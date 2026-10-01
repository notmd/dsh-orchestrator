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
 * | `orchestrator_repo_connect` | next | `ctx.subprocess` (verify `gh` auth) |
 * | `orchestrator_issue_create` / `_list` / `_update` | next | `ctx.storageDomain` |
 * | `orchestrator_worker_start` / `_message` / `_stop` / `_attach_pr` | next | `ctx.agents` |
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
export function buildOrchestratorTools(config: PluginConfig): Array<ToolDescriptor<never, unknown>> {
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
  ]
  return tools
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
