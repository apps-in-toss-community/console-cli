// Tests for `acquireSessionOrReauth` — the session-acquisition chokepoint
// added in #206.  All external I/O (readSession, loadCredentials, headless
// login) is injected via the `deps` parameter so no real Chrome, file system,
// or network is involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../session.js';
import { acquireSessionOrReauth } from './_shared.js';

// Minimal valid session shape used across tests.
const FAKE_SESSION: Session = {
  schemaVersion: 2,
  user: { id: 'u1', email: 'dev@example.com' },
  cookies: [],
  origins: [],
  capturedAt: '2026-06-01T00:00:00.000Z',
};

// Mirror the captureExit helper from `_shared.test.ts`.
type Exited = { code: number };

async function captureExit(fn: () => Promise<unknown>): Promise<Exited | null> {
  const original = process.exit;
  let exited: Exited | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch for tests
  (process as any).exit = ((code?: number) => {
    exited = { code: code ?? 0 };
    throw new Error(`__test_exit_${code ?? 0}__`);
  }) as never;
  try {
    await fn().catch((err) => {
      if (!(err instanceof Error) || !err.message.startsWith('__test_exit_')) throw err;
    });
  } finally {
    process.exit = original;
  }
  return exited;
}

describe('acquireSessionOrReauth', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stdout.push(String(chunk));
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stderr.push(String(chunk));
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up env var in case a test sets it.
    delete process.env.AITCC_SESSION;
  });

  // Case 1: session already present — happy path, no reauth needed.
  it('returns existing session immediately when readSession returns non-null', async () => {
    const result = await acquireSessionOrReauth(false, {
      readSession: async () => FAKE_SESSION,
      loadCredentials: async () => null,
      headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
    });
    expect(result).toBe(FAKE_SESSION);
    expect(stderr).toEqual([]);
  });

  // Case 2: AITCC_SESSION env active (CI mode) — never auto-spawn.
  it('exits 10 without reauth when AITCC_SESSION env is active', async () => {
    // We need to make isEnvSessionActive() return true. The easiest way
    // is to set a valid base64-encoded session in the env var.
    const blob = Buffer.from(JSON.stringify(FAKE_SESSION)).toString('base64');
    process.env.AITCC_SESSION = blob;

    const exit = await captureExit(() =>
      acquireSessionOrReauth(true, {
        // readSession returns null (simulating expired file session; env session
        // parsing happens inside readSession/isEnvSessionActive directly)
        readSession: async () => null,
        loadCredentials: async () => null,
        headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
      }),
    );
    expect(exit?.code).toBe(10);
    // JSON mode → stdout has the payload
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  // Case 3: no credentials configured at all.
  it('exits 10 with not-authenticated when loadCredentials returns null', async () => {
    const exit = await captureExit(() =>
      acquireSessionOrReauth(true, {
        readSession: async () => null,
        loadCredentials: async () => null,
        headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
      }),
    );
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  // Case 4: credentials from env (AITCC_EMAIL+PASSWORD) — never auto-spawn
  // in CI env-cred mode.
  it('exits 10 without reauth when credentials are sourced from env', async () => {
    const exit = await captureExit(() =>
      acquireSessionOrReauth(true, {
        readSession: async () => null,
        loadCredentials: async () => ({
          kind: 'env',
          email: 'ci@example.com',
          password: 'secret',
        }),
        headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
      }),
    );
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  // Case 5: file credentials present + headless login succeeds.
  it('returns the new session when headless reauth succeeds', async () => {
    const newSession: Session = { ...FAKE_SESSION, capturedAt: '2026-06-25T00:00:00.000Z' };
    let headlessLoginCalled = false;
    const result = await acquireSessionOrReauth(false, {
      readSession: async () => null,
      loadCredentials: async () => ({
        kind: 'file',
        email: 'dev@example.com',
        password: 'secret',
      }),
      headlessLogin: async () => {
        headlessLoginCalled = true;
        return { kind: 'ok', session: newSession };
      },
    });
    expect(headlessLoginCalled).toBe(true);
    expect(result).toBe(newSession);
    // Breadcrumb must appear on stderr.
    expect(stderr.join('')).toContain('Session expired — re-authenticating');
  });

  // Case 6: headless login returns step-up-needed.
  it('exits 10 and prints step-up message when reauth requires step-up', async () => {
    const exit = await captureExit(() =>
      acquireSessionOrReauth(true, {
        readSession: async () => null,
        loadCredentials: async () => ({
          kind: 'file',
          email: 'dev@example.com',
          password: 'secret',
        }),
        headlessLogin: async () => ({ kind: 'step-up-needed' }),
      }),
    );
    expect(exit?.code).toBe(10);
    expect(stderr.join('')).toContain('step-up');
    expect(stderr.join('')).toContain('aitcc login');
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  // Case 7: headless login fails for a benign reason.
  it('exits 10 and prints generic reauth-failed message on headless failure', async () => {
    const exit = await captureExit(() =>
      acquireSessionOrReauth(true, {
        readSession: async () => null,
        loadCredentials: async () => ({
          kind: 'file',
          email: 'dev@example.com',
          password: 'secret',
        }),
        headlessLogin: async () => ({ kind: 'failed', reason: 'chrome-launch-failed' }),
      }),
    );
    expect(exit?.code).toBe(10);
    expect(stderr.join('')).toContain('aitcc login');
    expect(stdout.join('')).toContain('"authenticated":false');
    // Secret-handling: reason label must not contain password / token / cookie.
    const stderrText = stderr.join('');
    expect(stderrText).not.toContain('secret');
    expect(stderrText).not.toContain('password');
  });
});
