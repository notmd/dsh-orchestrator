# STATUS — dsh-orchestrator

**This file is the handoff document.** Read it first; it is the only place that
records what is finished, what is next, and which decisions are deliberate. Keep
it updated **after every chunk of work**, and prune it when it grows — a stale or
bloated status file costs the next agent more than it saves.

| | |
|---|---|
| **Goal** | Implement [PRD.md](PRD.md) |
| **Plan source** | [PRD.md §16 Milestones](PRD.md#16-milestones), verified against [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| **Last updated** | 2026-10-01, chunk 1 |
| **Test command** | `node --test` (zero dependencies; Node 24) |
| **Current state** | 137 unit tests, all passing. Pure-logic board core is done and ported from the reference implementation. **No plugin is installed yet** — no host half, no client half, no M0 spikes run. |

---

## 1. Where we are, in one paragraph

The board's **truth logic is finished and proven**: the Kanban column/display-status
reducer, the activity model, and the head-scoped review-run facts (including both
loop bounds) exist as pure, dependency-free ES modules with a large ported test
suite. Nothing plugin-shaped exists yet: no `index.js` host entry, no `client.js`,
no tools, no storage, no routes, no UI. The next chunk is the review-loop planner
(chunk 2), and the first thing that must touch a live DSH profile is the M0 spike
list.

---

## 2. Done

### Chunk 1 — board core (pure logic), ported and tested

| Module | What it is |
|---|---|
| [`src/contract/activity.js`](src/contract/activity.js) | `ActivityState` vocabulary + `isSticky` / `needsInput`. Ported from AO `backend/internal/domain/activity.go`. |
| [`src/contract/status.js`](src/contract/status.js) | SCM enums (`CIState`, `ReviewDecision`, `Mergeability`), session-facts normalizer, `silentPastGrace`. Ported from AO `backend/pkg/contract/status.go`. |
| [`src/contract/kanban.js`](src/contract/kanban.js) | The column reducer, the display-status reducers, ranking, and the two labelled divergences. Ported from AO `backend/pkg/contract/kanban.go`. |
| [`src/review/runs.js`](src/review/runs.js) | Head-scoped `KanbanReviewRunFacts` + the two loop bounds (`roundBudgetExhausted`, `failedRetryLimitReached`). Shape ported from AO `backend/internal/service/session/kanban.go`. |

Test suites:

| Suite | Cases | Source |
|---|---|---|
| [`test/contract/kanban.test.js`](test/contract/kanban.test.js) | 78 | AO's own truth table, translated from `backend/pkg/contract/kanban_test.go` |
| [`test/contract/kanban-divergence.test.js`](test/contract/kanban-divergence.test.js) | 30 | New — both divergences asserted in both flag states |
| [`test/contract/activity.test.js`](test/contract/activity.test.js) | 6 | New — the three predicates |
| [`test/review/runs.test.js`](test/review/runs.test.js) | 23 | New — head pinning, both bounds |

```bash
node --test            # 137 pass
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
| 2 | **Review-loop planner**: `plan(prs, runs)` → per-PR `needs_review · running · up_to_date · changes_requested · ineligible`, the `sessionGate` (5 checks, 5 reason codes), and `existingHeadReason` (the 6 skip conditions). Pure functions, fully testable offline. | §7.5, M3 | The last large pure-logic piece. It is what makes A13/A20 provable without a browser or a GitHub repo. |
| 3 | **Attention + ordering**: the needs-attention predicate (exactly three display statuses), `statusReadiness` short-circuit, `(needsAttention desc, updatedAt desc)` ordering stable across a no-op refresh, `isTerminated` gating. | §11.7, A28–A30 | Completes the board's read model before any transport exists. |
| 4 | **Config**: `Config` schema via `@deepseek-ai/schemastery`, per-repo fields, and the loud `agentRulesFile` validation (reject absolute paths and any `..` segment; a missing file is a hard spawn error). | §13, A31 | Spawn depends on it, so it must land before the spawner. |
| 5 | **Feedback classification**: actionability, bot detection by `__typename`/`User.Type` (never a login substring — `robothon` must not be a bot), per-comment dedup keys, signature round-trip, re-arm only on a definitive clear. | §10.3, A12 | M4's logic, testable offline. |
| 6 | **Host half**: `index.js` → `apply()`; `OrchestratorService` over `ctx.storageDomain`; `WorkerSpawner` using the exact `ctx.agents.create()` recipe; `WorktreeManager`; `GitHubGateway` over `ctx.subprocess` + `gh`; `PrObserver` loop; the tool table; `/dsho/api/*` + `/dsho/events` on `ctx.webServer`. | §6, §12, M1 | The first code that needs a live profile. |
| 7 | **Client half**: `client.js` in the `window.__ModuleLoader__` format, `sidebar.panellist` row + `main` keyed panel, lanes/cards/inspector, themes, locale, keyboard access. | §11, M2 | Needs the routes from chunk 6. |
| — | **M0 spikes**, run against this profile before chunk 6 grows | §16 | The four unknowns in Appendix A §A10. R1 (panel seat) is the highest-uncertainty item in the whole project, so the spikes should be pulled *earlier*, interleaved with chunks 2–3. |

**Recommended immediate next step:** M0 spike 1 (register `sidebar.panellist` +
`main` from a throwaway bundle and confirm both render), because a failure there
invalidates §11.3 of the PRD and would force a UI-surface redesign. It is also
cheap: a fixture bundle, one `plugin_manager install_bundle`, one page refresh.

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

- **R1 — the `main` keyed slot at activation.** The whole board UI rests on it,
  and it is unverified from a third-party bundle (Appendix A §A10 item 1). Spike
  it before building the UI.
- **`ctx.agents.create()` outside `dsh-webhook`.** The API is public, but the
  shipped caller is `dsh-webhook` only; a hidden ordering requirement would
  invalidate the spawner (Appendix A §A10 item 2).
- **`attachSession` against a worktree whose repo root is a different
  workspace.** The contract says cwd must equal `path`; it says nothing about
  nested repositories or worktrees (Appendix A §A10 item 3).
- **SSE through `ctx.webServer.register`.** Plain HTTP is documented; streaming
  is not. The documented fallback is polling `/dsho/api/board` (Appendix A §A10
  item 5).
