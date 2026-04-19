<img src="https://r2.browser-use.com/github/ajsdlasnnalsgasld.png" alt="Browser Harness" width="100%" />

# Browser Harness JS ♞

The thinnest possible bridge from the LLM to Chrome. **No harness, no recipes, no rails** — just every CDP method as a typed JS call.

One persistent WebSocket, 56 domains, 652 typed wrappers, zero wrapping of what Chrome already does.

```
  ● agent: wants to click a button
  │
  ● no click() helper, no upload_file(), no goto()
  │
  ● agent writes the CDP call itself        await session.Input.dispatchMouseEvent({...})
  │                                          await session.DOM.setFileInputFiles({...})
  ✓ done — same pattern for all 652 methods
```

**The protocol is the API.** If Chrome can do it, you can call it.

## Installation

```bash
npx skills add https://github.com/browser-use/browser-harness-ts --skill cdp
```

## Usage

```text
Use the `cdp` skill to drive my browser.

Read `SKILL.md` first — it shows how to connect to my running Chrome, list tabs, and call any CDP method. There are no pre-baked click/goto/upload helpers; you call typed CDP methods directly (`session.Page.navigate`, `session.Input.dispatchMouseEvent`, `session.DOM.setFileInputFiles`, …). If you hit a non-obvious mechanic (dialogs, iframes, dropdowns, shadow DOM), check `interaction-skills/` for the CDP recipe before inventing one.
```

If Chrome asks you to tick a remote-debugging checkbox, do it — that's how the agent attaches:

<img src="docs/setup-remote-debugging.png" alt="Remote debugging setup" width="520" style="border-radius: 12px;" />

### Try this first

> Look at all the tabs I have open, group them by topic, and tell me what I'm working on today. Screenshot the most interesting one and describe what's on screen.

A clean demo of the whole thing — `listPageTargets()` to survey the window, `session.use(...)` to hop between tabs, `session.Page.captureScreenshot()` for the visual. One prompt, no recipes, pure CDP.

See [interaction-skills/](interaction-skills/) for recipes on the mechanics that are not obvious from the CDP method list alone.

## Files

- `SKILL.md` — day-to-day usage; how to connect, pick a tab, call methods, persist state
- `sdk/browser-harness-js` — tiny CLI that auto-spawns the server and forwards snippets
- `sdk/repl.ts` — Bun HTTP server holding one persistent `Session`
- `sdk/session.ts` — the `Session` class: transport, connect, target routing, events
- `sdk/gen.ts` — codegen: reads `browser_protocol.json` + `js_protocol.json` → typed wrappers
- `sdk/generated.ts` — every CDP method as `session.<Domain>.<method>(params)` (generated)

No helpers file. No `click()`, no `goto()`, no `upload_file()` — just the protocol, typed.

## Why no pre-baked helpers?

Every helper is a lie about what CDP already gives you. `click(x, y)` hides `Input.dispatchMouseEvent` — which has 14 parameters the LLM might need (button, clickCount, modifiers, pointerType, force, tangentialPressure, …). A harness that exposes three of them quietly limits what the agent can do.

- Types are the docs. `session.Page.navigate(` triggers autocomplete with the exact params — same JSDoc as the CDP reference.
- No version drift. The SDK is regenerated from the upstream protocol JSON; new Chrome methods appear as soon as you swap the JSON.
- No "helper doesn't handle my case" detours. If CDP can do it, the agent can call it — directly, typed, today.

The only "helpers" you'll find are things CDP itself is missing:
- `listPageTargets()` — filters `chrome://` / `devtools://` out of `Target.getTargets`
- `resolveWsUrl({wsUrl|port|profileDir})` — reads `DevToolsActivePort` for Chrome 144+
- `session.use(targetId)` / `session.waitFor(method, pred, timeout)` — the two routing primitives you genuinely need

## Contributing

PRs welcome. The best way to help: **contribute a new interaction skill** under [interaction-skills/](interaction-skills/) when you figure out the CDP recipe for something non-obvious (a dropdown framework, a shadow-DOM trap, a network-wait pattern).

- Keep recipes in **pure CDP** — `session.Domain.method(...)`, not wrapped helpers.
- Lead with the shortest method call that works; add the workaround or trap afterwards.
- Small and focused beats comprehensive. One mechanic per file.
- Bug fixes, codegen improvements, and `session.ts` refinements are equally welcome.

---

[Bitter lesson](https://browser-use.com/posts/bitter-lesson-agent-frameworks) · [Skills](https://browser-use.com/posts/web-agents-that-actually-learn)
