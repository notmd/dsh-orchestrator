# STATUS — dsh-orchestrator

**This file is the handoff document.** Read it first; it is the only place that
records what is finished, what is next, and which decisions are deliberate. Keep
it updated **after every chunk of work**, and prune it when it grows — a stale or
bloated status file costs the next agent more than it saves.

| | |
|---|---|
| **Goal** | Implement [PRD.md](PRD.md) |
| **Plan source** | [PRD.md §16 Milestones](PRD.md#16-milestones), verified against [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| **Last updated** | 2026-10-01, chunk 14 (the inspector renders) |
| **Verify** | `npm run verify` → `tsc` (src + test) + `node --test` + build · **all green** |
| **Current state** | **656 tests, 0 type errors. Twelve tools, and the requested flow runs end to end on its own ticks:** issue → worker → worktree → PR → observer → review pass → findings back to the worker → verdict → `Needs human review`. The board assembles into lanes and `orchestrator_board` reads it. **The host surface now exists**: `/dsho/api/board` answers a real request in a live host (verified: 200, `application/json`, `no-store`, four lanes). **684 tests. Fourteen tools, the requested flow runs to completion** is proven end to end in a real host**: a PR snapshot moves the card `building → validating / Review scheduled → Reviewing`, an approved verdict lands in **`needs_review / Needs human review` — never `Ready`** (A17), a new head schedules a fresh pass, and a failed pass lands in `Review failed` with its retry budget accounted. Along the way the lane spike found a real integration bug (fixed). The flow now **runs to its end**: a merged or closed PR finishes the worker, releases the issue, and collects the worktree. Still open: no *real* PR has been opened (the spike writes the observer's output directly — `gh pr create` needs write access to someone else's repository), and the worker has never run a turn. Also open: no PR has been opened by a worker yet, the protocol tools are not restricted to their session kinds, and worktree cleanup on archive does not exist. |

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
| 6q | **The board assembly.** `buildBoard` joins the stores, the reducer and the presentation layer — the only place that does, so the agent's view and the GUI's cannot disagree. Plus `orchestrator_board` | 1 test file |
| 6u | **The whole path, end to end.** A host spike drove `connectRepo → createIssue → startWorker → buildBoard` against the real services: a real worktree, a real session, and a card in `building` reading `Awaiting PR` | **live**; found a real argv bug |
| 6v | **A card moving through lanes** — the worker opens a PR (`gh pr create`), the observer sees it, the review sweep schedules a pass, and the card visibly moves `building → validating → …`. The PR half has never executed. | A4, A13, M1/M3 | Everything up to the PR is proven; nothing after it has run. |
| — | **§12.2's effect is UNVERIFIED, and three instruments have each failed to be valid ones.** Do not add a fourth without first proving it can measure the property: (1) `tools.get(name)` resolves globally without an explicit scope object (`ScopeKey` is an opaque `object`); (2) the session log holds permission/sandbox/approval, inbox and turn/step records and **nothing about tools, even after a full turn**; (3) `tools.execute` needs a complete `ToolExecutionInput`, including whatever supplies `signal` — it throws `reading 'aborted'` on a hand-built one. The next attempt should START from a real execution input captured from a live call. | §12.2, A3.5 | The effect is unproven. **Nothing is unsafe**: the protocol tools validate their caller and refuse. Unproven and unsafe are different, and this is the former. |
| 13 | **SEE the inspector render.** It is implemented and builds, but was never rendered: the attempt to put a card on the board pointed the lane spike at the plugin's own domain, and **a storage domain can only be opened once per process** — the plugin's endpoint began answering "domain 'dsho' is already open". So the spike must write to its OWN domain and the card must be seeded another way (a temp build of the plugin, or a dedicated seed path). | §11.2, M2 | The last named M2 item, implemented but unrendered. |
| 6y | **Clear the spike residue** from the web profile's `~/.dsh/storages/` (`dsho.json` and `dsho_lane_spike.json` hold repositories, issues and workers from the spikes). Harmless, but it is test data in a real profile. | housekeeping | Cheap, and it stops a later reader mistaking spike rows for real ones.
| 7b | **A removal path for the spike workspaces** left in the web profile\'s `workspace.json`. Not hand-edited: it is a running service\'s own state, with the user\'s real workspaces in the same table. | housekeeping | Needs the registry, or the user.
| 6v\\.3 | DONE — the lane sequence is proven live (see §3). Superseded by: (`building → validating (Review scheduled) → validating (Reviewing) → needs_review (Needs human review)`) and the failed-pass path. Note the durable store now holds spike repositories and issues in the **web profile's** `~/.dsh/storages/dsho.json` — harmless, but it is test residue. | §7.5, §7.6, A13, A17 | The half after `worker_start` has never executed live, and it is where the review ordering lives. |
| 6t | **The panel renders in a real GUI.** Module loaded, nav row present, selection works, and the panel shows its heading, count and empty state | **live** |
| 6s | **The client half.** `src/client/index.ts` registers the `sidebar.panellist` row and the `main` keyed panel, polls `/dsho/api/board`, and renders four lanes with loading/empty/error states. Its own `tsconfig.client.json` emits a **classic script** (`module: none`), since that is what `window.__ModuleLoader__` requires | builds |
| 6p | **The review sweep, and a real activity gate.** A tick schedules a pass for every worker whose head has none, and the gate now reads the **live** `AgentStatus` rather than assuming the worker is quiet | 5 tests |
| 6o | **The auto-review pass.** The reviewer contract (PRD §12.5, with "prefer a few high-confidence findings over nitpicks" quoted because that line is what stops every PR hitting the round cap), the read-only reviewer session in the worker's **own worktree**, the pinned-head `ReviewRun`, the head-checked verdict, finding routing, and the failed-pass retry budget | 16 tests |
| 6n | **The PR observer.** The `PrSnapshot` record and the `gh pr view --json` parser, plus the per-repository serialised poll. R13's invariant is the substance: a failed observation writes `fetched: false` **with the prior facts**, so even a caller that ignores the flag cannot see a fabricated `CLOSED` | 18 tests |
| 6m | **The outbox delivers.** A tick calls `planDelivery` and delivers each batch into the session that created the issue, via `ctx.agents.get()` — reached through the registry, not an owned handle, because the plugin does not own the user's session. Claim-before-send, with the claim released on failure | 9 tests |
| 6l | **Worker control.** `orchestrator_worker_message` / `_stop` over a **live handle registry** — the in-process cache of `AgentHandle`s that `spawnWorker` returns and `worker_start` used to discard | 9 tests |
| 6k | **The worker report protocol.** `orchestrator_report` (PRD §12.2) with the `Report` record, the outbox's delivery **policy** (§10.5) as a pure function, note truncation that is marked rather than silent, and PR binding on `pr_created` | 25 tests |
| 6j | **`orchestrator_worker_start`** — the moment three separately-verified layers meet: `WorktreeManager` (real git) → `spawnWorker` (real host, spike 2) → `assignWorker`. Plus the **worker contract** (PRD §12.4), the `Worker` record and its phases (§7.3/§5.2), and per-repo issue **numbers** | 27 tests |
| 6h/6i | **The issue record and its tools.** `createIssue`/`updateIssue`/`assignWorker` with two invariants the record enforces (at most one active worker per issue; an empty patch is not a change), plus `orchestrator_issue_create` / `_list` / `_update` over the verified store | 32 tests |
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
all**. The instrument was a mirror: it agreed with every hypothesis. This is the tenth
instance of one lesson and the first where the flawed instrument was mine. The
restriction's status reverts to **unknown**, because the stronger claim was not
supported by the measurement. What the same run *did* establish is that
`agent.ctx.tools.restrict({deny})` exists, is callable and returns a disposer — so the
mechanism is real; whether the listener reaches it remains open.

**Reading the wrong object does not throw — it silently does nothing.** The
`agent/created` payload is `{ agent, source, signal }`; the listener read it *as* the
agent, so every session arrived with `session: undefined`, was classified `other`, and
the deny-list was applied to nothing. **The whole restriction was inert**, and the
wiring had no unit coverage because it was assumed to be glue. A spike probing what a
session actually sees is what found it, and it is the eighth instance of this
session's one lesson: the failure is silent, and only a real run or a real type says
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
guarded by the data rather than by the intention. The workspace entries are not: that
file is a running service's own bookkeeping, and hand-editing it would mean
reimplementing the registry from outside with the user's real workspaces in the same
table. **A spike that registers through a service needs a way to unregister through it**,
and M0 spikes should prefer paths nothing else indexes.

**A fake that does not model reality hides the behaviour under test — seventh time.**
The failing-removal test passed for the wrong reason on the first run: the fake returned
an empty `worktree list`, so `remove` found nothing, was a no-op, and the "left in place"
branch was never reached. It is also the **second** time the worktree-list fake has
caused this. Delegating to the stateful fake for everything except `remove` fixed it.
That a single fake can produce two instances of the same bug, six rounds apart, is the
argument for making fakes stateful by default rather than by request.

**Two green halves that disagreed with each other.** The observer writes a PR snapshot
under `snapshotKey(workerId)`; the board read them by matching the snapshot's url to
`worker.pr.url`. Those differ in the **normal** case — one comes from the worker's
report, the other from the provider — so a real pull request never moved a card, with
no error and no log. Both halves were individually green because **each side agreed
with itself**. A unit test at a boundary cannot see a disagreement *across* it; only a
run that crosses it can. Sixth instance of this session's one lesson.

**The argv looked right and the tool disagreed.** `gh repo view .` resolves to
`notmd/.` — gh reads the argument as an explicit `owner/name`, never as a path — so
`connectRepo` failed with `gh-failed (not-found)`. The current repository is selected
by passing **nothing**. A unit test could only assert the argv its author intended,
and `.` looked entirely reasonable; only the real `gh` could say otherwise. **Fifth
instance of one lesson, and the second this round**: a fake, or a string assertion,
cannot falsify what the real tool does with its input.

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

This is the **fourth** instance of one lesson, and the most severe: the others degraded a
feature, while this one takes the process down. **Run the live boot before claiming a
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

**A fake must model reality, or it hides the bug it was written to find.** Third
instance of one lesson. The `worktreeGit` fake reported an empty `worktree list`
always — so `remove` found nothing to remove, was a silent no-op, and the test
asserting *"a failed spawn removes the worktree it just made"* failed for the wrong
reason. Git is stateful: `worktree add` changes what `list` reports. A fake that
implements the author's *idea* of an interface cannot falsify anything about the
real one — which is also how the storage adapter stayed green while being entirely
fictional, and how the realpath bug survived the unit tests.

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

## 4. Next — ordered, with the reason for the order

| Chunk | Work | PRD | Why now |
|---|---|---|---|
| 6g\.2 | **Wire `orchestrator_repo_connect` as a tool.** The preflight and the store both exist and are tested; what is missing is the wiring. It needs `inject` to gain `subprocess` and `storage`, and **`apply()` to become async** (opening the store is async), which is why it is its own step rather than a footnote — that change also touches the activation tests. | §12.1 | Makes the second real tool live, and proves the store against a real backend rather than a fake. |
| 6r | **`/dsho/api/board`.** One snapshot endpoint, no per-card fan-out; handlers answer their own errors so a storage failure is a `500` rather than the web server's throw-to-400 — a 400 for a backend outage would be a lie the client cannot act on | 4 tests + **live** |
| 6q | **The board's read surface**: `/dsho/api/board` on `ctx.webServer`, then `orchestrator_board`. The reducer, presentation, and stores all exist, so this is an assembly job. | §11.4, §12.1 | Nothing is visible in the GUI without it, and it is what the client half reads.
| 6p | **A tick that schedules review passes** — call `startReviewPass` for workers whose head has no current pass, so the loop turns without a human. Then `orchestrator_run_review` for the forced path. | §7.5, M3 | The pass is complete and tested but nothing schedules it, so no card ever enters `Validating`'s review loop.
| 6o | **The reviewer spawner** — the auto-review pass (M3): spawn a `read-only` reviewer at the PR's exact head, `orchestrator_review_verdict` → `ReviewRun` → route findings to the worker → re-review on the new head. The loop's bounds and the stale-head rule are already written and tested (`src/review/`). | §7.5, M3 | This is the feature the request calls out, and every piece under it — spawn, outbox, observer, reducer — now exists. |
| 6p | **Worktree cleanup on archive**, and `orchestrator_board` / `orchestrator_pr_sync` / `orchestrator_run_review`. | §9.3, §12.1 | R4's disk bound is only real if cleanup runs; the board tool is what the client will read. |
| 6l2 | **Restrict `orchestrator_report` to worker sessions** via `ctx.tools.restrict()` on the worker agent's ctx (Appendix A3.5), so a non-worker never sees it. Today it is registered globally and *refuses* at runtime, which is functionally equivalent but not the same as not offering it. | §12.2, A3.5 | Cheap, and it is the difference between "cannot" and "must not". |
| 6k | **`orchestrator_worker_message` / `_stop` / `_attach_pr`**, and the `Worker` record itself (PRD §7.3: phase, phaseHistory, pendingQuestion, lastSignalAt). | §7.3, §12.1 | Needs the worker record, which `worker_start` will have shown the shape of. |
| 6l | **`GitHubGateway` + `PrObserver`** — poll `gh pr view --json`, diff against the stored snapshot. A failed observation keeps the prior snapshot and can never fabricate a closed/merged transition (R13). | §7.4, §10.2 | The board is only truthful if the facts are. |
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
20. **Persistence is `ctx.storageDomain.open()` with zod schemas**, pinned to the
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
23. **Storage names are snake_case; caller keys are camelCase.** `UNIT_NAME_RE` is
    `/^[a-z][a-z0-9_]*$/`, so `FACT_TABLES` maps `prSnapshots → pr_snapshots`. A test
    asserts every declared name against the pattern, because that is the check that
    would have caught the mistake before a user did.
24. **`FactStore` adds no caching, validation, or retry of its own.** The domain is
    already the cache; the normalizers already validate. A second cache here could
    only diverge from the backend.
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
| **`ctx.storageDomain` shape** | **Closed.** Verified against the real backend by the storage spike; domain opens, all five tables work, records persist. |
| **The preset lease's lifetime** | Open. The reference frees it when the triggering function returns, which cannot be right for a worker that outlives the call; we hand it to the caller. |
| **`gh` not installed / not authenticated** | Handled at the message layer (`describeFailure` names the exact prerequisite); the preflight itself lands in 6g. |
