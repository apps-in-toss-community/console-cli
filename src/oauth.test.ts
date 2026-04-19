import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  CallbackMissingCodeError,
  CallbackStateMismatchError,
  CallbackTimeoutError,
  randomState,
  startCallbackServer,
} from './oauth.js';

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
    const expectation = expect(server.waitForCallback()).rejects.toBeInstanceOf(
      CallbackStateMismatchError,
    );
    const res = await hit(`${server.redirectUri}?code=abc&state=WRONG`);
    expect(res.status).toBe(400);
    await expectation;
    await server.close();
  });

  it('rejects a callback missing the code parameter', async () => {
    const server = await startCallbackServer({ timeoutMs: 5000 });
    const expectation = expect(server.waitForCallback()).rejects.toBeInstanceOf(
      CallbackMissingCodeError,
    );
    const res = await hit(`${server.redirectUri}?state=${server.expectedState}`);
    expect(res.status).toBe(400);
    await expectation;
    await server.close();
  });

  it('returns 404 for non-callback paths and stays alive for the real callback', async () => {
    const server = await startCallbackServer({ timeoutMs: 5000 });
    // A noisy probe hits /favicon.ico — must not settle the waiter.
    const noise = await hit(`http://127.0.0.1:${server.port}/favicon.ico`);
    expect(noise.status).toBe(404);

    // The real callback arriving afterwards still resolves cleanly — proving
    // the 404 did not poison the flow.
    const waiter = server.waitForCallback();
    const ok = await hit(`${server.redirectUri}?code=ok&state=${server.expectedState}`);
    expect(ok.status).toBe(200);
    const q = await waiter;
    expect(q.code).toBe('ok');
    await server.close();
  });

  it('times out with CallbackTimeoutError if no callback arrives', async () => {
    const server = await startCallbackServer({ timeoutMs: 100 });
    await expect(server.waitForCallback()).rejects.toBeInstanceOf(CallbackTimeoutError);
    await server.close();
  });

  it('returns 410 Gone for duplicate callbacks after success', async () => {
    const server = await startCallbackServer({ timeoutMs: 5000 });
    const waiter = server.waitForCallback();
    const first = await hit(`${server.redirectUri}?code=first&state=${server.expectedState}`);
    expect(first.status).toBe(200);
    await waiter;

    // A second callback — possibly attacker-crafted with the now-observed
    // state — must NOT render as a fresh success page.
    const second = await hit(`${server.redirectUri}?code=second&state=${server.expectedState}`);
    expect(second.status).toBe(410);
    expect(second.body).not.toContain('Logged in to ait-console');
    await server.close();
  });

  it('close() is idempotent', async () => {
    const server = await startCallbackServer({ timeoutMs: 100 });
    await server.close();
    // Must not throw on second call.
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('falls back to an ephemeral port when the preferred one is occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const addr = blocker.address() as AddressInfo;
    try {
      const server = await startCallbackServer({
        timeoutMs: 100,
        preferredPort: addr.port,
      });
      // Fallback kicked in — the assigned port must not equal the occupied one.
      expect(server.port).not.toBe(addr.port);
      expect(server.port).toBeGreaterThan(0);
      await server.close();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
