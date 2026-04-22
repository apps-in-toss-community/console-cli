import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchMiniAppRatings, fetchMiniApps, fetchReviewStatus } from './mini-apps.js';

const cookies: readonly CdpCookie[] = [
  {
    name: 'session',
    value: 'xyz',
    domain: 'apps-in-toss.toss.im',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    session: true,
  },
];

describe('fetchMiniApps', () => {
  it('hits /workspaces/:id/mini-app and returns [] on an empty workspace', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const apps = await fetchMiniApps(36577, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/mini-app',
    );
    expect(apps).toEqual([]);
  });

  it('normalises id/name fields and stashes the rest under extra', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            { id: 'abc123', name: 'my app', status: 'APPROVED', version: '1.0.0' },
            { miniAppId: 999, miniAppName: 'alt keys' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const apps = await fetchMiniApps(36577, cookies, { fetchImpl });
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({
      id: 'abc123',
      name: 'my app',
      extra: { status: 'APPROVED', version: '1.0.0' },
    });
    expect(apps[1]).toMatchObject({ id: 999, name: 'alt keys' });
    // Pin the exclusion list for the alt-key family too — if someone drops
    // `miniAppName`/`miniAppId` from the rest-destructure in the normaliser
    // they'd show up as leftover keys in `extra`.
    expect(apps[1]?.extra).toEqual({});
  });

  it('throws when the response is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchMiniApps(36577, cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected mini-app list shape/,
    );
  });

  it('throws when an entry is missing an id', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [{ name: 'no id here' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchMiniApps(36577, cookies, { fetchImpl })).rejects.toThrow(/missing id/);
  });
});

describe('fetchReviewStatus', () => {
  it('returns normalised shape on empty workspace', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { hasPolicyViolation: false, miniApps: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchReviewStatus(36577, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/mini-apps/review-status',
    );
    expect(got.hasPolicyViolation).toBe(false);
    expect(got.miniApps).toEqual([]);
  });

  it('preserves unknown miniApp fields for downstream join', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            hasPolicyViolation: true,
            miniApps: [{ id: 'abc', reviewState: 'REJECTED', rejectReason: 'nope' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchReviewStatus(36577, cookies, { fetchImpl });
    expect(got.hasPolicyViolation).toBe(true);
    expect(got.miniApps).toHaveLength(1);
    expect(got.miniApps[0]).toMatchObject({ id: 'abc', reviewState: 'REJECTED' });
  });

  it('throws when miniApps is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { hasPolicyViolation: false, miniApps: 'nope' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchReviewStatus(36577, cookies, { fetchImpl })).rejects.toThrow(
      /miniApps is not an array/,
    );
  });
});

describe('fetchMiniAppRatings', () => {
  it('hits the paged endpoint with default sort parameters', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            ratings: [],
            paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 0 },
            averageRating: 0,
            totalReviewCount: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchMiniAppRatings({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/app-ratings?page=0&size=20&sortField=CREATED_AT&sortDirection=DESC',
    );
    expect(got.ratings).toEqual([]);
    expect(got.paging.totalCount).toBe(0);
    expect(got.averageRating).toBe(0);
    expect(got.totalReviewCount).toBe(0);
  });

  it('passes through non-default page/size/sort values', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            ratings: [],
            paging: { pageNumber: 2, pageSize: 5, hasNext: true, totalCount: 42 },
            averageRating: 4.2,
            totalReviewCount: 42,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchMiniAppRatings(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        page: 2,
        size: 5,
        sortField: 'SCORE',
        sortDirection: 'ASC',
      },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('size=5');
    expect(calledUrl).toContain('sortField=SCORE');
    expect(calledUrl).toContain('sortDirection=ASC');
    expect(got.paging.hasNext).toBe(true);
    expect(got.averageRating).toBeCloseTo(4.2);
    expect(got.totalReviewCount).toBe(42);
  });

  it('passes each rating record through as an opaque record', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            ratings: [
              { score: 5, content: 'great!', nickname: 'dave', createdAt: '2026-04-20T12:00:00Z' },
              { score: 2, content: 'meh', nickname: 'alice' },
            ],
            paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 2 },
            averageRating: 3.5,
            totalReviewCount: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchMiniAppRatings({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(got.ratings).toHaveLength(2);
    expect(got.ratings[0]).toMatchObject({ score: 5, content: 'great!' });
    expect(got.ratings[1]).toMatchObject({ score: 2, nickname: 'alice' });
  });

  it('throws when ratings is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            ratings: 'nope',
            paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      fetchMiniAppRatings({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/ratings is not an array/);
  });

  it('throws when paging is missing', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { ratings: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      fetchMiniAppRatings({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/paging missing/);
  });
});
