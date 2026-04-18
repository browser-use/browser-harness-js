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

/**
 * Resolve a WebSocket URL. Order of preference:
 *   1. { wsUrl } — explicit.
 *   2. { profileDir } — reads `<profileDir>/DevToolsActivePort` and builds
 *      the WS URL directly from its two lines (port + path). This is the
 *      ONLY method that works on Chrome 144+ / chrome://inspect flow, which
 *      does not serve `/json/version` over HTTP.
 *   3. { port } — legacy: probes `http://host:port/json/version`. Works only
 *      for Chrome launched with `--remote-debugging-port` (older versions or
 *      explicit-port launches). FAILS on Chrome 144+ attached via
 *      chrome://inspect — use profileDir or wsUrl instead.
 */
export async function resolveWsUrl(opts: ConnectOptions): Promise<string> {
  if (opts.wsUrl) return opts.wsUrl;

  if (opts.profileDir) {
    const { port, path } = await readDevToolsActivePort(opts.profileDir);
    const host = opts.host ?? '127.0.0.1';
    return `ws://${host}:${port}${path}`;
  }

  if (opts.port) {
    return await fetchBrowserWsUrl(opts.host ?? '127.0.0.1', opts.port);
  }

  throw new Error('connect() needs one of: { wsUrl } | { profileDir } | { port }');
}

/**
 * Parse both lines of DevToolsActivePort. Chrome writes:
 *   line 1: port number
 *   line 2: path (e.g. "/devtools/browser/<uuid>")
 * With both in hand we can build `ws://host:port<path>` with no HTTP probe.
 */
async function readDevToolsActivePort(profileDir: string): Promise<{ port: number; path: string }> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const text = (await Bun.file(`${profileDir}/DevToolsActivePort`).text()).trim();
      const [portStr, path] = text.split('\n');
      const port = Number(portStr);
      if (!Number.isFinite(port)) throw new Error(`malformed port line: ${portStr}`);
      if (!path || !path.startsWith('/devtools/')) {
        // File is written atomically but path line may not be there on first open.
        throw new Error(`missing/invalid path line in DevToolsActivePort: ${JSON.stringify(text)}`);
      }
      return { port, path };
    } catch (e) {
      lastErr = e;
      await Bun.sleep(250);
    }
  }
  throw new Error(`Could not read ${profileDir}/DevToolsActivePort after 30s: ${lastErr}`);
}

async function fetchBrowserWsUrl(host: string, port: number): Promise<string> {
  // Legacy path. Only works for Chrome launched with --remote-debugging-port.
  // Chrome 144+ chrome://inspect flow does NOT serve /json/version.
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${host}:${port}/json/version`);
      if (r.ok) {
        const j = await r.json() as { webSocketDebuggerUrl: string };
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
      if (r.status === 404) {
        throw new Error(`Chrome at ${host}:${port} does not serve /json/version. You are probably on Chrome 144+ via chrome://inspect — use connect({profileDir: '<path>'}) or connect({wsUrl: '...'}) instead.`);
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
      // If it's the 404 message above, stop immediately — retrying won't help.
      if (e instanceof Error && e.message.includes('Chrome 144+')) throw e;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Could not reach ${host}:${port}/json/version after 30s: ${lastErr}`);
}

/**
 * List page targets via CDP's `Target.getTargets` (works on all Chrome versions,
 * including those that do not serve /json). Filters out chrome:// and devtools://
 * internals. Requires the session to be connected already.
 */
export type PageTarget = { targetId: string; title: string; url: string; type: string };
export async function listPageTargets(session: Session): Promise<PageTarget[]> {
  const { targetInfos } = await session.domains.Target.getTargets({});
  return (targetInfos as PageTarget[]).filter(
    t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://')
  );
}
