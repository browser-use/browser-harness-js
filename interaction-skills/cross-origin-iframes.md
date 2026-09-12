# Cross-Origin Iframes (OOPIFs)

Cross-origin iframes (stripe.com checkout, recaptcha, Salesforce Lightning, Azure blades) run in **out-of-process iframes (OOPIFs)** with their own CDP target. You cannot reach them via `contentDocument` from the parent.

## First try: coordinate clicks

Compositor-level input passes through OOPIFs transparently. If the thing you want is a button you can see in a screenshot, try this first — it's simpler and does not require a separate iframe attachment. Run the input commands on the parent page's explicit sessionId:

```js
// Click a "Pay" button inside a Stripe iframe by page coordinates
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
```

Coordinate-based typing also works if you click first, then `Input.insertText`/`Input.dispatchKeyEvent`.

## When you need DOM inside the OOPIF

Find the iframe target, attach it, and keep its own sessionId. The parent page session stays attached independently:

```js
const { targetInfos } = await session.Target.getTargets({})
const iframe = targetInfos.find(t => t.type === 'iframe' && t.url.includes('stripe.com'))

// Attach without changing any shared "current target".
const iframeSessionId = await session.attach(iframe.targetId)
return iframeSessionId
```

Then run iframe-scoped commands with that sessionId:

```bash
browser-harness-js --session '<iframeSessionId>' 'await session.Runtime.enable()'
browser-harness-js --session '<iframeSessionId>' '(await session.Runtime.evaluate({expression:"document.querySelector(\"[name=cardnumber]\").value",returnByValue:true})).result.value'
```

Use the parent page's sessionId for parent-scoped work and the iframe sessionId for iframe-scoped work. Both can remain attached at the same time. `Target.*` and `Browser.*` still hit the browser endpoint.

## Which target is which?

`Target.getTargets` returns **all** OOPIFs in the page, flat. If multiple iframes share an origin (e.g. multiple Stripe Elements), you need more than URL to disambiguate:

- Filter by URL path (`cardNumber` vs `cardExpiry` vs `cvc` in Stripe).
- Enumerate in DOM order from the parent: find all `<iframe>` elements, map their `src` to target URLs.
- Inspect title via `Target.getTargetInfo({ targetId })`.

## Listening to events from an OOPIF

With the iframe's explicit sessionId, `session.onEvent` / `session.waitFor` are filtered to events from that iframe attachment:

```bash
browser-harness-js --session '<iframeSessionId>' 'await session.Network.enable({})'
browser-harness-js --session '<iframeSessionId>' 'await session.waitFor("Network.responseReceived", p => p.response.url.includes("/confirm_payment"), 10_000)'
```

## Traps

- **An OOPIF is not always present until interaction.** Stripe's card iframe is lazy-mounted after you focus the outer input. Screenshot + coordinate-click the outer input first, then re-query `Target.getTargets`.
- **OOPIF targets disappear when the parent navigates.** A cached `iframe.targetId` from before a navigation is dead.
- **CSP / sandbox may block `Runtime.evaluate` side effects** even when you've attached. Read-only calls usually work; writes may silently no-op.
- **Keep parent and iframe sessionIds distinct.** A target-scoped command goes exactly to the sessionId supplied on that CLI call; do not substitute one target's sessionId for another.
