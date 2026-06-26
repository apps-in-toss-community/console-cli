// Tests for `withReauthRetry` — the mid-flight 401 transparent reauth helper
// added in #210.  All external I/O (loadCredentials, headless login) is
// injected via the `deps` parameter so no real Chrome, file system, or
// network is involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TossApiError } from '../api/http.js';
import type { Session } from '../session.js';
import { withReauthRetry } from './_shared.js';

// Minimal valid session shape used across tests.
const FAKE_SESSION: Session = {
  schemaVersion: 2,
  user: { id: 'u1', email: 'dev@example.com' },
  cookies: [],
  origins: [],
  capturedAt: '2026-06-01T00:00:00.000Z',
};

const NEW_SESSION: Session = {
  ...FAKE_SESSION,
  capturedAt: '2026-06-25T00:00:00.000Z',
};

// A genuine expired-session error (status 401, not a geo-block).
function expiredSessionError(): TossApiError {
  return new TossApiError(401, '9999', 'session expired', 0);
}

// A geo-block error (errorCode 4010).
function geoBlockError(): TossApiError {
  return new TossApiError(403, '4010', 'geo blocked', 0);
}

describe('withReauthRetry', () => {
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

  // (a) run succeeds on the first try — no reauth should occur at all.
  it('(a) returns result immediately when run succeeds on first attempt', async () => {
    let runCount = 0;
    const result = await withReauthRetry(
      false,
      FAKE_SESSION,
      async (s) => {
        runCount++;
        expect(s).toBe(FAKE_SESSION);
        return 'ok';
      },
      {
        loadCredentials: async () => null,
        headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
      },
    );
    expect(result).toBe('ok');
    expect(runCount).toBe(1);
    // No breadcrumb should appear.
    expect(stderr.join('')).toBe('');
  });

  // (b) genuine 401 → reauth succeeds → replay with new session.
  it('(b) replays run with new session after successful transparent reauth', async () => {
    let runCount = 0;
    let headlessLoginCalled = false;

    const result = await withReauthRetry(
      false,
      FAKE_SESSION,
      async (s) => {
        runCount++;
        if (runCount === 1) {
          // First call: throw genuine expired-session error.
          throw expiredSessionError();
        }
        // Second call (replay): return success with new session.
        expect(s).toBe(NEW_SESSION);
        return 'replayed-ok';
      },
      {
        loadCredentials: async () => ({ kind: 'file', email: 'dev@example.com', password: 'pw' }),
        headlessLogin: async (input) => {
          headlessLoginCalled = true;
          // Secret must not appear in any output — verify here by inspection.
          expect(input.email).toBe('dev@example.com');
          return { kind: 'ok', session: NEW_SESSION };
        },
      },
    );

    expect(result).toBe('replayed-ok');
    expect(runCount).toBe(2);
    expect(headlessLoginCalled).toBe(true);
    // Breadcrumb must appear on stderr, never on stdout.
    expect(stderr.join('')).toContain('Session expired — re-authenticating');
    // No credential values in any output.
    expect(stderr.join('')).not.toContain('pw');
    expect(stdout.join('')).not.toContain('pw');
  });

  // (c) geo-block (4010) → rethrows WITHOUT triggering reauth.
  it('(c) rethrows geo-block error without attempting reauth', async () => {
    let loadCredentialsCalled = false;
    const err = geoBlockError();

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          throw err;
        },
        {
          loadCredentials: async () => {
            loadCredentialsCalled = true;
            return { kind: 'file', email: 'dev@example.com', password: 'pw' };
          },
          headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
        },
      ),
    ).rejects.toThrow(err);

    expect(loadCredentialsCalled).toBe(false);
    expect(stderr.join('')).toBe('');
  });

  // (d) AITCC_SESSION env active (CI mode) → rethrows, no reauth spawned.
  it('(d) rethrows when AITCC_SESSION env is active without attempting reauth', async () => {
    // Set a non-empty AITCC_SESSION to activate CI mode.
    process.env.AITCC_SESSION = Buffer.from(JSON.stringify(FAKE_SESSION)).toString('base64');

    let headlessLoginCalled = false;
    const err = expiredSessionError();

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          throw err;
        },
        {
          loadCredentials: async () => ({ kind: 'file', email: 'dev@example.com', password: 'pw' }),
          headlessLogin: async () => {
            headlessLoginCalled = true;
            return { kind: 'ok', session: NEW_SESSION };
          },
        },
      ),
    ).rejects.toThrow(err);

    expect(headlessLoginCalled).toBe(false);
    expect(stderr.join('')).toBe('');
  });

  // (e) env credentials or no credentials → rethrows, no reauth spawned.
  it('(e) rethrows when credentials are env-sourced', async () => {
    let headlessLoginCalled = false;
    const err = expiredSessionError();

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          throw err;
        },
        {
          loadCredentials: async () => ({
            kind: 'env',
            email: 'ci@example.com',
            password: 'ci-pw',
          }),
          headlessLogin: async () => {
            headlessLoginCalled = true;
            return { kind: 'ok', session: NEW_SESSION };
          },
        },
      ),
    ).rejects.toThrow(err);

    expect(headlessLoginCalled).toBe(false);
    expect(stderr.join('')).toBe('');
  });

  it('(e) rethrows when no credentials are stored at all', async () => {
    let headlessLoginCalled = false;
    const err = expiredSessionError();

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          throw err;
        },
        {
          loadCredentials: async () => null,
          headlessLogin: async () => {
            headlessLoginCalled = true;
            return { kind: 'ok', session: NEW_SESSION };
          },
        },
      ),
    ).rejects.toThrow(err);

    expect(headlessLoginCalled).toBe(false);
    expect(stderr.join('')).toBe('');
  });

  // (f) reauth returns 'failed' → original error propagates, no replay.
  it('(f) rethrows original error when headless reauth fails', async () => {
    let runCount = 0;
    const err = expiredSessionError();

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          runCount++;
          throw err;
        },
        {
          loadCredentials: async () => ({ kind: 'file', email: 'dev@example.com', password: 'pw' }),
          headlessLogin: async () => ({ kind: 'failed', reason: 'chrome-launch-failed' }),
        },
      ),
    ).rejects.toThrow(err);

    // run was called exactly once — no replay after failed reauth.
    expect(runCount).toBe(1);
    // Breadcrumb appeared (we did attempt reauth).
    expect(stderr.join('')).toContain('Session expired — re-authenticating');
    // No secret in any output.
    const all = stdout.join('') + stderr.join('');
    expect(all).not.toContain('pw');
    expect(all).not.toContain('password');
  });

  // (g) reauth returns 'step-up-needed' → step-up message, no replay.
  it('(g) emits step-up message and rethrows original error when reauth requires step-up', async () => {
    let runCount = 0;
    const err = expiredSessionError();

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          runCount++;
          throw err;
        },
        {
          loadCredentials: async () => ({ kind: 'file', email: 'dev@example.com', password: 'pw' }),
          headlessLogin: async () => ({ kind: 'step-up-needed' }),
        },
      ),
    ).rejects.toThrow(err);

    // run was called exactly once — no replay.
    expect(runCount).toBe(1);
    // Step-up message must appear on stderr.
    expect(stderr.join('')).toContain('step-up');
    expect(stderr.join('')).toContain('aitcc login');
    // No secret in any output.
    const all = stdout.join('') + stderr.join('');
    expect(all).not.toContain('pw');
    expect(all).not.toContain('password');
  });

  // Extra: non-TossApiError passes through unchanged.
  it('rethrows non-TossApiError errors without triggering reauth', async () => {
    const err = new TypeError('unexpected type error');
    let loadCredentialsCalled = false;

    await expect(
      withReauthRetry(
        false,
        FAKE_SESSION,
        async () => {
          throw err;
        },
        {
          loadCredentials: async () => {
            loadCredentialsCalled = true;
            return null;
          },
          headlessLogin: async () => ({ kind: 'failed', reason: 'should-not-call' }),
        },
      ),
    ).rejects.toThrow(err);

    expect(loadCredentialsCalled).toBe(false);
    expect(stderr.join('')).toBe('');
  });
});
