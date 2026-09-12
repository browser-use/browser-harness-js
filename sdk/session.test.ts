import { describe, expect, test } from 'bun:test';

import { Session } from './session.ts';

function installFakeSocket(
  session: Session,
  onSend?: (message: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  (session as any).ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const message = JSON.parse(raw) as Record<string, unknown>;
      sent.push(message);
      const result = onSend?.(message) ?? {};
      queueMicrotask(() => {
        (session as any).onMessage(JSON.stringify({ id: message.id, result }));
      });
    },
  };
  return sent;
}

async function sentMessage(method: string): Promise<Record<string, unknown>> {
  const session = new Session();
  session.setActiveSession('page-session');
  const sent = installFakeSocket(session);

  await session._call(method, {});
  return sent[0]!;
}

describe('Session CDP routing', () => {
  test('keeps page commands on the active target session', async () => {
    expect(await sentMessage('Page.navigate')).toMatchObject({ sessionId: 'page-session' });
  });

  test('routes extension commands through the browser session', async () => {
    expect(await sentMessage('Extensions.getExtensions')).not.toHaveProperty('sessionId');
  });

  test('attach returns a sessionId without replacing the legacy active session', async () => {
    const session = new Session();
    session.setActiveSession('legacy-session');
    const sent = installFakeSocket(session, message =>
      message.method === 'Target.attachToTarget' ? { sessionId: 'new-session' } : {},
    );

    const sid = await session.attach('target-a');

    expect(sid).toBe('new-session');
    expect(session.getActiveSession()).toBe('legacy-session');
    expect(sent[0]).toMatchObject({
      method: 'Target.attachToTarget',
      params: { targetId: 'target-a', flatten: true },
    });
    expect(sent[0]).not.toHaveProperty('sessionId');
  });

  test('scoped sessions keep concurrent page commands pinned to their own sessionIds', async () => {
    const session = new Session();
    const sent = installFakeSocket(session);
    const a = session.withSession('session-a');
    const b = session.withSession('session-b');

    await Promise.all([
      a._call('Runtime.evaluate', { expression: '"A"' }),
      b._call('Runtime.evaluate', { expression: '"B"' }),
    ]);

    expect(sent[0]).toMatchObject({ method: 'Runtime.evaluate', sessionId: 'session-a' });
    expect(sent[1]).toMatchObject({ method: 'Runtime.evaluate', sessionId: 'session-b' });
  });

  test('changing the legacy active session cannot move a scoped call', async () => {
    const session = new Session();
    const sent = installFakeSocket(session);
    const scoped = session.withSession('fixed-session');

    session.setActiveSession('other-session');
    await scoped._call('Page.navigate', { url: 'https://example.com' });

    expect(sent[0]).toMatchObject({ sessionId: 'fixed-session' });
  });

  test('browser-level commands stay unscoped even through a scoped session', async () => {
    const session = new Session();
    const sent = installFakeSocket(session);
    const scoped = session.withSession('fixed-session');

    await scoped._call('Target.getTargets', {});

    expect(sent[0]).not.toHaveProperty('sessionId');
  });

  test('scoped event listeners ignore the same event from another session', () => {
    const session = new Session();
    const scoped = session.withSession('session-a');
    const received: string[] = [];
    scoped.onEvent((method) => received.push(method));

    (session as any).onMessage(JSON.stringify({
      method: 'Network.requestWillBeSent',
      params: { requestId: 'b' },
      sessionId: 'session-b',
    }));
    (session as any).onMessage(JSON.stringify({
      method: 'Network.requestWillBeSent',
      params: { requestId: 'a' },
      sessionId: 'session-a',
    }));

    expect(received).toEqual(['Network.requestWillBeSent']);
  });

  test('scoped waitFor ignores a matching event from another session', async () => {
    const session = new Session();
    const scoped = session.withSession('session-a');
    const waiting = scoped.waitFor<{ requestId: string }>('Network.requestWillBeSent', undefined, 1_000);

    // 先故意送一个“方法名完全相同、但来自另一个 session”的事件。
    // 如果过滤失效，waiting 会错误地拿到 requestId=b；正确实现必须继续等待。
    (session as any).onMessage(JSON.stringify({
      method: 'Network.requestWillBeSent',
      params: { requestId: 'b' },
      sessionId: 'session-b',
    }));
    (session as any).onMessage(JSON.stringify({
      method: 'Network.requestWillBeSent',
      params: { requestId: 'a' },
      sessionId: 'session-a',
    }));

    expect(await waiting).toEqual({ requestId: 'a' });
  });

  test('scoped waitFor keeps browser-level events visible when they have no sessionId', async () => {
    const session = new Session();
    const scoped = session.withSession('session-a');
    const waiting = scoped.waitFor<{ targetInfo: { targetId: string } }>('Target.targetCreated', undefined, 1_000);

    // Target.* 是浏览器级事件，CDP 消息不会附带某个 page sessionId。
    // 显式 session 路由不能因此把它直接过滤掉；需要时由调用方再按 targetId 等字段筛选。
    (session as any).onMessage(JSON.stringify({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'new-target' } },
    }));

    expect(await waiting).toEqual({ targetInfo: { targetId: 'new-target' } });
  });
});
