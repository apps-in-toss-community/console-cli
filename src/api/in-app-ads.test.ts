import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import {
  createAdsPlacementGroup,
  fetchAdsAbuseStatus,
  fetchAdsPlacementGroups,
} from './in-app-ads.js';

// Confirmed live 2026-07-24, workspace 3095 / app 31146 (issue #226) — both
// endpoints returned empty/neutral state. These tests pin the request
// (URL/method) and the confirmed empty-state response shape.

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

describe('fetchAdsPlacementGroups', () => {
  it('hits /mini-app/:aid/in-app-ads-v2/placement-groups and returns the raw array', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const got = await fetchAdsPlacementGroups({ workspaceId: 3095, miniAppId: 31146 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-ads-v2/placement-groups',
    );
    expect(got).toEqual([]);
  });

  it('passes through populated entries opaquely', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [{ id: 'pg_1', name: 'Home banner', status: 'ACTIVE' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchAdsPlacementGroups({ workspaceId: 3095, miniAppId: 31146 }, cookies, {
      fetchImpl,
    });
    expect(got).toEqual([{ id: 'pg_1', name: 'Home banner', status: 'ACTIVE' }]);
  });

  it('rejects a non-array response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { not: 'an array' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchAdsPlacementGroups({ workspaceId: 3095, miniAppId: 31146 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected ads placement-groups shape/);
  });
});

describe('fetchAdsAbuseStatus', () => {
  it('hits /mini-app/:aid/in-app-ads-v2/abuse-status and normalises the confirmed shape', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { abuseLevel: 'NONE', isServingBlocked: false, blockedPlacementGroups: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchAdsAbuseStatus({ workspaceId: 3095, miniAppId: 31146 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-ads-v2/abuse-status',
    );
    expect(got).toEqual({
      abuseLevel: 'NONE',
      isServingBlocked: false,
      blockedPlacementGroups: [],
    });
  });

  it('normalises a blocked state with populated blockedPlacementGroups', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            abuseLevel: 'SEVERE',
            isServingBlocked: true,
            blockedPlacementGroups: [{ id: 'pg_1' }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchAdsAbuseStatus({ workspaceId: 3095, miniAppId: 31146 }, cookies, {
      fetchImpl,
    });
    expect(got.abuseLevel).toBe('SEVERE');
    expect(got.isServingBlocked).toBe(true);
    expect(got.blockedPlacementGroups).toEqual([{ id: 'pg_1' }]);
  });

  it('falls back to safe defaults on a malformed response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchAdsAbuseStatus({ workspaceId: 3095, miniAppId: 31146 }, cookies, {
      fetchImpl,
    });
    expect(got).toEqual({
      abuseLevel: 'UNKNOWN',
      isServingBlocked: false,
      blockedPlacementGroups: [],
    });
  });
});

describe('createAdsPlacementGroup', () => {
  it('POSTs to the singular /placement-group path with a BANNER body', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? 'GET';
      calledBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { groupId: 'g_1', state: 'REGISTERING' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await createAdsPlacementGroup(
      {
        workspaceId: 3095,
        miniAppId: 31146,
        displayName: 'Home banner',
        adFormat: 'BANNER',
        adStyles: ['NORMAL'],
      },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-ads-v2/placement-group',
    );
    expect(calledMethod).toBe('POST');
    expect(calledBody).toEqual({
      displayName: 'Home banner',
      adFormat: 'BANNER',
      adStyles: ['NORMAL'],
    });
    expect(got).toEqual({ groupId: 'g_1', extra: { groupId: 'g_1', state: 'REGISTERING' } });
  });

  it('includes categoryId for an INTERSTITIAL body and omits adStyles/rewardSettings', async () => {
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (_input, init) => {
      calledBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { groupId: 'g_2' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await createAdsPlacementGroup(
      {
        workspaceId: 3095,
        miniAppId: 31146,
        displayName: 'Full screen',
        adFormat: 'INTERSTITIAL',
        categoryId: 42,
      },
      cookies,
      { fetchImpl },
    );
    expect(calledBody).toEqual({
      displayName: 'Full screen',
      adFormat: 'INTERSTITIAL',
      categoryId: 42,
    });
  });

  it('includes categoryId + rewardSettings for a REWARDED body', async () => {
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (_input, init) => {
      calledBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { groupId: 'g_3' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await createAdsPlacementGroup(
      {
        workspaceId: 3095,
        miniAppId: 31146,
        displayName: 'Reward video',
        adFormat: 'REWARDED',
        categoryId: 7,
        rewardSettings: { unitType: 'coin', unitAmount: 10 },
      },
      cookies,
      { fetchImpl },
    );
    expect(calledBody).toEqual({
      displayName: 'Reward video',
      adFormat: 'REWARDED',
      categoryId: 7,
      rewardSettings: { unitType: 'coin', unitAmount: 10 },
    });
  });

  it('falls back to a numeric `id` field and empty extra on an unexpected response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await createAdsPlacementGroup(
      { workspaceId: 3095, miniAppId: 31146, displayName: 'x', adFormat: 'BANNER' },
      cookies,
      { fetchImpl },
    );
    expect(got).toEqual({ groupId: undefined, extra: {} });
  });
});
