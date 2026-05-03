import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import {
  fetchAppEventCatalogs,
  fetchAppServiceStatus,
  fetchAppTemplates,
  fetchBundles,
  fetchCerts,
  fetchConversionMetrics,
  fetchDeployedBundle,
  fetchImpressionCategoryList,
  fetchMiniAppRatings,
  fetchMiniApps,
  fetchReviewStatus,
  fetchShareRewards,
  fetchSmartMessageCampaigns,
  fetchUserReports,
  issueCert,
  revokeCert,
} from './mini-apps.js';

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

describe('fetchUserReports', () => {
  it('hits /mini-apps/:aid/user-reports (plural!) with default page size', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { reports: [], nextCursor: null, hasMore: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchUserReports({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-apps/29405/user-reports?pageSize=20',
    );
    expect(got).toEqual({ reports: [], nextCursor: null, hasMore: false });
  });

  it('passes cursor and custom pageSize through', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { reports: [], nextCursor: 'next-xyz', hasMore: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchUserReports(
      { workspaceId: 3095, miniAppId: 29405, pageSize: 5, cursor: 'abc' },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('pageSize=5');
    expect(calledUrl).toContain('cursor=abc');
    expect(got.nextCursor).toBe('next-xyz');
    expect(got.hasMore).toBe(true);
  });

  it('passes each report record through as an opaque record', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            reports: [
              {
                id: 1,
                reason: 'SPAM',
                content: 'bad ad',
                createdAt: '2026-04-20T12:00:00Z',
              },
              { id: 2, reason: 'INAPPROPRIATE' },
            ],
            nextCursor: null,
            hasMore: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchUserReports({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(got.reports).toHaveLength(2);
    expect(got.reports[0]).toMatchObject({ id: 1, reason: 'SPAM', content: 'bad ad' });
    expect(got.reports[1]).toMatchObject({ id: 2, reason: 'INAPPROPRIATE' });
  });

  it('throws when reports is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { reports: 'nope', nextCursor: null, hasMore: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      fetchUserReports({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/reports is not an array/);
  });
});

describe('fetchBundles', () => {
  it('returns normalised empty page with no query params', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { contents: [], totalPage: 0, currentPage: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchBundles({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/bundles',
    );
    expect(got).toEqual({ contents: [], totalPage: 0, currentPage: 0 });
  });

  it('passes page, tested, and deployStatus through as query params', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { contents: [], totalPage: 3, currentPage: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchBundles(
      { workspaceId: 3095, miniAppId: 29405, page: 1, tested: true, deployStatus: 'DEPLOYED' },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('tested=true');
    expect(calledUrl).toContain('deployStatus=DEPLOYED');
    expect(got.totalPage).toBe(3);
    expect(got.currentPage).toBe(1);
  });

  it('passes each bundle record through as an opaque record', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            contents: [
              { id: 101, version: '1.0.0', deployStatus: 'DEPLOYED', createdAt: '2026-04-01' },
              { id: 102, version: '1.0.1', deployStatus: 'TESTED' },
            ],
            totalPage: 1,
            currentPage: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchBundles({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl });
    expect(got.contents).toHaveLength(2);
    expect(got.contents[0]).toMatchObject({ id: 101, version: '1.0.0', deployStatus: 'DEPLOYED' });
    expect(got.contents[1]).toMatchObject({ id: 102, deployStatus: 'TESTED' });
  });

  it('throws when contents is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { contents: 'nope', totalPage: 0, currentPage: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      fetchBundles({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/contents is not an array/);
  });
});

describe('fetchDeployedBundle', () => {
  it('returns null when no bundle is currently deployed', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchDeployedBundle(3095, 29405, cookies, { fetchImpl });
    expect(got).toBeNull();
  });

  it('returns the deployed bundle record verbatim', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            id: 101,
            version: '1.0.0',
            deployStatus: 'DEPLOYED',
            deployedAt: '2026-04-01T12:00:00Z',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchDeployedBundle(3095, 29405, cookies, { fetchImpl });
    expect(got).toMatchObject({ id: 101, version: '1.0.0', deployStatus: 'DEPLOYED' });
  });

  it('throws when the response is an array (unexpected)', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchDeployedBundle(3095, 29405, cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected deployed-bundle shape/,
    );
  });
});

describe('fetchCerts', () => {
  it('returns empty array when no certs are provisioned', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const got = await fetchCerts(3095, 29405, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/certs',
    );
    expect(got).toEqual([]);
  });

  it('passes each cert record through as an opaque record', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              id: 1,
              commonName: 'app.example.com',
              createdAt: '2026-04-01',
              validUntil: '2027-04-01',
            },
            { id: 2, commonName: 'api.example.com' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchCerts(3095, 29405, cookies, { fetchImpl });
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ id: 1, commonName: 'app.example.com' });
    expect(got[1]).toMatchObject({ id: 2, commonName: 'api.example.com' });
  });

  it('throws when the response is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchCerts(3095, 29405, cookies, { fetchImpl })).rejects.toThrow(/not an array/);
  });
});

describe('issueCert', () => {
  it('POSTs {name} to the singular cert/issue path and returns the PEM pair', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody = '';
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? 'GET';
      calledBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
            publicKey: '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await issueCert(3095, 29349, 'sandbox-2026-05', cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29349/cert/issue',
    );
    expect(calledMethod).toBe('POST');
    expect(JSON.parse(calledBody)).toEqual({ name: 'sandbox-2026-05' });
    expect(got.privateKey).toMatch(/BEGIN PRIVATE KEY/);
    expect(got.publicKey).toMatch(/BEGIN CERTIFICATE/);
  });

  it('throws when privateKey or publicKey is missing', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { publicKey: 'only-cert' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(issueCert(3095, 29349, 'x', cookies, { fetchImpl })).rejects.toThrow(
      /missing privateKey\/publicKey/,
    );
  });

  it('throws when the response is not an object', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: 'nope' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(issueCert(3095, 29349, 'x', cookies, { fetchImpl })).rejects.toThrow(
      /not an object/,
    );
  });
});

describe('revokeCert', () => {
  it('POSTs an empty body to the plural certs/<id>/disable path', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody = '';
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? 'GET';
      calledBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await revokeCert(3095, 29349, 'cert-abc', cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29349/certs/cert-abc/disable',
    );
    expect(calledMethod).toBe('POST');
    expect(calledBody).toBe('{}');
  });

  it('percent-encodes cert IDs that contain URL-unsafe characters', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await revokeCert(3095, 29349, 'a/b c', cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29349/certs/a%2Fb%20c/disable',
    );
  });
});

describe('fetchConversionMetrics', () => {
  it('builds the expected URL with defaults (refresh=false)', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { metrics: [], cacheTime: '2026-04-23T13:00:00' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchConversionMetrics(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        timeUnitType: 'DAY',
        startDate: '2026-04-01',
        endDate: '2026-04-22',
      },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/conversion-metrics?refresh=false&timeUnitType=DAY&startDate=2026-04-01&endDate=2026-04-22',
    );
    expect(got).toEqual({ metrics: [], cacheTime: '2026-04-23T13:00:00' });
  });

  it('sets refresh=true when requested', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { metrics: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await fetchConversionMetrics(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        timeUnitType: 'WEEK',
        startDate: '2026-01-01',
        endDate: '2026-04-22',
        refresh: true,
      },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('refresh=true');
    expect(calledUrl).toContain('timeUnitType=WEEK');
  });

  it('passes each metrics record through as an opaque record', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            metrics: [
              { date: '2026-04-01', impressions: 100, clicks: 10 },
              { date: '2026-04-02', impressions: 120, clicks: 14 },
            ],
            cacheTime: '2026-04-23T13:00:00',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchConversionMetrics(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        timeUnitType: 'DAY',
        startDate: '2026-04-01',
        endDate: '2026-04-02',
      },
      cookies,
      { fetchImpl },
    );
    expect(got.metrics).toHaveLength(2);
    expect(got.metrics[0]).toMatchObject({ date: '2026-04-01', impressions: 100 });
    expect(got.cacheTime).toBe('2026-04-23T13:00:00');
  });

  it('throws when metrics is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { metrics: 'oops' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchConversionMetrics(
        {
          workspaceId: 3095,
          miniAppId: 29405,
          timeUnitType: 'DAY',
          startDate: '2026-04-01',
          endDate: '2026-04-22',
        },
        cookies,
        { fetchImpl },
      ),
    ).rejects.toThrow(/not an array/);
  });

  it('leaves cacheTime undefined when absent', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { metrics: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchConversionMetrics(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        timeUnitType: 'DAY',
        startDate: '2026-04-01',
        endDate: '2026-04-22',
      },
      cookies,
      { fetchImpl },
    );
    expect(got.cacheTime).toBeUndefined();
  });
});

describe('fetchShareRewards', () => {
  it('builds the expected URL with empty search by default', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const got = await fetchShareRewards({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/share-rewards?search=',
    );
    expect(got).toEqual([]);
  });

  it('passes through a search filter and url-encodes it', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await fetchShareRewards({ workspaceId: 3095, miniAppId: 29405, search: '친구 초대' }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toContain('search=%EC%B9%9C%EA%B5%AC+%EC%B4%88%EB%8C%80');
  });

  it('passes each reward record through as an opaque record', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            { id: 1, title: '친구 초대 리워드', status: 'ACTIVE' },
            { id: 2, title: 'OG 보상', status: 'ENDED' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchShareRewards({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ id: 1, title: '친구 초대 리워드', status: 'ACTIVE' });
    expect(got[1]).toMatchObject({ id: 2, status: 'ENDED' });
  });

  it('throws when the response is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchShareRewards({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/not an array/);
  });
});

describe('fetchSmartMessageCampaigns', () => {
  it('POSTs to /smart-message/campaigns with page/size on the URL and filter body', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody: unknown = null;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = (init?.method ?? 'GET').toUpperCase();
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            items: [],
            paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchSmartMessageCampaigns({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(calledMethod).toBe('POST');
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/smart-message/campaigns?page=0&size=20',
    );
    expect(calledBody).toEqual({
      sort: [{ field: 'regTs', direction: 'DESC' }],
      search: '',
      filters: {},
    });
    expect(got).toEqual({
      items: [],
      paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 0 },
    });
  });

  it('forwards search, page, size, sort, and filters', async () => {
    let calledUrl = '';
    let calledBody: unknown = null;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            items: [],
            paging: { pageNumber: 2, pageSize: 50, hasNext: true, totalCount: 123 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await fetchSmartMessageCampaigns(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        page: 2,
        size: 50,
        search: 'launch',
        sort: [{ field: 'modTs', direction: 'ASC' }],
        filters: { channelTypes: ['PUSH'] },
      },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('size=50');
    expect(calledBody).toEqual({
      sort: [{ field: 'modTs', direction: 'ASC' }],
      search: 'launch',
      filters: { channelTypes: ['PUSH'] },
    });
  });

  it('passes campaign records through opaquely', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            items: [{ id: 7, title: 'Welcome', status: 'SCHEDULED', newField: 'future-proof' }],
            paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 1 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchSmartMessageCampaigns({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toEqual({
      id: 7,
      title: 'Welcome',
      status: 'SCHEDULED',
      newField: 'future-proof',
    });
    expect(got.paging.totalCount).toBe(1);
  });

  it('rejects non-object success payloads', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchSmartMessageCampaigns({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected smart-message campaigns shape/);
  });

  it('falls back to defaults when the server omits paging fields', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { items: [{ id: 1 }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchSmartMessageCampaigns(
      { workspaceId: 3095, miniAppId: 29405, page: 3, size: 7 },
      cookies,
      { fetchImpl },
    );
    expect(got.paging.pageNumber).toBe(3);
    expect(got.paging.pageSize).toBe(7);
    expect(got.paging.hasNext).toBe(false);
    expect(got.paging.totalCount).toBe(1);
  });
});

describe('fetchAppEventCatalogs', () => {
  it('POSTs to /log/catalogs/search with isRefresh/pageNumber/pageSize/search body', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody: unknown = null;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = (init?.method ?? 'GET').toUpperCase();
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            results: [],
            cacheTime: '2026-04-23T14:17:56.598344405',
            paging: {
              pageNumber: 0,
              pageSize: 20,
              hasNext: false,
              totalCount: 0,
              totalPages: 0,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchAppEventCatalogs({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(calledMethod).toBe('POST');
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/log/catalogs/search',
    );
    expect(calledBody).toEqual({
      isRefresh: false,
      pageNumber: 0,
      pageSize: 20,
      search: '',
    });
    expect(got.results).toEqual([]);
    expect(got.cacheTime).toBe('2026-04-23T14:17:56.598344405');
    expect(got.paging).toEqual({
      pageNumber: 0,
      pageSize: 20,
      hasNext: false,
      totalCount: 0,
      totalPages: 0,
    });
  });

  it('forwards refresh/search/paging', async () => {
    let calledBody: unknown = null;
    const fetchImpl: FetchLike = async (_input, init) => {
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            results: [],
            cacheTime: null,
            paging: { pageNumber: 1, pageSize: 5, hasNext: true, totalCount: 17, totalPages: 4 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchAppEventCatalogs(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        pageNumber: 1,
        pageSize: 5,
        search: 'purchase',
        refresh: true,
      },
      cookies,
      { fetchImpl },
    );
    expect(calledBody).toEqual({
      isRefresh: true,
      pageNumber: 1,
      pageSize: 5,
      search: 'purchase',
    });
    expect(got.paging.totalPages).toBe(4);
    expect(got.cacheTime).toBeUndefined();
  });

  it('passes event records through opaquely', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            results: [{ name: 'signup_complete', count: 42, unknownField: 'later' }],
            paging: { pageNumber: 0, pageSize: 20, hasNext: false, totalCount: 1, totalPages: 1 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchAppEventCatalogs({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(got.results).toHaveLength(1);
    expect(got.results[0]).toEqual({
      name: 'signup_complete',
      count: 42,
      unknownField: 'later',
    });
  });

  it('rejects non-object success payloads', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchAppEventCatalogs({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected event-catalogs shape/);
  });
});

describe('fetchAppTemplates', () => {
  it('hits /templates/search with page/size defaults and omits optional filters', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { page: { totalPageCount: 0 }, groupSendContextSimpleView: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchAppTemplates({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/templates/search?page=0&size=20',
    );
    expect(got).toEqual({ templates: [], totalPageCount: 0 });
  });

  it('forwards contentReachType/isSmartMessage when provided', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { page: { totalPageCount: 3 }, groupSendContextSimpleView: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await fetchAppTemplates(
      {
        workspaceId: 3095,
        miniAppId: 29405,
        page: 1,
        size: 5,
        contentReachType: 'MARKETING',
        isSmartMessage: true,
      },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('size=5');
    expect(calledUrl).toContain('contentReachType=MARKETING');
    expect(calledUrl).toContain('isSmartMessage=true');
  });

  it('passes templates through opaquely and maps groupSendContextSimpleView to templates', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            page: { totalPageCount: 1 },
            groupSendContextSimpleView: [
              { id: 5, title: 'Welcome', templateType: 'PUSH', unknownField: 1 },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchAppTemplates({ workspaceId: 3095, miniAppId: 29405 }, cookies, {
      fetchImpl,
    });
    expect(got.totalPageCount).toBe(1);
    expect(got.templates).toHaveLength(1);
    expect(got.templates[0]).toEqual({
      id: 5,
      title: 'Welcome',
      templateType: 'PUSH',
      unknownField: 1,
    });
  });

  it('rejects non-object success payloads', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchAppTemplates({ workspaceId: 3095, miniAppId: 29405 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected templates shape/);
  });
});

describe('fetchImpressionCategoryList', () => {
  it('hits /impression/category-list (no workspaces prefix) and normalises the tree', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              categoryGroup: { id: 7, name: '생활', isSelectable: true },
              categoryList: [
                {
                  id: 3882,
                  name: '정보',
                  isSelectable: true,
                  subCategoryList: [
                    { id: 56, name: '뉴스', isSelectable: true },
                    { id: 58, name: '도서', isSelectable: true },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchImpressionCategoryList(cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/impression/category-list',
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.categoryGroup).toEqual({ id: 7, name: '생활', isSelectable: true });
    expect(got[0]?.categoryList[0]?.subCategoryList).toEqual([
      { id: 56, name: '뉴스', isSelectable: true },
      { id: 58, name: '도서', isSelectable: true },
    ]);
  });

  it('rejects a non-array payload', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { not: 'array' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchImpressionCategoryList(cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected impression\/category-list shape/,
    );
  });

  it('handles missing subCategoryList gracefully', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              categoryGroup: { id: 3, name: '금융', isSelectable: false },
              categoryList: [{ id: 1, name: 'X', isSelectable: false }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchImpressionCategoryList(cookies, { fetchImpl });
    expect(got[0]?.categoryList[0]?.subCategoryList).toEqual([]);
  });
});

describe('fetchAppServiceStatus', () => {
  it('hits /mini-app/:id/review-status (singular) and returns the service status triple', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            shutdownCandidateStatus: null,
            scheduledShutdownAt: null,
            serviceStatus: 'PREPARE',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchAppServiceStatus(3095, 29405, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/29405/review-status',
    );
    expect(got).toEqual({
      shutdownCandidateStatus: null,
      scheduledShutdownAt: null,
      serviceStatus: 'PREPARE',
    });
  });

  it('preserves shutdown fields when populated', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            shutdownCandidateStatus: 'SCHEDULED',
            scheduledShutdownAt: '2026-06-01T00:00:00',
            serviceStatus: 'RUNNING',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchAppServiceStatus(3095, 29405, cookies, { fetchImpl });
    expect(got.shutdownCandidateStatus).toBe('SCHEDULED');
    expect(got.scheduledShutdownAt).toBe('2026-06-01T00:00:00');
    expect(got.serviceStatus).toBe('RUNNING');
  });

  it('rejects a response missing serviceStatus', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ resultType: 'SUCCESS', success: { shutdownCandidateStatus: null } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchAppServiceStatus(3095, 29405, cookies, { fetchImpl })).rejects.toThrow(
      /missing serviceStatus/,
    );
  });
});
