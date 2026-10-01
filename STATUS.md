# STATUS — dsh-orchestrator

**This file is the handoff document.** Read it first; it is the only place that
records what is finished, what is next, and which decisions are deliberate. Keep
it updated **after every chunk of work**, and prune it when it grows — a stale or
bloated status file costs the next agent more than it saves.

| | |
|---|---|
| **Goal** | Implement [PRD.md](PRD.md) |
| **Plan source** | [PRD.md §16 Milestones](PRD.md#16-milestones), verified against [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| **Last updated** | 2026-10-01, chunk 6b (worker spawner) |
| **Verify** | `npm run verify` → typecheck (src) + `node --test` + build · **all three green** |
| **Current state** | **The plugin installs and activates in DSH, and the worker-spawn recipe is written and unit-tested.** 370 tests pass; `tsc` reports **0 errors across `src/` and `test/`**; `npm run build` emits `dist/`. M0 spike 1 is done (panel seat proven) and the host entry is live with one real tool. The services behind it (issue store, spawner, observer, routes) and the whole client half are still to come. |

---

## 1. Where we are, in one paragraph

The board's **read model is finished and proven in TypeScript** — what column a
card sits in, what it says, whether it pulses, what order cards appear in, what
the review-loop scheduler will do next — plus configuration with its loud
`agentRulesFile` validation. Every module is ported from the reference
implementation and covered by a large ported test suite. **M0 spike 1 is done**:
a third-party bundle really does get the `main` panel seat and a
`sidebar.panellist` row, verified in a live GUI. What does not exist yet: the host
half (`index.js`, services, tools, storage, routes) and the client half (the
board UI). Next is chunk 6, the host half, preceded by the small fence-repair in
§3.

---

## 2. Done

### Chunk 5 — TypeScript migration (hard requirement, round 2)

| | |
|---|---|
| Source | `src/**/*.ts` — all seven modules converted, real annotations replacing the old JSDoc typedefs |
| Types | Every enum-ish const also exports its union type, derived with `(typeof X)[keyof typeof X]` — no separate types file, so the ported files stay comparable to their Go originals |
| Tests | `test/**/*.test.ts` — renamed, import specifiers repointed |
| Config | `tsconfig.json` (all files, noEmit), `tsconfig.src.json` (src only, the `typecheck` gate), `tsconfig.build.json` (emit to `dist/`) |
| Tooling | `typescript@6.0.3` + `@types/node` as devDependencies (registry reachable, verified) |

**Why the tests still need no dependencies:** Node 24.11.1 strips types natively,
so `node --test` runs `.ts` test files directly. Verified before migrating.

**Why imports say `./activity.ts`:** `tsc` is configured with
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so the source
uses real `.ts` specifiers (which is what Node's stripper needs) and the **emit
rewrites them to `.js`** (verified in `dist/contract/kanban.js`). This is the
trick that makes one source tree serve both the test runner and the shipped
bundle.

Verified: `src/` typecheck **0 errors**; **342/342 tests pass**;
`npm run build` emits `dist/**/*.js` and the output imports and runs.

### Chunks 1–4 — see git history

The reducer, activity model, session status, head-scoped review facts, review-loop
scheduler, card presentation, and configuration. All ported from AO at `53ba1e8`;
78 + 37 of the tests are AO's own truth tables translated from `kanban_test.go`
and `status_test.go`.

Test suites (all `.ts`, all passing):

| Suite | Cases | Source |
|---|---|---|
| [`test/contract/kanban.test.ts`](test/contract/kanban.test.ts) | 78 | AO's truth table, translated from `kanban_test.go` |
| [`test/contract/kanban-divergence.test.ts`](test/contract/kanban-divergence.test.ts) | 30 | New — both divergences asserted in both flag states |
| [`test/contract/activity.test.ts`](test/contract/activity.test.ts) | 6 | New — the three predicates |
| [`test/contract/status.test.ts`](test/contract/status.test.ts) | 37 | AO's truth table, translated from `status_test.go` |
| [`test/review/runs.test.ts`](test/review/runs.test.ts) | 28 | New — head pinning, both bounds, superseded-head context |
| [`test/review/planner.test.ts`](test/review/planner.test.ts) | 77 | New — the scheduler, every reason code, the manual override |
| [`test/board/presentation.test.ts`](test/board/presentation.test.ts) | 41 | New — A27–A30, ordering stability, lane grouping |
| [`test/config/validate.test.ts`](test/config/validate.test.ts) | 45 | New — A31, defaults, every rejection |

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
| 6c | **Run M0 spike 2** (§16): call the real `ctx.agents.create()` from a non-`dsh-webhook` caller, with `attachSession` against a worktree whose repo root is a different workspace (Appendix A §A10 items 2–3). The recipe is written; only reality can confirm it. | M0 | It is the last unknown that can invalidate the spawner, and it invalidates the load-bearing part of M1. |
| 6d | **`WorktreeManager`** (`git worktree add/remove` via `ctx.subprocess`), then `OrchestratorService` + the issue/worker stores over `ctx.storageDomain`, `GitHubGateway` (`gh`), `PrObserver`. Each tool ships **with** its service. | §6, §9, §12, M1 | The spawner needs a real worktree to point at before anything can be spawned for real. |
| 7 | **Client half**: `src/client/**/*.ts` → `dist/client.js` in the `window.__ModuleLoader__` **classic-script** form, plus the `sidebar.panellist` row and the `main` keyed panel, lanes/cards/inspector, themes, locale, keyboard access. | §11, M2 | Needs the routes from chunk 6. |
| 8 | **M0 spikes 2–4**: `ctx.agents.create()` outside `dsh-webhook`; `attachSession` against a worktree; a `/dsho/api/*` route + SSE from a slot component. | §16 | Spike 1 is done; these are the remaining unknowns. |
| 9 | **Feedback classification** (actionability, bot detection by `__typename`/`User.Type` never a login substring, per-comment dedup, re-arm only on a definitive clear) and the **report outbox** (§10.5, A23). | §10.3, §10.5 | M4's logic, testable offline. Can be interleaved with 6. |

**Recommended next step: chunk 6c — run spike 2.** The spawner exists and is
tested against fakes, and fakes cannot answer the only question that matters about
it: does the real `ctx.agents.create()` accept a non-`dsh-webhook` caller, and does
`attachSession` tolerate a worktree whose repository root is a different workspace?
Append a spawn to `fixtures/panel-spike`'s host half (or a sibling fixture), install
it, boot, and look for the new titled session in the GUI sidebar. The install loop
is cheap and documented in [docs/verification-harness.md](docs/verification-harness.md).
outside `dsh-webhook`, and `attachSession` against a worktree). The install loop is
now cheap and fully documented in [docs/verification-harness.md](docs/verification-harness.md).

### ✅ Chunk 6b — the worker spawner is written and tested

[`src/host/spawn.ts`](src/host/spawn.ts) is a transcription of the one **audited**
implementation of this recipe: `@deepseek-ai/dsh-webhook`'s
`packages/webhook/webhook/src/session.ts`. Every step and its order are theirs —
validate before any `await`, lease the agent-preset scope, check the abort signal
at each boundary, create the workspace, `agents.create()` with `meta.cwd` in that
workspace, then publish (attach → permission → title) and only then `followup()`
the prompt.

**Why each ordering choice is load-bearing**, since it is easy to "tidy" one away:

| Choice | Consequence of getting it wrong |
|---|---|
| `permissionPresets.resolve()` before any `await` | an unusable preset costs nothing instead of leaving a half-created session |
| Publish before prompting | a worker that is visible but not yet acting beats one acting before it is visible |
| `followup()`, not `inject()`/`steer()` | `inject` sits until other input arrives; `steer` needs a *running* turn to steer, which does not exist yet |
| Rollback failure logged, not thrown | the original error is the one the user can act on; a second failure is noise |
| The preset lease goes to the **caller** | the reference frees it when the triggering function returns, which cannot be right for a worker that must outlive the call — **flagged for confirmation in spike 2** |

**TDD found a real resource leak.** A test asserting "an aborted request releases
the lease it already took" failed: `signal.throwIfAborted()` thrown between
`acquireScope()` and `agents.create()` escaped without releasing the scope. The
reference can do that because its framework registers the lease as a disposable
resource and unwinds it; we hand the lease to the caller, so the abort checks had
to move *inside* one rollback boundary. That is exactly the class of bug fakes are
for.

`test/host/spawn.test.ts` — 12 tests: the exact call sequence, the abort paths, and
three rollback scenarios (create fails, attach fails, and both rollback steps fail).

### ✅ Chunk 6a DONE — the plugin installs and activates

**Verified in a real GUI, not inferred.** The package was built, installed into the
`web` profile and booted:

```bash
npm run build
dsh plugin --profile web add /Users/notmd/dev/game/dsh-orchestrator
dsh --profile web --port 0 --no-open --host 127.0.0.1   # then open the tokenised URL
```

| Evidence | Result |
|---|---|
| Loader composition (`dsh --profile web --dump-config`) | `# == @local/dsh-orchestrator` → `- id: orchestrator`, `name: '@local/dsh-orchestrator'` |
| Server boot | clean — **no activation error** |
| GUI → Settings → Plugins | **`Installed  1` → `@local/dsh-orchestrator`** with its manifest description, read without activating the plugin (Appendix A1.2) |
| The spike, removed with `dsh plugin --profile web remove` | its "Spike" `sidebar.panellist` row is **gone** from `navigation "Global panels"` |

| File | What it is |
|---|---|
| [`src/index.ts`](src/index.ts) | The plugin entry: `name`, `inject: ['tools']`, `apply()`. Validates config loudly, then registers the tool table under one `ctx.effect`. |
| [`src/host/context.ts`](src/host/context.ts) | The host `Context` slice, declared **structurally** — so activation is testable against a fake `ctx`, and the plugin's host-plane footprint is one reviewable file. |
| [`src/host/tool.ts`](src/host/tool.ts) | A local `defineTool` equivalent, compiling the schema DSL to the JSON Schema the registry stores. |
| [`src/host/tools.ts`](src/host/tools.ts) | The tool table — **one tool today**, `orchestrator_config`, the only one fully backed by existing code. |
| [`test/host/index.test.ts`](test/host/index.test.ts) | 16 tests: registration, `ctx.effect` disposal, loud config rejection, and the tool compiler. |

**Why `defineTool` is not imported, and why that is not laziness:** the package is
installed as a **symlink**, so a bare `@deepseek-ai/*` specifier resolves by walking
up from this package's *real* path — the developer's checkout — and never reaches
`~/.dsh/profiles/node_modules`, where the peers live. On top of that, the registry's
`@deepseek-ai/dsh-tools` is `0.0.1-rc.1` while the installed host is `0.1.7-rc.2`, so
installing it would put a second, mismatched copy in the tree. Both facts were
measured. The descriptors are transcribed from the installed `defineTool`, so the
registry sees exactly what it would have seen otherwise.

**The tool table is deliberately one tool, not eleven.** The other ten need services
that do not exist yet, and shipping a tool whose body says "not implemented" is worse
than not shipping it: the model would call it and the user would get a
plausible-looking failure. The table grows with its services; the mapping from tool →
blocking service is written down in `src/host/tools.ts`.

### ✅ M0 spike 1 DONE — the panel seat is proven, and R1 is closed

**The PRD's highest-uncertainty item is verified end to end, in a real GUI, with a
real third-party bundle.** Not read from types — executed.

Fixture: [`fixtures/panel-spike/`](fixtures/panel-spike) — a four-file bundle that
registers `main` (key `spike`) and `sidebar.panellist` (id `spike`, order 3) using
the exact shape copied from the one shipped plugin that does it
(`@deepseek-ai/dsh-client-ui-schedule`).

Procedure (see [docs/verification-harness.md](docs/verification-harness.md)):

```bash
dsh plugin --profile web add ./fixtures/panel-spike   # installs AND registers the bundle
dsh --profile web --port 0 --no-open --host 127.0.0.1 # then open the printed tokenised URL
```

Observed in the page:

| Signal | Result |
|---|---|
| `window.__DSH_BOOT__.entries` | contains `{ id: '@local/panel-spike', url: 'plugins/??@local/panel-spike/client.js&rev=8938748466e9', immediately: true }` — entry count went 65 → **66** |
| `window.__DSH_PANEL_SPIKE_CLIENT__` | `true` — the client half's `apply()` **ran**, so both registrations were accepted without throwing |
| Sidebar accessibility tree | `navigation "Global panels"` → `button "Plugins"`, `button "Spike"` — the row rendered, labelled from our `label` |
| After clicking the row | `heading "panel-spike"` + `StaticText "The main keyed slot renders a third-party panel."` — **the `main` keyed slot rendered our component** |

**Two things this settles, and one it does not.** It settles that a third-party
bundle may (a) register into the root-scoped `sidebar.panellist` list and (b) take
a **key** in the root-scoped `main` keyed slot, with the row's `id` addressing the
panel. It does **not** settle that a *second* occupant is refused gracefully, nor
anything about the host plane (`ctx.agents`, `ctx.storage`, `ctx.subprocess`) —
those remain M0 spikes 2–4.

**Also verified: `dsh plugin --profile <name> add <dir>` is the full
`install_bundle` equivalent.** It performed *both* steps — added the package as a
dependency **and** appended it to `dsh.profile.bundles` in the profile manifest —
so no hand-editing of the profile was needed and no `plugin_manager` tool was
required. Remove it with `dsh plugin --profile web remove @local/panel-spike`.

### ✅ The verification/install problem is SOLVED — see [docs/verification-harness.md](docs/verification-harness.md)

Earlier rounds recorded this as blocked. It is not. **The full procedure is
documented in [docs/verification-harness.md](docs/verification-harness.md); read
that before touching the browser.** In brief:

- **Boot your own authenticated GUI:** `dsh --profile web --port 0 --no-open
  --host 127.0.0.1`, then read the printed
  `dsh web: http://127.0.0.1:<port>/?token=<token>` line and open it with the
  Chrome DevTools MCP `new_page`. That token is the gate; the desktop app's GUI on
  `19387` stays unreachable (401 + a token in another process's memory + no CDP
  port), and none of that matters any more.
- **Install with the CLI:** `dsh plugin --profile web add <absolute-package-dir>`
  (`--profile` is required). This is the `install_bundle` equivalent — the
  `plugin_manager` *tool* does not exist in this build's installed packages.
- **The `web` profile is the right target for verification**, because it is a
  different profile from `desktop`: you cannot break the user's live session, and
  the procedure is repeatable.
- **Prove the boot** with `document.title === 'DeepSeek Harness'` plus
  `window.__DSH_BOOT__` existing, and enumerate loaded client modules from
  `window.__DSH_BOOT__.entries` (66 entries in the `web` profile with the spike
  installed).

**What was done instead, and why it is still real progress:** the slot
declarations were verified **from the installed artifacts**, which is evidence the
PRD itself treats as authoritative ("the installed `lib/types/*.d.ts` wins"). See
§3a. That settles "do `main` and `sidebar.panellist` exist and who occupies
them?" — the part of R1 that can be settled without a running plugin.

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
   in the **fact adapter** — chunk 5c — where `lastActivityAt` is computed as that
   `max()`. The reducer stays verbatim so the ported tests keep meaning what they
   mean.

9. **A run carries `status` *and* `verdict`, not the PRD's merged `state`.** The
   reference splits them (`running · complete · delivered · failed · cancelled`
   vs `'' · approved · changes_requested`), and the ported planner needs the split:
   the merged form cannot distinguish "failed with no verdict" from "failed after
   requesting changes". The PRD's vocabulary survives as the planner's per-head
   `AOReviewState`, and its `queued` is not a stored status at all — a scheduled
   pass has **no run row**, and the reducer renders `Review scheduled` from
   `present === false`.

10. **`orderCards` adds an `id` tie-break.** The reference relies on
   `Array.prototype.sort` stability to keep equal cards in insertion order. Our
   board is rebuilt from a snapshot on every refresh, so relying on insertion
   order would let the board flicker on a no-op refresh, which A29 forbids.
   Comparing `id` last makes the ordering a pure function of the card set. There
   is a test that permutes the input and asserts one output.

11. **The reference's `statusPresentation` guard is reproduced but inert.** It is
   a daemon-side presentation override this plugin never sets. It is kept so a
   future port that *does* set it inherits the reference's behaviour instead of
   silently losing it, and the comment says so.

12. **`presentCard` normalizes PR facts at its boundary.** The ported reducer
   expects Go-style zero values on every field, so the public card boundary maps
   through `prFacts()` rather than trusting its caller. Without this the reducer
   throws on a hand-written card — which is how the omission was found.

13. **🔴 HARD REQUIREMENT (set by the user, round 2): all first-party code is
   TypeScript.** This supersedes decision 1 below, which chose plain ESM
   JavaScript specifically to avoid a build step. Reasons TypeScript was chosen
   over JS: it is a hard requirement, so it is not up for re-litigation.

   What this changes, and the honest cost:

   | | Before (JS) | Now (TS) |
   |---|---|---|
   | Source | `src/**/*.js`, JSDoc types | `src/**/*.ts`, erased-type annotations |
   | Tests | `node --test` on `.js` | `node --test` on `.ts` — **still zero dependencies**, because Node 24 strips types natively (verified: `node /tmp/t.ts` runs) |
   | Build | none | `tsc` → `dist/`; `package.json` `exports` points at `dist/` |
   | Client half | hand-written classic script | authored in TS, compiled to the `window.__ModuleLoader__` **classic-script** form — it is *not* an ES module, so it needs its own `tsconfig` (`module: none`, `lib: DOM`) |
   | DSH guidance | "**A Host-only bundle needs no dependencies, install scripts, or build tool**" | this now needs `tsc` at build time, so the bundle gains a build step |

   **Two constraints to respect during the migration**, both discovered by testing
   rather than assuming:
   - `node --test` type-stripping only accepts **erasable** syntax. No `enum`, no
     `namespace`, no parameter properties. Constants stay `const` objects plus
     union types — which is what the ported code already uses, so this is free.
   - `tsc` is available globally (v6.0.3) and Node is v24.11.1. **Do not add a
     `typescript` devDependency unless the registry is reachable** — check first.

   Migration is mechanical (rename, annotate, add `tsconfig`, repoint `exports`,
   re-run the 342 tests plus `tsc --noEmit`). It is chunk 5 in the plan below.

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
