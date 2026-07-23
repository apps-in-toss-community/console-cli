import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchPromotionMoneyBalance, fetchPromotionMoneyHistories } from './promotion-money.js';

// Confirmed live 2026-07-24, workspace 3095 (issue #226): both endpoints
// returned zeroed/empty state (no promotion-money campaigns run yet).

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

describe('fetchPromotionMoneyBalance', () => {
  it('hits /workspaces/:wid/promotion-money and returns the confirmed zeroed shape', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({ resultType: 'SUCCESS', success: { balance: 0, availableBalance: 0 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchPromotionMoneyBalance(3095, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/promotion-money',
    );
    expect(got.balance).toBe(0);
    expect(got.availableBalance).toBe(0);
  });

  it('carries extra server fields through under `extra`', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { balance: 1000, availableBalance: 500, currency: 'KRW' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchPromotionMoneyBalance(3095, cookies, { fetchImpl });
    expect(got.balance).toBe(1000);
    expect(got.availableBalance).toBe(500);
    expect(got.extra).toEqual({ currency: 'KRW' });
  });
});

describe('fetchPromotionMoneyHistories', () => {
  it('hits /workspaces/:wid/promotion-money/histories with an optional page param', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await fetchPromotionMoneyHistories({ workspaceId: 3095, page: 1 }, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/promotion-money/histories?page=1',
    );
  });

  it('normalises a bare-array response (confirmed empty-list shape)', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchPromotionMoneyHistories({ workspaceId: 3095 }, cookies, { fetchImpl });
    expect(got).toEqual({ contents: [], totalPage: 0, currentPage: 0 });
  });

  it('normalises a page-object response (⚠️ inferred wrapper, other list endpoints use this shape)', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { contents: [{ id: 'h1' }], totalPage: 1, currentPage: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchPromotionMoneyHistories({ workspaceId: 3095 }, cookies, { fetchImpl });
    expect(got).toEqual({ contents: [{ id: 'h1' }], totalPage: 1, currentPage: 0 });
  });

  it('rejects a genuinely unexpected shape', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: 'nope' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchPromotionMoneyHistories({ workspaceId: 3095 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected promotion-money histories shape/);
  });
});
