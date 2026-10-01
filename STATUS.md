# STATUS — dsh-orchestrator

**This file is the handoff document.** Read it first; it is the only place that
records what is finished, what is next, and which decisions are deliberate. Keep
it updated **after every chunk of work**, and prune it when it grows — a stale or
bloated status file costs the next agent more than it saves.

| | |
|---|---|
| **Goal** | Implement [PRD.md](PRD.md) |
| **Plan source** | [PRD.md §16 Milestones](PRD.md#16-milestones), verified against [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| **Last updated** | 2026-10-01, chunk 2 |
| **Test command** | `node --test` (zero dependencies; Node 24) |
| **Current state** | 219 unit tests, all passing. The **entire pure-logic board core** — reducer, activity model, head-scoped review facts, and the review-loop scheduler — is done and ported from the reference implementation. **No plugin is installed yet** — no host half, no client half, no M0 spike run. |

---

## 1. Where we are, in one paragraph

The board's **truth logic is finished and proven**: the Kanban column/display-status
reducer, the activity model, the head-scoped review-run facts (both loop bounds),
and the review-loop scheduler (per-head planning, the five-check session gate, the
six head-skip conditions, the round cap) all exist as pure, dependency-free ES
modules with a large ported test suite. Nothing plugin-shaped exists yet: no
`index.js` host entry, no `client.js`, no tools, no storage, no routes, no UI. The
next chunk is attention/ordering (chunk 3), which completes the board's read model.

---

## 2. Done

### Chunk 1 — board core: the reducer

| Module | What it is |
|---|---|
| [`src/contract/activity.js`](src/contract/activity.js) | `ActivityState` vocabulary + `isSticky` / `needsInput`. Ported from AO `backend/internal/domain/activity.go`. |
| [`src/contract/status.js`](src/contract/status.js) | SCM enums (`CIState`, `ReviewDecision`, `Mergeability`), session-facts normalizer, `silentPastGrace`. Ported from AO `backend/pkg/contract/status.go`. |
| [`src/contract/kanban.js`](src/contract/kanban.js) | The column reducer, the display-status reducers, ranking, and the two labelled divergences. Ported from AO `backend/pkg/contract/kanban.go`. |
| [`src/review/runs.js`](src/review/runs.js) | Head-scoped `KanbanReviewRunFacts` + the two loop bounds. Shape ported from AO `backend/internal/service/session/kanban.go`. |

### Chunk 2 — board core: the review-loop scheduler

| Module | What it is |
|---|---|
| [`src/review/planner.js`](src/review/planner.js) | `plan(prs, runs)` → per-head `AOReviewState`; `sessionGate` (5 checks, 5 reason codes); `existingHeadReason` (6 skip conditions); `ineligibleReason`; `evaluateSession` → the heads a pass may start for; `evaluateManualRequest` → the user-forced override. Ported from AO `backend/internal/review/planner.go` + `backend/internal/autoreview/coordinator.go`. |

Test suites:

| Suite | Cases | Source |
|---|---|---|
| [`test/contract/kanban.test.js`](test/contract/kanban.test.js) | 78 | AO's own truth table, translated from `backend/pkg/contract/kanban_test.go` |
| [`test/contract/kanban-divergence.test.js`](test/contract/kanban-divergence.test.js) | 30 | New — both divergences asserted in both flag states |
| [`test/contract/activity.test.js`](test/contract/activity.test.js) | 6 | New — the three predicates |
| [`test/review/runs.test.js`](test/review/runs.test.js) | 28 | New — head pinning, both bounds, superseded-head context |
| [`test/review/planner.test.js`](test/review/planner.test.js) | 77 | New — the scheduler, every reason code, the manual override |

```bash
node --test            # 219 pass
node --test --watch    # while iterating
```

### Scaffolding

- `package.json` — bundle manifest declaring `dsh.bundle.patch`. Zero
  dependencies, **no build step** (the DSH guidance: "A Host-only bundle needs no
  dependencies, install scripts, or build tool"). Source is plain ESM JavaScript
  with JSDoc types; tests use the built-in `node:test`.
- `cordis.patch.yml` — inserts the `orchestrator` row.
- `LICENSE` (Apache-2.0, copied from the reference) and `NOTICE` — the
  attribution and statement-of-modifications the PRD §20 requires for ported code.
- `.gitignore` — `node_modules/`, `.dsho/`.

---

## 3. Next — ordered, with the reason for the order

Chunk numbers are this file's own; milestone letters are the PRD's.

| Chunk | Work | PRD | Why now |
|---|---|---|---|
| 3 | **Attention + ordering**: the needs-attention predicate (exactly three display statuses), `statusReadiness` short-circuit, `(needsAttention desc, updatedAt desc)` ordering stable across a no-op refresh, `isTerminated` gating. | §11.7, A28–A30 | Completes the board's read model before any transport exists. |
| 4 | **Config**: `Config` schema via `@deepseek-ai/schemastery`, per-repo fields, and the loud `agentRulesFile` validation (reject absolute paths and any `..` segment; a missing file is a hard spawn error). | §13, A31 | Spawn depends on it, so it must land before the spawner. |
| 5 | **Feedback classification**: actionability, bot detection by `__typename`/`User.Type` (never a login substring — `robothon` must not be a bot), per-comment dedup keys, signature round-trip, re-arm only on a definitive clear. | §10.3, A12 | M4's logic, testable offline. |
| 6 | **Host half**: `index.js` → `apply()`; `OrchestratorService` over `ctx.storageDomain`; `WorkerSpawner` using the exact `ctx.agents.create()` recipe; `WorktreeManager`; `GitHubGateway` over `ctx.subprocess` + `gh`; `PrObserver` loop; the tool table; `/dsho/api/*` + `/dsho/events` on `ctx.webServer`. | §6, §12, M1 | The first code that needs a live profile. |
| 7 | **Client half**: `client.js` in the `window.__ModuleLoader__` format, `sidebar.panellist` row + `main` keyed panel, lanes/cards/inspector, themes, locale, keyboard access. | §11, M2 | Needs the routes from chunk 6. |

### ⚠ Chunk 6/7 has an access problem that must be solved before it can be verified

**This session has no `plugin_manager` and no `cordis_inspect_query` tool, and
approval prompts are disabled** (an action needing approval is rejected
automatically). That is the documented install path — `plugin_manager` with
`action: install_bundle` — and the documented way to confirm a slot registration.
So chunks 6 and 7 can be *written* but **cannot be installed or verified from
here** as things stand.

Options, in order of preference:

1. **Ask the user to run one `install_bundle`** (or to enable the plugin-manager
   tool), then verify by refresh. This is the honest path and it is one action.
2. Verify the **client half inside the live page** through the Chrome DevTools MCP
   server, which *is* available: inject the client module and check the slot
   registry in the running GUI. This can prove the panel seat (R1) without an
   install, at the cost of touching the user's live session.
3. Verify the **host half** offline by unit-testing it against a fake `ctx`
   object, and defer installation.

**What was done instead, and why it is still real progress:** the slot
declarations were verified **from the installed artifacts**, which is evidence the
PRD itself treats as authoritative ("the installed `lib/types/*.d.ts` wins"). See
§3a below. That settles "do `main` and `sidebar.panellist` exist and who occupies
them?" — the part of R1 that can be settled without a running plugin. The part
that still needs a live install is "does a *third-party* bundle get to register
into them at activation time".

### 3a. Verified: the panel seat exists, is free, and has a shipped exemplar

Read from the installed packages under `~/.dsh/profiles/node_modules/@deepseek-ai/`.
The PRD's §6.1 claims hold, **and there is better news than the PRD expected**:
the exact pattern this board needs is already implemented and shipping.

| Claim | Evidence |
|---|---|
| `main` is a root-scoped **keyed** slot, declared by the layout's own `root` registration as `children: { main: { kind: 'keyed', scope: 'root' } }` | `dsh-client-ui-layout/lib/types/client/index.d.ts:53`, `dsh-client-ui-layout/lib/client.js:601` |
| `sidebar.panellist` is a root-scoped **list** whose docs say "Each list id addresses the matching main panel" | `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:46` |
| `sidebar` and `rightbar` are `single`, root-scoped, and **occupied** — do not touch them | `ui-sidebar`'s `SidebarRoot`; the layout d.ts marks both `OCCUPIED` |
| A registrant into `main` **may declare its own child slot** | `ui-conversation` registers `{ name: 'main', key: 'conversation', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } }` |
| The seat is **free** in the shipped composition and in this desktop profile | the only shipped `main` registrant besides the Conversation is `ui-schedule` (key `schedules`), and `dsh-web-app/cordis.patch.yml:370` sets `disabled: true` on it; `~/.dsh/profiles/desktop/cordis.patch.yml` does not re-enable it |

**The unplanned, most useful finding: `ui-schedule` is a shipped reference
implementation of exactly the seat the board needs.** It registers into `main`
with `key: 'schedules'`, and into `sidebar.panellist` with `id: 'schedules'`,
`order: 10`, `label: () => t('panel')` — the same `id` addressing the `main` key,
which is the pattern PRD §11.3 prescribes. It is disabled by default, so nothing
competes with us, but its source is the template to copy rather than a design to
invent. **Read `dsh-client-ui-schedule/lib/client.js` (~line 6790) before writing
the board's registration.**

This substantially de-risks **R1**, which the PRD called the highest-uncertainty
item in the project. What remains genuinely unverified is narrower than before:
only whether a *third-party* bundle (rather than a first-party one) is accepted
into `main` at activation, and whether `attachSession` tolerates a worktree path
whose repository root is a different workspace (Appendix A §A10 items 1–3).

---

## 4. Decisions taken while implementing (deltas from the PRD)

These are places where the PRD left room and the code had to choose. A continuing
agent should treat them as current intent and may overrule them deliberately, but
should not "fix" them by accident.

1. **Plain ESM JavaScript, no TypeScript, no build step.** Keeps the bundle
   dependency-free as DSH's host-plugin guidance requires, and keeps the client
   half hand-writable in the verified `window.__ModuleLoader__` format. JSDoc
   carries the types.

2. **Time is epoch milliseconds, not `Date`.** JSON-friendly across the
   host→client boundary and directly comparable, which the reducer's tie-breaks
   need.

3. **Go zero values are reproduced by explicit normalizers** (`sessionFacts()`,
   `prFacts()`, `reviewRunFacts()`). This is what lets AO's ported tests keep
   asserting AO's exact answers while the JS callers can omit fields.

4. **The `requireHumanApprovalBeforeReady` field defaults to `false` in the
   reducer** even though the *shipped config* default is `true`. The reducer's
   default is the AO-exact behaviour, so the flag's absence cannot silently
   change a ported case; the config layer (chunk 4) is what sets `true`. This is
   why all 78 ported cases pass unchanged.

5. **Row 5b is placed *before* row 4 (`pluginOwnsNextStep`).** The PRD's §7.6
   table implies the round-budget clause sits inside row 5, which is *after* row
   4. That ordering cannot satisfy A18: row 4 fires on
   `autoInjectReview && changesRequested`, which is the default configuration, so
   a changes-requested PR whose round budget ran out would keep claiming a loop
   that has stopped and would never be released from `Validating`. Placing the
   release before row 4 is what makes A18 reachable. See the `DIVERGENCE (row 5b)`
   comment in [`src/contract/kanban.js`](src/contract/kanban.js).

6. **Row 6's guard is `!externalReview.approved`, not a re-test of the aggregate
   `reviewDecision`.** Row 3 needs both, so a real human approval that GitHub's
   aggregate has not caught up with (a dismissed review, a review on an older
   commit) must still count as "a human approved". Re-testing the aggregate would
   downgrade that approval to `Needs human review`. There is a test for this.

7. **The escalation reason is suppressed for a head our pass approved.** If the
   round budget is spent but the *current* head was approved, the card waits on a
   human for the ordinary reason, and an escalation banner would claim automation
   stopped when the pass in fact succeeded.

8. **`noSignalGrace` uses AO's exact predicate** (`signalExpected && !hasSignal &&
   now - lastActivityAt > grace`), not the PRD §7.6 gloss
   (`now - max(lastSignalAt, lastObservedAt) > grace`). The PRD's version belongs
   in the **fact adapter** — the DSH→board translation layer that chunk 6 will
   write — where `lastActivityAt` should be computed as that `max()`. The reducer
   stays verbatim so the ported tests keep meaning what they mean.

---

## 5. Documented divergences from Agent Orchestrator

Exactly one behavioural divergence exists, in two rows of the reducer. Both are
gated on `requireHumanApprovalBeforeReady` (shipped default `true`), so setting it
`false` restores AO's exact behaviour — and that is asserted in both flag states
by [`test/contract/kanban-divergence.test.js`](test/contract/kanban-divergence.test.js).

| Row | Divergence | Why |
|---|---|---|
| 5b (new) | A halted automated loop — round budget spent, or three verdict-less automated passes on one head — releases the PR from `Validating` into `needs_review` / `Needs human review`. | PRD §7.5 + A18. AO has no round cap in its reducer, so its row 4 would claim a loop that has stopped. The general rule: **a lane may only claim an active loop while that loop is actually running.** |
| 6 (new) | An auto-review-approved PR with no human approval cannot reach `ready` on mergeability alone; it lands in `needs_review` / `Needs human review`. | PRD §7.6 + A17. AO's mergeability row would reach `Ready` with no human review, and the requested flow is explicit that human review comes first. |

Everything else in [`src/contract/kanban.js`](src/contract/kanban.js) is AO's
reducer verbatim.

---

## 6. Reference material available locally

The reference implementation is cloned on this machine and is the authority for
any "what does AO actually do" question — prose and code disagreed in the PRD's
own research pass, and the code won.

| | |
|---|---|
| **AO clone** | `/Users/notmd/dev/game/agent-orchestrator.ref` at commit `53ba1e8` |
| Reducer | `backend/pkg/contract/kanban.go`, tests in `kanban_test.go` |
| Activity | `backend/internal/domain/activity.go` |
| Status/enums | `backend/pkg/contract/status.go` |
| Planner | `backend/internal/review/planner.go` |
| Gating + reasons | `backend/internal/autoreview/coordinator.go` (`sessionGate`, `existingHeadReason`) |
| **DSH packages** | `~/.dsh/profiles/node_modules/@deepseek-ai/` — verified `0.1.7-rc.2`, cordis `4.0.4` |
| DSH plugin contract | [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) — every API, with its evidence |

**Do not guess a DSH API.** Read the installed `lib/types/*.d.ts`; where the
appendix and an upstream README disagree, the installed types win.

---

## 7. Open risks carried forward

- **R1 — the `main` keyed slot at activation.** Substantially de-risked: `main` is
  declared, root-scoped, keyed, free in this profile, and `ui-schedule` ships a
  working registration of exactly this pattern (§3a). The residual unknown is
  whether a *third-party* bundle is accepted there, which needs one install.
- **`ctx.agents.create()` outside `dsh-webhook`.** The API is public, but the
  shipped caller is `dsh-webhook` only; a hidden ordering requirement would
  invalidate the spawner (Appendix A §A10 item 2).
- **`attachSession` against a worktree whose repo root is a different
  workspace.** The contract says cwd must equal `path`; it says nothing about
  nested repositories or worktrees (Appendix A §A10 item 3).
- **SSE through `ctx.webServer.register`.** Plain HTTP is documented; streaming
  is not. The documented fallback is polling `/dsho/api/board` (Appendix A §A10
  item 5).
- **Install/verify access.** See the box in §3: this session cannot run
  `plugin_manager`, so chunks 6–7 need the user for installation, or verification
  through the Chrome DevTools MCP server.
