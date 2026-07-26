import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

type ReplStartup = {
  ok: boolean;
  ready: boolean;
  port: number;
};

async function readStartup(
  stdout: ReadableStream<Uint8Array>,
): Promise<ReplStartup> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';

  try {
    while (!output.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(output.trim()) as ReplStartup;
}

describe('persistent REPL', () => {
  test('survives a detached rejected promise from an evaluated snippet', async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, fileURLToPath(new URL('./repl.ts', import.meta.url))],
      env: { ...process.env, CDP_REPL_PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const startup = await readStartup(child.stdout);
      expect(startup.ok).toBe(true);
      expect(startup.ready).toBe(true);
      expect(startup.port).toBeGreaterThan(0);

      const baseUrl = `http://127.0.0.1:${startup.port}`;
      const overwrite = await fetch(`${baseUrl}/eval`, {
        method: 'POST',
        body: 'globalThis.eval = () => { throw new Error("poisoned evaluator"); }; return "overwritten";',
      });
      expect(overwrite.status).toBe(200);
      expect(await overwrite.text()).toBe('overwritten');

      const afterOverwrite = await fetch(`${baseUrl}/eval`, {
        method: 'POST',
        body: '6 * 7',
      });
      expect(afterOverwrite.status).toBe(200);
      expect(await afterOverwrite.text()).toBe('42');

      const detached = await fetch(`${baseUrl}/eval`, {
        method: 'POST',
        body: 'void Promise.reject(new Error("detached rejection probe")); return "scheduled";',
      });
      expect(detached.status).toBe(200);
      expect(await detached.text()).toBe('scheduled');

      await Bun.sleep(25);

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });

      const subsequent = await fetch(`${baseUrl}/eval`, {
        method: 'POST',
        body: '21 * 2',
      });
      expect(subsequent.status).toBe(200);
      expect(await subsequent.text()).toBe('42');
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
