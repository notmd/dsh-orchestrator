# Verification harness — driving the Web GUI from an agent session

**Read this before trying to verify anything in the browser.** It exists because
the obvious approaches do not work, and the working one is non-obvious.

Verified 2026-10-01 against DeepSeek Harness `0.1.7-rc.2` on macOS.

---

## 1. The problem this solves

The plugin's whole UI half (the `main` panel seat, the `sidebar.panellist` row)
can only be *proved* in a running GUI. Three plausible routes all fail:

| Route | Why it fails |
|---|---|
| Point the Chrome DevTools MCP server at the **desktop app's** GUI (`127.0.0.1:19387`) | That server is attached to **its own Chrome instance**, not the desktop app, and the app exposes **no CDP/remote-debugging port** to attach to. |
| `curl`/`fetch` the desktop GUI | It answers **401** to everything. `dsh-client-connection/lib/index.js` gates each request behind a cookie minted from a **process-scoped launch token**; `GET /?token=<launchToken>` is required to be redirected with the signed cookie. That token lives in the running process's memory — it cannot be read from disk or from another process. Measured: `/` → 401, `/?token=bogus` → 401, nonexistent paths → 404, so there is no unauthenticated asset path either. |
| Serve a standalone harness page and borrow the deployment's React | React is not a plain package in the profile (`node_modules/react` does not exist). It comes from the **browser module table**, which only the authenticated server populates. |

**The working route: start your own `dsh web`, which prints its own authenticated
URL including its own launch token.**

---

## 2. The procedure

### Step 1 — boot a web profile server on a free port

Run it as a **managed background job** (it is a long-lived server):

```bash
dsh --profile web --port 0 --no-open --host 127.0.0.1
```

Why each flag:

| Flag | Why it is not optional |
|---|---|
| `--profile web` | Boots the `web` profile (`$DSH_HOME/profiles/web`) rather than the desktop one. **This is what keeps the user's app untouched** — different profile, different `cordis.patch.yml`, different installed plugins. |
| `--port 0` | Lets the OS pick a free port. The desktop app already holds `19387`, so a fixed port would either collide or need an arbitrary guess. |
| `--no-open` | Suppresses opening the URL in the **default browser**. Without it you hijack the user's browser, and you still do not get the URL programmatically. |
| `--host 127.0.0.1` | Keeps it loopback-only. The web server carries **no TLS, authentication, or origin policy of its own** — the token is the only gate. Never bind `0.0.0.0`. |

### Step 2 — read the authenticated URL out of the job output

The server prints exactly one line of this shape, after the MCP-server banners
that share stdout:

```
dsh web: http://127.0.0.1:62982/?token=HCxPJtuqQZfkh4Evo0ZQdmUL96jE9Ug3Q3zDjhHb5UA
```

Wait for it (the banner noise comes first), then take the URL:

```bash
# via the job tool: wait: true, timeout_ms ≈ 20000
# or grep the job output for /^dsh web: /
```

**The token is process-scoped.** Every new `dsh web` run mints a fresh one, and
the port changes. Never hardcode either — re-read the line each time.

### Step 3 — open it in Chrome through the DevTools MCP server

```
new_page(url: "http://127.0.0.1:<port>/?token=<token>")
```

The first request exchanges the token for a signed cookie and **redirects to the
clean `/`** — which is why a later `evaluate_script` reports
`location.href === "http://127.0.0.1:<port>/"` with no token in it. That is
expected and correct, not a failed auth.

### Step 4 — confirm the app really booted

```js
() => ({ title: document.title, boot: Object.keys(window.__DSH_BOOT__ || {}) })
// → { title: "DeepSeek Harness", boot: ["rev", "entries", "batches"] }
```

A 401 renders a **plain-text page**, not the app: `document.title` would be empty
and there would be no `__DSH_BOOT__`. Title plus `__DSH_BOOT__` is the boot proof.

### Step 5 — tear down

Kill the background job when finished. Leaving it running holds a port and a
process for no benefit.

---

## 3. What you can actually inspect from the page

| Signal | How | What it proves |
|---|---|---|
| **Client modules loaded** | `window.__DSH_BOOT__.entries` — an array of `{ id, url, rev, inject, … }` | Your plugin's client half is in the browser graph. Grep it for your package name. Verified: 65 entries in the `web` profile. |
| **Boot payload shape** | `window.__DSH_BOOT__` → `{ rev, entries, batches }`; `batches` is 3 × `{ phase, url, rev, entries }` | The loader's phase grouping, if you need to know activation order. |
| **Loader** | `window.__ModuleLoader__` → `{ mode, pendingQueue, load, create }` | Classic-script modules register via `__ModuleLoader__.load({ id, factory })`. |
| **Other config globals** | `__DSH_BOOT_READY__`, `__DSH_CONTACT_CONFIG__`, `__DSH_SHORTCUTS_CONFIG__`, `__DSH_MODELS_ONBOARDING__`, `__DSH_CONNECTION_RECOVERY__`, `__DSH_DOCUMENT_PREVIEW_CONFIG__` | Presence/absence is a cheap boot-integrity check. |
| **Sidebar rows** | Query the sidebar `<aside>` for `button`s and read `aria-label` / `title` / `innerText` | The `sidebar.panellist` rows. With no registrations the list is not rendered at all — **so absence of your row is a real signal, not a missing element**. |
| **Slot registrations** | Not available from a global. Use the `cordis_inspect_query` tool (`Slots.listSubTree`) when the session has it; otherwise infer from `__DSH_BOOT__.entries` plus the DOM. | Whether `main` / `sidebar.panellist` are reachable and unoccupied. |

Verified baseline in the `web` profile (nothing of ours installed):

```
sidebar buttons: New session · Collapse sidebar · Plugins · Search sessions ·
                 View options · Add workspace · {per-workspace actions} · Settings
→ no custom global panel row, consistent with the `main` seat being free.
```

---

## 4. Installing a plugin into a profile

There are two supported surfaces, and neither is the `plugin_manager` **tool**
(named by the plugin-development skill, but not present in the installed packages
of this build nor in a session's tool list — it appears scoped to a shipped agent
preset inside `app.asar`).

### 4a. CLI — `dsh plugin`

```bash
dsh plugin --profile web add /absolute/path/to/package-dir
```

`--profile <name>` is **required** (without it: `error: required option '--profile
<name>' not specified`). This is the CLI counterpart of `install_bundle`.

### 4b. GUI — the Plugins page

The `web` profile ships `@deepseek-ai/dsh-client-ui-plugin-manager` and
`@deepseek-ai/dsh-client-ui-settings-plugins` (both confirmed present in
`__DSH_BOOT__.entries`, and the host side `plugin-inventory` is enabled at
`dsh-web-app/cordis.patch.yml:98`). So the GUI can list, install, and remove
plugins without the agent tool. The sidebar's **Plugins** button is the entry
point.

**Activation semantics** (from the plugin-development reference): a **new** bundle
can activate through HMR, but **replacing** an installed package needs a restart
to load a fresh module generation. Read the install result's `application` and
`warnings` fields — not server logs, terminal output, or the page's boot payload —
to decide whether a change is live.

---

## 5. Boundaries — what this harness does **not** prove

Be precise about this, it is easy to overclaim:

- It proves the UI in the **`web` profile**. It does **not** install anything into
  the `desktop` profile the user is actually running. That is a feature (you
  cannot break their session), and a limitation (you have not verified their
  profile).
- It does **not** by itself prove that a **third-party** bundle is accepted into
  the root-scoped `main` keyed slot at activation. Only an actual install does
  that. Everything else about the client half can be asserted in Node against a
  React shim and a fake `ctx.slots`.
- It does **not** give you `ctx.agents`, `ctx.storage`, or `ctx.subprocess` —
  those are host-plane. Host verification is a Node test against a fake `ctx`, or
  an install plus real use.

---

## 6. Quick reference

```bash
# 1. serve (background job)
dsh --profile web --port 0 --no-open --host 127.0.0.1
# 2. wait for: dsh web: http://127.0.0.1:<port>/?token=<token>
# 3. new_page(url: that URL)
# 4. () => ({ title: document.title, boot: Object.keys(window.__DSH_BOOT__ || {}) })
# 5. () => window.__DSH_BOOT__.entries.map(e => e.id)   # is my plugin's client half here?
# 6. install: dsh plugin --profile web add /abs/path/to/package
# 7. kill the background job
```

**Related reading:** [docs/dsh-plugin-contract.md](dsh-plugin-contract.md) §A1.4
(install and observe), §A2.1–A2.4 (the slots and the client module format), §A8
(development loop), §A10 (the items still open).
