# Open questions — decisions needed before M1

Each item has a **recommendation**; answer by accepting it or overriding. Items marked 🔴 block the first milestone.

---

## 1. 🔴 Worker isolation model

DSH's `Workspace.attachSession()` requires a session's `cwd` to **equal** the workspace path, so one worktree per issue means one DSH Workspace per issue — visible as project rows in the sidebar.

| Option | Pro | Con |
|---|---|---|
| **A. Worktree + workspace per issue** *(recommended)* | True isolation; concurrent workers cannot collide; faithful to the reference; each worker's files are inspectable in place | Sidebar gains one row per active issue |
| B. One checkout, one workspace, workers serialized | Clean sidebar | No parallelism — kills the point |
| C. One checkout, one workspace, branch switching per worker | Some parallelism | Workers share a dirty tree; branch switches can destroy uncommitted work. Unsafe |

**Recommendation: A**, with `hideWorktreeWorkspaces: false` by default (better DSH integration: the user can open a worker's directory from the sidebar). Titles prefixed `#<n> …` so the rows group visually. Reversible later via the config flag.

> **Also needed:** what's the ceiling? `maxConcurrentWorkers: 2` is a guess. How many agents do you actually want running against one repo, and how much disk/RAM can worktrees consume?

---

## 2. 🔴 Where does merge happen?

AO exposes merge as an explicit user action (`POST /api/v1/prs/{id}/merge`, `ao pr merge`) but never merges automatically.

- **A. GitHub only** — the board shows `Ready`; you merge in GitHub; the observer picks it up.
- **B. GitHub + a user-only `Merge` button on the card** *(recommended)* — strictly a convenience; the action is never available to an agent tool.
- C. Allow the orchestrator agent to merge approved PRs — **not recommended**: it makes an irreversible, outward-facing change unattended.

**Recommendation: B.** Confirm you want the button, since it requires a repo-level "which merge method" setting (`squash` / `merge` / `rebase`).

---

## 3. 🔴 Plan gate default

- **A. `auto`** — fastest; you only see the plan in the session log.
- **B. `notify`** *(recommended)* — the worker proceeds, but the card flags the plan so you can redirect mid-flight.
- **C. `block`** — the worker stops after planning and waits for your approval.

**Recommendation: B** for a normal repo, **C** while you are building trust in the pipeline or working on anything destructive.

---

## 4. 🔴 Issue source of truth

You said *"using a normal deepseek session and create issues"*.

- **A. Local issues, canonical; GitHub issue optional mirror** *(recommended)* — no forge convention to learn; issues are created with full repo context in hand; the queue lives where the orchestrator can reason about priority.
- **B. GitHub issues canonical; DSH reads them** — matches AO's tracker intake, but requires you to leave DSH to file an issue, which contradicts the stated flow.
- C. Both writable, bidirectionally synced — a conflict-resolution problem you do not need.

**Recommendation: A.** Do you want the GitHub mirror at all? (It is one `gh issue create` and gives you a public record, but it is duplicate surface to keep in sync.)

---

## 5. Do you want the webhook ingress at all? — **now largely answered by evidence**

Verified in AO's clone: **their local daemon has no webhook code at all** (`grep -ril webhook backend/` matches three `doc.go` files, each listing it as out of scope; no HMAC or `X-Hub-Signature-256` anywhere in `backend/`). Webhooks exist only in their cloud, and even there a 30-second poller (`prstatus`) exists to *"recover pull request refreshes when GitHub webhooks fail or remain silent beyond the configured grace period."*

So the question is no longer "should we use webhooks" — it is "how much is 25 seconds of latency worth to you".

- **A. Polling only** *(recommended)* — no tunnel, no extra secret, no dedup table, self-healing after a restart. Worst-case latency is one `pollIntervalMs` (30 s), and realistically 1–2 minutes for the *review* path because AO gates auto-review on a 1-minute sweep plus a 1-minute worker-idle threshold.
- **B. Polling + webhook accelerator** — sub-second PR-change notification; requires exposing a loopback port through a TLS tunnel plus a shared secret.

**Recommendation: A for v1, B in M6 only if the latency actually annoys you.** The observer is authoritative either way, so this is a build-order question, not an architecture question.

---

## 6. Worker visibility

- **A. Root DSH session per worker, attached to a workspace** *(recommended)* — visible in the sidebar, resumable, steerable by you typing into it; the card's click target is the real DSH chat, so you get the full harness.
- **B. Subagents (invisible to the sidebar)** — cleaner sidebar, but you cannot reliably steer or inspect mid-flight, and the session log story is weaker.

**Recommendation: A.** Confirm that "one sidebar row per active worker" is acceptable (see Q1).

---

## 7. Scope: one repo or several?

The PRD specifies multi-repo (a `Repo` registry + a board that can filter by repo). If you only ever drive one repository, Phase-1 scope halves.

**Question:** one repo, or several? And should the board show all repos in one view, or be scoped per repo?

---

## 8. Auto-review defaults — **decided by you: ON**

You asked for AO's auto review after the PR opens, with human review after that. The PRD now defaults to:

| Flag | Default | Meaning |
|---|---|---|
| `autoReview` | `true` | The plugin's own reviewer runs on every PR head; the PR stays in `Validating` until its pass approves |
| `autoInjectReview` | `true` | `changes_requested` findings are routed back to the worker automatically, so the loop closes without you |
| `requireHumanApprovalBeforeReady` | `true` | An auto-review-approved PR lands in `In review` showing `Needs human review`, **not** `Ready` |

> **This is a divergence from AO, and it is deliberate.** AO's reducer lets an auto-review-approved, mergeable PR reach `Ready` without any human approval. You asked for human review *after* the automated pass, so I inserted a guaranteed gate ([PRD §7.6](../PRD.md) row 6). Set `requireHumanApprovalBeforeReady: false` for AO's exact behaviour. If AO-fidelity matters more than the gate, say so and I will flip it.

### Sub-decisions still open on this

**8a. Should the worker auto-address the reviewer's findings?** (`autoInjectReview`, default `true`.)

- **On** *(default, and what "worker should continue to iterate" implies)* — the loop runs `review → fix → re-review` until the reviewer approves or the cap trips. Costs more tokens; gets you a clean PR to review.
- **Off** — the reviewer still runs, but its findings sit on the card for *you* to triage, and you choose what the worker acts on. Cheaper, more control, more of your attention.

**8b. Is 3 review rounds the right cap?** (`maxReviewRounds`, default 3.) On exhaustion the PR is released from `Validating` into `In review` / `Needs human review` with a `Needs you` badge and the reason `review-round-limit`, and **all** automation stops. Too low and ordinary PRs escalate on a nitpick; too high and a bad reviewer burns budget. 3 is a starting guess, not a measured value — expect to tune it after the first real repo.

**8c. How strict should the reviewer be?** The reviewer contract ([PRD §12.5](../PRD.md)) sets an explicit bar: correctness, security, test coverage, and contract violations only — not style a linter covers. This is the highest-leverage knob in the whole design, because a reviewer that nitpicks drives every PR into the round cap. You will want to read the first few review passes and adjust the contract wording.

**8d. Review the reviewer.** The reviewer is a model given a diff and a contract. Its findings are visible on the card each round, so a bad reviewer is diagnosable rather than silent — but plan to spend time on the contract wording in M3.

### Sub-decisions added after reading AO's source

**8e. Where should the reviewer's findings live — plugin-internal only, or posted to the PR?** AO posts a **real GitHub review** with inline comments (always as `COMMENT`, because GitHub rejects `APPROVE`/`REQUEST_CHANGES` on your own PR) and carries the verdict out-of-band. The PRD now adopts this. It is strictly more useful — you can read the automated review on the PR next to your own — but it means **a bot writes to your PR**, and every automated round adds review noise to the PR's timeline. Say so if you would rather the reviewer stayed invisible to GitHub.

**8f. Are 3 failed passes per head the right retry allowance?** (`autoReviewFailedRetryLimit`, default 3.) Separate from `maxReviewRounds`. It bounds retries when the reviewer *errors* and produces no verdict — a flaky reviewer, not a disagreeing one. AO uses 3.

**8g. Should the worker be allowed to use DSH's `subagent` tool?** AO explicitly forbids its workers from using the runtime's built-in subagent/delegation tools, and instead routes parallel work through the orchestrator spawning more workers. **DSH is the opposite case**: `subagent` is native, and its work already shows up as a child session. The PRD recommends allowing `subagent` for read-only exploration but forbidding it for implementation, so parallel work stays attributable to an issue and a branch. This is a genuine design choice, not a port — confirm the policy.

**8h. Should the plugin post its own GitHub review at all, given the account-scoping constraint?** If your PRs are branch-protected to require an approving review, a `COMMENT` review does **not** satisfy that requirement — the automated pass can never unblock a protected branch on its own. That is correct behaviour (the human still approves), but it means the auto review adds information rather than satisfying branch protection. Worth confirming your repos' settings match that expectation.

**8i. One reviewer or several?** AO supports **N reviewers with different harnesses** against the same PR head (`Reviewers []ReviewerConfig`), each with independent verdict state and its own review runs, filtered by harness. Our v1 uses exactly one. With a DSH-only plugin the value is lower — AO's N-reviewer value comes from comparing *different harnesses*, which does not apply when every worker and reviewer is the same model. But a two-tier scheme is plausible: a cheap reviewer on every push, an expensive one before the human sees it. **Recommendation: one reviewer for v1**, with the `harness` field recorded on every `ReviewRun` so multi-reviewer later is a config change rather than a migration. Say so if you want two tiers from the start.

**8j. Is 90 seconds the right `noSignalGrace`?** AO's value. It is short because it measures from *spawn/restore* — it catches a session that never produced a first signal — not from last activity. If your workers take longer than 90 s to produce their first signal on a cold repo (dependency install, `postCreate`), you will see false `No signal` cards. The `postCreate` config (§13.1) is the usual fix rather than raising the grace.

---

## 9. Verification contract

The Verify stage needs to know what "passing" means per repo.

- Where should it read this from — a `dsho` config block, `package.json` scripts, `AGENTS.md`, or a plain field you fill in when connecting the repo?
- **Recommendation:** an explicit field on the repo connection (`verifyCommands: string[]`) with a suggested default detected from `package.json`/`Makefile`/`justfile` and shown for confirmation. No guessing at run time.

What are the actual commands for your first repo?

---

## 10. PR body and branch naming

Proposed, modelled on the reference's own PRs:

- **Branch:** `dsho/issue-<n>-<slug>` (AO uses `ao/agent-orchestrator-<issue#>/<slug>`)
- **PR title:** the issue title
- **PR body:** issue link, what changed, a diffstat, verification evidence (commands + outcome), and a "review focus" section

Acceptable? Any house convention (e.g. Conventional Commits subject) the worker must follow?

---

## 11. PR feedback: what counts as actionable?

Proposed, ported from the reference:

- Routed: `CHANGES_REQUESTED`, human unresolved line-anchored review comments, human issue comments, CI failure (if `autoInjectCI`), merge conflict.
- **Not** routed: bot-authored comments, resolved comments.
- Cap: 3 automated nudges per feedback key, then escalate to `Needs you`.

Confirm the bot-exclusion is right for you. If you use a review bot you *do* want to act on (a linter bot, say), that needs an allowlist.

---

## 12. Naming

`DSH Orchestrator` is a placeholder. Consequences: the plugin package name (`@local/dsh-orchestrator`), the two slot ids (`orchestrator`), the tool prefix (`orchestrator_*`), the route prefix (`/dsho/`), the branch prefix (`dsho/`), and the config filename (`.dsho/`).

Tool and route names are a compatibility surface once installed — better to settle the name now. Any preference?

---

## Decisions already made in the PRD (veto any of these)

| Decision | Rationale | § |
|---|---|---|
| Plugin bundle, not a daemon | DSH provides the process, HTTP server, agent runtime, persistence, and UI shell | 6 |
| Fetch routes + SSE for the client API, not Typert Remote | Remote requires a DSH source checkout and a `build:lib` step; a host-only bundle needs no build tool | 6.3 |
| `main` keyed slot + `sidebar.panellist` for the board | They are unoccupied in the shipped composition and are the intended full-page mechanism | 11.3 |
| Board placement is derived, never draggable | Manual placement would be a second, competing truth | 11.1 |
| Anthropic-style "attention zones" demoted to a badge | Keeps the useful pre-attentive signal without reviving the reference's stale lane model | 11.1 |
| `gh` CLI via `ctx.subprocess` for all GitHub I/O | Reuses the credential already on the machine; no App, no OAuth, no PAT store | 10.1 |
| Polling default; webhook opt-in | Local-only; no tunnel required; the reference's local path is explicitly polling-only | 10.2 |
| One worker session per issue, root + resumable | Visible, steerable, durable; matches the requested flow | 8 |
| Worker phase declared by an explicit protocol tool | Avoids guessing intent from prose; DSH's `AgentStatus` is only `idle`\|`running` | 12.2 |
| No agent tool for merging | Irreversible outward-facing action stays human-only | 10.1 |
| **Auto review runs on every PR head, before a human sees it** | Requested explicitly; mirrors AO's `AutoReview` loop | 7.5, 10.4 |
| **The reviewer is its own read-only session, not a subagent** | Independent context; an enforced `read-only` preset is a real boundary; a subagent would review inside the worker's own context | 7.5 |
| **Findings are routed back to the worker automatically** | Requested "worker should continue to iterate"; mirrors AO's `AutoInjectReview` | 10.3, 10.4 |
| **A human approval gates `Ready`** | Requested "human review will be after that". **A deliberate divergence from AO's reducer** — reversible via `requireHumanApprovalBeforeReady: false` | 7.6 |
| **The reviewer executes nothing** | AO forbids it in the reviewer prompt: a test run writes caches and snapshots into the shared worktree, polluting the diff under review | 12.5 |
| **The reviewer posts a real PR review as a comment** | GitHub rejects APPROVE/REQUEST_CHANGES on your own PR, so the verdict travels out-of-band via a protocol tool | 7.5 |
| **One `orchestrator_report` tool, not five** | Mirrors `ao report`: orthogonal `state` + `outputs`, with batching owned by the outbox rather than duplicated per tool | 10.5, 12.2 |
| **Worker reports go to a durable outbox, batched, into the orchestrator session** | Decouples production from delivery; the orchestrator conversation becomes where worker progress aggregates | 10.5 |
| **Branch naming is a namespace** (`dsho/issue-<n>/root`) | Makes PR attribution derivable from the branch name, so it survives a restart without an in-memory map | 9.2 |
| **Verified constants replace guesses** | `noSignalGrace` 90 s, review sweep/idle 1 min, failed-retry limit 3, report windows 1 h / 5 min / 3 min, `MaxReportTextCharacters` 1000 | 7.6, 10.4, 10.5, 13 |
| Reducer ported from the reference's `kanban.go` | Its precedence is the product's most valuable design asset | 7.6 |
