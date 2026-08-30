import { describe, expect, test } from 'bun:test';

import { Session } from './session.ts';

async function sentMessage(method: string): Promise<Record<string, unknown>> {
  const session = new Session();
  session.setActiveSession('page-session');

  let sent: Record<string, unknown> | undefined;
  (session as any).ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      sent = JSON.parse(raw);
      queueMicrotask(() => {
        (session as any).onMessage(JSON.stringify({ id: sent!.id, result: {} }));
      });
    },
  };

  await session._call(method, {});
  return sent!;
}

describe('Session CDP routing', () => {
  test('keeps page commands on the active target session', async () => {
    expect(await sentMessage('Page.navigate')).toMatchObject({ sessionId: 'page-session' });
  });

  test('routes extension commands through the browser session', async () => {
    expect(await sentMessage('Extensions.getExtensions')).not.toHaveProperty('sessionId');
  });
});
