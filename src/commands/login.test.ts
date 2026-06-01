import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../api/http.js';
import { TossApiError } from '../api/http.js';
import type { CredentialsSource } from '../auth/credentials.js';
import {
  AUTH_SETTLE_DELAY_MS,
  chooseLoginMode,
  computeFallbackTimeoutMs,
  INTERACTIVE_FALLBACK_FLOOR_MS,
  isAllowedAuthorizeHost,
  isLoginLanding,
  type LoginCommandArgs,
  type LoginDeps,
  type PromptDeps,
  resolveCredentialsForLogin,
  resolveUserWithRetry,
  type SaveTarget,
} from './login.js';

// The live flow is E2E-only (needs a real Chrome and a human) but the
// smaller pieces — URL predicates and the auth-settle retry — are pure
// functions that are worth guarding against regression.

describe('isLoginLanding', () => {
  it('accepts the workspace URL with no tail', () => {
    expect(isLoginLanding('https://apps-in-toss.toss.im/workspace')).toBe(true);
  });

  it('accepts workspace with auth-code tail', () => {
    expect(
      isLoginLanding('https://apps-in-toss.toss.im/workspace?code=abc&state=%2Fworkspace'),
    ).toBe(true);
  });

  it('accepts workspace sub-paths', () => {
    expect(isLoginLanding('https://apps-in-toss.toss.im/workspace/59/mini-app')).toBe(true);
  });

  it('rejects prefix-lookalikes like /workspacely', () => {
    expect(isLoginLanding('https://apps-in-toss.toss.im/workspacely')).toBe(false);
  });

  it('rejects other hosts even if the path matches', () => {
    expect(isLoginLanding('https://apps-in-toss.evil.example/workspace')).toBe(false);
  });

  it('rejects unrelated paths on the right host', () => {
    expect(isLoginLanding('https://apps-in-toss.toss.im/sign-up')).toBe(false);
  });

  it('returns false for malformed URLs instead of throwing', () => {
    expect(isLoginLanding('not a url')).toBe(false);
  });
});

describe('isAllowedAuthorizeHost', () => {
  it('allows business.toss.im and subdomains', () => {
    expect(isAllowedAuthorizeHost('business.toss.im')).toBe(true);
    expect(isAllowedAuthorizeHost('business-accounts.toss.im')).toBe(true);
    expect(isAllowedAuthorizeHost('apps-in-toss.toss.im')).toBe(true);
    // Even the bare registrable domain is allowed (matches the suffix).
    expect(isAllowedAuthorizeHost('toss.im')).toBe(true);
  });

  it('rejects lookalike hosts', () => {
    expect(isAllowedAuthorizeHost('toss.im.example.com')).toBe(false);
    expect(isAllowedAuthorizeHost('toss-im.example.com')).toBe(false);
    expect(isAllowedAuthorizeHost('nottoss.im')).toBe(false);
    expect(isAllowedAuthorizeHost('business.toss.example.com')).toBe(false);
  });
});

describe('resolveUserWithRetry', () => {
  const cookies = [
    {
      name: 's',
      value: 'v',
      domain: 'apps-in-toss.toss.im',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      session: true,
    },
  ];

  const successBody = {
    resultType: 'SUCCESS' as const,
    success: {
      id: 1,
      bizUserNo: 1,
      name: 'N',
      email: 'e@x',
      role: 'MEMBER',
      workspaces: [],
      isAdult: true,
      isOverseasBusiness: false,
      minorConsents: [],
    },
  };

  const authFailBody = {
    resultType: 'FAIL' as const,
    success: null,
    error: { errorType: 0, errorCode: '4010', reason: 'not yet', data: {}, title: null },
  };

  it('returns the parsed user on the first successful response', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response(JSON.stringify(successBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await resolveUserWithRetry(cookies, { fetchImpl });
    expect(result.email).toBe('e@x');
    expect(calls).toBe(1);
  });

  it('retries once on TossApiError isAuthError, calls onRetry, then succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify(authFailBody), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ...successBody,
          success: { ...successBody.success, id: 2, email: 'e2@x' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
    const retryDelays: number[] = [];
    const result = await resolveUserWithRetry(cookies, {
      fetchImpl,
      onRetry: (ms) => retryDelays.push(ms),
    });
    expect(result.id).toBe(2);
    expect(calls).toBe(2);
    expect(retryDelays).toEqual([AUTH_SETTLE_DELAY_MS]);
  });

  it('does not retry non-auth errors', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 0, errorCode: '5000', reason: 'server', data: {}, title: null },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    };
    await expect(resolveUserWithRetry(cookies, { fetchImpl })).rejects.toBeInstanceOf(TossApiError);
    expect(calls).toBe(1);
  });
});

describe('chooseLoginMode', () => {
  // Pure decision function — sums up the policy in one place so the
  // CLI command body stays focused on I/O.
  it('picks headless only when credentials exist and --interactive is off', () => {
    expect(chooseLoginMode({ interactiveFlag: false, hasCredentials: true })).toBe('headless');
  });
  it('falls back to interactive when no credentials are configured', () => {
    expect(chooseLoginMode({ interactiveFlag: false, hasCredentials: false })).toBe('interactive');
  });
  it('--interactive forces interactive even with credentials available', () => {
    expect(chooseLoginMode({ interactiveFlag: true, hasCredentials: true })).toBe('interactive');
  });
  it('--interactive without credentials still produces interactive', () => {
    expect(chooseLoginMode({ interactiveFlag: true, hasCredentials: false })).toBe('interactive');
  });
});

describe('computeFallbackTimeoutMs', () => {
  // After a headless attempt fails and we hand off to the visible Chrome
  // fallback, the user's `--timeout` budget should be honoured — but never
  // below the floor that gives the human time to actually type.
  it('subtracts elapsed time from the overall budget', () => {
    expect(computeFallbackTimeoutMs(300_000, 5_000)).toBe(295_000);
  });
  it('floors at INTERACTIVE_FALLBACK_FLOOR_MS when the budget is nearly exhausted', () => {
    expect(computeFallbackTimeoutMs(60_000, 59_000)).toBe(INTERACTIVE_FALLBACK_FLOOR_MS);
  });
  it('floors when the headless attempt overshot the total budget', () => {
    // Should not produce a negative timeout — `Math.max` clamps.
    expect(computeFallbackTimeoutMs(20_000, 25_000)).toBe(INTERACTIVE_FALLBACK_FLOOR_MS);
  });
  it('returns the full budget when no time has elapsed', () => {
    expect(computeFallbackTimeoutMs(300_000, 0)).toBe(300_000);
  });
  it('honours small budgets exactly when above the floor', () => {
    expect(computeFallbackTimeoutMs(45_000, 5_000)).toBe(40_000);
  });
});

// `resolveCredentialsForLogin` is the new policy core that decides where
// the email + password come from on a given invocation. It is the seam
// agent-plugin observes via `--json` reasons, so each branch needs an
// explicit lockdown — surprise behaviour here breaks scripted callers.
describe('resolveCredentialsForLogin', () => {
  const baseArgs: LoginCommandArgs = {
    json: false,
    timeout: '300',
    interactive: false,
    passwordStdin: false,
  };

  // Default opts simulate a non-TTY shell (e.g. CI) so we have to opt in
  // to TTY for the prompt-path tests.
  const nonTty = { stdoutIsTTY: false, stdinIsTTY: false } as const;
  const tty = { stdoutIsTTY: true, stdinIsTTY: true } as const;

  it('returns argv credentials when --email + --password are passed', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const got = await resolveCredentialsForLogin(
        { ...baseArgs, email: 'a@b', password: 'pw' },
        {},
        { env: {}, ...nonTty },
      );
      expect(got).toEqual({
        kind: 'ok',
        credentials: { source: 'argv', email: 'a@b', password: 'pw' },
        saveTarget: 'none',
      });
      // --password on argv must emit the `ps`-visibility warning.
      const calls = writeMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('visible in `ps`'))).toBe(true);
    } finally {
      writeMock.mockRestore();
    }
  });

  it('honours --save keychain by reporting it on the argv path', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const got = await resolveCredentialsForLogin(
        { ...baseArgs, email: 'a@b', password: 'pw', save: 'keychain' },
        {},
        { env: {}, ...nonTty },
      );
      expect(got).toMatchObject({ kind: 'ok', saveTarget: 'keychain' });
    } finally {
      writeMock.mockRestore();
    }
  });

  it('reads --password-stdin via the injected reader and strips trailing newline', async () => {
    const deps: LoginDeps = { readStdin: () => Promise.resolve('pw-from-pipe\n') };
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, email: 'a@b', passwordStdin: true },
      deps,
      { env: {}, ...nonTty },
    );
    expect(got).toEqual({
      kind: 'ok',
      credentials: { source: 'argv', email: 'a@b', password: 'pw-from-pipe' },
      saveTarget: 'none',
    });
  });

  it('rejects --password and --password-stdin together (exit 2)', async () => {
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, email: 'a@b', password: 'pw', passwordStdin: true },
      {},
      { env: {}, ...nonTty },
    );
    expect(got).toMatchObject({
      kind: 'error',
      reason: 'conflicting-password-source',
      exitCode: 2,
    });
  });

  it('rejects an empty --password-stdin payload (exit 2)', async () => {
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, email: 'a@b', passwordStdin: true },
      { readStdin: () => Promise.resolve('\n') },
      { env: {}, ...nonTty },
    );
    expect(got).toMatchObject({ kind: 'error', reason: 'invalid-password' });
  });

  it('rejects --email without any password source (exit 2)', async () => {
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, email: 'a@b' },
      {},
      { env: {}, ...nonTty },
    );
    expect(got).toMatchObject({ kind: 'error', reason: 'missing-password' });
  });

  it('rejects an email without an "@" (exit 2)', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const got = await resolveCredentialsForLogin(
        { ...baseArgs, email: 'no-at-sign', password: 'pw' },
        {},
        { env: {}, ...nonTty },
      );
      expect(got).toMatchObject({ kind: 'error', reason: 'invalid-email' });
    } finally {
      writeMock.mockRestore();
    }
  });

  it('rejects an unknown --save value (exit 2)', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const got = await resolveCredentialsForLogin(
        { ...baseArgs, email: 'a@b', password: 'pw', save: 'disk' },
        {},
        { env: {}, ...nonTty },
      );
      expect(got).toMatchObject({ kind: 'error', reason: 'invalid-save' });
    } finally {
      writeMock.mockRestore();
    }
  });

  it('honours --save=file by routing to the file backend', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const got = await resolveCredentialsForLogin(
        { ...baseArgs, email: 'a@b', password: 'pw', save: 'file' },
        {},
        { env: {}, ...nonTty },
      );
      expect(got).toMatchObject({ kind: 'ok', saveTarget: 'file' });
    } finally {
      writeMock.mockRestore();
    }
  });

  it('falls through to env when no flags are set and both env vars are present', async () => {
    const got = await resolveCredentialsForLogin(
      baseArgs,
      {},
      {
        env: { AITCC_EMAIL: 'env@x', AITCC_PASSWORD: 'env-pw' },
        ...nonTty,
      },
    );
    expect(got).toEqual({
      kind: 'ok',
      credentials: { source: 'env', email: 'env@x', password: 'env-pw' },
      saveTarget: 'none',
    });
  });

  it('uses the keychain when getCredentials returns a value (no env)', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const fromStore: CredentialsSource = {
        kind: 'keychain',
        email: 'kc@x',
        password: 'kc-pw',
      };
      const got = await resolveCredentialsForLogin(
        baseArgs,
        { getCredentials: () => Promise.resolve(fromStore) },
        { env: {}, ...nonTty },
      );
      expect(got).toEqual({
        kind: 'ok',
        credentials: { source: 'keychain', email: 'kc@x', password: 'kc-pw' },
        saveTarget: 'none',
      });
      const calls = writeMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('Using credentials from OS keychain for kc@x'))).toBe(
        true,
      );
    } finally {
      writeMock.mockRestore();
    }
  });

  it('refuses non-TTY runs with no credentials configured', async () => {
    const got = await resolveCredentialsForLogin(
      baseArgs,
      { getCredentials: () => Promise.resolve(null) },
      { env: {}, ...nonTty },
    );
    expect(got).toMatchObject({ kind: 'error', reason: 'interactive-required' });
  });

  it('drives the interactive prompts when stdin is a TTY and no creds exist', async () => {
    const calls: string[] = [];
    const prompts: PromptDeps = {
      email: () => {
        calls.push('email');
        return Promise.resolve('typed@x');
      },
      password: () => {
        calls.push('password');
        return Promise.resolve('typed-pw');
      },
      saveTarget: () => {
        calls.push('saveTarget');
        return Promise.resolve('keychain' as SaveTarget);
      },
    };
    const got = await resolveCredentialsForLogin(
      baseArgs,
      { getCredentials: () => Promise.resolve(null), prompts },
      { env: {}, ...tty },
    );
    expect(got).toEqual({
      kind: 'ok',
      credentials: { source: 'prompt', email: 'typed@x', password: 'typed-pw' },
      saveTarget: 'keychain',
    });
    expect(calls).toEqual(['email', 'password', 'saveTarget']);
  });

  it('skips the saveTarget prompt when --save was passed explicitly', async () => {
    const calls: string[] = [];
    const prompts: PromptDeps = {
      email: () => Promise.resolve('typed@x'),
      password: () => Promise.resolve('typed-pw'),
      saveTarget: () => {
        calls.push('saveTarget');
        return Promise.resolve('none' as SaveTarget);
      },
    };
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, save: 'none' },
      { getCredentials: () => Promise.resolve(null), prompts },
      { env: {}, ...tty },
    );
    expect(got).toMatchObject({ kind: 'ok', saveTarget: 'none' });
    expect(calls).toEqual([]);
  });

  it('rejects --interactive combined with --email (no silent drop of credentials)', async () => {
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, interactive: true, email: 'a@b', password: 'pw' },
      {},
      { env: {}, ...nonTty },
    );
    expect(got).toMatchObject({ kind: 'error', reason: 'conflicting-interactive-flags' });
  });

  it('rejects --interactive combined with --save (so the user sees their save was ignored)', async () => {
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, interactive: true, save: 'keychain' },
      {},
      { env: {}, ...nonTty },
    );
    expect(got).toMatchObject({ kind: 'error', reason: 'conflicting-interactive-flags' });
  });

  it('--interactive returns ok with null credentials so the visible browser drives the form', async () => {
    const got = await resolveCredentialsForLogin(
      { ...baseArgs, interactive: true },
      { getCredentials: () => Promise.resolve(null) },
      { env: { AITCC_EMAIL: 'env@x', AITCC_PASSWORD: 'env-pw' }, ...nonTty },
    );
    expect(got).toEqual({ kind: 'ok', credentials: null, saveTarget: 'none' });
  });

  it('--json suppresses the keychain breadcrumb so machine consumers do not see noise', async () => {
    const writeMock = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const fromStore: CredentialsSource = {
        kind: 'keychain',
        email: 'kc@x',
        password: 'kc-pw',
      };
      await resolveCredentialsForLogin(
        { ...baseArgs, json: true },
        { getCredentials: () => Promise.resolve(fromStore) },
        { env: {}, ...nonTty },
      );
      const calls = writeMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('Using credentials from OS keychain'))).toBe(false);
    } finally {
      writeMock.mockRestore();
    }
  });
});
