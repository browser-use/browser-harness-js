---
name: cdp
description: Drive Chrome via the DevTools Protocol from JavaScript. Run JS snippets through the `browsercode` CLI — it auto-spawns a long-lived bun HTTP server holding a fully-typed CDP `Session`, and every call (`browsercode 'await session.Page.navigate(...)'`) executes against the same persistent connection. Session, active target, and globals survive across calls. Use when the user wants to automate, script, or inspect a Chrome browser via CDP — single tab or multi-tab, attach to existing Chrome or to a new one launched with --remote-debugging-port.
---

# CDP — `browsercode` skill

Custom codegen'd CDP SDK (every method from browser_protocol.json + js_protocol.json gets a typed wrapper) plus a tiny HTTP server that holds one persistent CDP `Session`. The `browsercode` CLI auto-starts the server on first use and forwards JS snippets to it.

The SDK lives at `~/.claude/skills/cdp/sdk/`. The CLI is symlinked at `/usr/local/bin/browsercode`.

## How to use

Just run `browsercode '<JS>'`. The first call spawns the server in the background; subsequent calls hit the same process and so reuse the same `session`, the same WebSocket to Chrome, and any globals you set.

```bash
browsercode 'await session.connect({port:9222})'
browsercode 'await session.Page.navigate({url:"https://example.com"})'
browsercode '(await session.Runtime.evaluate({expression:"document.title",returnByValue:true})).result.value'
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
Detect failure with `if browsercode '...'; then ...; else handle_error; fi` or by checking `$?`.

**Multi-line snippets via stdin (heredoc).** Important: a multi-statement snippet does NOT auto-return the last expression — write `return X` explicitly. Single-expression snippets passed as the first argument DO auto-return.

```bash
browsercode <<'EOF'
const tabs = await listPageTargets("localhost", 9222);
globalThis.tid = tabs[0].targetId;
await session.use(globalThis.tid);
return globalThis.tid;
EOF
```

## CLI commands

| Command | Behavior |
|---|---|
| `browsercode '<js>'`     | Auto-start server if needed, eval the JS, print result. |
| `browsercode <<EOF…EOF`  | Same, code from stdin. |
| `browsercode --status`   | Print health JSON (uptime, connected, sessionId) or exit 1 if down. |
| `browsercode --start`    | Explicit start (no-op if already running). |
| `browsercode --stop`     | Graceful shutdown. Drops session state. |
| `browsercode --restart`  | Stop + start fresh. |
| `browsercode --logs`     | `tail -f` the server log (`/tmp/browsercode.log`). |

Env vars: `CDP_REPL_PORT` (default `9876`), `CDP_REPL_LOG` (default `/tmp/browsercode.log`).

## API surface inside snippets

These globals are pre-loaded — no imports needed:

- `session` — the persistent `Session`. Has every CDP domain mounted: `session.Page`, `session.DOM`, `session.Runtime`, `session.Network`, … 56 domains, 652 methods total.
- `listPageTargets(host, port)` — fetch real page targets from `http://host:port/json`, with `chrome://` and `devtools://` URLs filtered out.
- `resolveWsUrl(opts)` — resolve a WS URL from `{wsUrl}` | `{port, host?}` | `{profileDir}`.
- `CDP` — the generated namespaces (`CDP.Page`, `CDP.Runtime`, …) for type-name reference.

### Calling a CDP method

Every method takes a single object argument matching the CDP wire params; it resolves to the typed return value (no `result` envelope, no `id` correlation — handled for you).

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

Three ways; always do this **before** any domain calls.

```js
// 1. Explicit browser-level WebSocket URL
await session.connect({ wsUrl: 'ws://localhost:9222/devtools/browser/<id>' })

// 2. By port — discovers wsUrl via http://host:port/json/version (Chrome <144 only)
await session.connect({ port: 9222, host: 'localhost' })

// 3. By Chrome profile dir — reads DevToolsActivePort. Required for Chrome 144+.
await session.connect({ profileDir: '/Users/me/Library/Application Support/Google/Chrome' })
```

`port` and `profileDir` modes poll for up to 30s — `DevToolsActivePort` can exist before the port is listening.

### Picking a target (tab)

After `connect()`, call `session.use(targetId)` once; subsequent page-level calls (Page/DOM/Runtime/Network/etc.) auto-route to that target's sessionId. `Browser.*` and `Target.*` calls always hit the browser endpoint.

```js
const tabs = await listPageTargets('localhost', 9222)   // filters chrome:// internals
const sid  = await session.use(tabs[0].targetId)
await session.Page.enable()
await session.Page.navigate({ url: 'https://example.com' })
```

To switch tabs: `session.use(otherTargetId)`. To detach: `session.setActiveSession(undefined)`.

### Events

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
browsercode '(await listPageTargets("localhost",9222)).forEach((t,i)=>globalThis["tab"+i]=t.targetId)'
browsercode 'await session.use(globalThis.tab0)'
browsercode 'await session.Page.navigate({url:"https://example.com"})'
```

`session` itself, the active sessionId, and event subscribers are already preserved by the server — globals are only needed for ad-hoc data.

## Connecting to a running Chrome (chrome://inspect flow)

When attaching to the user's already-running Chrome instead of spawning fresh Chromium:

1. **Try to attach before asking the user to set anything up.** If `browsercode 'await session.connect({port:9222})'` works, skip the rest.
2. **Opening the inspect page (macOS):** prefer AppleScript over `open -a` — it reuses the current profile and avoids the profile picker:
   ```bash
   osascript -e 'open location "chrome://inspect/#remote-debugging"'
   ```
3. **Profile picker.** Chrome may open the profile picker before any real tab exists. Tell the user to choose their normal profile first, then tick the checkbox and click **Allow** if shown.
4. **First connect may block on the Allow dialog.** If `connect` hangs, tell the user to click **Allow** in Chrome — `connect()` polls for up to 30 seconds.
5. **Chrome 144+ does NOT serve `/json/version` from chrome://inspect.** Use `connect({profileDir: '...'})` to read the port from `DevToolsActivePort` instead.
6. **`DevToolsActivePort` can exist before the port is listening.** Already handled — `connect()` polls for 30s.

## Working with targets (tabs)

- **Filter Chrome internals.** `listPageTargets()` already drops `chrome://` and `devtools://` URLs. If you call `Target.getTargets()` directly, filter manually.
- **CDP target order ≠ visible tab-strip order.** When the user says "the first tab I can see", use a screenshot or page title to identify it — `Target.activateTarget` only switches to a known targetId.

## Looking up a method

The full typed surface is in `~/.claude/skills/cdp/sdk/generated.ts` (~655 KB, only loaded if you read it). Each method has its CDP description as a JSDoc comment plus typed `*Params` / `*Return` interfaces in per-domain namespaces.

```bash
grep -n "navigate" ~/.claude/skills/cdp/sdk/generated.ts | head
```

## Regenerating the SDK

When the upstream protocol JSONs change, replace `sdk/browser_protocol.json` and/or `sdk/js_protocol.json` and re-run:

```bash
cd ~/.claude/skills/cdp/sdk && bun gen.ts
browsercode --restart   # pick up the new bindings
```

## Files

- `/usr/local/bin/browsercode` → `~/.claude/skills/cdp/sdk/browsercode` (the CLI)
- `~/.claude/skills/cdp/sdk/repl.ts` — HTTP server (`Bun.serve` on `127.0.0.1:9876`)
- `~/.claude/skills/cdp/sdk/session.ts` — `Session` class (transport, connect, target routing, events)
- `~/.claude/skills/cdp/sdk/generated.ts` — codegen output: every CDP method as a typed wrapper
- `~/.claude/skills/cdp/sdk/gen.ts` — codegen script
- `~/.claude/skills/cdp/sdk/{browser,js}_protocol.json` — upstream protocol (vendored)
