# Connection & Tab Visibility

## Pick the right connect() form

Don't guess — the wrong form wastes 30s on a timeout.

| Chrome was launched… | Use | Why |
|---|---|---|
| Via `chrome://inspect` (Chrome 144+) | `session.connect({profileDir})` | `/json/version` is NOT served — only `DevToolsActivePort` + WS work |
| Via `--remote-debugging-port=<port>` (you spawned it yourself) | `session.connect({port})` | Probes `/json/version`. Fails on Chrome 144+ chrome://inspect |
| You already have `ws://…/devtools/browser/<uuid>` | `session.connect({wsUrl})` | Escape hatch. Always works |

```js
await session.connect({
  profileDir: '/Users/<you>/Library/Application Support/Google/Chrome'
})
```

`{profileDir}` reads `<profileDir>/DevToolsActivePort` (line 1: port, line 2: WS path) and builds the WS URL directly — no HTTP probe, immune to the Chrome 144+ `/json/version` 404.

## The omnibox popup problem

When Chrome opens fresh, the only CDP `type: "page"` targets may be `chrome://inspect` and `chrome://omnibox-popup.top-chrome/` (a 1px invisible viewport). If you attach to the omnibox popup, every subsequent action happens on a tab the user cannot see.

`listPageTargets()` already filters `chrome://` and `devtools://` URLs. If you call `Target.getTargets` directly, filter these manually:

```js
const { targetInfos } = await session.Target.getTargets({})
const realTabs = targetInfos.filter(t =>
  t.type === 'page' &&
  !t.url.startsWith('chrome://') &&
  !t.url.startsWith('devtools://')
)
```

If no real pages exist yet, create one instead of attaching to nothing:

```js
const tabs = await listPageTargets()
let targetId = tabs[0]?.targetId
if (!targetId) {
  ({ targetId } = await session.Target.createTarget({ url: 'about:blank' }))
}
await session.use(targetId)
```

## Startup sequence

1. `await session.connect({profileDir})` — or the right variant for how Chrome was launched.
2. `const tabs = await listPageTargets()` — see what real pages exist.
3. `await session.use(tabs[0].targetId)` — route Page/DOM/Runtime/Network calls to that target.
4. `await session.Target.activateTarget({ targetId: tabs[0].targetId })` — bring the tab visually to front.
5. Enable the domains you need: `await session.Page.enable()`, `await session.Network.enable({})`, etc.

## CDP target order ≠ visible tab-strip order

When the user says "the first tab I can see", do NOT trust the order of `Target.getTargets`. Use:

- A screenshot (`session.Page.captureScreenshot()`) to identify visually.
- Page title / URL heuristics.
- Or platform UI automation (macOS: AppleScript; Linux: `xdotool`/`wmctrl`).

`Target.activateTarget` only switches to a targetId you already know — it cannot resolve "leftmost tab".

## First connect may block on Chrome's Allow dialog

If `session.connect()` hangs, tell the user to click **Allow** in Chrome. The connect flow polls for up to 30s.

## Bringing Chrome to front (macOS)

```bash
osascript -e 'tell application "Google Chrome" to activate'
```

Prefer AppleScript over `open -a` — reuses the current profile, avoids the profile picker.
