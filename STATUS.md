# STATUS — dsh-orchestrator

**This file is the handoff document.** Read it first; it is the only place that
records what is finished, what is next, and which decisions are deliberate. Keep
it updated **after every chunk of work**, and prune it when it grows — a stale or
bloated status file costs the next agent more than it saves.

| | |
|---|---|
| **Goal** | Implement [PRD.md](PRD.md) |
| **Plan source** | [PRD.md §16 Milestones](PRD.md#16-milestones), verified against [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| **Last updated** | 2026-10-01, chunk 6g |
| **Verify** | `npm run verify` → `tsc` (src + test) + `node --test` + build · **all green** |
| **Current state** | **507 tests, 0 type errors.** The board's read model, configuration, the host plane's low-level layers (spawn, worktree, exec, GitHub access), **persistence, and the repository preflight** are done and verified — worktrees against real git, activation in a real GUI. **The storage question is settled** (see decisions 20–21). Still missing: the observer, the routes, the client half, and the *wiring* of `repo_connect` as a tool. |

---

## 1. Where we are, in one paragraph

Every piece of logic that could be reasoned about offline now exists, is ported from
the reference where the reference has it, and is covered by tests — **474 of them,
with `tsc` clean across `src/` and `test/`**. The plugin installs into a profile and
activates (verified in a live GUI). The worker-spawn recipe and the worktree manager
are verified against reality — spike 2 against the real host services, worktrees
against real git. What does **not** exist: the issue/worker store, the PR observer,
the orchestrator routes, the review loop's plumbing, and the entire client half. The
next chunk is `orchestrator_repo_connect`, which forces the storage decision that
everything else inherits.

---

## 2. Done

| Chunk | What | Verified by |
|---|---|---|
| 1–3 | The board's read model: the Kanban reducer, activity model, session status, head-scoped review-run facts, the review-loop scheduler, card presentation (attention, ordering, lanes) | **78 + 37 tests are AO's own truth tables** translated from `kanban_test.go` / `status_test.go`, so a porting bug cannot hide behind a rewrite |
| 4 | Config: every PRD §13 default, explicit key-by-key validation, and the loud `agentRulesFile` path rules (A31) | 45 tests |
| 5 | **TypeScript migration** (hard requirement) — all source and tests, `tsc` clean, zero-dependency tests via Node 24 type stripping | 0 type errors |
| 5e | Made the **tests** type-clean too (was 105 errors, all deliberate invalid input and unannotated fixtures) | 0 errors across `src/` **and** `test/` |
| 6a | **The plugin installs and activates.** Entry, structural host-context typing, a local `defineTool` equivalent, one real tool | Live GUI: `Settings → Plugins → Installed 1 → @local/dsh-orchestrator` |
| 6b | **The worker spawner** — `dsh-webhook`'s audited recipe, step for step, with its rollback discipline | 12 tests incl. three rollback scenarios |
| 6d | **The worktree manager** — branch naming, `.dsho/worktrees`, add/remove/list, porcelain parsing, `check-ignore` preflight | 28 unit + **12 real-git subtests** |
| 6e | **The command seam** — argv over `ctx.subprocess`, bounded in time and output, failure classification | 33 tests |
| 6f | **GitHub credential chain** (`AO_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`) and every `gh`/`git` argv | 30 tests |
| 6g | **Persistence and the repository preflight.** The fact store on `ctx.storage`'s KV layer, record ids, and `connectRepo`'s three checks (git work tree → worktree root ignored → `gh` installed and authenticated) with a refusal that names the fix | 33 tests |

Spikes: **M0 spike 1** (the panel seat is real) and **M0 spike 2**
(`ctx.agents.create()` works for a third-party caller) are both closed — see §3.

Scaffolding: `package.json` (bundle manifest, `dsh.bundle.patch`), `cordis.patch.yml`,
`LICENSE` + `NOTICE` (the Apache-2.0 attribution PRD §20 requires for ported code),
`tsconfig{,.src,.build,.spike}.json`, `.gitignore`.

---

## 3. Findings worth not rediscovering

Each of these cost real time or would have shipped a silent bug. They are the most
valuable thing in this file.

**The panel seat works, and there is a shipped exemplar.** A third-party bundle
*does* get the root-scoped `main` keyed slot and a `sidebar.panellist` row — proven
by execution, not by reading types. The row's `id` addresses the panel's `key`.
**`@deepseek-ai/dsh-client-ui-schedule` implements exactly this pattern** and is
merely `disabled: true`, so read its registration (~`lib/client.js:6790`) rather than
designing from scratch.

**`ctx.agents.create()` is safe for a non-`dsh-webhook` caller**, and
`attachSession` tolerates a per-issue worktree path. `agentPresets.acquireScope` and
`.mount` are real — they appear in no `.d.ts` because `dsh-agent-presets` is a
**dangling symlink** in the profile, so only calling them settles it.

**`git worktree list` returns realpath-resolved paths.** On macOS `/tmp` and `/var`
are symlinks, so `/var/folders/…` is reported as `/private/var/folders/…`. Every
textual path comparison silently no-ops — idempotence, `remove`, and `pruneAll` each
*reported success while doing nothing*. A real-git integration test caught it; the
unit tests were green throughout. **A fake git returns what its author expected, so
it cannot falsify a path comparison.**

**A deadline must arrive as a result, never as a throw.** When `handle.done` rejects
on abort — a normal way for it to surface — code after the `await` never runs.
Caught by a test asserting the child was terminated; it was not. The same fix makes
`timedOut` uniform: callers branch on it, and if it sometimes threw, every caller
would need a try/catch too.

**Verification and installation are both solved — see
[docs/verification-harness.md](docs/verification-harness.md).** In short: the desktop
app's GUI is unreachable (401 behind a process-scoped launch token, no CDP port), so
**boot your own**: `dsh --profile web --port 0 --no-open --host 127.0.0.1`, read the
printed `dsh web: http://127.0.0.1:<port>/?token=…` line, and open it with the Chrome
DevTools MCP `new_page`. Install with `npm run build && dsh plugin --profile web add
"$PWD"` — that CLI does both steps `install_bundle` would (dependency **and**
`dsh.profile.bundles`), so the profile is never hand-edited. Host-side spikes go in
`src/spike/` (excluded from the shipped bundle, built by `npm run build:spike`) and
are inserted with a `--patch` overlay, because a host result is otherwise invisible
from outside the process.

**A live session's log buffers.** "No turn events on disk" does **not** mean no turn
happened. Read the log after the session closes, or watch the GUI.

---

## 4. Next — ordered, with the reason for the order

| Chunk | Work | PRD | Why now |
|---|---|---|---|
| 6g\.2 | **Wire `orchestrator_repo_connect` as a tool.** The preflight and the store both exist and are tested; what is missing is the wiring. It needs `inject` to gain `subprocess` and `storage`, and **`apply()` to become async** (opening the store is async), which is why it is its own step rather than a footnote — that change also touches the activation tests. | §12.1 | Makes the second real tool live, and proves the store against a real backend rather than a fake. |
| 6h | **The issue and worker stores** on the settled fact store, then `orchestrator_issue_create` / `_list` / `_update`. | §7.1, §7.3, §12.1 | Now unblocked: the storage question is settled in 6g. |
| 6i | **`GitHubGateway` + `PrObserver`** — poll `gh pr view --json`, diff against the stored snapshot, emit fact changes. Invariants: a failed observation keeps the prior snapshot and can never fabricate a closed/merged transition (R13). | §7.4, §10.2 | The board is only truthful if the facts are. |
| 7 | **Client half** — `src/client/**/*.ts` → `dist/client.js` in the `window.__ModuleLoader__` classic-script form, the `sidebar.panellist` row and the `main` keyed panel, lanes/cards/inspector, themes, locale, keyboard access. | §11, M2 | The seat is proven (§3) and there is a shipped exemplar to copy. |
| 8 | `/dsho/api/*` + `/dsho/events` on `ctx.webServer` (SSE is unverified — the fallback is polling the board endpoint). | §11.4, A10 item 5 | Needs the stores; the client needs the routes. |
| 9 | **Feedback classification** (actionability, bot detection by `__typename`/`User.Type` — never a login substring; per-comment dedup; re-arm only on a definitive clear) and the **report outbox** (§10.5, A23). | §10.3, §10.5 | M4's logic, testable offline; can be interleaved. |

**Recommended next step: 6g\.2 — wire `orchestrator_repo_connect`.** It is small and
it is the first time the store meets a real backend, which is worth doing before more
is built on top of it. Two smaller items stay queued: confirm the admitted prompt
actually produces a turn (the residual in spike 2), and settle whether the preset
lease should be released by the caller or owned by the worker's context.

---

## 5. Decisions taken while implementing (deltas from the PRD)

Treat these as current intent. Overrule them deliberately, but not by accident.

1. **Plain ESM TypeScript, no bundler.** `tsc` only. Imports use real `.ts`
   specifiers (what Node's type stripper needs); `rewriteRelativeImportExtensions`
   rewrites them to `.js` on emit, so one source tree serves both the test runner and
   the shipped bundle.
2. **Time is epoch milliseconds**, not `Date` — JSON-friendly across the host↔client
   boundary and directly comparable, which the reducer's tie-breaks need.
3. **Go zero values are reproduced by explicit normalizers** (`sessionFacts()`,
   `prFacts()`, `reviewRunFacts()`), which is what lets AO's ported tests keep
   asserting AO's exact answers while JS callers may omit fields.
4. **`requireHumanApprovalBeforeReady` defaults to `false` *in the reducer*** even
   though the *shipped config* default is `true`. The reducer's default is the
   AO-exact behaviour, so the flag's absence cannot silently change a ported case;
   the config layer sets `true`. This is why all ported tests pass unchanged.
5. **Reducer row 5b sits before row 4.** The PRD places the round-budget clause
   inside row 5, which is *after* the auto-inject row — and that ordering cannot
   satisfy A18, because row 4 fires on the default configuration. See §6.
6. **Row 6's guard is `!externalReview.approved`**, not a re-test of the aggregate
   `reviewDecision`: a real human approval the aggregate has not caught up with must
   still count, or it would be downgraded to `Needs human review`.
7. **The escalation reason is suppressed for a head our pass approved** — the budget
   being spent is history there, and a banner would claim automation stopped when the
   pass succeeded.
8. **`noSignalGrace` uses AO's exact predicate**; the PRD's
   `max(lastSignalAt, lastObservedAt)` belongs in the fact adapter, so the reducer
   stays verbatim.
9. **A run carries `status` *and* `verdict`**, not the PRD's merged `state` — the
   merged form cannot express "failed with no verdict", which the planner needs. The
   PRD's `queued` is not a stored status: a scheduled pass has no run row, and
   `present === false` is what renders `Review scheduled`.
10. **`orderCards` adds an `id` tie-break.** The reference relies on sort stability;
    we rebuild from a snapshot each refresh, so relying on insertion order would let a
    no-op refresh reorder the board — which A29 forbids.
11. **The reference's `statusPresentation` guard is reproduced but inert** (we never
    set it), kept so a future port inherits the behaviour instead of losing it.
12. **`presentCard` normalizes PR facts at its boundary**, because the ported reducer
    expects Go zero values on every field.
13. **All first-party code is TypeScript** — a hard requirement set by the user. This
    costs the DSH property the PRD leaned on ("a Host-only bundle needs no
    dependencies, install scripts, or build tool"): the bundle now needs
    `npm run build` before install.
14. **`defineTool` is not imported.** The package installs as a **symlink**, so a bare
    `@deepseek-ai/*` specifier resolves from the checkout and never reaches
    `~/.dsh/profiles/node_modules`; and the registry's `dsh-tools` is `0.0.1-rc.1`
    against the host's `0.1.7-rc.2`. Descriptors are transcribed from the installed
    `defineTool` instead.
15. **The tool table grows with its services.** A tool whose body says "not
    implemented" is worse than no tool: the model calls it and the user gets a
    plausible-looking failure. `src/host/tools.ts` maps tool → blocking service.
16. **`ctx.subprocess`, not `ctx.shell`, for git and `gh`.** `shell.resolve()` takes a
    command *string*, which would mean shell-quoting argv built from user data;
    `spawn()` takes an argv *array*, so injection is unrepresentable rather than
    escaped. Same reasoning as `slugify`.
17. **Cleanup and preflights never read a failure as a positive answer.**
    `check-ignore`'s 128 is not "ignored"; `classifyCommandFailure` checks rate limits
    *before* 403, because GitHub answers 403 for both and getting it backwards means
    retrying a rate limit in a tight loop.
18. **`gh pr view --json`, not GraphQL.** AO reads PRs through `gh api graphql`; the
    PRD prescribes this. The field list is exactly what §7.4 names and the reducer
    reads.
20. **Persistence is `ctx.storage`'s KV layer, not `ctx.storageDomain`.** The PRD
    allows either. `storageDomain` validates records with **zod schemas**, which
    would mean importing a schema library the plugin cannot resolve (the symlink
    problem, decision 14) and pinning a version the host may differ on. The KV layer
    takes `unknown` records and needs no schema library — and the **ported
    normalizers are already the validators**: `prFacts()`, `sessionFacts()` and
    `reviewRunFacts()` fill Go's zero values on every read, which is exactly how a
    record predating a field is supposed to behave. Everything is behind `FactStore`,
    so switching later is a change to one file.
21. **Record ids are ULIDs, and the id is the storage key.** Lexicographic order is
    creation order, so a board sorted by id is also sorted by age; and the Crockford
    alphabet excludes `I`/`L`/`O`/`U`, so an id survives being read out loud. The
    alphabet is also what makes an id safe as a KV key, which the store asserts
    rather than assuming.
22. **A review is always posted as `event=COMMENT`** (R17): GitHub rejects
    `APPROVE`/`REQUEST_CHANGES` on your own PR, so forwarding the verdict would 422
    every PR. **`pushArgv` has no `--force` parameter at all** — making force-push
    unreachable is stronger than making it conditional.

---

## 6. Documented divergences from Agent Orchestrator

Exactly one behavioural divergence, in two rows of the reducer, both gated on
`requireHumanApprovalBeforeReady` (shipped default `true`) — so setting it `false`
restores AO's exact behaviour, and that is asserted in **both** flag states by
`test/contract/kanban-divergence.test.ts`.

| Row | Divergence | Why |
|---|---|---|
| 5b (new) | A halted loop — round budget spent, or three verdict-less automated passes on one head — releases the PR from `Validating` into `needs_review` / `Needs human review`. | PRD §7.5 + A18. AO has no round cap in its reducer, so its row 4 would claim a loop that has stopped. The general rule: **a lane may only claim an active loop while that loop is actually running.** |
| 6 (new) | An auto-review-approved PR with no human approval cannot reach `ready` on mergeability alone. | PRD §7.6 + A17. AO's mergeability row would reach `Ready` with no human review. |

Everything else in `src/contract/kanban.ts` is AO's reducer verbatim.

**One PRD conflict resolved in code:** §7.3 writes the branch as
`dsho/issue-<n>-<slug>` while §13.1 shows `dsho/<prefix>/issue-<n>/root`. This
implements the first as the default with the prefix as a middle segment. The two
shapes are not reconciled upstream; it is one function to change.

---

## 7. Reference material available locally

The reference implementation is cloned on this machine and is the authority for any
"what does AO actually do" question — prose and code disagreed in the PRD's own
research pass, and the code won.

| | |
|---|---|
| **AO clone** | `/Users/notmd/dev/game/agent-orchestrator.ref` at commit `53ba1e8` |
| Reducer / status / activity | `backend/pkg/contract/{kanban,status}.go`, `backend/internal/domain/activity.go` |
| Planner / gating | `backend/internal/review/planner.go`, `backend/internal/autoreview/coordinator.go` |
| Spawn recipe | `packages/webhook/webhook/src/session.ts` — the audited implementation |
| Auth / PR reading | `backend/internal/adapters/scm/github/{auth.go,observer_provider.go}` |
| Board UI semantics | `packages/product-ui/src/{SessionsBoardView.tsx,session-presentation.ts}` |
| **DSH packages** | `~/.dsh/profiles/node_modules/@deepseek-ai/` — verified `0.1.7-rc.2`, cordis `4.0.4` |
| DSH plugin contract | [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) — every API, with its evidence |
| Verification harness | [docs/verification-harness.md](docs/verification-harness.md) — how to drive a real GUI and run a host spike |

**Do not guess a DSH API.** Read the installed `lib/types/*.d.ts`; where the appendix
and an upstream README disagree, the installed types win. Where the types are
unreadable (a dangling symlink, as with `dsh-agent-presets`), call the API — and
record what it did.

---

## 8. Open risks carried forward

| Risk | State |
|---|---|
| **R1 — the `main` keyed slot** | **Closed.** Proven by execution, with a shipped exemplar. |
| **`ctx.agents.create()` outside `dsh-webhook`** | **Closed** (spike 2), with one residual: the admitted prompt's turn is unobserved. |
| **`attachSession` against a worktree** | **Closed** (spike 2). |
| **SSE through `ctx.webServer.register`** | Open. Plain HTTP is documented; streaming is not. Fallback is polling `/dsho/api/board`. |
| **`ctx.storageDomain` shape** | Open, and now the blocking question (chunk 6h). |
| **The preset lease's lifetime** | Open. The reference frees it when the triggering function returns, which cannot be right for a worker that outlives the call; we hand it to the caller. |
| **`gh` not installed / not authenticated** | Handled at the message layer (`describeFailure` names the exact prerequisite); the preflight itself lands in 6g. |
