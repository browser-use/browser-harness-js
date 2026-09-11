/**
 * CDP REPL — HTTP server holding one persistent CDP Session.
 *
 * Endpoints (bind 127.0.0.1:9876 by default; override with $CDP_REPL_PORT):
 *   POST /eval     body = raw JS to evaluate (NOT JSON-wrapped).
 *                  Top-level await supported. Single expression auto-returns.
 *                  Response: {"ok":true,"result":<json>} | {"ok":false,"error":..,"stack"?:..}
 *   GET  /health   {"ok":true,"uptime":<seconds>,"connected":<bool>,"sessionId":<string|null>}
 *   POST /quit     graceful shutdown. Returns {"ok":true} then exits.
 *
 * State: `session`, the active sessionId, event subscribers, and any
 * `globalThis.<name>` you set persist across requests for the lifetime of
 * the process.
 */

import { Session, listPageTargets, resolveWsUrl, detectBrowsers } from './session.ts';
import { runSnippet } from './snippet.ts';
import * as Generated from './generated.ts';

const session = new Session();
(globalThis as any).session = session;
// Bind helpers to the singleton session so the agent calls `listPageTargets()`
// with no args (no host/port confusion, no /json endpoint assumption).
(globalThis as any).listPageTargets = () => listPageTargets(session);
(globalThis as any).resolveWsUrl = resolveWsUrl;
(globalThis as any).detectBrowsers = detectBrowsers;
(globalThis as any).CDP = Generated;

const PORT = Number(process.env.CDP_REPL_PORT ?? 9876);
const startedAt = Date.now();

function serialize(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' } as const;

/**
 * Render a value to the body of a successful /eval response.
 * - undefined / null / "" / {} / []  → empty (caller prints nothing)
 * - string → raw (no JSON quotes)
 * - everything else → JSON
 */
function renderResult(v: unknown): string {
  const s = serialize(v);
  if (s === undefined || s === null) return '';
  if (typeof s === 'string') return s;
  if (Array.isArray(s) && s.length === 0) return '';
  if (typeof s === 'object' && s !== null && Object.keys(s as object).length === 0) return '';
  return JSON.stringify(s);
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        connected: session.isConnected(),
        sessionId: session.getActiveSession() ?? null,
        // CLI 在 --session 模式下用这个能力位确认后台确实理解请求级 session 路由。
        // 这样升级 CLI 但旧 REPL 仍驻留内存时，会 fail closed，而不是静默退化成不安全路由。
        capabilities: { explicitSessionRouting: true },
      });
    }

    if (req.method === 'POST' && url.pathname === '/eval') {
      const code = await req.text();
      if (!code.trim()) {
        return new Response('empty body\n', { status: 400, headers: TEXT });
      }
      try {
        // CLI 用 header 显式声明“本次请求属于哪个长期 CDP session”。
        // 不带 header 时继续走旧的 shared activeSessionId，保持上游兼容。
        const requestedSessionId = req.headers.get('x-browser-harness-session-id')?.trim();
        const evalSession = requestedSessionId ? session.withSession(requestedSessionId) : session;
        const result = await runSnippet(code, evalSession);
        const body = renderResult(result);
        return new Response(body, { status: 200, headers: TEXT });
      } catch (e: any) {
        const msg = (e?.stack ?? e?.message ?? String(e)) + '\n';
        return new Response(msg, { status: 500, headers: TEXT });
      }
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      // Delay shutdown so the response flushes over the wire first.
      setTimeout(() => { server.stop(true); session.close(); process.exit(0); }, 50);
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(JSON.stringify({
  ok: true,
  ready: true,
  port: server.port,
  message: `CDP REPL listening on http://127.0.0.1:${server.port}`,
}));
