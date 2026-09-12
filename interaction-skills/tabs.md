# Tabs

Use **CDP for control** (attach, activate known targets, inspect). Use **UI automation for visible order**.

## Pure CDP

```js
// List page targets (filtered; chrome:// / devtools:// dropped)
const tabs = await listPageTargets()

// Create a new tab, then attach it. Keep the returned sessionId.
const { targetId } = await session.Target.createTarget({ url: 'https://example.com' })
const sessionId = await session.attach(targetId)

// To work with another existing tab, attach it separately and keep its own sessionId.
const otherSessionId = await session.attach(otherTargetId)

// Show this tab visibly in Chrome. This is independent from CDP session routing.
await session.Target.activateTarget({ targetId })

// Close a tab
await session.Target.closeTarget({ targetId })

// Inspect a known target directly.
const { targetInfo } = await session.Target.getTargetInfo({ targetId })
```

For target-scoped work, use the corresponding sessionId on every CLI call: `browser-harness-js --session <sessionId> ...`. Multiple target sessions can remain attached at the same time; there is no global "switch tab" routing step.

**Explicit CDP session routing and `Target.activateTarget` are independent.** The former chooses where protocol commands go; the latter changes Chrome-side visible focus. If the user expects Chrome to visibly change, call `activateTarget` too.

## Two things `Target.createTarget` quietly gets wrong

1. **Race: `{ url }` in `createTarget` can resolve before navigation starts.** If you then poll `document.readyState`, you'll see `'complete'` for about:blank and move on. Safer:
   ```js
   const { targetId } = await session.Target.createTarget({ url: 'about:blank' })
   const sessionId = await session.attach(targetId)
   ```
   Then run `Page.enable`, `Page.navigate`, and the `Page.loadEventFired` wait with `browser-harness-js --session <sessionId> ...`.

2. **New tab may open behind the active one.** Add `Target.activateTarget` if the user needs to see it.

## Visible tab-strip order (platform UI)

CDP's `Target.getTargets` returns an arbitrary order — not left-to-right.

### macOS

```applescript
tell application "Google Chrome"
  set out to {}
  set i to 1
  repeat with t in every tab of front window
    set end of out to {tab_index:i, tab_title:(title of t), tab_url:(URL of t)}
    set i to i + 1
  end repeat
  return out
end tell
```

```applescript
tell application "Google Chrome"
  set active tab index of front window to 2
  activate
end tell
```

### Linux

No AppleScript. Use `xdotool`, `wmctrl`, or desktop-environment scripting. The split is the same — CDP for attach/activate-by-id, window manager for visible ordering.

## Traps

- `listPageTargets()` already drops `chrome://` and `devtools://`. If you call `Target.getTargets` raw, you must filter yourself, or you'll attach to a 1px omnibox popup.
- If a page reports `innerWidth=0 innerHeight=0`, you're probably attached to a non-window surface (omnibox popup, background tab that never rendered).
