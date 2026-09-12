---
name: cdp
description: Drive Chrome via the DevTools Protocol from JavaScript. Run JS snippets through the `browser-harness-js` CLI — it auto-spawns a long-lived bun HTTP server holding a fully-typed CDP `Session`, and every call executes against the same persistent browser connection. Attached CDP sessions and globals can survive across calls; target-scoped work uses an explicit sessionId so concurrent callers cannot change each other's routing. Use when the user wants to automate, script, or inspect a Chrome browser via CDP — single tab or multi-tab, attach to existing Chrome or to a new one launched with --remote-debugging-port.
---

# CDP — `browser-harness-js` skill

Custom codegen'd CDP SDK (every method from browser_protocol.json + js_protocol.json gets a typed wrapper) plus a tiny HTTP server that holds one persistent CDP `Session`. The `browser-harness-js` CLI auto-starts the server on first use and forwards JS snippets to it.

The SDK lives in the skill's `sdk/` directory. In the rest of this doc, `<skill-dir>` refers to wherever `npx skills add` installed the skill (Claude Code: `~/.claude/skills/cdp`; Cursor: `~/.cursor/skills/cdp`; other agents vary). The CLI should be on PATH as `browser-harness-js`.

## Setup (once, first use)

`npx skills add` drops the skill into your agent's skills directory but does NOT put the CLI on PATH. Before the first call, verify it's reachable and symlink it into any directory on your PATH if not:

```bash
# macOS (Apple Silicon + Homebrew)
command -v browser-harness-js >/dev/null || ln -sf <skill-dir>/sdk/browser-harness-js /opt/homebrew/bin/browser-harness-js

# macOS (Intel) / most Linux — may need sudo
command -v browser-harness-js >/dev/null || ln -sf <skill-dir>/sdk/browser-harness-js /usr/local/bin/browser-harness-js

# Linux without sudo (ensure ~/.local/bin is on PATH)
command -v browser-harness-js >/dev/null || { mkdir -p ~/.local/bin && ln -sf <skill-dir>/sdk/browser-harness-js ~/.local/bin/browser-harness-js; }
```

The CLI auto-installs `bun` on first run if it's missing (the server is Bun-native). Set `BROWSER_HARNESS_SKIP_BUN_INSTALL=1` to opt out.

## How to use

Just run `browser-harness-js '<JS>'`. The first call spawns the server in the background; subsequent calls hit the same process and reuse the same browser WebSocket and any globals you set. Treat the REPL as shared: for work scoped to a page/iframe target, attach once, keep the returned sessionId, and pass `--session <id>` on every later target-scoped call.

```bash
browser-harness-js 'await session.connect()'
browser-harness-js 'await session.attach((await listPageTargets())[0].targetId)'  # prints <sessionId>
browser-harness-js --session '<sessionId>' 'await session.Page.navigate({url:"https://example.com"})'
browser-harness-js --session '<sessionId>' '(await session.Runtime.evaluate({expression:"document.title",returnByValue:true})).result.value'
```

Output is the **raw result content** — no `{ok,result}` envelope.

| Result type | stdout |
|---|---|
| string                       | bare text, no JSON quotes (e.g. `Example Domain`) |
| number / boolean             | `42`, `true` |
| object / array (non-empty)   | compact JSON (e.g. `{"frameId":"..."}`, `[1,2,3]`) |
| `undefined` / `null` / `""` / `{}` / `[]` | empty (no output) |

**Errors** go to **stderr**, exit code `1`. The CDP error message and JS stack are printed verbatim, e.g.:
```
Error: CDP -32602: invalid params
    at _call (.../session.ts:117:33)
    ...
```
Detect failure with `if browser-harness-js '...'; then ...; else handle_error; fi` or by checking `$?`.

**Multi-line snippets via stdin (heredoc).** Important: a multi-statement snippet does NOT auto-return the last expression — write `return X` explicitly. Single-expression snippets passed as the first argument DO auto-return.

```bash
browser-harness-js <<'EOF'
const tabs = await listPageTargets();
return tabs.map(t => ({ targetId: t.targetId, title: t.title, url: t.url }));
EOF
```

## CLI commands

| Command | Behavior |
|---|---|
| `browser-harness-js '<js>'`     | Auto-start server if needed, eval the JS, print result. |
| `browser-harness-js --session <id> '<js>'` | Eval with all target-scoped CDP calls/events pinned to that existing sessionId. |
| `browser-harness-js <<EOF…EOF`  | Same, code from stdin. |
| `browser-harness-js --status`   | Print health JSON (uptime, connected, sessionId) or exit 1 if down. |
| `browser-harness-js --start`    | Explicit start (no-op if already running). |
| `browser-harness-js --stop`     | Graceful shutdown. Drops session state. |
| `browser-harness-js --restart`  | Stop + start fresh. |
| `browser-harness-js --logs`     | `tail -f` the server log (`/tmp/browser-harness-js.log`). |

Env vars: `CDP_REPL_PORT` (default `9876`), `CDP_REPL_LOG` (default `/tmp/browser-harness-js.log`).

## API surface inside snippets

These globals are pre-loaded — no imports needed:

- `session` — the CDP session view for the current request. Without `--session`, it is the browser-level root `Session`; with `--session <id>`, target-scoped domains are pinned to that attached sessionId. It exposes every CDP domain: `session.Page`, `session.DOM`, `session.Runtime`, `session.Network`, … 56 domains, 652 methods total.
- `listPageTargets()` — list real page targets via CDP's `Target.getTargets` (works on Chrome 144+ too), with `chrome://` and `devtools://` URLs filtered out. No args — uses the connected session.
- `detectBrowsers()` — scan OS-specific profile dirs for running Chromium-based browsers with remote debugging on. Returns `[{name, profileDir, port, wsPath, wsUrl, mtimeMs}]`, sorted by most recently launched.
- `resolveWsUrl(opts)` — resolve a WS URL from `{wsUrl}` | `{port, host?}` | `{profileDir}`. For the no-args auto-detect flow, call `session.connect()` directly instead.
- `CDP` — the generated namespaces (`CDP.Page`, `CDP.Runtime`, …) for type-name reference.

### Calling a CDP method

Every method takes a single object argument matching the CDP wire params; it resolves to the typed return value (no `result` envelope, no `id` correlation — handled for you).

For target-scoped domains (Page/DOM/Runtime/Network/Input/etc.), run the snippet with `browser-harness-js --session <id> ...`. `Browser.*`, `Target.*`, and `Extensions.*` stay on the browser endpoint.

```js
// no params
await session.DOM.enable()

// required params
await session.Page.navigate({ url: 'https://example.com' })

// all-optional params (object also optional)
await session.Page.captureScreenshot()
await session.Page.captureScreenshot({ format: 'png', quality: 80 })

// returns are stripped to the typed shape
const { root } = await session.DOM.getDocument()
const { nodeId } = await session.DOM.querySelector({ nodeId: root.nodeId, selector: 'h1' })
```

### Connecting

**Default: just call `session.connect()` with no args.** It auto-detects running Chromium-based browsers (Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Comet, Canary) by scanning OS-specific profile dirs for a `DevToolsActivePort` file, ordered by most-recently-launched, and picks the first one whose WebSocket accepts. OS-agnostic — works on macOS, Linux, Windows.

```js
await session.connect()   // auto-detect
```

Use `detectBrowsers()` first if you want to see what's available (or let the user pick) before connecting:

```js
const found = await detectBrowsers()
// [{ name: 'Google Chrome', profileDir, port, wsPath, wsUrl, mtimeMs }, ...]
```

**Explicit forms** — use these only when auto-detect picks the wrong browser, or when you already know where to connect:

| Form | When to use |
|---|---|
| `{ profileDir }` | Target a specific browser when several are running. Reads `<profileDir>/DevToolsActivePort` directly. |
| `{ wsUrl }` | You already have `ws://…/devtools/browser/<uuid>` (e.g. piped from elsewhere). |

```js
await session.connect({ profileDir: '/Users/<you>/Library/Application Support/Google/Chrome' })
await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/<uuid>' })
```

Profile paths by OS — use these with `{ profileDir }`:
- macOS: `~/Library/Application Support/<Browser>` (e.g. `Google/Chrome`, `Comet`, `BraveSoftware/Brave-Browser`, `Arc/User Data`)
- Linux: `~/.config/<browser>` (e.g. `google-chrome`, `chromium`, `BraveSoftware/Brave-Browser`)
- Windows: `%LOCALAPPDATA%\<Browser>\User Data` (e.g. `Google\Chrome`, `Microsoft\Edge`, `BraveSoftware\Brave-Browser`)

Per-candidate WS-open timeout defaults to **5s** — live browsers answer with open/close within ~100ms, so 5s is already generous. The only case where 5s is too short is when Chrome is showing the **Allow** popup and waiting on the user to click. If you expect that, pass `timeoutMs: 30000`:

```js
await session.connect({ profileDir: '/Users/<you>/Library/Application Support/Google/Chrome', timeoutMs: 30_000 })
```

**If you see `No detected browser accepted a connection`** — the browsers have `DevToolsActivePort` files but none are currently serving WS. Most common cause: remote-debugging is enabled but the user hasn't clicked **Allow** on the prompt yet. Tell them to click Allow, then retry (or bump `timeoutMs`).

### Picking a target (tab)

Treat the REPL as shared. After `connect()`, attach the target once, keep the returned sessionId in the agent/task context, and pass it explicitly on every later target-scoped CLI call. Do not rely on a shared "current target".

```bash
browser-harness-js 'await session.attach((await listPageTargets())[0].targetId)'  # prints <sessionId>
browser-harness-js --session '<sessionId>' 'await session.Page.enable()'
browser-harness-js --session '<sessionId>' '(await session.Runtime.evaluate({expression:"document.title",returnByValue:true})).result.value'
```

The same attached sessionId can be reused across many CLI calls, including long-lived domain state and event subscriptions/waits. When `--session <id>` is used, `session.onEvent(...)` and `session.waitFor(...)` are automatically filtered to that session.

`listPageTargets()` uses CDP's `Target.getTargets` (not `/json`), so it works on Chrome 144+ too. It already filters out `chrome://` and `devtools://` URLs. Equivalent raw call:

```js
const { targetInfos } = await session.Target.getTargets({})
const tabs = targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://'))
```

To work with another target, attach it and keep its own sessionId; there is no global "switch tab" step. To detach an attachment explicitly, call `session.Target.detachFromTarget({ sessionId: '<sessionId>' })`.

### Events

Run target-scoped event work with `--session <id>` so listeners and waits are filtered to that attached session.

```js
// Subscribe (returns an unsubscribe fn)
const off = session.onEvent((method, params, sessionId) => { ... })

// Or wait for a single matching event with optional predicate + timeout
await session.Network.enable()
const ev = await session.waitFor(
  'Page.frameNavigated',
  (p) => p.frame.url.includes('example.com'),
  10_000
)
```

### Persisting state across calls

Each snippet runs inside its own async wrapper, so its `let`/`const` declarations vanish when it returns. To carry data forward, attach to `globalThis`:

```bash
browser-harness-js 'globalThis.note = "inspection started"'
browser-harness-js 'globalThis.note'
```

The browser connection, attached CDP sessions, and event subscribers are preserved by the server. Keep routing sessionIds in the agent/task context and pass them with `--session`; use globals only for ad-hoc shared data that is intentionally safe to share.

## Connecting to a running Chrome (chrome://inspect flow)

When attaching to the user's already-running browser:

1. **Try `await session.connect()` first** (no args) — auto-detect handles every Chromium-based browser via `DevToolsActivePort`. If it returns, you're done.
2. **If auto-detect fails** with `No running browser with remote debugging detected`, the user needs to turn it on. Open the inspect page:
   ```bash
   # macOS — prefer AppleScript over `open -a` (reuses current profile, avoids the profile picker)
   osascript -e 'open location "chrome://inspect/#remote-debugging"'

   # Linux
   google-chrome 'chrome://inspect/#remote-debugging'     # or: chromium, google-chrome-stable

   # Windows (PowerShell)
   Start-Process chrome 'chrome://inspect/#remote-debugging'
   ```
   Only macOS's AppleScript path avoids the profile picker; Linux/Windows may prompt the user to pick a profile first.
3. **Tick "Discover network targets"** in chrome://inspect, then click **Allow** when Chrome prompts.
4. **If auto-detect picks the wrong browser** (multiple running, you want a specific one): list them with `await detectBrowsers()`, then `await session.connect({ profileDir: <the one you want> })`.
5. **If `session.connect()` returns `No detected browser accepted a connection`**, the user has remote-debugging on but hasn't clicked **Allow** yet. Tell them to click it and retry, or pass `timeoutMs: 30000` to wait for the click.

## Working with targets (tabs)

- **Filter Chrome internals.** `listPageTargets()` already drops `chrome://` and `devtools://` URLs. If you call `Target.getTargets()` directly, filter manually.
- **CDP target order ≠ visible tab-strip order.** When the user says "the first tab I can see", use a screenshot or page title to identify it — `Target.activateTarget` only switches to a known targetId.

## Looking up a method

The full typed surface is in `<skill-dir>/sdk/generated.ts` (~655 KB, only loaded if you read it). Each method has its CDP description as a JSDoc comment plus typed `*Params` / `*Return` interfaces in per-domain namespaces.

```bash
grep -n "navigate" <skill-dir>/sdk/generated.ts | head
```

## Regenerating the SDK

When the upstream protocol JSONs change, replace `sdk/browser_protocol.json` and/or `sdk/js_protocol.json` and re-run:

```bash
cd <skill-dir>/sdk && bun gen.ts
browser-harness-js --restart   # pick up the new bindings
```

## Files

All paths are relative to `<skill-dir>` (the install path — see top of this doc).

- `/usr/local/bin/browser-harness-js` → `<skill-dir>/sdk/browser-harness-js` (the CLI)
- `sdk/repl.ts` — HTTP server (`Bun.serve` on `127.0.0.1:9876`)
- `sdk/session.ts` — `Session` class (transport, connect, target routing, events)
- `sdk/generated.ts` — codegen output: every CDP method as a typed wrapper
- `sdk/gen.ts` — codegen script
- `sdk/{browser,js}_protocol.json` — upstream protocol (vendored)
