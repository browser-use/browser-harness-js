import { afterEach, describe, expect, test } from 'bun:test';

import { runSnippet } from './snippet.ts';

const CALLBACK_KEY = '__browserHarnessScopedCallbackTest';
const GLOBAL_KEY = '__browserHarnessPersistentGlobalTest';

afterEach(() => {
  delete (globalThis as any)[CALLBACK_KEY];
  delete (globalThis as any)[GLOBAL_KEY];
});

describe('request-scoped snippet session binding', () => {
  test('allows a snippet to shadow session with a local const', async () => {
    const scoped = { marker: 'scoped' } as any;
    const result = await runSnippet('const session = "local"; return session;', scoped);
    expect(result).toBe('local');
  });

  test('routes both session and globalThis.session to the request-scoped view', async () => {
    const scoped = { marker: 'scoped' } as any;
    const result = await runSnippet('return session === globalThis.session && session.marker;', scoped);
    expect(result).toBe('scoped');
  });

  test('callbacks created by the snippet keep the request-scoped session after eval returns', async () => {
    const scoped = { marker: 'scoped' } as any;
    await runSnippet(`globalThis.${CALLBACK_KEY} = () => session;`, scoped);
    expect((globalThis as any)[CALLBACK_KEY]()).toBe(scoped);
  });

  test('other globalThis properties still persist on the real global object', async () => {
    const scoped = { marker: 'scoped' } as any;
    await runSnippet(`globalThis.${GLOBAL_KEY} = 42;`, scoped);
    expect((globalThis as any)[GLOBAL_KEY]).toBe(42);
  });
});
