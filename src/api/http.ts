// Thin HTTP layer for driving the Apps in Toss console API.
//
// Two concerns live here:
//   1. Serialising the session's captured cookies into a `Cookie` header
//      per request origin (we drop cookies whose Domain/Path don't match
//      the target URL — feeding `apps-in-toss.toss.im` session cookies to
//      `business-accounts.toss.im` would be either ignored or rejected).
//   2. Unwrapping the Toss `{ resultType, success, error? }` envelope that
//      every console endpoint uses. Upstream callers get `T` on success or
//      a typed `TossApiError` on failure — no need to repeat envelope
//      dispatch in every command.
//
// We don't try to be a full cookie jar. The cookie set we care about is
// captured in one shot at login time and replayed verbatim thereafter;
// Set-Cookie responses from API calls are ignored. A later PR will add
// refresh logic once we see whether the console issues sliding sessions.

import type { CdpCookie } from '../cdp.js';

export interface TossEnvelopeSuccess<T> {
  readonly resultType: 'SUCCESS';
  readonly success: T;
}

export interface TossEnvelopeFailure {
  readonly resultType: 'FAIL';
  readonly success: null;
  readonly error: {
    readonly errorType: number;
    readonly errorCode: string;
    readonly reason: string;
    readonly data?: unknown;
    readonly title?: string | null;
  };
}

export type TossEnvelope<T> = TossEnvelopeSuccess<T> | TossEnvelopeFailure;

export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    readonly reason: string,
    readonly errorType: number,
  ) {
    super(`Toss API error ${errorCode}: ${reason} (HTTP ${status})`);
    this.name = 'TossApiError';
  }

  /** Cookie-based auth rejected — session missing/expired/invalidated. */
  get isAuthError(): boolean {
    return this.status === 401 || this.errorCode === '4010';
  }
}

export class NetworkError extends Error {
  constructor(
    readonly url: string,
    cause: Error,
  ) {
    super(`Network request to ${url} failed: ${cause.message}`);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export class MalformedResponseError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string,
  ) {
    super(`Malformed response from ${url} (HTTP ${status}): ${message}`);
    this.name = 'MalformedResponseError';
  }
}

// --- Cookie matching ---

/**
 * RFC 6265-ish domain match. We accept the bare hostname case plus the
 * standard suffix match (`.example.com` cookie matches `foo.example.com`),
 * because CDP `Network.getAllCookies` normalises cookie Domain to a form
 * with a leading dot for host-matching cookies but without for explicit-host
 * cookies. Either form should round-trip correctly.
 */
export function domainMatches(cookieDomain: string, hostname: string): boolean {
  if (cookieDomain.length === 0) return false;
  const lower = cookieDomain.toLowerCase();
  const host = hostname.toLowerCase();
  if (lower === host) return true;
  if (lower.startsWith('.') && host.endsWith(lower)) return true;
  // Host cookies without a leading dot: cookie Domain must equal the host.
  // Suffix-match only applies when there's an explicit leading dot.
  if (!lower.startsWith('.') && host.endsWith(`.${lower}`)) return true;
  return false;
}

/**
 * Build a `Cookie:` header value for the given URL from a captured cookie
 * set. Returns `null` when no cookies match — the caller should skip the
 * header entirely rather than emit `Cookie: ` with an empty value.
 */
export function cookieHeaderFor(url: URL, cookies: readonly CdpCookie[]): string | null {
  const matching = cookies.filter((c) => {
    if (!domainMatches(c.domain, url.hostname)) return false;
    if (c.path && !url.pathname.startsWith(c.path)) return false;
    if (c.secure && url.protocol !== 'https:') return false;
    return true;
  });
  if (matching.length === 0) return null;
  return matching.map((c) => `${c.name}=${c.value}`).join('; ');
}

// --- Request helper ---

// Narrow fetch signature that callers (and tests) can satisfy without
// implementing Bun-specific extensions like `fetch.preconnect`.
export type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly cookies: readonly CdpCookie[];
  readonly body?: unknown;
  readonly fetchImpl?: FetchLike;
  readonly headers?: Record<string, string>;
}

/**
 * Perform a request against the console API and unwrap the Toss envelope.
 *
 * Always sets `Accept: application/json` and propagates the captured cookie
 * set. Callers may pass additional headers (useful for CSRF tokens that
 * later endpoints turn out to require — discovery is per-feature).
 */
export async function requestConsoleApi<T>(options: RequestOptions): Promise<T> {
  const url = new URL(options.url);
  const cookieHeader = cookieHeaderFor(url, options.cookies);
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...options.headers,
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    // Cookies handled manually; disable any built-in cookie jar behaviour.
    redirect: 'follow',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new NetworkError(url.toString(), err as Error);
  }

  let parsed: TossEnvelope<T>;
  try {
    parsed = (await res.json()) as TossEnvelope<T>;
  } catch (err) {
    throw new MalformedResponseError(url.toString(), res.status, (err as Error).message);
  }

  if (parsed.resultType === 'SUCCESS') {
    return parsed.success;
  }
  throw new TossApiError(
    res.status,
    parsed.error.errorCode,
    parsed.error.reason,
    parsed.error.errorType,
  );
}
