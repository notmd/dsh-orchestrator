# Agent Orchestrator — task state & transition analysis

**Subject:** [`Untrivial-ai/agent-orchestrator`](https://github.com/Untrivial-ai/agent-orchestrator) ("AO")
**Method:** shallow clone of `main` @ `99d4035e992c84da0c1aadf5c76c5f6710e9221a` (2026-10-01, *"fix(session): remove progress bar… (#6123)"*), reading the Go backend directly. Repo total: ~4,012 PRs.
**Focus:** how a *task* (a session/worker) moves through state — which states exist, who writes them, and what triggers each transition.

> **Scope note.** This is a focused companion to [Appendix B — AO reference teardown](./agent-orchestrator-reference.md), which covers the product, stack, API, and the board/derivation contracts at large. This document goes one level deeper on *transitions*: the reducers, precedence rules, triggers, and saga guards — and flags the state-model discrepancies it found.

---

## 1. The mental model: there is no single "task state machine"

A "task" is a **session** (`domain.SessionRecord`) — the New Task dialog literally reserves a session row (`IsTaskPreparation`, `TaskPreparationToken`). Its state is not one enum but **eight layers**, split by one hard architectural rule:

> **Observed facts are persisted. Lifecycle facts are persisted. Display state is never persisted.**

`KanbanColumn` states it outright: *"It is independent of the display SessionStatus and is never persisted."* (`backend/pkg/contract/kanban.go`). `docs/scm-observer.md` repeats it: *"Display status is never stored."*

That split yields three different mechanisms all called "transition":

| Kind | Where it lives | Mechanism | Replay safety |
|---|---|---|---|
| **Level transition** | derived state (`SessionStatus`, `KanbanColumn`, `AOReviewState`) | pure reducer recomputed from facts at read time | re-derivable forever |
| **Edge transition** | durable sagas (`AgentSwitchState`, `SessionInterfaceTransitionPhase`) | explicit `ValidTransition(from, to)` guard + CAS writes | resumable after crash |
| **Edge *action*** | nudges/prompts to the agent | level facts + persisted dedup signature (`pr.last_nudge_signature`) | survives daemon restart |

The pipeline the code implements everywhere:

```
OBSERVE (external facts) -> UPDATE (durable facts) -> DERIVE (display status)   + ACT (edge-triggered)
```

---

## 2. Layer-by-layer: the states

### Layer 0 — Agent activity (durable, hook-driven)
`backend/internal/domain/activity.go` → persisted as `activity_state`.

```
active | idle | waiting_input | blocked | exited
```

- `waiting_input` and `blocked` are **sticky** (`IsSticky()`): a paused agent is never aged or demoted by the passage of time.
- Both mean "paused on the user" but demand **opposite automation** — `waiting_input` is an agent at an empty prompt awaiting its next instruction (safe to message/nudge); `blocked` is an agent stopped on a pending permission/approval dialog where a stray keystroke could answer on the user's behalf. `NeedsInput()` is the shared predicate that both render as `needs_input`.
- **Entry mapping is per-harness.** `backend/internal/adapters/agent/claudecode/activity.go` maps AO hook sub-commands (not native event names):

| Hook event / payload | Activity state |
|---|---|
| `user-prompt-submit` | `active` |
| `pre-tool-use`, `post-tool-use`, `post-tool-use-failure` | `active` (under precedence rules below) |
| `permission-request` | `blocked` (richer than the notification: carries the blocking `tool_name`) |
| `stop` | `idle` (turn ended, interrupt included — agent alive, not exited) |
| `notification{idle_prompt, agent_completed}` | `idle` |
| `notification{agent_needs_input}` | `waiting_input` |
| `notification{permission_prompt}` | `blocked` |
| `session-end{reason}` | `exited`, except `clear`/`resume` which report nothing (same AO session continues) |
| anything else | no signal (`ok == false`) |

- **Exit transitions from `blocked` are the subtle part** (`backend/internal/lifecycle/manager.go`, `applyToolPrecedenceLocked`): the state may only change on a **turn boundary** (`user-prompt-submit`, `stop`, `session-end`, `process-exited`, `chat.controller.stopped`, `permission-resolved`) **or** the correlated `post-tool-use` of *the exact tool* whose dialog was blocking (approval ⇒ the tool ran, the earliest observable "decision resolved" signal).
- Correlation requires a unique in-flight tool name. With two same-name tools in flight (a batch of `Bash` calls, one sitting at the dialog), the code **fails closed**: no candidate is recorded and only a turn boundary clears the block. Parallel-subagent tool traffic can therefore never clear a live `blocked` — the comment cites the earlier regression that reverted the naive mapping.
- Signals carrying **no `Event` tag** pass through untouched (last-writer-wins) — the pinned compatibility contract for older CLIs and untagged adapters.

### Layer 1 — Session lifecycle (durable)
- **Provision** (`SessionProvisionState`): `provisioning -> ready | failed`; the zero value resolves to `ready` for rows predating asynchronous spawn. Messages sent while `provisioning` are queued and dispatched when the controller arrives; a `failed` start keeps the row, conversation, and queue so the user can retry.
- **Termination**: `IsTerminated` flag + `Activity = exited`. `MarkTerminated` loops with CAS on `Revision` and `RuntimeLaunchID`, so a stale launch can never terminate a replacement; an already-terminated row still reaps containers.
- **Termination guardrails** (`docs/architecture.md`): runtime **and** process must both be dead, no recent activity, no merged-PR ownership. *"Failed probes are NOT proof of death."*
- **Auto-termination on merge** (`lifecycle/reactions.go`): requires `TerminateOnPRMerge`, **no open PR remaining**, **≥1 merged**, and the agent **not** `ActivityActive`. A still-working agent defers teardown to the next poll — otherwise a worker raising a second PR in the same session would be dropped from the SCM observer roster and the follow-up PR would never be attributed or nudged.

### Layer 2 — Turn (durable, per conversation)
`TurnState` (`backend/internal/domain/conversation.go`):

```
queued -> running -> completed | recovered | interrupted | failed
                        (plus cancelled: a queued turn withdrawn from the dock before dispatch)
```

- `Terminal()`: `completed | recovered | interrupted | failed | cancelled`.
- `interrupted` is distinct from `failed` — the provider reports it as its own terminal status and AO must not relabel it.
- `recovered` = history proved the turn is no longer live but carried no portable provider outcome: terminal without claiming success or failure.

### Layer 3 — The two explicit sagas (the only real FSMs)
These are the only places with a written transition contract, deliberately placed in `domain` so no alternate store caller can bypass orchestration ordering.

**`AgentSwitchState`** (`domain/agent_switching.go`) — moving a session between harnesses:

```
preparing_handoff -> stopping_source -> source_stopped -> starting_target
        -> target_ready -> delivering_context -> completed
any non-terminal state -> failed
from == to is allowed (metadata amendment within one durable phase)
```

`ValidAgentSwitchTransition(from, to)` rejects anything else; `Terminal()` = `completed | failed`.

**`SessionInterfaceTransitionPhase`** (`domain/session_interface_transition.go`) — moving a live session between TUI and Chat controllers:

```
requested -> preflighting -> draining -> source_stopping -> source_stopped
        -> target_starting -> activating -> completed
                                          \-> failed | cancelled | recovery_required
```

- `Terminal()` = `completed | failed | cancelled | recovery_required`; `Active()` = `!Terminal()`.
- `recovery_required` is a durable diagnostic row, reconciled at daemon start (killed or reclaimed).
- Typed policies accompany it: `drain | interrupt` (what to do with in-flight work) and `strict | provider_history` (history policy — provider history may never waive a trusted current-turn checkpoint, AO's high-water mark, or native conversation identity).

### Layer 4 — PR lifecycle (persisted, normalized from providers)
`contract.PRState` (`backend/pkg/contract/scm.go`): `draft | open | merged | closed`.

It is a **collapse of boolean columns in priority order** (`pr_store.go`, `prState()`: `Merged > Closed > Draft > Open`), and `StateChangedAt` is seeded from provider timestamps and updated when AO *observes* a draft/open/merged/closed transition. There is no explicit transition guard here — the provider is the source of truth and AO normalizes whatever it last observed.

Companion fact enums:
- `CIState`: `unknown | pending | passing | failing`
- `ReviewDecision`: `none | approved | changes_requested | review_required`
- `Mergeability`: `unknown | mergeable | conflicting | blocked | unstable` (`blocked` is partly *synthesized locally* from draft / failing-CI / changes-requested facts)
- `PRCheckStatus`: `unknown | queued | in_progress | passed | failed | skipped | cancelled`

### Layer 5 — AO review runs (persisted) → per-head review state (derived)
- `AOReviewRunStatus`: `running -> complete -> delivered`, plus `failed | cancelled`.
- `AOReviewVerdict`: `"" (none) | approved | changes_requested` (`Valid()` accepts only the two real verdicts).
- `AOReviewState` (derived, **keyed on PR URL + head SHA**), via `review.Plan()` (`backend/internal/review/planner.go`):

| Condition (for the *current* head) | `AOReviewState` |
|---|---|
| closed / merged / empty URL / empty head SHA | `ineligible` |
| latest run status `running` | `running` |
| verdict `approved` | `up_to_date` |
| verdict `changes_requested` | `changes_requested` |
| status `failed` or `cancelled` (no verdict) | `needs_review` (retryable) |
| no run recorded for this head | `needs_review` |

A run recorded against a **different** SHA is surfaced separately as `PreviousRun` and can never decide the current head — the "stale pass" invariant.

### Layer 6 — `SessionStatus` (derived, 14 values, activity-first)
`contract.DeriveStatus` (`backend/pkg/contract/status.go`). Precedence, in order:

```
is_terminated        -> merged (if no open PR and any merged) else terminated
activity == active   -> working
activity == exited   -> exited
activity == waiting_input | blocked -> needs_input
SCM status           -> aggregated across open PRs
silent past grace    -> no_signal
otherwise            -> idle
```

Multi-PR aggregation is **worst-wins** on an explicit severity rank (`ci_failed` 0 → `changes_requested` 1 → `draft` 2 → `review_pending` 3 → `pr_open` 4 → `approved` 5 → `mergeable` 6), and **stack-aware**: a PR blocked on an open parent is skipped unless its own signal is actionable (`ci_failed`, `draft`, `changes_requested`); if that leaves nothing, it falls back to all open PRs.

`no_signal` is the only time-based transition: `SignalExpected && !HasSignal && now - LastActivityAt > noSignalGrace` — a session that *should* be reporting hook activity and never has.

### Layer 7 — Kanban column + DisplayStatus (derived, never persisted, PR-first)
`backend/pkg/contract/kanban.go`; wiring in `backend/internal/service/session/kanban.go`; exposed on the wire as `kanbanColumn` + `displayStatus` and typed in `frontend/src/api/schema.ts`.

```
building | validating | needs_review | ready | archive
```

**Per-PR column reducer** (`derivePRKanbanColumn`), in evaluation order:

| # | Condition | Column |
|---|---|---|
| 1 | merged or closed | `ready` |
| 2 | draft | `validating` |
| 3 | externally approved (provider `approved` **and** a surviving non-AO approval) | `ready` |
| 4 | AO owns the next step (pass `running`; or `AutoInjectReview` + changes-requested; or `AutoInjectCI` + CI failing) | `validating` |
| 5 | `AutoReview` on and AO has not approved this head (not run / failed / cancelled / changes-requested) | `validating` |
| 6 | mergeable | `ready` |
| 7 | fallthrough — no AO loop is turning it, so the next turn is a person's | `needs_review` |

**Session-level reducer** (`DeriveKanbanPresentation`):
1. `IsTerminated` → `archive` / `Terminated`.
2. No PRs → `building`, with the phrase taken from worker activity (`Working` / `Blocked` / `Exited` / `No signal` / `Awaiting PR`).
3. One or more PRs → derive per PR, then rank: `ready(0) < needs_review(1) < validating(2) < building|archive(3)`; tie-break on newest `UpdatedAt`, then URL, *"so the board never flickers between equally ranked PRs"*. Merged/closed PRs are pooled out first, so a terminal PR cannot speak for a session that still has live work.

**`DisplayStatus`** (21 renderable phrases — `"Working"`, `"Fixing CI failures"`, `"Addressing comments"`, `"Needs review"`, `"Review scheduled"`, `"Reviewing"`, `"Review failed"`, `"Review pending"`, `"Draft"`, `"CI failing"`, `"Commented"`, `"Changes requested"`, `"Needs human review"`, `"Mergeable"`, `"Approved"`, `"Merged"`, `"Closed without merge"`, `"Terminated"`, …) is derived **inside the chosen column**, so a card can never show a phrase belonging to a stage it is not in.

Two precedence rules stand out inside `validatingDisplayStatus` / `inReviewDisplayStatus`:
- The **worker's own distress outranks the loop**: `blocked`/`waiting_input` → `Blocked`, `exited` → `Exited`, silent → `No signal`.
- **Crediting AO's auto-fix loops requires liveness**: `AutoInjectCI` + CI failing only reads `Fixing CI failures` when `Activity == active`. Otherwise it falls through to the plain CI fact (`CI failing`). *"A stale AutoInjectCI/AutoInjectReview flag on an idle worker falls through to the plain CI/review-facts reading instead of claiming work nobody is doing."*

### Layer 8 — Reaction dedup (durable edge layer)
`pr.last_nudge_signature` holds `{seen, attempts}` (JSON, schema kept explicit and stable so a restart resumes the same dedup state). This is what converts *level* facts into *one-shot* actions and prevents re-prompting an agent on every 30-second poll.

---

## 3. How transitions actually fire

```
                    push                                     poll
 agent hooks  ---------------> lifecycle.Manager ------> SQLite  (activity_state,
 runtime obs  --------------->   (fact reducer)            is_terminated, pr.*,
 chat signals --------------->                              review_run, ...)
                                                           |
                                                           | CDC change_log -> SSE -> UI
                                                           v
 provider APIs --30s--> observe/scm Observer --> pr store --> LCM.ApplySCMObservation
                                                           \-> nudges (rebase / fix CI / address review)
 auto-review sweep --60s--> autoreview.Coordinator --> review.Plan --> review engine (TriggerAuto)
```

**1. Push — agent hooks.** `ApplyActivitySignal` first normalizes provenance per event (`user-prompt-submit` clears the assistant text; `stop` clears the user prompt; anything else clears all three), then fences on `LaunchID` / controller generation so a delayed hook from a replaced runtime cannot claim the session, and only then runs the tool-flight precedence machine.

**2. Poll — SCM observer (30s, `observe/scm`).** discovery → attribution by author + branch prefix → batched detail fetch → review-thread refresh (own 2-minute cadence) → **persist the PR row first** → notify lifecycle, which owns the reactions. ETags and commit-check probes gate the refetch; unconditional re-fetch after 5 minutes.

**3. Reactions (`lifecycle/reactions.go`, `ApplyPRObservation`).** Conditions are **queued, not short-circuited** — explicitly so that "a CI failure cannot suppress review feedback on the same PR". The queue:

| Fact | Nudge | Gate |
|---|---|---|
| `CI == failing` | "fix these failing checks" (named checks) | `pr.auto_inject_ci` |
| unresolved human review comments | "address these comments" | per-comment `auto_inject_review` |
| `ReviewDecision == changes_requested` | "address review X, reply on GitHub review id, resolve threads" | per-review `auto_inject_review` |
| `Mergeability == conflicting` | "rebase and resolve conflicts" | only the **bottom of a stack**; `urgent` |

Notable rules: the merge-conflict nudge is `urgent` (it bypasses the `needs_input` suppression gate, because the human parked at the prompt may be exactly who must rebase) yet still funnels through `sessionguard.NudgeUrgent`, which refuses on a live permission dialog. It is **re-armed** only on a *definitively computed* `mergeable`/`unstable` — never on `unknown` (GitHub's recompute window after a push or retarget) or `blocked` (locally synthesized, so it proves nothing about the provider's conflict state). Re-arming is non-delivery bookkeeping and therefore runs *above* the dead-session delivery gate, so an exited-then-restored session still drops the stale signature.

**4. Auto-review sweep (60s, `autoreview.Coordinator`).** Session gate: `AutoReviewEnabled && Kind == worker && !IsTerminated && Activity == idle && idle >= 1m` (default threshold 1 minute). Then `review.Plan` → trigger if any head is `needs_review` or `running`. Reasons are a readable taxonomy: `disabled`, `not_worker`, `terminated`, `not_idle`, `idle_threshold_not_met`, `no_pr`, `planner_ineligible`, `draft_pr`, `merged_pr`, `closed_pr`, `missing_head_sha`, `already_approved`, `changes_requested_same_sha`, `cancelled_same_sha`, `review_running`, `failed_same_sha_retry_limit`. Failed *auto* passes on the same head retry at most **3** times.

---

## 4. Design patterns worth stealing

1. **Derived display state is never persisted** — one source of truth (facts); no DB/UI drift; presentation changes need no migration.
2. **Scope every derived decision to a head SHA** — a review pass can never decide a commit it did not see; stale passes become `PreviousRun`.
3. **Level facts + persisted edge dedup** — idempotent reducers answer "where am I", signature-keyed one-shot actions answer "what should happen", and the signature survives restart.
4. **Explicit `ValidTransition(from, to)` in `domain`**, enforced at the persistence boundary so no alternate caller can skip orchestration ordering.
5. **Fail closed on ambiguity** — two same-name in-flight tools ⇒ no correlation ⇒ only a turn boundary clears `blocked`.
6. **Actor-credit requires liveness** — "AO is fixing CI" is only claimed when the worker is actually `active`.
7. **Deterministic tie-breaks** (newest `UpdatedAt`, then URL) to stop board flicker.
8. **Multi-entity aggregation with a declared precedence** — worst-wins for session status, ranked priority for the board, per-entity turn ownership for the columns.
9. **Queue independent reactions instead of returning early** — one failed condition must not hide the others (including deferred read errors, surfaced only *after* the nudges are sent).

---

## 5. Findings, discrepancies, and risks

**A. Two parallel derivations with opposite precedence (the main smell).**
`SessionStatus` (Layer 6) is **activity-first** with PR facts as fallback; `KanbanColumn` + `DisplayStatus` (Layer 7) is **PR-first** with worker facts as an override. Both live in `backend/pkg/contract` and are derived from the same facts. A session can legitimately read `idle` in one and `Approved`/`ready` in the other. The kanban comments read as a specification written *against* the older `DeriveStatus`, but nothing in the code marks Layer 6 as superseded. This is the most likely source of future "the board and the badge disagree" bugs.

**B. `pr.state` is a derived collapse, not a state machine.**
`prState()` recomputes `Merged > Closed > Draft > Open` from bool columns on every upsert; there is no transition guard and no rejection of illegal moves (e.g. open → draft → open is fine, and a provider regression would be accepted silently). Only `StateChangedAt` records *when* the normalized state changed. The sagas in Layer 3 are the only guarded FSMs in the system.

**C. No `unknown` activity value in current `main`.**
[Appendix B](./agent-orchestrator-reference.md) §B2 lists `activity_state` as *"active · idle · waiting_input · blocked · exited · **unknown**"*. Reading `domain/activity.go` at `99d4035` shows exactly five values, and there is no `ActivityUnknown` constant anywhere in `domain`. Either the appendix followed the prose docs rather than the code, or the value was removed since. Worth correcting in the appendix.

**D. Presentation strings are shared verbatim as UI text.**
`DisplayStatus` values are pre-renderable English (`"Closed without merge"`, `"Fixing CI failures"`) and typed into `frontend/src/api/schema.ts`. That is deliberate (clients print as-is, one derivation for desktop/web/mobile), but it pushes copy decisions into the Go contract and makes i18n a cross-language change.

**E. Time is a first-class transition input in only one place.**
Only `no_signal` (`SignalExpected && !HasSignal && past grace`) and the auto-review idle threshold are time-driven; everything else is edge- or observation-driven. Notably `waiting_input`/`blocked` are explicitly exempt from time-demotion — a design choice that keeps a paused agent from silently reading as "idle, safe to nudge".

---

## 6. Quick reference — states by file

| Layer | States | File |
|---|---|---|
| Agent activity | `active, idle, waiting_input, blocked, exited` | `backend/internal/domain/activity.go` |
| Hook→state mapping | per harness | `backend/internal/adapters/agent/*/activity.go` (e.g. `claudecode/activity.go`) |
| Provision | `provisioning, ready, failed` | `backend/internal/domain/session.go` |
| Turn | `queued, running, completed, recovered, interrupted, failed, cancelled` | `backend/internal/domain/conversation.go` |
| Agent-switch saga | `preparing_handoff … completed, failed` | `backend/internal/domain/agent_switching.go` |
| Interface-transition saga | `requested … completed, failed, cancelled, recovery_required` | `backend/internal/domain/session_interface_transition.go` |
| PR lifecycle | `draft, open, merged, closed` | `backend/pkg/contract/scm.go` (`prState()` in `storage/sqlite/store/pr_store.go`) |
| Review run / verdict | `running, complete, delivered, failed, cancelled` × `none, approved, changes_requested` | `backend/pkg/contract/scm.go`, `domain/review.go` |
| Review state (derived) | `needs_review, running, up_to_date, changes_requested, ineligible` | `backend/internal/review/planner.go` |
| Session status (derived) | 14 values, activity-first | `backend/pkg/contract/status.go` |
| Kanban column (derived) | `building, validating, needs_review, ready, archive` | `backend/pkg/contract/kanban.go` |
| Display status (derived) | 21 phrases, per column | `backend/pkg/contract/kanban.go` |
| Reaction dedup | `{seen, attempts}` signatures | `pr.last_nudge_signature`; `lifecycle/reactions.go` |
| Auto-review sweep | gate reasons + 3-retry cap | `backend/internal/autoreview/coordinator.go` |
| Lifecycle reducer / precedence | — | `backend/internal/lifecycle/manager.go`, `lifecycle/reactions.go` |

**Primary docs:** `docs/architecture.md` (§Lifecycle Management, §Session State Machine, §Termination Guardrails), `docs/scm-observer.md` (polling pipeline, durable-state invariants), `CONTEXT.md` (domain glossary).

---

# Part II — Diff against our implementation (dsho)

**Subject:** this repository, `dsho` (DSH Orchestrator plugin), at `961cdb6` ("fix(review): let a review pass post, and make its boundary per project").
**Basis:** `src/` (~11.6k lines of TypeScript: `contract/`, `domain/`, `review/`, `board/`, `host/`, `client/`), `test/`, `locale/`. Our files carry explicit `PORTED from … (commit 53ba1e8)` headers plus a `DIVERGENCE` convention, which makes the diff auditable line by line.

> **Note.** `README.md` still says "No implementation has been written"; the working tree and `git log` say otherwise (`src/` is populated and `dist/` is built). Treat the README status paragraph as stale.

## 7. Structural mapping

| Concern | AO | dsho | Verdict |
|---|---|---|---|
| Unit of work | **session** (kind `worker`); the board is session-scoped | **issue → worker, 1:1** ("at most one active worker per issue"); the DSH session is the durable spine | reinterpretation, same invariant (session is the recovery anchor) |
| Task/pipeline state | **absent** — no notion of "implementing" | `WorkerPhase`, 14 values, **declared** by the worker via `orchestrator_report` | new layer |
| Activity | 5 states, from CLI hooks + tool-flight correlation | 6 states (adds `unknown`), protocol-first then `Agent.status` fallback | ported + extended |
| Board column | 5 columns, PR-first reducer, never persisted | **ported verbatim** + 2 deliberate divergences | faithful |
| Session status | 14 values, activity-first | **ported verbatim** | faithful |
| Review run | `status` × `verdict`, per head SHA | **ported verbatim**, plus a round budget | faithful + bounded |
| Review trigger | daemon sweep, coordinator + read path separate | pure `evaluateSession`, shared by trigger path and read path **by construction** | stronger invariant |
| Reaction/nudge dedup | per-PR `last_nudge_signature` `{seen, attempts}` + re-arm | per-worker `feedback.routedIds` + `nudgedAtHead` + `headSha` | different shape, same purpose |
| Multi-step sagas | `AgentSwitchState`, `SessionInterfaceTransitionPhase`, both with `ValidTransition` | **none** (no harness switching, one interface mode) | gap by scope, not omission |
| Termination | `is_terminated` + reaper + terminate-on-merge | terminal `WorkerPhase` + completion sweep; merged→issue `done`, closed→`cancelled` | different hazards guarded |
| Issue/tracker layer | normalized vocabulary (`open/in_progress/review/done/cancelled`) for providers AO reads | own `IssueState` (`open/in_progress/done/cancelled`), authoritative because **we** own the queue | simplification |

## 8. Divergences we introduced on purpose

| # | Divergence | AO's behaviour | What it buys | Cost |
|---|---|---|---|---|
| D1 | **Declared `WorkerPhase`** (`src/domain/workers.ts`) | none: AO infers from activity + PR facts | pipeline position on the card, an append-only `phaseHistory` audit trail, and an explicit "waiting on a person" fact | a second state axis that must be kept consistent with the derived board (see §12.1) |
| D2 | **Round budget** `maxReviewRounds: 3` (`src/review/runs.ts`) | re-reviews a changes-requested head **forever** | automation that provably stops; `escalationReason` drives the `Needs you` badge (A18) | enforced in **two** places (reducer row 5b + `evaluateSession`) — divergence the tests pin deliberately |
| D3 | **Optional human gate** `requireHumanApprovalBeforeReady` (kanban row 6) | an auto-approved, mergeable PR reaches `ready` with no human | a PR can never be "done" without a person, when a deployment asks for that; matches our flow's review order | one more flag to reason about — and **it ships `false`** (chunk 43: the user overruled the PRD's `true`), so the default is AO's behaviour and the gate is opt-in |
| D4 | **`unknown` activity + readiness** (`src/contract/activity.ts`, `StatusReadiness`) | no `unknown`; absence normalizes to a state | honesty after restart, and "uncertainty must not be rendered as a demand" | a sixth state to handle in every reducer branch |
| D5 | **Manual review path** `evaluateManualRequest` | has `triggerSource`, no manual-bypass policy | a person can force a pass on a judged head | must not consume the auto budget (marked `manual`) |
| D6 | **Head-keyed dedup** for CI/conflict items | per-PR conflict key + explicit re-arm on a cleared conflict (#4528's fix) | a new commit naturally resets; no re-arm state machine, and no stale signature to survive a restart | loses the "same head went from conflicting to clean" case — which cannot happen without a new head, so the trade is sound |
| D7 | **Protocol identity** — a report resolves the worker from `exec.agent.session`, never from an argument | out-of-band observation of sessions | a worker cannot report against another's card | needs a session-bound tool call |

## 9. What AO has that we deliberately do not

1. **Guarded sagas.** AO's `ValidAgentSwitchTransition` / interface-transition phases exist because an external process operation cannot share a SQLite transaction. We do no such operation — no harness switching, no TUI⇄Chat handoff — so there is nothing to checkpoint. If we ever add a multi-step external operation (worktree relocation, branch retarget, provider migration), AO's shape is the pattern to copy: durable phase row + `ValidTransition` in `domain` + terminal-state reconciliation that records *why* it stopped and reports it rather than hiding it.
2. **Tool-flight precedence and the blocked-clear correlation.** AO's hardest state work is deciding when `blocked` may end: a turn boundary, or the correlated `post-tool-use` of the exact blocking tool, failing closed on ambiguity. We do not need it — our blockage is a *declared level* (`pendingQuestion`, `awaiting_human`) rather than an edge inferred from a stream — and our writes go through an inbox, so a stray write cannot answer a dialog (the three AO guards with no DSH analogue).
3. **Time-based demotion of pauses.** `isSticky` / `needsInput` are ported into `src/contract/activity.ts` and **then never called anywhere in `src/`** (verified by grep). AO's rule — a paused agent stays paused until a *new signal*, never until a clock — is therefore only enforced *incidentally* in our system: stickiness never matters because our activity comes from protocol facts that are not aged. The vocabulary is dead code today.
4. **Per-provider hook mapping.** AO maintains one `DeriveActivityState` per harness (30+ adapters). We have exactly one harness, which is the entire point of the plugin.

## 10. What we inherit, including AO's smell

- **Two parallel derivations.** We kept both `SessionStatus` (activity-first) and `KanbanColumn`/`DisplayStatus` (PR-first), with an explicit role split: the lane is placement, the session status drives the terminal treatment and the loader (`src/host/board-service.ts`). AO's #5081 bug was conflating them; we document the separation instead of removing it. The same "two readings can disagree" property is therefore still present, by design.
- **Pre-renderable English strings as contract.** `DisplayStatus` values are load-bearing keys. We added the missing layer AO lacks: `locale/en.json` + `locale/zh.json` with an English fallback table in `src/client/index.ts` that a test asserts agrees with the JSON.
- **Persisted edge dedup is mandatory.** Both systems poll level facts and must act once; both persist the dedup state alongside the durable row, because a restart must not re-prompt an agent.
- **Derived state is never stored.** Both derive the board at read time; neither persists a lane or a display status.

## 11. The diff already caught real bugs in our tree

These are the failure modes the level/edge split produces, and each was a commit:

| Bug | Symptom | Guard that caught it |
|---|---|---|
| Archive lane structurally unreachable (`eb65d16`) | `isTerminated` hardcoded false → the archive sheet was always empty and `Terminated`/`Merged` could never render — **the same class as AO's archive column** | now derived from `isTerminalPhase(worker.phase)` |
| Review id-space mismatch (`3ab517b`) | `githubReviewId` (REST) compared against snapshot node ids (`PRR_…`) → our own reviews were treated as a person's, and routed back to the worker as human feedback | one shared `ourReviewIds()` over **both** id spaces |
| Feedback dedup loss | the worker normalizer rebuilt the record field-by-field and dropped `feedback` → every poll re-nudged | `normalizeWorker` now carries the field explicitly, with the reason in a comment |
| `autoInjectCI` read only by the board | the card claimed `Fixing CI failures` while nothing ever told the worker | `ciFeedback()` made the flag real |
| Round shown as `3/3` while the lane said `Needs review` | a running pass displayed the cycle count + 1 | `reviewEvidence()` distinguishes running from settled passes |

## 12. Gaps in our state model I would close, in order

1. **Six of fourteen `WorkerPhase` values are unreachable in production.** Grepping every `setPhase` call site: production writes only `queued` (spawn), `awaiting_human` and `shipping` (report state), and `merged`/`closed` (completion). `planning`, `implementing`, `verifying`, `self_reviewing`, `awaiting_auto_review`, `addressing_feedback`, `merge_ready`, `abandoned`, and `failed` are declared, listed in `TERMINAL_PHASES` or documented in the PRD, and **never assigned**. Test fixtures hand-construct workers in those phases, which hides the gap. Since `phase` feeds `isTerminalPhase` (archive, `is_terminated`) and `isBlockedWorker` (attention), this is load-bearing, not cosmetic: either wire each phase to its producer (reviewer service → `awaiting_auto_review`, feedback routing → `addressing_feedback`, merge → `merge_ready`, and a genuine `failed`/`abandoned` path) or delete the unused values. The reference hit exactly this class of bug with its archive column.
2. **`setPhase` accepts any transition.** There is no `ValidPhaseTransition`: `merged → implementing` is representable, and the only thing preventing a post-terminal write is `completeWorker`'s own idempotency check. AO's `ValidAgentSwitchTransition` is the pattern — a `domain`-level guard plus "terminal is terminal" — and it costs one table.
3. **Three overlapping terminal representations.** A finished worker is expressed as a terminal `WorkerPhase`, an `endedAt` timestamp, an `isTerminated` session fact handed to the reducers, and an `IssueState` (`done`/`cancelled`). AO has one (`is_terminated`). Document the precedence explicitly, or collapse two of them; today a reader must reconstruct the mapping from `board-service.ts`.
4. **Dead ported vocabulary.** `isSticky` and `needsInput` are exported and unused. Either give a paused worker the "not aged by a clock" protection they promise (suppress `No signal` demotion while `pendingQuestion` is set — the R20 hazard the comment names) or drop them from the contract so the next reader does not assume a guarantee the code does not provide.

**Net assessment.** The port is closer than the "reinterpretation" framing suggests: the derived board, the review planner, the review-run vocabulary, and both reducers are line-faithful, including their comments and their reason-code strings. The genuine additions are exactly three — a **declared phase axis** (D1, currently half-wired), a **bounded automation loop** (D2), and a **mandatory human gate** (D3) — and each is marked `DIVERGENCE` at the site. The gaps (§12) are all consistency gaps inside the new phase axis, not porting errors: AO's own guarded-saga and precedence machinery is either unnecessary here (no external handoff, no dialog paste) or unimplemented in a way nothing currently depends on.

---

# Part III — GitHub integration behaviour diff

**AO sources read:** `backend/internal/adapters/scm/github/{doc.go,provider.go,observer_provider.go,client.go,auth.go,merge_action.go,review_resolve.go,review_request.go}`, `backend/internal/observe/scm/observer.go`, `backend/internal/review/prompt.go`, `docs/scm-observer.md`.
**dsho sources read:** `src/github/{argv.ts,auth.ts}`, `src/domain/pr-snapshot.ts`, `src/host/{observer-service.ts,exec.ts,repo.ts,reviewer-service.ts,feedback-service.ts,reports-service.ts,completion.ts}`, `src/domain/reviewer-contract.ts`.

The headline: **our GitHub layer is a faithful but much narrower port.** Where AO maintains a provider-neutral SCM subsystem with a polling observer, conditional requests, identity resolution and write actions, we have a per-PR `gh` fetch that exists to feed the board. Two of the biggest behavioural gaps are structural (no discovery, no merge); the rest are mapping details worth knowing before either side drifts.

## 13. Transport and polling

| | AO | dsho |
|---|---|---|
| Read | REST `GET /repos/{o}/{r}/pulls/{n}` (authoritative draft/merged/closed/head) **plus one GraphQL query** (reviewDecision, mergeStateStatus, statusCheckRollup, review summaries, review threads) | `gh pr view --json` with a fixed 13-field list (`PR_VIEW_FIELDS`) |
| Second call | REST `/actions/jobs/{job_id}/logs` for failure-class check runs, tailed to 20 lines (best-effort; a sentinel on failure) | `gh api --paginate repos/{o}/{r}/pulls/{n}/comments` for **inline** comments |
| Conditional requests | In-memory ETag per (method, path, query), `If-None-Match` and 304 body replay; GraphQL always re-fetched (no ETag support) | **None.** Every tick is an unconditional full fetch |
| Cadence | 30 s PR/CI tick; 2 min review-thread interval; 5 min unconditional max age; GraphQL batches of 25; cache capped at 512 | 30 s tick (`pollIntervalMs`), 60 s review sweep, 90 s no-signal grace |
| Cost per worker | about 1 REST/30 s (mostly **304, unbilled**) plus at most 1 GraphQL/5 min | **2 billed `gh` calls per 30 s tick, roughly 240/hour**, always |
| Concurrency | Bounded batches, per-repo guards | Serialised **per repository** (`observeAll`), which the bounded-work NFR demands |
| Terminal handling | `reconcileTerminalGitHubPRs`: GitHub's `state=open` listing drops merged/closed PRs before the transition is observed | Not needed: we poll by PR number, so a merged PR keeps being observed until completion fires |

**Finding (G1).** The missing conditional-request path is the largest behavioural difference in steady state. AO's 304s are explicitly *not billed*, and that is what lets it poll every 30 s. We re-fetch the full payload plus a paginated comment list every tick with no cache, no `updatedAt` gate, and no per-PR backoff: a twenty-worker board is 40 sequential billed calls per minute. Mitigations that keep the design: skip a tick when `snapshot.updatedAt` is unchanged *and* no local action is pending, widen the interval for cards in `ready`/`archive`, and fetch the inline-comment endpoint only when the reviews list changed.

## 14. Discovery and identity — the biggest structural difference

**AO** runs **unattended discovery**: it turns live sessions into observation subjects, lists open PRs per scanned repo, and **attributes** them to a session by authenticated author identity plus branch-prefix match (with head-repo eligibility; unknown or deleted heads excluded). Three write paths create rows (`discoverNewPRs`, observer refresh, explicit `claim` — `ao session claim-pr`, `spawn --claim-pr`, gh-wrapper capture). Its identity history is instructive: five independent derivations of "which PR is this?" (`pr.url`, subject key, dispatch key, repo scan set, store `provider_id`) formed an unenforced distributed invariant that a repo rename broke; #4090 made `provider_id` plus `pr_url_alias` the stable answer and added alias collapse so one PR observed under two URLs renders as one card.

**dsho** has **no discovery at all**. A pull request enters the system exactly one way: the worker reports it — `orchestrator_report` with an `outputs[]` entry of kind `pr_created` — and `reports-service.ts` binds `{number, url, headSha}` onto the worker record. The observer then targets `worker.pr.number > 0`, passing the repository explicitly (`--repo`) rather than trusting the checkout's remote.

| | AO | dsho |
|---|---|---|
| Binding | discovery plus attribution plus claim paths | **one**: the worker's own report |
| Identity | `provider_id` (stable) plus `pr_url_alias` collapse | `{number, url}` from the report; `url` falls back to `#<n>` |
| Recovery after restart | discovery re-lists and re-attributes | **unimplemented**: `prListArgv` exists for exactly this ("Used to recover PRs after a restart") and is called from nowhere |
| Safety net for a PR the plugin did not see created | gh-wrapper capture plus author and branch attribution | none |

**Finding (G2).** The failure mode is inverted relative to AO's. AO's risk was a *wrong* attribution and it built five derivations plus alias collapse to fix it; ours is a *missing* binding. The window is between `gh pr create` (run by the worker) and the report landing: a crash, a truncated report, or a worker that creates the PR and never reports leaves a live PR invisible to the board forever, because the plugin never looks for PRs — it only asks about ones it was told about. `prListArgv` already encodes the shape of the fix (recover by `--head <branch>` for a worker with a branch and no bound PR); it is dead code today.

## 15. Field mapping — where the two normalisations actually diverge

Both systems read the same provider facts, and both were written by people burned by the same things (bot detection by login, empty payloads reading as state changes). The differences concentrate in CI and mergeability.

| Fact | AO (`github/doc.go`, State mapping) | dsho (`pr-snapshot.ts`) | Verdict |
|---|---|---|---|
| Draft / Merged / Closed / head | REST booleans; `Closed = state=="closed" && !Merged` (mutually exclusive) | `gh pr view`: `state`, `isDraft`, `headRefOid`; terminality = `fetched && (MERGED \|\| CLOSED)` | equivalent |
| CI | failure-class conclusion means failing; any running or queued means pending; all non-skipped success or neutral means passing; **an empty rollup falls back to the rollup-level `state` field** | same failure list (plus `STARTUP_FAILURE`); pending includes `PENDING/QUEUED/IN_PROGRESS/WAITING/REQUESTED/EXPECTED` and a blank conclusion and status; **an empty rollup is `unknown`, never `passing`** | **ours is more conservative** (a repo with no CI must not read green); AO is more complete (the rollup fallback) |
| Review decision | GraphQL `reviewDecision` maps to `ReviewApproved/ChangesRequest/Required/None` | same mapping, verbatim | identical |
| Mergeability | **9 composed rules** in priority order over GraphQL `mergeStateStatus` and `mergeable` plus `reviewDecision` and CI, with REST `mergeable_state` only as a tie-breaker; synthesizes `blocked` locally from draft, failing CI, and changes-requested; exposes merge blocker reasons | provider `mergeable` and `mergeStateStatus` passed through; **no synthesis, no reasons list**; only `MERGEABLE` affects the `ready` lane | see G3 |
| Review threads | normalised `pr_review_threads` with a **resolved** flag; resolved threads skipped client-side | review bodies plus inline comments fetched per tick; **no thread or resolution state** | see G4 |
| Bot detection | `__typename == "Bot"` or `User.Type`; the `login.contains("bot")` fallback was **deliberately dropped** (it false-positives on `robothon`, `lambot123`) | identical rule and identical rationale (R19); unknown is reported as undefined and callers treat it as actionable | identical, independently justified |
| Failed-check logs | fetched and attached to the observation | not fetched | minor |
| Notifications | PR merged and ready-to-merge intents through the notification port | none (we notify through the report outbox to the orchestrator session) | minor |

**Finding (G3).** Because we never synthesize `MergeBlocked`, a PR the provider reports as `mergeStateStatus: BLOCKED` with `mergeable: UNKNOWN` reaches the kanban reducer as an empty mergeability and falls through to `needs_review` — the same *lane* AO's synthesis would produce, by a different route, so no card is wrong today. What we lose is AO's **reason list**: `mergeBlockersFromLocal` feeds a merge-readiness card that says *why* it cannot merge (conflicts, draft, failing CI, unresolved changes). Ours shows the phrase but not the reasons.

**Finding (G4).** The coarse external-comment reading in `board-service.ts` — `comments: external.length > 0 && external.every(r => r.state === 'COMMENTED')` — is a real difference from AO's per-thread model. A reviewer who submits `CHANGES_REQUESTED` *and* `COMMENTED` makes `comments` false, so a card can read `Changes requested` while unanswered line comments are also sitting on the PR; and because we track no resolution, a discussion a person has already resolved keeps counting as unresolved feedback until the next head. AO stores resolution per thread and skips resolved ones, which is what makes "the review is still outstanding" a decidable fact rather than a heuristic.

## 16. Reviews: submission, identity, verdict

This is the part where we are **most** faithful, including the reason:

- **Both post `event: COMMENT` from the pull request author's own account**, because GitHub rejects `APPROVE` and `REQUEST_CHANGES` on your own PR. AO states it in `review/prompt.go` ("Always use `event: COMMENT` … State in the body whether you are requesting changes or approving; the machine-readable verdict goes to AO in step 2"); we assert it in `prReviewArgv` and document it as R17. The machine verdict travels out-of-band in both: AO's `ao review submit --run … --verdict … --review-id …` against our `orchestrator_review_verdict`.
- **Both take the review id from the reviewer rather than parsing the POST response.** AO's prompt pipes `--jq '.id'` and hands the number to `ao review submit`; ours takes `githubReviewId` as a tool argument. Same trust model, and the same hazard — which is why both need an id-based discriminator to tell the plugin's own reviews from a person's when the aggregate `reviewDecision` mixes them (ours: `ourReviewIds` over node **and** REST ids; the node/REST mismatch was a real bug in our tree, Part II §11).
- **Inline comments** are posted as an array in both: AO's JSON `{"comments":[{path,line,body}]}` via `--input -`; ours as repeated `-f comments[][path|line|body]` fields. AO additionally warns its reviewer to shell-escape quotes because reviewer panes run through a PTY; we build argv in-process, so that class of bug cannot occur here.
- **Read-only discipline**: identical intent, different enforcement. AO's reviewer prompt forbids executing anything and each reviewer adapter carries a **command-level allowlist** (some with base64-pipe tricks so the only permitted shell line is the exact review POST); ours states `REVIEWER_EXECUTES_NOTHING`, `REVIEWER_MUTATES_NOTHING` and `REVIEWER_UNTRUSTED_INPUT` in `reviewer-contract.ts` and relies on the `read-only` permission preset plus the prompt. AO's is the stronger lever: a prompt cannot stop a harness that has a shell, a preset or allowlist can.

## 17. Write actions — the clearest capability gap

| Action | AO | dsho |
|---|---|---|
| Merge | `PUT /repos/{o}/{r}/pulls/{n}/merge` with **`sha` set to the reviewed head as a compare-and-swap precondition**, squash only; 409 becomes `ErrSCMHeadChanged`, 405/422 becomes `ErrSCMNotMergeable` | **none.** The user merges on GitHub |
| Resolve review threads | `review_resolve.go` (and a "mark pr review thread resolved" store write) | none — the worker is instructed to reply and resolve its own threads (the same message text AO injects into its worker) |
| Request reviewers | `review_request.go` | none |
| Push | the worker pushes its branch | `pushArgv` with **no `--force` parameter at all** — unreachable by configuration, not merely discouraged |

**Finding (G5).** AO's merge is the one write action whose *design* is worth copying even if we never take the capability: passing `sha` makes "merge the commit that was reviewed" a provider-enforced precondition, so a merge cannot land on an unreviewed head — our D3 human-gate policy expressed one layer down, where our own bug cannot bypass it. If we ever add a merge button, it should be that call.

## 18. Credentials

The chain is **identical in order and semantics** — `AO_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`, memoised for five minutes with invalidation forwarded through the fallback chain on an auth-class failure so a rotated token is picked up without a restart; a source that yields nothing is skipped, and any other error surfaces only if nothing later succeeds. Both refuse to build a GitHub App, an OAuth flow, or a PAT store.

Two differences:

1. AO additionally supports per-host static tokens (for its GitLab path); we are GitHub-only.
2. **Ours resolves the token and never uses it.** `githubTokenChain` is exported from `src/github/auth.ts` and imported nowhere; every `gh` and `git` call goes through the exec seam without injecting `GH_TOKEN`, so the effective credential is always whatever `gh` itself has configured. The only auth code on a live path is `gh auth status` as the repo-connect preflight (`repo.ts`), which reads the exit code.

**Finding (G6).** The ported chain is currently dead code. It is not harmful — `gh` resolves the same credential — but it means a project-scoped `AO_GITHUB_TOKEN` does **not** affect our `gh` calls, silently contradicting the module's own documentation that a project-scoped variable wins, and the "auth-class failure drops the memo" behaviour we carefully ported can never run. Either inject the resolved token into the child environment (and then the doc becomes true) or delete the module and state plainly that `gh` owns credential resolution.

## 19. Failure and rate-limit handling

| | AO | dsho |
|---|---|---|
| Classification | HTTP status sentinels: `ErrNotFound` (404), `ErrAuthFailed` (401, or 403 without rate-limit signals), `ErrRateLimited` (403 with `X-RateLimit-Remaining: 0`, the abuse-detection body, or 429) carrying `ResetAt` and `RetryAfter` | `classifyCommandFailure` sniffs `gh`'s stderr into `notInstalled`, `rateLimited`, `unauthorized`, `forbidden`, `notFound`, `timedOut`, `unknown`, with the same 403-before-rate-limit ordering and an `invalidatesToken` flag for auth-class |
| Backoff | real cooldowns: `rateLimitCooldown`, `boundedCooldown`, `defaultRateLimitCooldown`, parsed from the provider hint | `retryAfterMs` **parses the same hint and is called from nowhere**; no cooldown path exists, so the 30 s tick is the only retry cadence |
| Failed observation | `Fetched=false` placeholders are **routing metadata that must never reach storage**; the prior row is left untouched and the repo is pinned refresh-incomplete | the failed snapshot **is** written, carrying `fetched: false` **and the prior facts**, so a caller that ignores the flag still cannot fabricate `CLOSED` (R13) |
| Per-repo failure isolation | one failed ref pins the whole repo's sync cursor | failures are contained per worker; there is no cursor to pin |

**Finding (G7).** `describeFailure(rateLimited)` tells the user "The plugin backs off rather than retrying", but nothing implements a back-off and `retryAfterMs` has no callers, so the honest behaviour is "retries every tick against an already-exhausted budget". Either wire the parsed hint into the observer's schedule (the piece is already written, and testable in isolation) or change the message. A message that overstates the mechanism is the same class of defect as a board that claims a loop nobody is running.

**Finding (G8).** Storing the failed snapshot diverges from AO's invariant on purpose, and is safer than it looks: prior facts are carried forward, so no fabricated transition is possible. The cost is that a long outage leaves cards showing stale facts whose only freshness signal is `observedAt`, with `fetched: false` and `error` sitting on a record no read path surfaces. A card that has not been observed for ten minutes should be able to say so.

## 20. What to copy, ranked

1. **Gate the poll (G1).** Highest operational value: an `updatedAt` check plus a wider interval for settled cards cuts the billed call rate by an order of magnitude without touching any state logic.
2. **Make failure freshness visible (G8) and wire the back-off (G7).** The parser exists; the honesty of the rate-limit message depends on it.
3. **Recover unbound PRs (G2)** — implement the `prListArgv` path that already exists, for a worker with a branch and no bound PR, closing the crash window between `gh pr create` and the report.
4. **Track thread resolution (G4)** — the difference between "there is feedback" and "the feedback still stands" is what keeps `needs_review` from being a guess on a re-reviewed PR.
5. **Expose merge blockers (G3)**, and if a merge action is ever added, use AO's `sha`-guarded PUT (G5).
6. **Decide the auth module's fate (G6)**: inject the token, or delete the chain and stop documenting a precedence it does not have.

**Net assessment of the GitHub layer.** The part that faces the provider API is a *smaller* system with a *better* safety invariant: R13's "a failed observation never fabricates a transition" is enforced more simply than AO's five durable-state invariants, and it is enforced where it matters (the observer), whereas AO needs cursors, semantic hashes and write modes because it polls many repositories it does not own. The three things AO has that we do not are consequences of scope: unattended discovery, conditional requests, and write actions. Of those, only the polling cost (G1) is a live problem in the system as it stands; the rest are capabilities we chose not to take, and the notes above say what to copy if that changes.




