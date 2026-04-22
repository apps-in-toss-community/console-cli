// Client for the "ipd-thor" service, which backs the console's notice
// board (공지사항). Different base URL than everything else
// (`api-public.toss.im/api-public/v3/ipd-thor`) and a fixed workspaceId
// of 129 — that's Toss's shared "앱인토스 콘솔 공지사항" workspace, not
// the caller's business workspace. Every console user reads the same
// notices from this one bucket.
//
// Shares the Toss `{resultType, success, error}` envelope, so we can
// reuse `requestConsoleApi` from http.ts. Captured session cookies are
// domain-matched against `.toss.im` which matches both the console
// and ipd-thor hosts, so no separate auth handshake is needed.

import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

export const IPD_THOR_WORKSPACE_ID = 129;
const BASE = 'https://api-public.toss.im/api-public/v3/ipd-thor/api/v1';

// --- Posts (공지사항) ---
//
// GET /workspaces/129/posts?page=&size=&title__icontains=
//
// Response envelope (observed 2026-04-23):
//   { page, pageSize, count, next, previous, results: [post] }
//
// Pagination is 1-indexed. The server echoes `page: 1` when you send
// `page=0`, so we expose the page back to callers as the server returned
// it — don't re-normalize to 0-indexed, that would lie about what the
// API actually does.

export interface NoticePostsPage {
  readonly page: number;
  readonly pageSize: number;
  readonly count: number;
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly Readonly<Record<string, unknown>>[];
}

export interface FetchNoticesParams {
  readonly page?: number;
  readonly size?: number;
  readonly titleContains?: string;
}

export async function fetchNotices(
  params: FetchNoticesParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<NoticePostsPage> {
  const qs = new URLSearchParams();
  qs.set('page', String(params.page ?? 0));
  qs.set('size', String(params.size ?? 20));
  if (params.titleContains !== undefined) {
    qs.set('title__icontains', params.titleContains);
  }
  const url = `${BASE}/workspaces/${IPD_THOR_WORKSPACE_ID}/posts?${qs.toString()}`;

  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Unexpected notices shape: not an object');
  }
  const rec = raw as Record<string, unknown>;
  const resultsRaw = rec.results;
  if (!Array.isArray(resultsRaw)) {
    throw new Error('Unexpected notices shape: results is not an array');
  }
  const results = resultsRaw.map((r) => {
    if (r === null || typeof r !== 'object') return {};
    return r as Record<string, unknown>;
  });
  return {
    page: typeof rec.page === 'number' ? rec.page : 1,
    pageSize: typeof rec.pageSize === 'number' ? rec.pageSize : (params.size ?? 20),
    count: typeof rec.count === 'number' ? rec.count : results.length,
    next: typeof rec.next === 'string' ? rec.next : null,
    previous: typeof rec.previous === 'string' ? rec.previous : null,
    results,
  };
}

// --- Categories ---
//
// GET /workspaces/129/categories  → array of category objects with
// { id, name, postCount, children, ... }. Children is always empty in
// the observed response; if Toss adds hierarchy later we pass it
// through unchanged.

export async function fetchNoticeCategories(
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const url = `${BASE}/workspaces/${IPD_THOR_WORKSPACE_ID}/categories`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected categories shape: not an array');
  }
  return raw.map((c) => {
    if (c === null || typeof c !== 'object') return {};
    return c as Record<string, unknown>;
  });
}

// --- Single post ---
//
// GET /workspaces/129/posts/:id — not yet observed in a live capture
// (sidebar list endpoint only pulls the collection). Included on
// speculation so `aitcc notices show <id>` has a place to live; the
// fetch path follows the same envelope as the list endpoint.

export async function fetchNoticePost(
  postId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Record<string, unknown>> {
  const url = `${BASE}/workspaces/${IPD_THOR_WORKSPACE_ID}/posts/${postId}`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected notice-post shape for id=${postId}`);
  }
  return raw as Record<string, unknown>;
}
