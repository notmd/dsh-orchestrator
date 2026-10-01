# Appendix A — DSH plugin contract, verified

Every DSH API this PRD relies on, with the artifact it was verified from. Verification was performed against the installed **DeepSeek Harness `0.1.7-rc.2`** on the authoring machine (`DSH_HOME=/Users/notmd/.dsh`, profile `desktop`), whose plugin packages are installed under `~/.dsh/profiles/node_modules/@deepseek-ai/`, plus the public source repository [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (default branch **`master`**, MIT).

> **Authority order.** Where this appendix and an upstream README disagree, the installed `lib/types/*.d.ts` wins — it is what the runtime actually enforces. The upstream doc policy is the same in spirit: the contract layer beats prose.

---

## A1. Plugin package shape

### A1.1 A bundle is a package whose manifest declares `dsh.bundle.patch`

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

> A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries. … **A Host-only bundle needs no dependencies, install scripts, or build tool.**
> — `packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md`

**Verified in a real shipped bundle:** `apps/web/tests/fixtures/plugins/fixture-bundle/package.json` + `cordis.patch.yml` — a minimal working example with a host `index.js`, a `client.js`, a `locale/` directory, and an `icon.svg`.

### A1.2 Display metadata and icon

Read from the manifest **without activating the plugin**, so a card can render without running code:

```json
{
  "icon": "./icon.svg",
  "meta": { "title": "Orchestrator", "description": "Issues, workers, and a derived PR board." },
  "exports": { "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" },
  "files": ["locale/*.json", "icon.svg"]
}
```

Icon must be a path **relative to the manifest directory**; SVG/PNG/JPEG/WebP up to **256 KiB**; absolute paths, URLs, paths outside the directory, and escaping symlinks are rejected. Missing fields fall back to `package.json` `name`/`description`. Locale strings live in `locale/en.json` (and `locale/zh.json`, …).

### A1.3 Host plugin export forms — pick exactly one

- `export function apply(ctx, config) {}` with optional `export const inject = [...]` and `export const Config`.
- A service class as the default export.

Register everything inside `apply` via `ctx.effect()` / `ctx.on()` and return its cleanup. A plugin declaring `Config` has the row's `config` validated at activation.

**Verified example** — a real shipped rule plugin, `apps/cli/config/examples/github-review/github-ready-review-rule.mjs`:

```js
import z from '@deepseek-ai/schemastery'
import { WebhookRuleId } from '@deepseek-ai/dsh-webhook'

export const name = 'github-ready-review-rule'
export const inject = ['webhookRuntime']

export const Config = z.object({
  source: z.string().required(),
  repository: z.string().required(),
  workspacePath: z.string().required(),
  agentPreset: z.string().required(),
  permissionPreset: z.string().required(),
})

export function apply(ctx, config) {
  ctx.effect(() => ctx.webhookRuntime.register({ /* … */ }))
}
```

### A1.4 Install, enable, observe

Installation is performed by the **`plugin_manager`** tool with `action: install_bundle` and the absolute package directory as `target` — not by hand-editing the profile.

> Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps.
> — `SKILL.md` (cordis-plugin-development)

Inspect outcomes separately: `failed` needs diagnosis, `overridden` means a higher-priority layer wins, `restart-required` means the change is not live. A **new** bundle can activate through HMR; replacing an installed package requires a restart to load a fresh module generation.

---

## A2. Slot / UI surface

### A2.1 The `main` keyed slot — the full-page seat a board needs

```ts
/**
 * Central panel selected by sidebar entry id. The reserved `conversation`
 * key hosts the Conversation; other keys receive no Session binding.
 */
'main': {
    kind: 'keyed';
    scope: 'root';
};
```

> Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation. `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session. **No global panel is registered by the shipped composition.**
> — `@deepseek-ai/dsh-client-ui-layout`, `README.md`

Verified in `@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts`. **This is the seat the Kanban board occupies, and nothing currently competes for it.**

Two related seats we deliberately do **not** take:

| Slot | Kind | Why not |
|---|---|---|
| `sidebar` | `single`, root | **Occupied** by `ui-sidebar`'s `SidebarRoot`, which declares the workspace and settings seats inside it. Registering replaces the whole navigation column. |
| `rightbar` | `single`, root | **Occupied** by the right sidebar; registering would replace it. Also wrong shape for a board. |
| `shell.overlay` | `list`, root | A click-through frame-wide floating layer — correct for a badge or toast, wrong for a board. |

### A2.2 `sidebar.panellist` — the navigation row that selects the panel

> Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware `label`. **The same id addresses the component registered in the layout's root-scoped `main` keyed slot**; selecting a missing main entry throws without changing the current selection. The label supplies plain visible text, the accessible name, and the collapsed tooltip. Each row reads its own selected state through `usePanelInfo` … **With no registrations, neither the list nor spacing for it is rendered.** The shipped composition registers no example panel.
> — `@deepseek-ai/dsh-client-ui-sidebar`, `README.md`

Verified in `@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` (the `'sidebar.panellist'` declaration) and `lib/client.js` (`renderSlot("sidebar.panellist", …)`, `ctx.slots.entriesOfSlot("sidebar.panellist")`).

### A2.3 Slot declaration mechanics

- `root` is the only built-in declaration rendered through the Cordis service itself; every other key is rendered by the entry that declared it.
- **Declaring a child key makes it live and authorizes exactly one owner.** Registering into an undeclared slot, or declaring a child already owned elsewhere, **fails during plugin activation**.
- Contribute with `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`: the callback re-runs per declaration lifetime and its effects are disposed when the owner collapses.
- Cardinality: `single` | `list` (needs `id` + `order`) | `keyed` (owner dispatches `entryKey`) | `chain`.
- `priority` is a shadowing rank; lower renders first. Additive work should take a fresh list `id` or unoccupied key.

### A2.3.1 Runtime registration — verified against a live GUI

The board registers **one `main` panel and one `sidebar.panellist` row per connected project**, and adds
and removes them as the project list moves. That is a step past "register once at activation", so each
fact it depends on is recorded here with what it was verified from:

| Fact | Evidence |
|---|---|
| A keyed slot takes **many keys from one plugin**; each key is its own cell, and a disposer removes exactly its own. | `dsh-client-ui-slots/lib/index.js` — `SlotCore.register` keys cells by `key`; `entriesOfSlot` projects one winner per cell. **Live**: two panels registered under `orchestrator:repo-v1` / `orchestrator:repo-v2`, both rendered, no shadowing error. |
| The layout **prunes a selection whose main key disappeared**, so a disconnected project cannot leave a blank centre pane. | `dsh-client-ui-layout/lib/client.js` — `ctx.slots.subscribe("main", retainMainPanels)`, and `retainMainPanels` clears `activePanelId` when no live entry carries it. |
| The sidebar **derives its rows from the registry** and re-syncs on a slot subscription, so a row registered after activation appears without a reload. `order` is ascending, ties keep registration order. | `dsh-client-ui-sidebar/lib/client.js` — `syncPanels()` maps `entriesOfSlot("sidebar.panellist")` and sorts by `options.order`; `ctx.slots.subscribe("sidebar.panellist", syncPanels)`. |
| `label` may be a **function**, which the shell re-resolves on every sync (locale change included). This is the only way to put data (the repository) inside a translated row label. | `dsh-client-ui-slots/lib/index.js` — `resolveSlotLabel(label) { return typeof label === 'function' ? label() : label }`; `dsh-client-ui-sidebar` calls it in `syncPanels`, which is also subscribed to `ctx.locale`. |

**One consequence to design around: `ctx.slots.inject`'s callback runs when the seat is DECLARED, not when
our data changes.** Registering from a poll therefore needs both paths to converge on one reconcile
function, and a row must wait for its panel (`selectPanel` throws — inside the user's click — for a key no
one registered).

### A2.3.2 The workspace/project row exposes NO action seat

`dsh-client-ui-workspace`'s `ProjectRowItem` renders the workspace row's hover buttons **inline**: a `...`
menu whose items are hard-coded to Rename / Delete, and a New Session button. There is no `list` slot for
them, and `sidebar.workspaces` itself is a `single` hole that the same package already occupies. Verified
in `dsh-client-ui-workspace/lib/client.js` (`ProjectRowItem`, `WorkspaceBrowser`'s registration) and by
querying the running GUI: the project row's buttons carry no plugin id.

So **an icon button on the project row is not reachable from a plugin** without an upstream seat (a
`sidebar.workspaces.project.row.action` list, declared and rendered by that package). What is reachable,
and what this plugin uses, is a `sidebar.panellist` row per project.

### A2.4 Client module registration

A package joins the browser graph by declaring `dsh.client` in `package.json` and exporting a bundle at `exports["./client"]`:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

The browser artifact registers a lazy factory whose **id equals the package name**, via `window.__ModuleLoader__.load({ id, factory(require) { … } })`. React comes from the browser module table — do **not** install or CDN a second copy. For compiled sources use the deployment's client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`.

**Verified minimal client half** — `templates/decoration/client.js`:

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() { /* … */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

### A2.5 UI rules that are binding, not stylistic

| Rule | Source |
|---|---|
| Render React components in a slot. **Never** serve HTML from the host and iframe it — an iframe receives no theme tokens, no light/dark switching, no `ctx.locale`. | `references/practices.md` §UI |
| Style with `--dsw-alias-*` theme tokens. Literal colours for artwork only. | same |
| **Do not `require` any `@deepseek-ai/dsh-client-ui-*` package.** `dsh.client.inject` entries order activation only. Copy markup/CSS/behaviour into the plugin, rename classes under your prefix, keep only token references. | same |
| A throwing component blanks the slot entry (`slot entry crashed in '<slot>'`). | same |
| Route visible text through the client locale service. | `references/ui-plugin.md` |
| Do not write DOM outside your component or append to `document.body`. | same |
| Choose a slot that already allocates space; do not read another plugin's DOM to estimate placement. | same |
| For a non-conversation main panel, pad the top by `--dsh-frame-top-clearance` (48px); on macOS desktop honor `--dsh-frame-leading-clearance`. | `ui-layout` README |
| Copy spacing/type/row patterns from the **Plugin Manager page**, the host's own management-list reference. | `references/practices.md` §UI |

---

## A3. Host services

### A3.1 Creating a worker Session — the exact recipe

This is the single most important host technique in the PRD. `@deepseek-ai/dsh-webhook` ships a complete, audited implementation (`packages/webhook/webhook/src/session.ts`, compiled to `lib/types/session.js`). Reproduced here because the orchestrator follows it almost exactly:

```js
const resolved = resolveRequest(ctx, request);           // validate before any await
ctx.permissionPresets.resolve(resolved.permissionPreset);
const preset = await ctx.agentPresets.resolve(resolved.agentPreset);
await ctx.agentPresets.acquireScope(preset.id);
signal.throwIfAborted();

const workspace = await ctx.workspaceRegistry.create(resolved.workspacePath);
signal.throwIfAborted();

const sessionId = brandString(`webhook-${randomUUID()}`);
const handle = await ctx.agents.create({
  sessionId,
  signal,
  meta: { cwd: workspace.path, agentPreset: preset.id },
  agentOptions: resolved.agentOptions,                   // { provider, model, maxTokens? }
  setup: async (agentCtx) => {
    await ctx.agentPresets.mount(agentCtx, preset.id);
    installInitialModelSelection(agentCtx, resolved.modelSelection);
  },
});

// publish: attach, permission, title, then prompt
await workspace.attachSession(sessionId);
ctx.permissionPresets.set(handle.agent.session, resolved.permissionPreset);
ctx.sessionTitle.rename(handle.agent.session, resolved.title);
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: resolved.prompt }],
  source: { kind: 'webhook', provider, source, deliveryId, ruleId, form: 'notice', summary },
}));
```

Note the rollback discipline: a failed `attachSession` path disposes the agent (`await handle.dispose()`), and a rollback failure is logged without replacing the original error.

**Key detail:** `handle.agent` is retained after this function returns. That handle is what the orchestrator keeps to detect idle and to deliver review feedback.

### A3.2 The `Agent` interface

```ts
interface Agent {
  readonly options: AgentOptions;
  readonly session: Session;      // the durable spine
  readonly inbox: Inbox;
  readonly status: AgentStatus;   // 'idle' | 'running'
  readonly ctx: Context;          // agent-scoped; registrations unwind on disposal

  cancel(cause: AgentCancelCause, options?: CancelOptions): void;
  whenIdle(): Promise<void>;
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
  followup(message: UserMessage): void;   // queue an ordinary follow-up turn and wake
  steer(message: UserMessage): void;      // nearest step boundary
  inject(message: UserMessage): void;     // context, does NOT wake
}
```

`AgentStatus = 'idle' | 'running'` — **only two values.** This is why §7.6 derives the richer `activity_state` from additional signals rather than reading `status` alone.

Semantics that matter for the feedback loop:

- `followup()` — "Queue an ordinary follow-up turn and wake the driver. The item becomes the sole ordinary message of its own turn." This is the correct call for PR feedback.
- `inject()` — does **not** wake; context can sit until other input arrives. Wrong for feedback.
- `steer()` — consumed at the next step boundary of a running turn. Too intrusive for feedback.
- `whenIdle()` — "Resolve after the current whole-agent activity reaches quiescence… **does not identify the settlement of any particular message.**" So do not use it as "my followup finished".

### A3.3 Service keys referenced by this PRD

| `ctx` key | Package | Verified declaration |
|---|---|---|
| `ctx.agents` | `dsh-agent` | `dsh-agent/lib/types/index.d.ts:20` → `agents: AgentRegistry` |
| `ctx.workspaceRegistry` | `dsh-workspace` | `dsh-workspace/lib/types/index.d.ts` → `WorkspaceRegistry extends Service` |
| `ctx.agentPresets` | `dsh-agent-presets` | used by `dsh-webhook` |
| `ctx.permissionPresets` | `dsh-permission-presets` | used by `dsh-webhook` |
| `ctx.sessionTitle` | `dsh-session-title` | used by `dsh-webhook` |
| `ctx.tools` | `dsh-tools` | `defineTool`, `restrict`, `guard` |
| `ctx.storage` / `ctx.storageDomain` | `dsh-storage` | `dsh-storage/lib/types/index.d.ts:23-27` → `storage: Storage` |
| `ctx.subprocess` | `dsh-subprocess` | `dsh-subprocess/lib/types/index.d.ts:43` → `subprocess: SubprocessRuntime` |
| `ctx.shell` | `dsh-shell` | foreground + background command execution |
| `ctx.sessionQuery` | `dsh-session-query` | `dsh-session-query/lib/types/index.d.ts:25` → `sessionQuery: SessionQueryEngine` |
| `ctx.jobs` | `dsh-jobs` | background job registry and output ring |
| `ctx.webServer` | `dsh-host-webserver` | named route / upgrade registration |
| `ctx.webhookRuntime` | `dsh-webhook` | `register(rule)`, `dispatch(delivery)` |
| `ctx.userQuestions` | `dsh-user-questions` | `dsh-user-questions/lib/types/index.d.ts:13` → `userQuestions: UserQuestionService` |
| `ctx.approval` | `dsh-user-approval` | `dsh-user-approval/lib/types/index.d.ts:21` → `approval: ApprovalService` |
| `ctx.slots` (client) | `dsh-client-ui-slots` | `inject`, `register`, `entriesOfSlot`, `subscribe` |
| `ctx.layout` (client) | `dsh-client-ui-layout` | `selectPanel`, `toggleSidebar`, `openRightbar`, `closeRightbar` |

### A3.4 Tool registration

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

Schema DSL supports `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`, author-only `json`, and exact-one `oneOf`. Registering a tool is enough to make it visible — the registry feeds its schema into system-prompt assembly automatically.

### A3.5 Extension-point strength ladder

> From weakest to strongest: `ctx.tools.restrict()` can only remove tools; `ctx.tools.guard()` can only deny; waterfall listeners can rewrite and depend on registration order; `system-prompt/assemble` replaces the whole assembly.
> — `references/practices.md`

Consequences for this plugin:

- Worker-only tools → `ctx.tools.restrict()` on the **worker agent's** ctx (obtained in an `agent/created` listener). Keeps schema presentation, lookup, and execution aligned.
- Worker instructions → `ctx.systemPrompt.section()`. **Never** listen to `system-prompt/assemble`.
- Anything that must hold regardless of listener order → `ctx.tools.guard()`.
- Per-agent state (e.g. observing a worker's tool calls) → register on `agent.ctx`, wrapped in one `agent.ctx.effect()`, **and** keep that disposer keyed by agent in the plugin's own effect. Unloading the plugin does not by itself dispose `agent.ctx` registrations.

### A3.6 Persistence and the log-as-truth rule

> **The session log is the only source of truth.** Anything the model sees must be reconstructable from committed session events… Plugin memory is a derived cache.

Consequences:

- Board records (issues, workers, PR snapshots) live in `ctx.storageDomain` — application state, not session history.
- **Do not append session events with a new `type`.** Readers accept an unknown stored event only when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker — so the session would refuse to reopen. Derive state from existing events, or keep plugin-owned data in storage.
- `dsh-workspace` requires session persistence + a storage backend:

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
- name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: json }
- name: '@deepseek-ai/dsh-workspace'
```

---

## A4. Workspaces — the constraint that shapes isolation

```ts
/**
 * Prepend a session to this workspace's candidate account. … A new id's live
 * or persisted header cwd must resolve to an existing directory equal to
 * `path`; unknown ids, missing or invalid cwd values, and mismatches reject
 * without writing.
 */
attachSession(sessionId: SessionId): Promise<void>

readonly path: string;   // fs.realpath of the path given at create time, never rewritten
readonly title: string;  // display title; duplicates allowed
```

Also: `create(path, title?)` canonicalizes via `fs.realpath` and **rejects** relative, nonexistent, or non-directory paths; repeated calls for the same canonical path return the existing workspace; `resolveByPath()` resolves without creating.

**Implication, stated once more for emphasis:** a session's `cwd` *is* its workspace path. A per-issue worktree therefore *must* be its own workspace. This is not a stylistic choice — it is the documented contract.

---

## A5. Web server — serving the board API

> `register(route)` adds a named `exact` or `prefix` HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both return a disposer that removes the registration. A duplicate path within either table throws… HTTP matching is exact over the whole table, then longest prefix, then the fallback handler.
> An HTTP request whose handler throws is answered **400** — or the socket destroyed when headers are already out — and logged as a warning; **it never exits the process.**
> — `@deepseek-ai/dsh-host-webserver`, `README.md`

`host` accepts exactly `127.0.0.1` (default) or `0.0.0.0` (deliberate exposure; **the server carries no TLS, authentication, or origin policy of its own**).

Practical consequences: handlers must validate input and return explicit error bodies rather than relying on throw-to-400; the board API needs no auth because it is same-origin loopback; and if the webhook ingress listens on a second port, that port must be loopback-only behind a reverse proxy.

---

## A6. The existing GitHub ingress (optional accelerator)

Two shipped packages, **neither enabled by default** — verified: `grep webhook` over the shipped `@deepseek-ai/dsh-base/cordis.patch.yml` and `@deepseek-ai/dsh-web-app/cordis.patch.yml` returns nothing.

### A6.1 `@deepseek-ai/dsh-webhook`

> `dsh-webhook` provides the Host `ctx.webhookRuntime`: a registry for trusted programmatic webhook rules plus the one built-in action, creating an ordinary root Session inside a Web Workspace.
> … a callback **may execute arbitrary trusted code** and returns either `null` or one `WebhookSessionRequest`.

That "arbitrary trusted code, may return `null`" clause is what lets the orchestrator reuse signed ingress while doing its **own** `followup()` instead of the built-in "create a new session" action.

### A6.2 `@deepseek-ai/dsh-webhook-github`

Config keys: `source`, `path`, `secretEnv`, `maxBodyBytes` — **all required**. Contract: `POST application/json` only; requires `X-Hub-Signature-256`, `X-GitHub-Delivery`, `X-GitHub-Event`; **verifies HMAC before JSON parsing**; never logs the secret, signature, or payload. Status map: `202` dispatched · `400` malformed · `401` bad signature · `405` wrong method · `413` too large · `415` wrong media type · `503` credential/runtime unavailable.

### A6.3 Documented limits — why this stays an accelerator

> - **Process-local fire-and-forget only** — a crash loses rule calls that have not admitted a prompt; there is no queue, replay, or retry.
> - **No built-in deduplication** — repeated provider deliveries may create repeated Sessions; rules that need idempotency own it.
> - **No completion result** — HTTP acceptance and rule settlement do not report Agent success, idle, or output.
> - **No TLS** — the injected development WebServer is normally loopback-only behind a TLS reverse proxy or tunnel.

### A6.4 The composition pattern (from the shipped overlay)

`apps/cli/config/examples/github-review/cordis.yml` — a second `dsh-host-webserver` **inside a group that isolates only `webServer`**, so exposing the webhook port never exposes the UI API:

```yaml
- insert:
    - id: webhook-runtime
      name: '@deepseek-ai/dsh-webhook'
    - id: github-webhook-ingress
      name: cordis:group
      group: true
      isolate:
        webServer: true
      config:
        - id: github-webhook-server
          name: '@deepseek-ai/dsh-host-webserver'
          config: { host: '127.0.0.1', port: !!js Number(process.env.DSH_GITHUB_WEBHOOK_PORT ?? 3081) }
        - id: github-webhook-adapter
          name: '@deepseek-ai/dsh-webhook-github'
          config:
            source: primary-github
            path: /github
            secretEnv: DSH_GITHUB_WEBHOOK_SECRET
            maxBodyBytes: 1048576
```

**This is the strongest single signal in the whole research pass:** DSH already ships and documents an opt-in GitHub PR webhook → agent session pipeline. The orchestrator is an extension of a supported pattern, not an invention.

---

## A7. Client ↔ host transport options

| Option | Build needed | Verdict |
|---|---|---|
| **Typert Remote** (`ctx.remote.<ns>.<method>`) — `@Remote` decorators, generated descriptors/codecs, `pnpm run build:lib` | **Yes — DSH source checkout** | Phase 3 |
| **Exact Fetch routes on `ctx.webServer`** + same-origin `fetch` + SSE | No | **Phase 1** |
| Session projections + `wire.view` | Requires the DSH build toolchain | Only if we later ship a projection-based view |

Supporting quotes:

> Controller operations belong on generated Remote methods or explicit Remote streams; **feature-owned downloads register exact Fetch routes**.
> — `docs/subsystems/web-client.md`

> For compiled sources, use the deployment's Client build tooling to emit this format.
> — `references/ui-plugin.md`

---

## A8. Development loop

- Author the bundle in **workspace files**, then install with `plugin_manager` `action: install_bundle` + absolute `target`.
- Every `plugin_manager` action needs approval unless the profile has Full access. `cordis_inspect_query` needs no approval — prefer it for confirming new rows.
- Read the installation result's `application` and `warnings` fields to decide whether the change is live. **Not** server logs, terminal output, or the page's boot payload.
- Client-plugin HMR reloads without a manual refresh only while `pnpm run dev:web` is also running from the same checkout to rebuild bundles.
- **In the Desktop app the skill directory sits inside `app.asar`**, which only the Host process's own file reads can open: `ls`/`cat`/`cp`/`cmp`, glob, search, `node`, and pnpm all fail on it. Copy templates into the workspace before editing.

### Knowledge sources, in the order the skill prescribes

1. `cordis_inspect_query` — `Service`, `Event`, `Config.listConfigs`, `Tool`, `Slots`, `Theme`.
2. `<packageDir>/README.md` (resolved from `Config.listConfigs`, never guessed from `$DSH_PROFILE_DIR`).
3. Installed `lib/index.js` + `lib/types/**/*.d.ts` — or `packages/<group>/<name>/src` in a source checkout.

---

## A9. Version pinning

| Thing | Version verified |
|---|---|
| DSH / all `@deepseek-ai/dsh-*` peers | `0.1.7-rc.2` |
| `@deepseek-ai/cordis` | `~4.0.4` |
| `@deepseek-ai/schemastery` | `~3.18.4` |
| Bundled Node (desktop runtime) | `24.18.1` |
| Bundled pnpm | `11.7.0` |
| `@octokit/webhooks` (used by `dsh-webhook-github`) | `^14.2.0` |
| Client React | from the browser module table — never bundled |

Declare DSH peer dependencies as **exact** versions (as shipped packages do: `"@deepseek-ai/dsh-tools": "0.1.7-rc.2"`), not ranges.

---

## A10. Open verification items

Items this appendix could **not** fully verify from the installed artifacts, to be settled in M0:

1. **Where a workspace bundle's `main`-slot registration is validated.** Slot declarations are per-owner; confirm with `cordis_inspect_query` `Slots.listSubTree` that `main` and `sidebar.panellist` are reachable from a third-party bundle at activation time, and that no shipped occupant exists.
2. **Whether `ctx.agents.create()` is safe for a non-`dsh-webhook` caller.** The API is on `ctx.agents` (public), but the only shipped caller is `dsh-webhook`. M0 spike 2 must confirm no hidden ordering requirement.
3. **Whether `attachSession` tolerates a worktree path whose repository root is a *different* workspace.** The contract says cwd must equal `path`; it does not discuss nested repositories or worktrees. M0 spike 2 confirms empirically.
4. **How to observe a pending `ask_user_question` from outside the agent's turn.** `ctx.userQuestions.ask()` returns a promise; observing its pending state for another agent is unverified. Fallback: the explicit `orchestrator_needs_input` tool (which this PRD already makes the primary signal).
5. **SSE through `ctx.webServer.register`.** Plain HTTP is documented; SSE streaming is not explicitly shown. If it proves awkward, poll the board endpoint on a short interval instead (and drop `/dsho/events`).
