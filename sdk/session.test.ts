import { describe, expect, test } from 'bun:test';

import { Session } from './session.ts';

function connectFakeSocket(session: Session): void {
  const internals = session as unknown as {
    ws: { readyState: number; send: (message: string) => void };
    onMessage: (message: string) => void;
  };
  internals.ws = {
    readyState: WebSocket.OPEN,
    send(message) {
      const { id } = JSON.parse(message) as { id: number };
      queueMicrotask(() => internals.onMessage(JSON.stringify({
        id,
        error: { code: -32000, message: 'Fetch domain is not enabled' },
      })));
    },
  };
}

describe('Session command rejection handling', () => {
  test('an ignored CDP rejection does not become unhandled', async () => {
    const session = new Session();
    connectFakeSocket(session);

    void session._call('Fetch.disable');
    await Bun.sleep(10);
  });

  test('an awaited CDP rejection still reaches the caller', async () => {
    const session = new Session();
    connectFakeSocket(session);

    await expect(session._call('Fetch.disable')).rejects.toThrow(
      'CDP -32000: Fetch domain is not enabled',
    );
  });
});
