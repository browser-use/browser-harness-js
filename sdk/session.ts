/**
 * CDP Session: one persistent WebSocket to Chrome's browser endpoint.
 * Auto-injects sessionId for the active target on every call.
 *
 * Connect with `flatten: true` so all sessions share one WS (no nested
 * Target.sendMessageToTarget envelopes).
 */

import { bindDomains, type Domains, type Transport } from './generated.ts';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

export type ConnectOptions = {
  /** Full WS URL: ws://host:port/devtools/browser/<id> */
  wsUrl?: string;
  /** Or: read DevToolsActivePort from this Chrome profile dir */
  profileDir?: string;
  /** Or: probe http://host:port/json/version (Chrome <144 only) */
  port?: number;
  host?: string;
};

export class Session implements Transport {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeSessionId: string | undefined;
  private eventListeners: Array<(method: string, params: unknown, sessionId?: string) => void> = [];

  // Generated bindings — one per CDP domain.
  // Initialized lazily after construction so `_call` is available.
  domains!: Domains;

  constructor() {
    this.domains = bindDomains(this);
    // Mirror domains onto `this` so calls read as `session.Page.navigate(...)`.
    for (const k of Object.keys(this.domains) as (keyof Domains)[]) {
      (this as any)[k] = this.domains[k];
    }
  }

  /** Connect to Chrome's browser-level WebSocket. */
  async connect(opts: ConnectOptions = {}): Promise<void> {
    const wsUrl = await resolveWsUrl(opts);
    await new Promise<void>((res, rej) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', (e) => rej(e));
      ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
      ws.addEventListener('close', () => {
        // Reject anything still pending so callers don't hang forever.
        for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
      this.ws = ws;
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws?.close();
  }

  /**
   * Pick a target and make subsequent calls auto-route to it.
   * Uses Target.attachToTarget with flatten:true (single-WS, sessionId-on-message).
   */
  async use(targetId: string): Promise<string> {
    const r = await this._call('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    this.activeSessionId = r.sessionId;
    return r.sessionId;
  }

  /** Set the active sessionId directly (e.g. one you already attached). */
  setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
  }

  getActiveSession(): string | undefined {
    return this.activeSessionId;
  }

  /** Subscribe to all CDP events. Returns an unsubscribe fn. */
  onEvent(fn: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.eventListeners.push(fn);
    return () => {
      this.eventListeners = this.eventListeners.filter(x => x !== fn);
    };
  }

  /** Wait for the next event matching `method` (and optional predicate). */
  waitFor<T = unknown>(method: string, predicate?: (params: T) => boolean, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      const unsub = this.onEvent((m, params) => {
        if (m !== method) return;
        if (predicate && !predicate(params as T)) return;
        clearTimeout(timer);
        unsub();
        resolve(params as T);
      });
    });
  }

  // Transport implementation. Called by the generated domain bindings.
  _call(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected. Call session.connect(...) first.'));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params: params ?? {} };
    if (this.activeSessionId && !isBrowserLevel(method)) {
      msg.sessionId = this.activeSessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new CdpError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const fn of this.eventListeners) {
        try { fn(m.method, m.params, m.sessionId); } catch { /* ignore */ }
      }
    }
  }
}

export class CdpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(`CDP ${code}: ${message}`);
    this.name = 'CdpError';
  }
}

/** Browser-level methods never take a sessionId. */
function isBrowserLevel(method: string): boolean {
  return method.startsWith('Browser.') || method.startsWith('Target.');
}

/** Resolve a WS URL from a variety of input shapes. */
export async function resolveWsUrl(opts: ConnectOptions): Promise<string> {
  if (opts.wsUrl) return opts.wsUrl;

  if (opts.profileDir) {
    const port = await readDevToolsActivePort(opts.profileDir);
    return await fetchBrowserWsUrl(opts.host ?? 'localhost', port);
  }

  if (opts.port) {
    return await fetchBrowserWsUrl(opts.host ?? 'localhost', opts.port);
  }

  throw new Error('connect() needs one of: { wsUrl } | { profileDir } | { port }');
}

async function readDevToolsActivePort(profileDir: string): Promise<number> {
  const f = Bun.file(`${profileDir}/DevToolsActivePort`);
  const text = (await f.text()).trim();
  // First line is the port, second is the path under /devtools/browser/<id>.
  const port = Number(text.split('\n')[0]);
  if (!Number.isFinite(port)) throw new Error(`Bad DevToolsActivePort: ${text}`);
  return port;
}

async function fetchBrowserWsUrl(host: string, port: number): Promise<string> {
  // Poll up to 30s — DevToolsActivePort can exist before the port is listening.
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${host}:${port}/json/version`);
      if (r.ok) {
        const j = await r.json() as { webSocketDebuggerUrl: string };
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Could not reach ${host}:${port}/json/version after 30s: ${lastErr}`);
}

/** List page targets. Filters out chrome:// internals (omnibox-popup, etc.). */
export type PageTarget = { targetId: string; title: string; url: string; type: string };
export async function listPageTargets(host: string, port: number): Promise<PageTarget[]> {
  const r = await fetch(`http://${host}:${port}/json`);
  const all = await r.json() as PageTarget[];
  return all.filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://'));
}
