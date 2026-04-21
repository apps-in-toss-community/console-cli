import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import {
  cookieHeaderFor,
  domainMatches,
  type FetchLike,
  MalformedResponseError,
  NetworkError,
  requestConsoleApi,
  TossApiError,
} from './http.js';

const cookie = (
  overrides: Partial<CdpCookie> & Pick<CdpCookie, 'name' | 'value' | 'domain'>,
): CdpCookie => ({
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  session: true,
  ...overrides,
});

describe('domainMatches', () => {
  it('matches an explicit-host cookie against the same hostname', () => {
    expect(domainMatches('apps-in-toss.toss.im', 'apps-in-toss.toss.im')).toBe(true);
    expect(domainMatches('apps-in-toss.toss.im', 'other.toss.im')).toBe(false);
  });

  it('matches a leading-dot cookie as a suffix (but not against the bare domain)', () => {
    // RFC 6265 §5.1.3: a leading-dot cookie matches sub-domains only; the
    // bare domain itself is NOT a match (that requires the cookie Domain
    // to equal the host exactly).
    expect(domainMatches('.toss.im', 'business.toss.im')).toBe(true);
    expect(domainMatches('.toss.im', 'toss.im')).toBe(false);
    expect(domainMatches('.toss.im', 'evil-toss.im')).toBe(false);
  });

  it('treats a bare-host cookie as suffix-matching its subdomains too', () => {
    // CDP normalises Domain to the bare form sometimes; we accept either.
    expect(domainMatches('toss.im', 'business.toss.im')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(domainMatches('TOSS.IM', 'business.toss.im')).toBe(true);
  });
});

describe('cookieHeaderFor', () => {
  const cookies: readonly CdpCookie[] = [
    cookie({ name: 'a', value: '1', domain: 'apps-in-toss.toss.im' }),
    cookie({ name: 'b', value: '2', domain: 'business-accounts.toss.im' }),
    cookie({ name: 'c', value: '3', domain: '.toss.im' }),
    cookie({ name: 'd', value: '4', domain: 'apps-in-toss.toss.im', secure: true }),
  ];

  it('serialises only cookies whose domain matches the target URL', () => {
    const header = cookieHeaderFor(new URL('https://business-accounts.toss.im/user/me'), cookies);
    // `b` (exact match) and `c` (suffix match via .toss.im) apply; `a`/`d` don't.
    expect(header).toBe('b=2; c=3');
  });

  it('drops secure-only cookies for http URLs', () => {
    const secureOnly: CdpCookie[] = [
      cookie({ name: 's', value: '1', domain: 'example.com', secure: true }),
    ];
    expect(cookieHeaderFor(new URL('http://example.com/'), secureOnly)).toBeNull();
    expect(cookieHeaderFor(new URL('https://example.com/'), secureOnly)).toBe('s=1');
  });

  it('returns null when no cookies match so the caller can skip the header entirely', () => {
    expect(cookieHeaderFor(new URL('https://unrelated.example/'), cookies)).toBeNull();
  });

  it('respects cookie Path prefix filtering', () => {
    const scoped: CdpCookie[] = [
      cookie({ name: 'p', value: '1', domain: 'example.com', path: '/console' }),
    ];
    expect(cookieHeaderFor(new URL('https://example.com/console/x'), scoped)).toBe('p=1');
    expect(cookieHeaderFor(new URL('https://example.com/other'), scoped)).toBeNull();
  });
});

describe('requestConsoleApi', () => {
  const baseCookies: readonly CdpCookie[] = [
    cookie({ name: 'session', value: 'xyz', domain: 'apps-in-toss.toss.im' }),
  ];

  it('unwraps a SUCCESS envelope to the typed payload', async () => {
    const fetchImpl: FetchLike = async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      expect(url).toBe('https://apps-in-toss.toss.im/ok');
      const headers = new Headers(init?.headers);
      expect(headers.get('Cookie')).toBe('session=xyz');
      expect(headers.get('Accept')).toContain('application/json');
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { hello: 'world' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await requestConsoleApi<{ hello: string }>({
      url: 'https://apps-in-toss.toss.im/ok',
      cookies: baseCookies,
      fetchImpl,
    });
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws TossApiError on a FAIL envelope, surfacing errorCode/reason', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 0, errorCode: '4010', reason: 'auth missing', data: {}, title: null },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      requestConsoleApi({
        url: 'https://apps-in-toss.toss.im/ok',
        cookies: baseCookies,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'TossApiError',
      status: 401,
      errorCode: '4010',
      reason: 'auth missing',
    });
  });

  it('TossApiError.isAuthError fires for 401 or errorCode 4010', () => {
    expect(new TossApiError(401, '9999', 'x', 0).isAuthError).toBe(true);
    expect(new TossApiError(500, '4010', 'x', 0).isAuthError).toBe(true);
    expect(new TossApiError(500, '9999', 'x', 0).isAuthError).toBe(false);
  });

  it('wraps thrown fetch errors in NetworkError', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('DNS error');
    };
    await expect(
      requestConsoleApi({
        url: 'https://apps-in-toss.toss.im/ok',
        cookies: baseCookies,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('raises MalformedResponseError on non-JSON bodies', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } });
    await expect(
      requestConsoleApi({
        url: 'https://apps-in-toss.toss.im/ok',
        cookies: baseCookies,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(MalformedResponseError);
  });
});
