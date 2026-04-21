import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../api/http.js';
import { TossApiError } from '../api/http.js';
import {
  AUTH_SETTLE_DELAY_MS,
  isAllowedAuthorizeHost,
  isLoginLanding,
  resolveUserWithRetry,
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

  it('returns the parsed user on the first successful response', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
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
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    // Can't easily inject fetch into fetchConsoleMemberUserInfo from here
    // without re-exporting — instead, monkey-patch globalThis.fetch for
    // the duration of the test.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const result = await resolveUserWithRetry(cookies);
      expect(result.email).toBe('e@x');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('retries once on TossApiError isAuthError, calls onRetry, then succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            resultType: 'FAIL',
            success: null,
            error: { errorType: 0, errorCode: '4010', reason: 'not yet', data: {}, title: null },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            id: 2,
            bizUserNo: 2,
            name: 'N2',
            email: 'e2@x',
            role: 'MEMBER',
            workspaces: [],
            isAdult: true,
            isOverseasBusiness: false,
            minorConsents: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    const retryDelays: number[] = [];
    try {
      const result = await resolveUserWithRetry(cookies, {
        onRetry: (ms) => retryDelays.push(ms),
      });
      expect(result.id).toBe(2);
      expect(calls).toBe(2);
      expect(retryDelays).toEqual([AUTH_SETTLE_DELAY_MS]);
    } finally {
      globalThis.fetch = realFetch;
    }
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
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      await expect(resolveUserWithRetry(cookies)).rejects.toBeInstanceOf(TossApiError);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
