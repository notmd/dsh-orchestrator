# STATUS — dsh-orchestrator


**This file is the handoff document.** Read it first; it is the only place that
records what is finished, what is next, and which decisions are deliberate. Keep
it updated **after every chunk of work**, and prune it when it grows — a stale or
bloated status file costs the next agent more than it saves.


| | |
|---|---|
| **Goal** | Implement [PRD.md](PRD.md) |
| **Plan source** | [PRD.md §16 Milestones](PRD.md#16-milestones), verified against [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| **Last updated** | 2026-10-02, handoff cleanup (no code change): stale counts corrected, a malformed row repaired, a doubled finding merged — then four review passes, which corrected `verify:all`'s claim, PR #5's state, row 5's qualifier, two counts and row 6v, and closed the spike-residue item (reconciling §3's workspace paragraph with it and restoring a heading the dedupe had dropped) |
| **Verify** | `npm run verify` (src typecheck + suite + host/client build) exits **0**. `npm run verify:all` (adds `test/**` and `src/spike/**` to the typecheck) does **not** — its `typecheck:all` half reports **18 pre-existing errors in six test files** (`test/client/plugin-config.test.ts`, `test/domain/pr-snapshot.test.ts`, `test/host/exec.test.ts`, `test/host/feedback.test.ts`, `test/host/observer-scheduling.test.ts`, `test/host/review-threads.test.ts`). That is fixture drift at the type level, not broken behaviour: `npm test` passes because Node strips types. |
| **Current state** | **1011 tests (`npm test`), `src/` typechecked clean; `npm run verify` exits 0** (the `verify:all` failure above is pre-existing test-file type drift, not a regression). `verify:all` exists because `verify` typechecks only `tsconfig.src.json`, which excludes `test/**` and `src/spike/**`, so the suite's types and the spikes' types were never checked by it. The client bundle carries **0 module statements**, so it stays the classic script the loader needs. **The PRD's scope is implemented, audited and demonstrated** — the whole requested flow runs in `test/integration/flow.test.ts` against a mock provider with real git, the settings page's four writes are proven to reach the work in `test/integration/settings-flow.test.ts`, all 26 config keys are read by acting code, and the board and the settings dialog were measured in a live GUI rather than eyeballed. **Open:** M6 (which the PRD marks optional), §12.2's platform half (an assumption, not a task), A4's follow-through (waiting on a person), and G5 and G1 (blocked upstream) — see §4. |

---


## 1. Where we are, in one paragraph

The PRD's scope is built. Every layer the design named now exists, is ported
from the reference where the reference has it, and is covered by tests — **1011 of
them, with `src/` typechecked clean**. The plugin installs into a
profile and activates. The worker-spawn recipe, the worktree manager and the fact
store are each verified against reality — spike 2 against the real host services,
worktrees against real git, the store against the real backend. The board read
model, the issue and worker stores, the PR observer, the review loop (sweep →
auto-review pass → findings → feedback), the orchestrator routes and the entire
client half are implemented and tested, and the requested flow has run **live** end
to end: brief → worker → real pull request → reviewed head → stopped at the human
gate. What is **not** built is what the PRD marks optional (M6 hardening) and what
the platform will not let us measure from outside a session (§12.2's `restrict`
honouring); the rest of §4 is either waiting on a person (A4's follow-through) or
blocked upstream (G5's merge precondition and G1's conditional-request path). §4 is the honest list.

---


## 2. Done


| Chunk | What | Verified by |
|---|---|---|
| 43 | **`requireHumanApprovalBeforeReady` now defaults to `false`: an unconfigured install behaves exactly like Agent Orchestrator.** The user overruled the PRD on this one default, so the code, the PRD, this file and the two appendix docs all changed together rather than leaving the docs asserting the opposite of the shipped behaviour. The *capability* is untouched — reducer rows 6 and 5b are still compiled in and still asserted in both flag states, and a deployment that wants a person in the loop sets the flag (settings page → **Require a human approval before Ready**, or the profile patch). What changed is which behaviour is the surprise: `Ready` on mergeability alone used to mean the gate had been defeated, and now simply means nobody asked for one. **The default is pinned by its own test** (`test/contract/kanban-divergence.test.ts`), because every other case in that file passes the flag EXPLICITLY — without it, flipping this default back would leave the whole suite green. Three tests needed their intent made explicit instead of inherited, and `orchestrator_config`'s divergence note now states the default, so the tool output an agent reads cannot leave "no human approval needed" to be inferred. | `npm run verify` exits 0; **1011 tests** (was 1010 — the new default-behaviour case). |
| 42 | **The plugin's own settings now render on the Plugins page (sidebar → Plugins → the bundle).** The ask was a UI placement, and the placement turned out to be the small half: the row had **no `Config` export**, so DSH's Settings service did not list the entry at all (`volatileForm(schema) === undefined` → the entry is absent) and no page had anything to render. `src/config/schema.ts` declares the row's schema with **21 of its 26 fields marked `.volatile()`** — the fields the running plugin re-reads at use time — and the other five stay ordinary **with the decision recorded**: `defaultRepo`, `pollIntervalMs` and `reviewSweepIntervalMs` are read once at activation (a working directory and two `setInterval` periods), and `planGate` plus the `webhook` block are validated and reported but **not wired to any behaviour yet**. `livePluginConfig` normalizes once and defines getters over the Loader's live references, so a saved edit reaches the running plugin with **no wiring** in any consumer. Rows carry an **Overridden** badge and **Reset to default** (an `unset`, which restores inheritance rather than pinning the default), Save is one atomic revision-fenced `mutate`, and the page states in words which settings are **not** there instead of showing a subset in silence. | **LIVE in the web profile GUI** (`dsh --profile web`, booted on a free port, driven through the DevTools MCP). Measured, not eyeballed: six sections and 21 rows showing the plugin's real values; a staged `maxConcurrentWorkers` change was accepted at `expectedRevision: 0`; `api/settings/describe` read the value back **off the running entry's config**; the durable write appeared in the profile's `cordis.patch.yml`; **Reset to default** removed the override and the page returned to `2`; both directions left the profile **restored byte-identical**. **Two defects were found by running it, not by reading it:** (1) a guarded `ctx.configForms` read on the PARENT context threw (Cordis refuses an un-injected service), the guard swallowed it, and the page never registered although the settings document had listed `"ns":"orchestrator"` all along; (2) a number typed into the editor was sent as the **string** `"4"` and the host refused it (`expected number but got 4`), so the page now coerces on staging — and the client test had encoded the string too, which is how it slipped. It is pinned by 1010 tests (was 1000), typecheck + build clean, `test/client/plugin-config.test.ts` runs the page against a real hook runtime and `test/config/schema.test.ts` pins the schema against `PLUGIN_DEFAULTS` and the volatile decision. |
| 41 | **A real worker → real pull request cycle, live, on this repository.** A brief went in through `POST /dsho/api/tasks`; a worker was spawned in its own worktree on `dsho/issue-9-…`; it wrote, committed and pushed one file; the observer read the PR; the review sweep scheduled a pass; a read-only reviewer session judged that exact head; the card moved to `In review` and stopped. **The durable phase history is the deliverable**, because it is where §12.1's gap was visible: `queued → implementing → verifying → shipping → awaiting_auto_review`, against the two workers this same profile ran under the old code, whose histories are `queued → shipping → closed` and `queued → shipping → awaiting_human → closed` — no `implementing`, no `verifying`, no `awaiting_auto_review`, because nothing wrote them. The two declared stages arrived through the new `stage` argument on `orchestrator_report`; `awaiting_auto_review` came from the reviewer service, and its summary names the head it pinned (`review pass scheduled for 7455c54`). The review run records `approved` at that head with a GitHub review id (`5388532481`), and the card reads `needs_review / Needs human review` with **no pulse and no spinner** (A28, A30) — and deliberately **not** `ready`/`merge_ready`, because D3's human gate is not satisfied: `externalReview.approved` is `false`, so the lane stays `needs_review` even though our own pass approved a mergeable pull request. That is the gate working, and it is why `merge_ready` remains unexercised live — it needs a person to approve, the one step of this pipeline that is not ours to take. Host-side evidence: PR [#5](https://github.com/notmd/dsh-orchestrator/pull/5) carrying the worker's own commit (README.md touched, titled in the repo's conventional-commit style), the worktree at `.dsho/worktrees/issue-9-…` on its branch at `7455c54`, and the issue left `in_progress` with its worker bound — the correct resting state for a pull request waiting on a human. | **live**; the PR ([#5](https://github.com/notmd/dsh-orchestrator/pull/5)) was **closed unmerged** after this run, so the post-merge half was never exercised. It carried **nine** commits because the branch was cut from a checkout whose local `main` was ahead of `origin/main` (measured **2** ahead now) — a publishing artifact, not a defect in the cycle. |
| 40 | **The task-state teardown implemented: all four §12 gaps and G1–G7.** Driven by [docs/agent-orchestrator-task-state-transitions.md](docs/agent-orchestrator-task-state-transitions.md). **§12.1** — nine of fourteen `WorkerPhase` values were declared and never assigned; every one of them now has a producer: `orchestrator_report` gained a `stage` argument (PRD §8.1's checkpoints) for planning/implementing/verifying/self_reviewing/addressing_feedback, the reviewer service writes `awaiting_auto_review`, feedback routing writes `addressing_feedback`, a new merge-readiness sweep writes `merge_ready`, an exhausted reviewer retry budget writes `failed`, and a stop writes `abandoned`. **§12.2** — `PHASE_TRANSITIONS` + `isValidPhaseTransition`, enforced **inside `setPhase`** so no caller can bypass it (merged → implementing is now unrepresentable), plus a rule that a terminal phase has no outgoing edge while the four externally-imposed outcomes (merged/closed/failed/abandoned) are reachable from any live phase. **§12.3** — the three overlapping terminal representations get ONE stated precedence, documented on `isTerminalPhase` (phase authoritative; `endedAt` a watermark; `isTerminated` derived at read time; `IssueState` the issue's own vocabulary), and the reviewer's planner gate now derives it instead of hardcoding `false`. **§12.4** — `isSticky`/`needsInput` are load-bearing: `pendingQuestion` finally has a producer (a `needs_input`/`stuck` report sets it, any other report clears it), and the board returns a paused worker's declared activity instead of the live status, so R20's demotion cannot happen. **G1** — a per-worker cadence (a *settled* card polled at 4×) and a 2-minute discussion-refresh interval replace an unconditional 3-call tick. **G2** — `recoverWorkerPr` finally calls `prListArgv`: a worker with a branch and no binding is recovered by `--head`, forks excluded, ambiguity refused, and the attempt watermarked on a slow cadence of its own. **G3** — mergeability is composed locally (`mergeBlockersFromLocal` + `synthesizeMergeability`) and the **reason list** is carried through the card and into the inspector. **G4** — review **threads** are fetched (`gh api graphql`) and resolution now decides what is outstanding, replacing the coarse "every external review is COMMENTED" reading. **G6** — the ported credential chain was dead code (DSH strips credential-shaped env vars, so `AO_GITHUB_TOKEN` reached nothing); the seam now injects it as `GH_TOKEN` for `gh` and drops the memo on a 401. **G7** — `retryAfterMs` had no caller: a rate-limit cooldown now gates the observer, which is what `describeFailure` had been promising. | **988 tests** (was 935); typecheck + build clean. **LIVE, against this repository's real GitHub PRs:** recovery bound PR #3 from its branch; the GraphQL thread query was accepted by GitHub and parsed 4 real threads (3 resolved) on PR #3; a deliberately bad injected token was rejected **401 by GitHub** — proof the child used it — and `invalidate()` ran; the real scheduler made 3 calls on the first pass, 0 on a same-instant repeat, 1 per tick, and 3 again at 2 minutes. **LIVE in a real host + GUI:** installed into the `web` profile, `/dsho/api/board` answered 200 with two real stored workers sitting in the **archive sheet**, and the panel rendered four lanes plus `Archived (2)` — the behaviour that was unreachable while `isTerminated` was hardcoded. Then uninstalled, and the server killed. |
| 39 | **The new-task feature, cloned from AO's `delegation.go` and its New-task dialog.** A brief (`POST /dsho/api/tasks`, and a **New task** button in the board topbar) creates a task that is **named from its own brief immediately** — whitespace collapsed, capped at 100 code points, `Untitled task` when the brief says nothing — so a card exists with a name on it before a model is involved. The worker is then asked **exactly once**, as its first instruction, to replace that provisional name through a new worker-protocol tool `orchestrator_task_title`; the replacement is **compare-and-swap** against the provisional title (a person's rename is never overwritten), one-shot, capped at 4 outstanding waits, and abandoned after a minute. A promptless task is allowed (AO's own case) and is simply never refined. Everything ported is named as ported: `src/domain/task-title.ts` holds the reference's rules and its four constants verbatim, `src/host/task-refinements.ts` its bounds. The one place this DIVERGES, and why: AO reads its provider's answer directly; DSH gives a plugin **no way to read an agent's output**, so the answer travels the channel that exists — a tool call from the worker — and the host owns the *expectation* instead of the call. | 32 tests: the ported title rules incl. code-point capping and the "no letter or digit" refusal; the registry's one-shot/expiry/cap; the service's ordering (the wait is registered **before** the spawn, because the worker is told to name the task and a later registration would race it); the queued-at-capacity path, where the wait is released because the queued worker is started by a sweep that never asks; the CAS refusal and the session rename. Plus **`test/integration/task-flow.test.ts`** — a real repository, a real worktree on a real branch, the real board: the card appears under the brief's words and is renamed in place when the worker answers. **Not yet verified LIVE:** the button and its dialog are built and asserted structurally (labelled modal, a real labelled textarea, focus in and back, disabled on an empty brief), but they have not been rendered in a live GUI — the half behind them is the half the integration test proves. |
| 38 | **The settings entry point is now a menu button.** The board topbar's `...` advertised `aria-haspopup="menu"` and delivered none of it — measured live, a click followed by **ArrowDown did not move focus at all**, the only way in was Tab, there was no arrow/Home/End navigation, and nothing closed the menu when focus left it. It now follows the WAI-ARIA menu-button contract (arrows open onto the first/last item and move with wrapping, Home/End jump, Escape closes and hands focus back to the trigger) with **Tab deliberately unhandled**: closing on Tab while the focused item is being unmounted is how focus ends up on `document.body`, so a focusout rule closes the menu instead — verified live, Tab lands on the next control and the menu closes. The surface was then aligned to the host's menu, measured off one: 16px radius (`radius-lg`), the translucent material (`specific-menu` over `menu-backdrop-filter` = 45% fill + `blur(40px) saturate(1.5)`), 144px min-width, items 34px at 13px/20px with a **12px** radius (`radius-md`, half the surface's) and the same prominent elevation. Note the host's own menus are **mouse-only** — portaled to the end of the body, so Tab leaves them and the arrows do nothing — which is why this follows the contract rather than the host. | 818 tests; every key path exercised with real key presses in the GUI |
| 37 | **The reviewer preset became reachable, and failures became locatable.** §13.1 asks for a per-repo `reviewerAgentPreset` and the contract already carried the field; **nothing read it**, so every install ran the plugin's reviewer. The page now has a **Reviewers** section whose one row writes it, and the reviewer pass reads it for all three things it feeds (the harness recorded on the `ReviewRun`, the preset it spawns, and the session facts the planner keys on) — per repo, falling back to the plugin default when empty. Alongside it: a **failed save is now reported on the row that caused it** (the host's refusal names the rejected key and every save sends exactly one, so the message lands where the user is looking, in place of that row's hint); `Saved` is now a receipt that clears itself rather than a permanent header; the **inline editor gives focus back to its pencil** (measured live: Escape in the editor used to leave focus on `document.body`); and the dialog **dismisses on a scrim press** like the host's own — guarded on `target === currentTarget`, because a drag that ends on the scrim is delivered there too and would otherwise throw the edit away. | 817 tests; the reviewer preset was followed through a REAL pass in the flow test; the row error, the receipt and the focus return were all measured live in the GUI |
| 36 | **The settings dialog rebuilt on the HOST's pattern.** The user's pointer was decisive: the reference (AO) is the right shape for a FORM, the host's own Settings is the right shape for THIS host. Measured off a live host dialog and transcribed: the mask (`bg-mask-1` + `mask-blur`, not a hand-mixed scrim), the panel surface (`bg-layer-2`, `radius-panel` = 28px, `elevation-prominent`), a fixed header over a scrolling body, rows as **hairline-divided** rows (not the reference's bordered card) with the label column taking the slack behind a 48px gutter, a 14px/22px title over a 12px/18px tertiary description, the **36x20 button switch with `aria-checked`** in the BRAND tone (green is a status colour here, not an "on" colour), 28px outline buttons, and `--dsw-focus-ring-*` outlines. Plus the accessibility the first version lacked: a **Tab trap** and focus RETURN to the `...` trigger. | 811 tests; measured live in **dark and light**, incl. Shift+Tab wrapping to the last control and Escape returning focus to the trigger |
| 35 | **Project settings.** The board topbar now names the connected project and carries a `...` menu that opens a modal settings dialog (the reference's Project Settings shape: section headings, one bordered group of rows, label left / control right — and the same Look: no project row menu exists in DSH, so the entry point is ours). Rows: Default branch, Session prefix (Worktrees); Enable issue intake, Repository, Assignee (Issues); Auto review PRs (Pull requests). Host side: `/dsho/api/settings` GET+POST, a pure validated patch contract, and the settings stored ON the `Repo` record so every consumer reads them live. **Four settings that were previously unreachable now reach the work**: `sessionPrefix` → a real branch, `workerAgentPreset` → the preset the spawn resolves, `intakeEnabled` → the queue sweep, `autoReview` → the review pass (that last one was already read; nothing could write it). | 35 tests across 3 files, incl. **`test/integration/settings-flow.test.ts`** — a real worktree branch on disk (`dsho/web/issue-1-…`), the resolved preset recorded by the spawn seam, and a queue held by intake-off then released by intake-on. **Verified LIVE in the web GUI**: the topbar names `acme/widgets`, `...` → Project settings opens the dialog, a switch and an inline edit each persisted (read back over the API), Escape closes it, and a record with NONE of the new fields read as the defaults |
| 1–3 | The board's read model: the Kanban reducer, activity model, session status, head-scoped review-run facts, the review-loop scheduler, card presentation (attention, ordering, lanes) | **78 + 37 tests are AO's own truth tables** translated from `kanban_test.go` / `status_test.go`, so a porting bug cannot hide behind a rewrite |
| 4 | Config: every PRD §13 default, explicit key-by-key validation, and the loud `agentRulesFile` path rules (A31) | 45 tests |
| 5 | **TypeScript migration** (hard requirement) — all source and tests ported, `tsc` clean, zero-dependency tests via Node 24 type stripping | 0 type errors at the time; the `test/**` half has drifted since — see the header |
| 5e | Made the **tests** type-clean too (was 105 errors, all deliberate invalid input and unannotated fixtures) | 0 errors across `src/` **and** `test/` at the time; the test files have drifted since — see the header |
| 6a | **The plugin installs and activates.** Entry, structural host-context typing, a local `defineTool` equivalent, one real tool | Live GUI: `Settings → Plugins → Installed 1 → @local/dsh-orchestrator` |
| 6b | **The worker spawner** — `dsh-webhook`'s audited recipe, step for step, with its rollback discipline | 12 tests incl. three rollback scenarios |
| 6d | **The worktree manager** — branch naming, `.dsho/worktrees`, add/remove/list, porcelain parsing, `check-ignore` preflight | 28 unit + **12 real-git subtests** |
| 6e | **The command seam** — argv over `ctx.subprocess`, bounded in time and output, failure classification | 33 tests |
| 6f | **GitHub credential chain** (`AO_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token`) and every `gh`/`git` argv | 30 tests |
| 6g | **Persistence and the repository preflight.** The fact store on `ctx.storageDomain.open()` (an earlier version of this row claimed `ctx.storage`'s KV layer — wrong, see §5 decision 19), record ids, and `connectRepo`'s three checks (git work tree → worktree root ignored → `gh` installed and authenticated) with a refusal that names the fix | 33 tests |
| 6h/6i | **The issue record and its tools.** `createIssue`/`updateIssue`/`assignWorker` with two invariants the record enforces (at most one active worker per issue; an empty patch is not a change), plus `orchestrator_issue_create` / `_list` / `_update` over the verified store | 32 tests |
| 6j | **`orchestrator_worker_start`** — the moment three separately-verified layers meet: `WorktreeManager` (real git) → `spawnWorker` (real host, spike 2) → `assignWorker`. Plus the **worker contract** (PRD §12.4), the `Worker` record and its phases (§7.3/§5.2), and per-repo issue **numbers** | 27 tests |
| 6m | **The outbox delivers.** A tick calls `planDelivery` and delivers each batch into the session that created the issue, via `ctx.agents.get()` — reached through the registry, not an owned handle, because the plugin does not own the user's session. Claim-before-send, with the claim released on failure | 9 tests |
| 6n | **The PR observer.** The `PrSnapshot` record and the `gh pr view --json` parser, plus the per-repository serialised poll. R13's invariant is the substance: a failed observation writes `fetched: false` **with the prior facts**, so even a caller that ignores the flag cannot see a fabricated `CLOSED` | 18 tests |
| 6o | **The auto-review pass.** The reviewer contract (PRD §12.5, with "prefer a few high-confidence findings over nitpicks" quoted because that line is what stops every PR hitting the round cap), the read-only reviewer session in the worker's **own worktree**, the pinned-head `ReviewRun`, the head-checked verdict, finding routing, and the failed-pass retry budget | 16 tests |
| 6p | **The review sweep, and a real activity gate.** A tick schedules a pass for every worker whose head has none, and the gate now reads the **live** `AgentStatus` rather than assuming the worker is quiet | 5 tests |
| 6q | **The board assembly.** `buildBoard` joins the stores, the reducer and the presentation layer — the only place that does, so the agent's view and the GUI's cannot disagree. Plus `orchestrator_board` | 1 test file |
| 6s | **The client half.** `src/client/index.ts` polls `/dsho/api/board`, renders four lanes with loading/empty/error states, and registers its slots. Its own `tsconfig.client.json` emits a **classic script** (`module: none`), since that is what `window.__ModuleLoader__` requires | builds |
| 6s.1 | **One board per project, not one global board.** A connected project gets a sidebar row AND a `main` keyed panel, addressed by the same id (`orchestrator:<repoId>`); the host scopes the cards, lanes, archive and counts by `?repoId=`, and the project list on every snapshot stays complete so the row list is never scoped by whichever panel polled last. The global row is gone: it could not answer "which project is this?" | **live** (two seeded projects: each row opened its own board and its own settings dialog) + 8 executable client tests against a fake `ctx.slots`, and 7 host scoping tests |
| 6t | **The panel renders in a real GUI.** Module loaded, nav row present, selection works, and the panel shows its heading, count and empty state | **live** |
| 6u | **The whole path, end to end.** A host spike drove `connectRepo → createIssue → startWorker → buildBoard` against the real services: a real worktree, a real session, and a card in `building` reading `Awaiting PR` | **live**; found a real argv bug |
| 6v / 6v.3 | **The lane sequence, closed in chunk 41.** The worker opens a PR (`gh pr create`), the observer sees it, the review sweep schedules a pass, and the card visibly moves `building → validating (Review scheduled) → validating (Reviewing) → needs_review (Needs human review)` — plus the failed-pass path. The half after `worker_start` had never executed before chunk 41. | §7.5, §7.6, A13, A17 — **CLOSED, verified live**; see chunk 41 for the trace. The lane spike needed its own storage domain because **a storage domain can only be opened once per process**, and the plugin's own `~/.dsh/storages/dsho.json` now carries the plugin's live records rather than any spike rows (§4). |
| 13 | **M2's inspector renders.** It was implemented and building but unrendered: seeding a card pointed the lane spike at the plugin's own domain, and the plugin's endpoint began answering "domain 'dsho' is already open". The spike now writes to its OWN domain. | §11.2, M2 — **CLOSED**: rendered and driven by keyboard in a live GUI (`83b7a47`, `f278330`). |

Spikes: **M0 spike 1** (the panel seat is real) and **M0 spike 2**
(`ctx.agents.create()` works for a third-party caller) are both closed — see §3.


Scaffolding: `package.json` (bundle manifest, `dsh.bundle.patch`), `cordis.patch.yml`,
`LICENSE` + `NOTICE` (the Apache-2.0 attribution PRD §20 requires for ported code),
`tsconfig{,.src,.build,.spike}.json`, `.gitignore`.


---


## 3. Findings worth not rediscovering

> **Read this index first.** The section below is the largest part of this file (~440
> lines) and is written as prose, because each finding is a story. But **ten of the
> findings are one lesson wearing different clothes**, and knowing the shape saves
> reading them all:


> ### The one lesson, in one line
>
> **A failure that is silent looks like success. Only reality — a live run, the real
> tool, the real type, the real file on disk — says otherwise. Not a fake, not a
> string assertion, not a compile that passes, and not your own summary of the work.**
>
> The instances, each of which cost a chunk:
>
> | Instance | What was silently wrong |
> |---|---|
> | The storage adapter | Called a method that did not exist; fakes agreed with it |
> | `git worktree list` | Returns realpath paths, so `remove` silently did nothing |
> | A worktree fake | Reported an empty list, so removal was a no-op — **twice, six rounds apart** |
> | `gh repo view .` | Resolves to `<owner>/.`; the argv test could only assert what its author intended |
> | The observer's snapshot key | Written by `workerId`, read by url — two green halves that disagreed with each other |
> | `ctx.agentRegistry` | A service I invented; **crashed the host** at the first tick |
> | `agent/created` payload | Read the payload *as* the agent, so the listener restricted nothing |
> | `ctx.locale` | **Throws when not injected**, even though the type said optional |
> | `normalizeWorker` | A field added to the type is dropped on read — the dedup never held |
> | `isBotAuthor` on a parsed record | Reads `__typename` from a raw payload; returned `undefined` for every review |


> ### Three rules that follow
>
> 1. **Prove a probe can detect what it looks for before trusting it.** A probe that
>    agrees with every hypothesis is a mirror, not an instrument. Three instruments in a
>    row failed to measure one boolean (§12.2) and each was plausible.
> 2. **Reading the right log is the whole of the diagnosis.** The host log was quiet
>    while the browser console reported the failure all along.
> 3. **Audit the spec against the code, not against your own narration.** It found
>    `maxConcurrentWorkers` validated, displayed, and never enforced.


> ### A second, distinct lesson
>
> **A boundary relaxed to make a test easier is a boundary that was protecting
> something.** A spike that joined the plugin's storage domain did not merely add rows —
> it broke the plugin (`domain 'dsho' is already open`). Isolation is load-bearing.




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


**The storage API was misread once, and the fakes could not catch it — now FIXED
and verified against the real backend.** `openFactStore` was written against
`ctx.storage.form('kv')`. Neither half was real: `ctx.storage` is a **form hub**
reached as `ctx.storage.<form>`, there is **no `kv` form anywhere**, and
`KvFacet`/`KvUnit` are *backend* interfaces a plugin does not call.


Three facts the correction turned up, all of which would have bitten later:


  - `ctx.storageDomain` **is** the facility; `ctx.storage.domain` is the same object
    through the hub. The direct ctx key is the simpler target.
  - **Domain and table names must match `/^[a-z][a-z0-9_]*$/`.** `prSnapshots` and
    `reviewRuns` would have thrown *at module load*. Storage names are snake_case;
    the ergonomic camelCase keys are ours.
  - The native path **does** need zod (`DomainTableSpec.valueSchema` is a `ZodType`).
    zod is a normal public package, so the symlink problem that rules out other DSH
    imports does not apply to it — it is pinned to the profile's version so the
    schemas are the same `ZodType` the host validates with.
  - `Domain.table()`'s `get`/`entries`/`keys` are **synchronous**: the domain is
    itself the cache. The hand-rolled cache this module used to carry was solving a
    problem that does not exist, and could have diverged from the backend.


**Verified against the real backend** by `src/spike/storage-spike.ts` (M0 storage
spike): the domain opened, all five tables accepted their names, a record survived a
put/get round trip, overwrite replaced rather than appended, delete emptied the
table, and close released it. It also persisted —
`~/.dsh/storages/dsho.json`, holding `unit: { name: "dsho", version: 1 }` and the
records under `repos`, `issues`, `workers`, `pr_snapshots`, `review_runs`. **That
file is the proof the snake_case names were required**, and the test residue was
removed afterwards.


This is the **second** bug of exactly this shape, after the worktree
canonicalization: **a fake cannot catch a wrong API, because it implements whatever
interface the author imagined.** The tests were green throughout — which is why the
fix was verified against reality rather than against another fake.


**PROVE A PROBE CAN DETECT WHAT IT LOOKS FOR BEFORE TRUSTING IT.** I asserted "the
restriction is not working" from `agent.ctx.tools.get(name)`. Having the spike apply a
restriction *itself* — which succeeded, returning a real disposer — left the probed
view unchanged, so `get()` resolves globally and **cannot see scope restrictions at
all**. The instrument was a mirror: it agreed with every hypothesis. This is the same
lesson again, and the first where the flawed instrument was mine. The
restriction's status reverts to **unknown**, because the stronger claim was not
supported by the measurement. What the same run *did* establish is that
`agent.ctx.tools.restrict({deny})` exists, is callable and returns a disposer — so the
mechanism is real; whether the listener reaches it remains open.


**Reading the wrong object does not throw — it silently does nothing.** The
`agent/created` payload is `{ agent, source, signal }`; the listener read it *as* the
agent, so every session arrived with `session: undefined`, was classified `other`, and
the deny-list was applied to nothing. **The whole restriction was inert**, and the
wiring had no unit coverage because it was assumed to be glue. A spike probing what a
session actually sees is what found it, and it is the same lesson again: the
failure is silent, and only a real run or a real type says
otherwise. It also means "fail-safe" cut both ways — the fail-safe posture kept a
global restriction from breaking every session, while the same silence hid that
nothing was restricted at all.


**`build:spike` alone leaves no client bundle, and the host refuses to start.** "1
required plugin did not activate ... client bundles not found; run pnpm run build
before launch". The host is right and my invocation was wrong: every earlier round had
a full build before the spike build, so `rm -rf dist && npm run build:spike` never
showed the gap. **The two builds are not interchangeable, and the failure is at
startup with a clear message — which is the good kind.**


**A guard that fails safe is not the same as a feature that works.** The tool
restriction is written against the design read from the installed types, and it is
unit-guarded in five ways — but its *effect* (one session's tool list) is not observable
from outside a session, so "applied and unobserved" is where it stands. The posture is
deliberate: a missing restriction is a small gap, a global one is a broken product, so
the wiring does nothing when it cannot be sure. Recorded as the next chunk rather than
counted as done.


**AUDIT THE SPEC AGAINST THE CODE, NOT AGAINST YOUR OWN NARRATION.** Recent rounds implied only A4 and §12.2 remained. Re-reading the milestones against `src/` found `maxConcurrentWorkers` **validated, displayed, and never enforced** — the plugin started unbounded workers — plus an absent human feedback loop (M4) and an empty `locale/` (M7). A long session drifts toward believing its own summaries; the spec does not drift.


**A CLEANUP YOU HAVE TO REMEMBER TO RUN IS A CLEANUP THAT STOPS HAPPENING.** Clearing the spike residue once was not enough, because every verification run re-created it. The seed now removes its OWN registration at the end. And the question that raised was worth measuring rather than trusting: the real session it created was attached to that workspace, so deleting the registration could have broken the card's navigation -- the platform documents `delete` as retaining the directory and the session logs, which says it does not, and the measurement agrees (`navigatedAwayAfterDelete: true`).

**A CLEANUP THAT DELETES BY A RULE YOU CANNOT READ AFTERWARDS IS INDISTINGUISHABLE FROM ONE THAT DELETES TOO MUCH.** The spike-residue removal records EVERY registration it considered, then deletes only `/tmp/dsho-*` scratch paths through `Workspace.delete`. "Removed six" would look identical if the filter had been wrong; the evidence that matters is that the user's four real workspaces survived. Do not hand-edit a running service's state file when it exposes the operation -- and when it does not, say so rather than reaching into the file.

**A CLICK THAT DOES NOTHING AND A CLICK THAT NAVIGATES LOOK IDENTICAL WHEN THE TARGET DOES NOT EXIST.** The 11.2 session-opening could not be verified with a seeded `sessionId` the harness had never heard of: the navigation had nowhere to land. Making the seed CREATE A REAL SESSION first turned the ambiguous result into a measurable one -- bogus id, panel stays (the fallback fires, proving the service is present); real id, panel gone (`navigatedAway: true`). **When a test cannot distinguish working from inert, the fixture is usually the problem, not the code.**

**THE INTERFACE DECLARED THE METHOD BUT NOT THE SERVICE KEY -- the call sites did.** To
close the 11.2 divergence I needed `ctx.<something>.openSession`. The type file declares
`UiWorkspace.openSession` and no module augmentation naming the key, so `ctx.<name>` was
not discoverable from the types. Grepping CALL SITES found `ctx.uiWorkspace.openSession(id)`
and `inject = ["slots", "uiWorkspace"]`, both in shipped plugins -- evidence, not
inference. **When a service key is not in the types, read how someone else reaches it.** The gap this closed is 11.2's: the card body now opens the WORKER'S DSH SESSION -- "the real working room, not a plugin-drawn chat" -- through the harness's own navigation, verified live with a real session, and the inspector keeps its place behind the hover action, where "one click further" belongs.

**AND CHECK BEFORE REMOVING: THE DEAD RULE WAS ALREADY GONE.** I went to delete two now-unused CSS classes and the edit reported the anchor missing -- because the earlier patch had already replaced them. A removal that reports nothing to remove is a correct outcome, not a failure to retry; the grep afterwards confirmed zero references.

**THE ARCHIVE COLUMN WAS STRUCTURALLY UNREACHABLE.** `isTerminated` short-circuits BOTH the kanban and the status derivation, and `buildCard` hardcoded it false — so the archive sheet could never hold anything and `Terminated`/`Merged` could never be displayed. The board had been fetching `lenses.archive` every poll to render a count that was always 0. Derived now, with a test asserting that active workers STAY on the board, because the risk of deriving a flag is over-applying it. **The same shape as the config audit: a behaviour displayed with nothing that can make it true.**

**AND PROSE PUNCTUATION IS CODE INSIDE A TEMPLATE LITERAL.** The stylesheet is one 100-line template literal; a backtick in a comment closed it and the following word was parsed as an identifier. Worth knowing before writing a comment in that block.

**ONE DROPPED POLL MUST NOT BLANK THE BOARD.** `setView(next)` replaced whatever was on screen, so a single failed request told the user the plugin was broken -- for a UI polling every 5 seconds, not a rare state. The reference's instinct is the fix: a banner above a board whose height does not move. Verified by KILLING THE HOST and measuring: 1 card and 4 lanes survived, the banner appeared with `role="status"`, and nothing blanked. **A degraded state deserves a sentence, not an empty screen** -- the same rule as `No signal` over a fabricated status.

**MEASURE THE BOX, NOT THE PICTURE.** After adopting the reference's full-height columns a lane measured **817px inside a 791px container** — `height: 100%` plus padding, with `box-sizing` at its `content-box` default. The screenshot looked fine; the numbers did not. Fixed by scoping `box-sizing: border-box` to the panel subtree, which closes the class rather than the instance. In this goal two defects were invisible to the tests AND to a casual look and visible only to a measurement with a number to compare against.

**A CARD'S JOB IS ONE QUESTION; EVERY BADGE MUST SERVE IT.** The card could not answer "is this waiting on me?" because nothing on it named a person, although the host had carried the reviewers in `prSnapshot.reviews` all along. The rules that keep the badges honest are the interesting part: the LATEST review per author wins (else a satisfied reviewer reads as a blocker), bots are excluded (our own reviewer's approval is already the status line, and an avatar for it would imply a human looked), and an unnamed review is dropped (a badge with no name is worse than none).

**THE THEME SWITCHES ON AN ATTRIBUTE, NOT THE OS PREFERENCE.** DSH themes via `body[data-ds-dark-theme]`; `prefers-color-scheme` does nothing. Two measurements were meaningless before I found that. Related: **a computed value read at an arbitrary moment is not a measurement of a rule** — I saw a card's background mid-`transition` and nearly reported light mode as broken; measuring the token showed it flipping correctly. And in LIGHT mode the host's `bg-layer-1..3` are ALL #fff, so lane and card backgrounds collapse (`cardVsLane = 0`): the distinction has to come from borders, which is why the card's is a step stronger than the lane's.

**FOUR THEME TOKENS I USED DO NOT EXIST, AND THE FALLBACKS HID IT.** `--dsw-alias-text`, `-surface`, `-border`, `-status-danger` are all invented; each had a literal fallback, so nothing looked broken while the board followed the host theme in NO respect. Two further traps from the same hunt: `--dsw-alias-fill-l1`/`-l2` are UNSET, and **`--dsw-alias-brand-primary` is #f9fafb -- nearly white, not an accent** (the accent is `-state-business-primary`), which is why a 'busy' status rendered white. **A token name is an assertion about someone else's code: measure it, never infer it from a grep of the string.** The CSS now lists the unset names so they cannot return.

**SEARCH FOR THE MECHANISM THE SPEC NAMES, NOT THE ONE THE NAME SUGGESTS.** `hideWorktreeWorkspaces` looked unimplementable: the workspace registry exposes no way to hide an entry, so a search for a hiding API finds nothing. The PRD says the mechanism instead — **"by NOT ATTACHING them"** — and the setting is obeyed by omitting one call. The name describes a visibility flag; the implementation is an absent `attachSession`. **I had already concluded "cannot be obeyed as named" and would have written that into the handoff as fact.** A plausible negative is the most expensive kind of wrong.

**SOME SETTINGS CAN ONLY BE OBEYED BY INSTRUCTING AN AGENT.** `draftPrs` and `prBodyTemplate` were dead because **the plugin never opens the pull request** — the worker does, from its own session — so a setting about HOW it is opened is enforceable only through the task message. That looks identical to a setting nobody implemented, and the fix is completely different: one needs code, the other needs a sentence. **Before calling a key dead, ask who COULD obey it.**

**RUN THE AUDIT EXHAUSTIVELY; AD HOC FOUND THREE, THE SWEEP FOUND FOURTH.** For every config key, find the code that ACTS on it, not the code that mentions it: 26 keys, **4 read by nothing at all** (`draftPrs`, `hideWorktreeWorkspaces`, `maxReportCharacters`, `prBodyTemplate`). The worst is the one where the behaviour EXISTS and the setting is bypassed -- truncation ran with a hardcoded bound, so `maxReportCharacters` was ignored while appearing to work. **A setting that is offered and then not applied is worse than no setting, because the user believes they configured something.**

**A SETTING THE BOARD READS IS NOT A SETTING ANYTHING OBEYS.** Three gaps found by auditing, all the same shape: `maxConcurrentWorkers` (validated, displayed, never enforced), R14's guardrail (in the PRD, no code), and `autoInjectCI` (read by the reducer to derive `Fixing CI failures`, read by nothing that acts). **The board reading a setting makes the gap invisible, because the UI looks like proof that the behaviour exists** — a card claiming `Fixing CI failures` is evidence of a label, not of a loop. The audit that finds these is mechanical: for every config key and every R-requirement, find the code that ACTS on it, not the code that mentions it.

**A RULE CAN BE IMPLEMENTED, TESTED, AND BYPASSED BY WHAT FEEDS IT.** R20's sticky rule was correct -- `isSticky` exists and `deriveStatus` checks the paused case before the clock -- but `buildCard` never SET the activity from the protocol, so a worker with an unanswered question arrived as plain `idle` and the clock demoted it to `No signal`, which is exactly what R20 forbids and rates HIGH. Testing a rule in isolation cannot see that its input never arrives. Assert the reader-visible outcome instead.

**A GUARD APPLIED TO THE WRONG DIRECTION IS A DEADLOCK.** R14 says a blocked worker is never injected into. Applied to the outbox as well -- which delivers a worker's reports into the ORCHESTRATOR session, the opposite direction -- it holds the worker's own `needs_input` report, which IS the blockage: nobody sees the question and the block can never clear. Seven tests failed on exactly that. **Before adding a guard, establish the direction it protects.** In that case the ABSENCE of a guard is the property, so a test now asserts the outbox does not consult the predicate at all.


**A QUEUE MUST RECORD THE INTENT, NOT INFER IT.** The slot queue could have started `open` issues, and then merely CREATING an issue would eventually spawn a worker -- an action nobody asked for, triggered a tick later. It uses an explicit `pendingWorker` flag instead, carried in the issue normalizer because the previous chunk proved that a field added to the interface alone does not survive a read.


**A FIELD ADDED TO A TYPE IS NOT A FIELD THAT SURVIVES STORAGE.** `normalizeWorker` builds its record FIELD BY FIELD, so `feedback` — added to the `Worker` interface — was written by the router and **silently dropped on the next read**. The dedup therefore never held and every poll re-nudged the worker, which is the exact failure the dedup exists to prevent. The types were happy the whole time. Any field on a stored record must be carried explicitly in its normalizer, and validated there rather than trusted.


**A parser's output is not its input.** `isBotAuthor` reads `__typename`/`type` from a RAW provider payload; a parsed `PrReview` carries the verdict in `isBot`. Calling `isBotAuthor` again on a parsed record returned `undefined` for every review, so our own bot reviews were treated as human and routed back to the worker. **Once a value is parsed, read the parsed field** — re-deriving it from a shape that no longer holds is a silent wrong answer.


**A SERVICE THAT IS NOT INJECTED THROWS WHEN READ — even for an "optional" one.** `ctx.locale` is not injected; reading it threw; `apply` never completed; the client entry failed to activate; and the harness then refused to render **its own shell** because a client plugin had failed. The same trap `ctx.agentRegistry` set on the host half. Marking a field optional in the TYPE does not make the READ safe: an optional service must be read through a guard, because the read is what throws. Two further lessons from the same chase: the HOST log was never the channel (the browser console said `web boot: 1 entry did not activate` all along), and removing the `inject` for an "optional" service made things worse by removing the only thing that made it readable. I wrote a fallback for a missing locale service and then declared that service a REQUIRED `dsh.client.inject` — so the plugin failed to load in precisely the environment the fallback exists for (`web boot: 1 entry did not activate`). Two cheaper probes said the code was fine: the console error carries no cause, and the emitted bundle evaluated cleanly under Node stubs. **A bundle that passes in isolation and fails in the host points at the MANIFEST, not the code.**


**A STORAGE DOMAIN CAN ONLY BE OPENED ONCE PER PROCESS.** A spike that joins the
plugin's domain does not merely add rows -- the plugin's own `/dsho/api/board` starts
answering `domain 'dsho' is already open`, so **the spike breaks the plugin**. The
spike's isolated domain was load-bearing, and I removed it for convenience to get a
card onto the board. Reverted, and the reason is now written in the spike so it is not
removed again. **The generalisable form: before relaxing an isolation boundary to make
a test easier, establish what the boundary was protecting.**


**Registering something is easier than unregistering it.** The spikes left rows in two
storage domains *and* workspace entries in the profile's live `workspace.json`. The
domains were removable because their rows pointed at throwaway `/tmp` paths — a deletion
guarded by the data rather than by the intention. The workspace entries looked like they
were not: that file is a running service's own bookkeeping, and hand-editing it would
mean reimplementing the registry from outside with the user's real workspaces in the
same table. They turned out to be removable **through** the service — `Workspace.delete`
removed every `/tmp/dsho-*` registration and the user's four real workspaces survived
(`b4ab859`) — so the earlier "not removable" reading was wrong: the file was off-limits,
not the operation. **A spike that registers through a service needs a way to unregister
through it**; prefer that to reaching into its state file, and when it exposes no such
operation, say so rather than editing the file. M0 spikes should prefer paths nothing
else indexes.

**Two green halves that disagreed with each other.** The observer writes a PR snapshot
under `snapshotKey(workerId)`; the board read them by matching the snapshot's url to
`worker.pr.url`. Those differ in the **normal** case — one comes from the worker's
report, the other from the provider — so a real pull request never moved a card, with
no error and no log. Both halves were individually green because **each side agreed
with itself**. A unit test at a boundary cannot see a disagreement *across* it; only a
run that crosses it can.

**The argv looked right and the tool disagreed.** `gh repo view .` resolves to
`notmd/.` — gh reads the argument as an explicit `owner/name`, never as a path — so
`connectRepo` failed with `gh-failed (not-found)`. The current repository is selected
by passing **nothing**. A unit test could only assert the argv its author intended,
and `.` looked entirely reasonable; only the real `gh` could say otherwise. **The same
lesson again**: a fake, or a string assertion, cannot falsify what the
real tool does with its input.

**A diagnostic must not look for furniture the empty state does not have.** I checked for
`[data-lane]` and `.dsho-panel` and concluded the panel was broken — but the empty state
renders no lanes, and I had removed every className when switching to inline styles, so
`.dsho-panel` cannot match by construction. Checking by *visible text* found the panel
working immediately. This is the second wrong-diagnostic-in-one-session; the pattern is
that a failed check is more often a bad probe than a bad system.


**A classic script is not a module, and the emitter decides which.** `window.__ModuleLoader__`
loads a **classic script** — that is what the host contract says — while this package is
`"type": "module"`, so `tsc` marked the file a module and appended `export {}`. The
bundle would then be loaded as a module and the loader would never be found. Visible
only by looking at the emitted file (`grep -cE '^(import|export)'`), which is now part
of the build check. `module: none` fixes it and is **deprecated in TS 6, removed in
TS 7** — a real maintenance item, and the alternative is stripping the appended
`export {}` after the emit.


**A service I invented crashed the host, and only a live boot could show it.**
`ctx.agentRegistry` **does not exist** — the registry *is* `ctx.agents`. Cordis refused it
at the first outbox tick with `cannot get property "agentRegistry" without inject`, and
the host **exited with code 1**. Every unit test passed, because the fakes had
`agentRegistry` as a plain property; a fake cannot enforce an injection contract.

This is the most severe shape of that lesson: the others degraded a feature, while
this one takes the process down. **Run the live boot before claiming a
host feature works** — it is one command, and `npm run verify` cannot substitute.


**Covering the assembly found a real interface problem.** `toPrFacts` returned the
*input* shape, so `facts.externalReview` was optional and every caller had to narrow
it — the tests failed to compile for exactly that reason. It now normalizes on the way
out via `prFacts()`, so a caller gets Go's zero values on every field. The reducer
tolerates holes; a caller reading `facts.externalReview.approved` does not.


**A presented card had no `updatedAt`, so it could not be ordered.** `orderCards` was
typed for `BoardCard`, but the lanes hold **views** — a different type. Typing the sort
against `BoardCard` would have forced every caller to re-derive a card it already had,
so it now takes a structural `OrderableCard` and the view carries `updatedAt`. Casting in
the caller would have hidden the gap rather than closed it.


**The review gate reads live activity, and `unknown` is not `idle`.** `AgentStatus`
is only `idle | running` — exactly the signal the gate wants, since a reviewer must
not race a worker whose diff is still moving. With **no** live handle (after a
restart, before the worker does anything) the honest answer is `unknown`, which the
gate refuses. Refusing is the safe direction: the pass starts as soon as the worker
next reports, whereas reviewing a moving diff reviews the wrong thing. A test
fixture with no `status` caught this by being correctly refused.


**A verdict is bound to a commit, and the plugin pins it.** The reviewer does not
choose which commit it judged: the pass records the pinned `headSha` on the
`ReviewRun`, and a verdict naming anything else is **rejected** (A16). Without it, a
worker pushing mid-review could have its *old* head's approval applied to its *new*
one — the exact race head-scoped runs exist to prevent. A rejected verdict leaves the
run `running` so the pass can still complete correctly.


**The dangerous failure is data that looks like a state change, not absent data.**
An empty PR payload reads as `CLOSED` to the reducer — and a closed PR archives a
live worker. So a failed observation writes `fetched: false` **carrying the prior
facts**, which means even a caller that ignores the flag sees the previous state
rather than a fabricated transition. A truncated `gh pr view --json` is the sharpest
case: invalid JSON that looks like valid input, so it is refused as a failed
observation rather than parsed halfway.


**Bot detection reads the provider's type, and reports UNKNOWN when there is none.**
`login.includes('bot')` false-positives on `robothon` and `lambot123`, silently
dropping a **human's** review feedback — the worst direction, because the worker
never hears about it. Unknown is deliberately not "human": the caller decides.


**Delivery goes through `ctx.agents.get()`, not an owned handle.** The plugin owns
handles for sessions it spawned, but the orchestrator session is the **user's** — so
it is reached through the agent registry instead. That is also why delivery keeps
working across a plugin reload, and why a worker's report can land in a session the
plugin never created.


**Read the cause, do not invent it.** `Agent.cancel()` takes `AgentCancelCause`, which
is `{ kind: 'user' } | { kind: 'parent' } | { kind: 'hook', reason } | { kind: 'disposed' }`
— so **only `hook` carries a reason**. A `reason` on a user cancellation would be an
invented field that happens to be ignored today. The caller's text is echoed in the
tool's reply instead. Same discipline as the storage API and the `check-ignore` exit
codes: read the installed type, or find out later.


**Unload must not dispose handles, and it looks like a leak.** A9 says unloading the
plugin leaves sessions and worktrees intact — but disposing an `AgentHandle` "stops
and drains, unregisters, removes the session, and unwinds the scope". So unload
**drops the references and disposes nothing**, and the preset scope lease each worker
holds is left alone too. Both are asserted by tests, because a reader who has not read
A9 would "fix" it into destroying the thing that must survive.


**A worker's identity is its session, never an argument.** `orchestrator_report`
takes no worker id: the caller's session (`exec.agent.session.id`, read from the
installed `ToolExecutionInput` rather than guessed) identifies the worker and the
plugin resolves it. A worker that could supply its own id could report on another's
behalf, and the board would show one worker's progress against another's card — the
same reason server-side sessions exist at all.

**A fake must model reality, or it hides the bug it was written to find.** The
`worktreeGit` fake reported an empty `worktree list` always — so `remove` found
nothing to remove, was a silent no-op, and the test asserting *"a failed spawn
removes the worktree it just made"* failed for the wrong reason. Git is stateful:
`worktree add` changes what `list` reports. Delegating to the stateful fake for
everything except `remove` fixed it. **The same fake produced the same bug twice,
six rounds apart**, which is the argument for making fakes stateful by default
rather than by request. A fake that implements the author's *idea* of an interface
cannot falsify anything about the real one — which is also how the storage adapter
stayed green while being entirely fictional, and how the realpath bug survived the
unit tests.

**A flaky test, not a flaky test.** An issue-list test asserting "oldest first"
passed on one run and failed on the next. The cause was real: record ids ended in a
**random** half, so two records created in the same millisecond ordered arbitrarily —
and `byQueueOrder` tie-breaks on `id` to express "oldest first". The ids are now
**ULID-monotonic** (the random half increments as a counter while the clock stands
still, and a backwards clock step is clamped forwards), so within a process id order
really is creation order. A second consequence worth knowing: `timestampOf()`
reports the timestamp actually *issued*, which may be later than one you passed in.


**A live session's log buffers.** "No turn events on disk" does **not** mean no turn
happened. Read the log after the session closes, or watch the GUI.


---


### Three findings from rebuilding the settings dialog against the HOST

1. **`React.createElement` gives one child's ELEMENT, not an array.** A
   `...(props.children ?? [])` spread worked for the three-row sections and threw
   `Spread syntax requires ...iterable[Symbol.iterator] to be a function` for the one
   section holding a single row -- and because it threw during render, the slot's error
   boundary blanked the ENTIRE panel with no visible cause. `?? []` does not help: the
   value is not null. Normalize with `Array.isArray`, and pass rows as one array argument
   at the call site. Caught only in a live host; `tsc` and 810 tests were green.
2. **The host's switch is a `<button role="switch" aria-checked>`, 36x20, in
   `--dsw-alias-brand-primary`** -- which is `#f9fafb` in dark and near-black in light, so
   the "on" tone is monochrome and flips with the theme. Green (`state-success-primary`)
   reads as "the thing is healthy", not "the thing is on", and the host reserves it for
   status. The same dialog also defines `--dsw-alias-bg-mask-1` and `--dsw-mask-blur` for
   the scrim and `--dsw-elevation-prominent` for the shadow, so no colour literal and no
   `color-mix` is needed anywhere in a modal.
3. **Focus return is not "focus what was focused".** The opener was the menu ITEM, which
   unmounts with the menu, so the restore was a silent no-op. Capture the control that
   OUTLIVES the action (the `...` trigger) at the call site and pass it down.


### The fact store is shared by every DSH process, and the last writer wins

Two settings flipped back on their own during this work, which looked like a bug in the settings path and was not:

- `~/.dsh/storages/dsho.json` is **one JSON unit** and it is not scoped to a profile, so **every** `dsh` process
  that loads this plugin -- the desktop app, each `dsh --profile web`, every server started earlier in the session --
  reads it into its own memory and writes the whole unit back.
- A process that has been running since before a change therefore holds a **stale copy**, and the next time it writes
  anything it puts that stale copy back, reverting fields it knows nothing about. Seven orphaned seed servers were
  alive, and one of them was the GUI hosting the session itself.
- Proof it is contention and not loss: a value written through the API, followed by `kill` and a fresh start, comes
  back intact; the file on disk matched every write at the moment of the write.

The practical rules: **verify settings through the server you are editing through**, and kill leftover
`dsh --profile web --patch /tmp/dsho-seed-patch.yml --port 0` servers before believing a settings bug.
Check the port first (`lsof -a -nP -p <pid> -iTCP -sTCP:LISTEN`): one of those processes was listening on the port the
session's GUI uses, and killing it would have ended the session.


## 4. Next

**Only genuinely-open items belong here, and this table has repeatedly drifted** — rows stayed
after their work was done, including R7's check and §12.2, both of which were listed as missing
after being closed. A "next" table that contradicts the "done" table is worse than no table: the
reader believes the stale one and re-does finished work. **Prune it whenever §2 grows.**

| Item | State | Why |
|---|---|---|
| **M6 hardening** | Optional, not started | Explicitly optional in the PRD: webhook ingress, plan gate, notification badge, `token+fetch` fallback, dedicated agent presets, a reviewer panel. |
| **§12.2's platform half** | Assumption, not a task | The wiring is verified (fake `agent/created`, four tests). What remains is whether DSH honours `restrict` for a scope — three instruments failed to measure it and the documented contract says it does. Do not add a fourth instrument without proving it can measure the property. |
| **A4's follow-through** | The flow ran; the pull request was then closed unmerged | The whole cycle happened live in chunk 41 (a real `gh pr create`, a reviewer pass at a pinned head, the card stopped at the human gate). PR [#5](https://github.com/notmd/dsh-orchestrator/pull/5) was **closed unmerged** afterwards (`state: CLOSED`, `mergedAt: null`), so nothing downstream of the human gate has run live: `merge_ready` and the merge/feedback half remain unexercised. Local `main` measured **2** commits ahead of `origin/main` when this was written; that number drifts, so read it as a measurement rather than a fact. |
| **G5: merge with a `sha` precondition** | Deliberately not implemented | The teardown's own verdict: AO's `PUT /pulls/{n}/merge` with `sha` set to the reviewed head is "the one write action whose design is worth copying **even if we never take the capability**". There is no merge button and there should not be one until the user asks; if there ever is, it is that call, because "merge the commit that was reviewed" then becomes a provider-enforced precondition rather than our own check. |
| **G1's conditional-request path** | Open, and blocked upstream | The teardown measures AO at ~1 mostly-**unbilled** REST call per 30 s because 304s are free, against our 2 billed calls always. `gh` exposes no ETag/If-None-Match, so the gate G1 names first — "skip a tick when `snapshot.updatedAt` is unchanged" — cannot be built on this transport at all. Chunk 40 took the two mitigations that do not need it (a slower cadence for settled cards, and a discussion refresh on its own interval). Closing the rest means leaving `gh` for `fetch` + ETags, which is a transport decision, not a state-model one. |

**The spike-residue housekeeping is closed**, and it left this table because the residue is gone. Measured 2026-10-02: neither `~/.dsh/storages/workspace.json` nor `~/.dsh/storages/dsho.json` holds a `/tmp/dsho-*` path or a spike row — the removal was real work (`b4ab859`, `0f19095`), not drift. What both files do hold is the plugin's own live data (one repository, 8 issues, 7 workers, 7 PR snapshots, 9 review runs) and its own issue worktrees beside the user's real projects, which is the plugin working rather than residue. Both files sit in `~/.dsh/storages/` and are shared by every DSH process rather than scoped to the web profile (§3).

**The settings surface has had five chunks of its own** (35 the page and the four settings that reach
acting code, 36 rebuilt on the host's own pattern, 37 the reviewer preset plus row-level failures,
38 the entry point as a menu, 42 the plugin's own settings on the Plugins page). Anything further
is polish chosen by the user, not by the PRD.

**One lesson from that work is worth keeping:** a host module is loaded at activation and does
**not** hot-reload (`touch`ing `dist/index.js` does nothing), so any host-side change needs a
restart before a GUI check — a 404 on a new route is the symptom to expect, not a bug in the route.

**Nothing here is required by the PRD except M6, which the PRD itself marks optional.** The next
chunk should therefore be chosen by the user rather than assumed: M6, or work
outside this repository.

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
4. **`requireHumanApprovalBeforeReady` defaults to `false` in the reducer *and* in
   the shipped config** (chunk 43 — the user overruled the PRD's default). The
   reducer's default is the AO-exact behaviour, so the flag's absence cannot silently
   change a ported case; the config layer used to set `true` on top of it, and no
   longer does. This is why all ported tests pass unchanged, in both states.
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
19. **Persistence is `ctx.storageDomain.open()` with zod schemas**, pinned to the
    profile's zod version so the schemas are the same `ZodType` the host validates
    with. (An earlier version of this decision claimed the KV layer avoided zod
    entirely; that was wrong — see §3.) The record schemas assert only that a record
    is a **JSON object**, because **the ported normalizers are the real validators**:
    `prFacts()`, `sessionFacts()` and `reviewRunFacts()` fill Go's zero values on
    every read, which is exactly how a record predating a field behaves — and a
    strict schema would *reject* an old record the reducer can read perfectly well,
    and make every future field addition a migration. The object check still earns
    its keep: a corrupted document is a scalar or array far more often than a
    plausible object.
20. **Storage names are snake_case; caller keys are camelCase.** `UNIT_NAME_RE` is
    `/^[a-z][a-z0-9_]*$/`, so `FACT_TABLES` maps `prSnapshots → pr_snapshots`. A test
    asserts every declared name against the pattern, because that is the check that
    would have caught the mistake before a user did.
21. **`FactStore` adds no caching, validation, or retry of its own.** The domain is
    already the cache; the normalizers already validate. A second cache here could
    only diverge from the backend.
22. **Record ids are ULIDs, and the id is the storage key.** Lexicographic order is
    creation order, so a board sorted by id is also sorted by age; and the Crockford
    alphabet excludes `I`/`L`/`O`/`U`, so an id survives being read out loud. The
    alphabet is also what makes an id safe as a KV key, which the store asserts
    rather than assuming.
23. **A review is always posted as `event=COMMENT`** (R17): GitHub rejects
    `APPROVE`/`REQUEST_CHANGES` on your own PR, so forwarding the verdict would 422
    every PR. **`pushArgv` has no `--force` parameter at all** — making force-push
    unreachable is stronger than making it conditional.
24. **The board is per PROJECT, and the entry point is too.** PRD §11.3 assumed one
    global panel; a global board cannot answer "which project is this?", and the panel
    it drew showed every project's workers at once under a topbar naming one of them.
    So a connected project gets **one `main` keyed panel and one `sidebar.panellist`
    row, addressed by the same id** (`orchestrator:<repoId>`), and the host scopes the
    cards, lanes, archive and counts by `?repoId=`. Three consequences worth naming:
    the **project list on a snapshot is never scoped** (it is what the row list is
    built from); the rows are **polled into existence**, because connecting a project
    is a host-side action taken by a session and nothing tells the client; and a
    **failed poll unregisters nothing**, because these rows are the only route to a
    board. PRD §11.3's "a full-page panel seat" still holds — it is now one seat per
    project. The project ROW still has no action seat of its own (§8).


---


## 6. Documented divergences from Agent Orchestrator


Exactly one behavioural divergence, in two rows of the reducer, both gated on
`requireHumanApprovalBeforeReady`. **It ships `false`** (chunk 43: the user overruled
the PRD's `true`), so an unconfigured install gets AO's exact behaviour and the two
rows are dormant until a deployment turns the gate on. Both flag states are asserted,
plus the shipped default's own behaviour, by `test/contract/kanban-divergence.test.ts`
— without that third case, flipping the default would leave every test green.


| Row | Divergence | Why |
|---|---|---|
| 5b (new) | A halted loop — round budget spent, or three verdict-less automated passes on one head — releases the PR from `Validating` into `needs_review` / `Needs human review`. | PRD §7.5 + A18. AO has no round cap in its reducer, so its row 4 would claim a loop that has stopped. The general rule: **a lane may only claim an active loop while that loop is actually running.** |
| 6 (new) | With the gate on, an auto-review-approved PR with no human approval cannot reach `ready` on mergeability alone. | PRD §7.6 + A17. AO's mergeability row would reach `Ready` with no human review. **Dormant by default since chunk 43** — the row is compiled in, the flag is off. |


Everything else in `src/contract/kanban.ts` is AO's reducer verbatim.


**One PRD conflict resolved in code:** §7.3 writes the branch as
`dsho/issue-<n>-<slug>` while §13.1 shows `dsho/<prefix>/issue-<n>/root`. This
implements the first as the default with the prefix as a middle segment. The two
shapes are not reconciled upstream; it is one function to change.


### The settings page, and where its rows come from

The page's LAYOUT is the reference's project settings exactly — Worktrees / Issues /
Pull requests, section headings over one bordered group of rows, the label left and
the control right, an inline pencil for a text value and a switch for a flag. Two
things are ours, and both are deliberate:

| Reference row | Ours | Why |
|---|---|---|
| **Assignee** — the GitHub login whose assigned issues are picked up | the **agent preset** this project's workers run as (`Repo.workerAgentPreset`) | Our intake is the local issue queue, not a tracker with assignees. The store key is named honestly (`workerAgentPreset`) while the LABEL keeps the reference's meaning: who works this project's issues. Wiring the row to a login nothing reads would have made the page lie. |
| **Enable issue intake** — auto-spawn from matching tracker issues | the per-repo gate on `fillSlots`'s queue sweep (`Repo.intakeEnabled`) | Same meaning, and it is a real switch: off holds the queue and keeps the `pendingWorker` flag, so turning it back on starts the work with nothing re-queued by hand. |

**A third difference is structural, not cosmetic: the project's `...` menu is OURS.**
DSH's sidebar has a `...` menu only for SESSION rows (`sidebar.workspaces.session.menu.item`
is a real list slot); the workspace/project row's menu (Rename / Delete workspace) is
hard-coded in `dsh-client-ui-workspace` and exposes no seat, and `sidebar.workspaces`
itself is a `single` slot that package already owns. So the entry point is a
`sidebar.panellist` row per project — one row, one `main` keyed panel, addressed by the
same id — and the panel's own topbar carries the `...` that opens the dialog for THAT
project. The project row itself still exposes no seat; a row on it would need an
upstream `dsh-client-ui-workspace` change (see §8).


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
| **R1 — the `main` keyed slot** | **Closed.** Proven by execution, with a shipped exemplar — and re-proven for DYNAMIC keys: one panel per connected project, registered and disposed as the project list moves. |
| **An icon button ON the project row** | Open, and it is an upstream change, not ours: `dsh-client-ui-workspace` renders the workspace row's hover buttons inline (the `...` menu and New Session) and declares no seat for them, so a plugin cannot add one. What exists today is a `sidebar.panellist` row per project (`orchestrator:<repoId>`), which selects that project's board. A `sidebar.workspaces.project.row.action` list slot upstream is what the icon button would need. |
| **`ctx.agents.create()` outside `dsh-webhook`** | **Closed** (spike 2), with one residual: the admitted prompt's turn is unobserved. |
| **`attachSession` against a worktree** | **Closed** (spike 2). |
| **SSE through `ctx.webServer.register`** | Open. Plain HTTP is documented; streaming is not. Fallback is polling `/dsho/api/board`. |
| **`ctx.storageDomain` shape** | **Closed.** Verified against the real backend by the storage spike; domain opens, all five tables work, records persist. |
| **The preset lease's lifetime** | Open. The reference frees it when the triggering function returns, which cannot be right for a worker that outlives the call; we hand it to the caller. |
| **`gh` not installed / not authenticated** | Handled at the message layer (`describeFailure` names the exact prerequisite) and by `connectRepo`'s preflight (6g). |

