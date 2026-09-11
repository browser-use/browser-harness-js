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

import { Session, type ScopedSession, listPageTargets, resolveWsUrl, detectBrowsers } from './session.ts';
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

function isExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;\n]/.test(trimmed)) return false;
  if (/^(let|const|var|if|for|while|do|switch|class|function|throw|try|return|import|export)\b/.test(trimmed)) return false;
  return true;
}

function serialize(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}

/**
 * 在一次 /eval 请求中执行代码。
 *
 * 关键点：`evalSession` 是“本次请求自己的 session 视图”。如果 CLI 带了
 * `--session <id>`，这里收到的是固定绑定到该 id 的 ScopedSession；否则仍然
 * 使用旧的根 Session。这样并发请求不会通过共享 activeSessionId 互相改路由。
 */
async function runSnippet(code: string, evalSession: Session | ScopedSession): Promise<unknown> {
  const body = isExpression(code) ? `return (${code});` : code;

  // 用函数参数提供局部 `session`，避免为了某个请求去改 globalThis.session。
  // 其余 helper 仍然挂在 globalThis 上，因此现有 snippet 的写法保持不变。
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction('session', body);
  return await fn(evalSession);
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
