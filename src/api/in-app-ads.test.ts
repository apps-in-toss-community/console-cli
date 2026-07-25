import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import {
  createAdsPlacementGroup,
  extractAppCategoryId,
  fetchAdMobAdInfo,
  fetchAdsAbuseStatus,
  fetchAdsPlacementGroups,
  resolveAdCategoryId,
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

// --- Ad category id resolution (issue #231) ---
//
// #229 shipped `create` with `--category` hard-required for non-BANNER
// formats because no category-candidate endpoint was known. #231's
// 2026-07-24 live measurement (workspace 3095 / app 31146) found the ad
// categoryId is the app's own impression category id, sanity-checked via
// `ad-mob-ad-info`. These tests pin `extractAppCategoryId`'s pure
// extraction, `fetchAdMobAdInfo`'s request/response normalisation for all
// three observed shapes (valid / explicit reason / cat-0 null placeholder),
// and `resolveAdCategoryId`'s composition of both calls.

describe('extractAppCategoryId', () => {
  it('reads category.id from the first categoryPaths entry', () => {
    const miniApp = {
      impression: {
        categoryPaths: [
          {
            group: { id: 1, name: '생활' },
            category: { id: 3882, name: '정보' },
            subCategory: { id: 10, name: '뉴스' },
          },
        ],
      },
    };
    expect(extractAppCategoryId(miniApp)).toBe(3882);
  });

  it('returns null for a null miniApp', () => {
    expect(extractAppCategoryId(null)).toBeNull();
  });

  it('returns null when impression is missing or not an object', () => {
    expect(extractAppCategoryId({})).toBeNull();
    expect(extractAppCategoryId({ impression: null })).toBeNull();
    expect(extractAppCategoryId({ impression: 'nope' })).toBeNull();
  });

  it('returns null when categoryPaths is missing or empty', () => {
    expect(extractAppCategoryId({ impression: {} })).toBeNull();
    expect(extractAppCategoryId({ impression: { categoryPaths: [] } })).toBeNull();
  });

  it('returns null when the first entry has no positive-integer category.id', () => {
    expect(
      extractAppCategoryId({
        impression: { categoryPaths: [{ category: { name: '정보' } }] },
      }),
    ).toBeNull();
    expect(
      extractAppCategoryId({
        impression: { categoryPaths: [{ category: { id: 0 } }] },
      }),
    ).toBeNull();
    expect(
      extractAppCategoryId({
        impression: { categoryPaths: [{ category: { id: -1 } }] },
      }),
    ).toBeNull();
  });
});

describe('fetchAdMobAdInfo', () => {
  it('hits /mini-app/:aid/in-app-ads-v2/category/:cid/ad-mob-ad-info/:format and normalises a valid response', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { id: 179, categoryId: 3882, category: { id: 179, name: 'News' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchAdMobAdInfo(
      { workspaceId: 3095, miniAppId: 31146, categoryId: 3882, adFormat: 'INTERSTITIAL' },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-ads-v2/category/3882/ad-mob-ad-info/INTERSTITIAL',
    );
    expect(got).toEqual({
      valid: true,
      info: { id: 179, categoryId: 3882, category: { id: 179, name: 'News' } },
      reason: null,
    });
  });

  it('normalises an explicit-reason invalid response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ resultType: 'SUCCESS', success: { reason: 'not exist category : 999' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchAdMobAdInfo(
      { workspaceId: 3095, miniAppId: 31146, categoryId: 999, adFormat: 'REWARDED' },
      cookies,
      { fetchImpl },
    );
    expect(got).toEqual({ valid: false, info: null, reason: 'not exist category : 999' });
  });

  it('normalises the cat-0 `success: null` placeholder/fallback response as invalid', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchAdMobAdInfo(
      { workspaceId: 3095, miniAppId: 31146, categoryId: 0, adFormat: 'INTERSTITIAL' },
      cookies,
      { fetchImpl },
    );
    expect(got).toEqual({ valid: false, info: null, reason: null });
  });
});

describe('resolveAdCategoryId', () => {
  const detailUrl =
    'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146';

  function detailResponse(categoryId: number | undefined) {
    return {
      resultType: 'SUCCESS',
      success: {
        isBeforeFirstReview: false,
        hasApproved: true,
        hasInReview: false,
        hasDraft: false,
        approvalType: 'APPROVED',
        rejectedMessage: null,
        miniApp:
          categoryId === undefined
            ? { miniAppId: 31146, impression: { categoryPaths: [] } }
            : {
                miniAppId: 31146,
                impression: {
                  categoryPaths: [{ category: { id: categoryId, name: '정보' } }],
                },
              },
      },
    };
  }

  it('resolves categoryId from the app detail and reports validated:true on a valid ad-mob-ad-info answer', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = input instanceof URL ? input.toString() : String(input);
      if (url === detailUrl) {
        return new Response(JSON.stringify(detailResponse(3882)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // ad-mob-ad-info call
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { id: 179, categoryId: 3882, category: {} },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await resolveAdCategoryId(
      { workspaceId: 3095, miniAppId: 31146, adFormat: 'INTERSTITIAL' },
      cookies,
      { fetchImpl },
    );
    expect(got).toEqual({ ok: true, categoryId: 3882, validated: true });
  });

  it('fails with category-not-resolved when the app has no impression category path', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify(detailResponse(undefined)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await resolveAdCategoryId(
      { workspaceId: 3095, miniAppId: 31146, adFormat: 'REWARDED' },
      cookies,
      { fetchImpl },
    );
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe('category-not-resolved');
      expect(got.message).toMatch(/--category/);
    }
  });

  it('fails with category-invalid when ad-mob-ad-info explicitly rejects the resolved category', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = input instanceof URL ? input.toString() : String(input);
      if (url === detailUrl) {
        return new Response(JSON.stringify(detailResponse(3882)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { reason: 'not exist category : 3882' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await resolveAdCategoryId(
      { workspaceId: 3095, miniAppId: 31146, adFormat: 'REWARDED' },
      cookies,
      { fetchImpl },
    );
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe('category-invalid');
      if (got.reason === 'category-invalid') expect(got.categoryId).toBe(3882);
      expect(got.message).toMatch(/--category/);
    }
  });

  it('degrades to validated:false (does not throw) when the ad-mob-ad-info call itself fails', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = input instanceof URL ? input.toString() : String(input);
      if (url === detailUrl) {
        return new Response(JSON.stringify(detailResponse(3882)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('network down');
    };
    const got = await resolveAdCategoryId(
      { workspaceId: 3095, miniAppId: 31146, adFormat: 'INTERSTITIAL' },
      cookies,
      { fetchImpl },
    );
    expect(got).toEqual({ ok: true, categoryId: 3882, validated: false });
  });
});
