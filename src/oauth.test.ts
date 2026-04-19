import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { randomState, startCallbackServer } from './oauth.js';

describe('randomState', () => {
  it('produces base64url strings with high entropy', () => {
    const s1 = randomState();
    const s2 = randomState();
    expect(s1).not.toBe(s2);
    // 32 bytes → 43 base64url chars (no padding)
    expect(s1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s2).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not collide across many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1024; i++) seen.add(randomState());
    expect(seen.size).toBe(1024);
  });
});

async function hit(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

describe('startCallbackServer', () => {
  it('binds to 127.0.0.1 on an ephemeral port and resolves on valid callback', async () => {
    const server = await startCallbackServer({ timeoutMs: 5000 });
    expect(server.port).toBeGreaterThan(0);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);

    const waiter = server.waitForCallback();
    const res = await hit(
      `${server.redirectUri}?code=abc123&state=${server.expectedState}&email=u%40example.com`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('Logged in to ait-console');

    const q = await waiter;
    expect(q.code).toBe('abc123');
    expect(q.state).toBe(server.expectedState);
    expect(q.raw.email).toBe('u@example.com');
    await server.close();
  });

  it('rejects a callback with a mismatched state', async () => {
    const server = await startCallbackServer({ timeoutMs: 5000 });
    // Attach the expectation before firing the request so the rejection is
    // never orphaned (avoids a PromiseRejectionHandledWarning under vitest).
    const expectation = expect(server.waitForCallback()).rejects.toThrow(/state/i);
    const res = await hit(`${server.redirectUri}?code=abc&state=WRONG`);
    expect(res.status).toBe(400);
    await expectation;
    await server.close();
  });

  it('returns 404 for paths other than /callback without settling', async () => {
    const server = await startCallbackServer({ timeoutMs: 500 });
    const expectation = expect(server.waitForCallback()).rejects.toThrow(/timed out/i);
    const res = await hit(`http://127.0.0.1:${server.port}/favicon.ico`);
    expect(res.status).toBe(404);
    // The waiter should still be alive; it will timeout shortly.
    await expectation;
    await server.close();
  });

  it('times out if no callback arrives', async () => {
    const server = await startCallbackServer({ timeoutMs: 100 });
    await expect(server.waitForCallback()).rejects.toThrow(/timed out/i);
    await server.close();
  });

  it('falls back to an ephemeral port if the preferred one is in use', async () => {
    // Occupy an ephemeral port, then ask the callback server to prefer it.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const addr = blocker.address() as AddressInfo;
    try {
      const server = await startCallbackServer({
        timeoutMs: 100,
        preferredPort: addr.port,
      });
      expect(server.port).not.toBe(addr.port);
      expect(server.port).toBeGreaterThan(0);
      await server.close();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
