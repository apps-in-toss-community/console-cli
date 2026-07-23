import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import {
  createIapProduct,
  fetchIapOrders,
  fetchIapProduct,
  fetchIapProducts,
  fetchIapRefunds,
} from './in-app-purchase.js';

// These functions' *response* shapes are inferred (see in-app-purchase.ts
// module comment + docs/api/in-app-purchase.md) — we pin the request
// (URL/method/body) and a plausible response round-trip rather than
// asserting against a live-captured body we don't have.

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

describe('fetchIapProducts', () => {
  it('hits /mini-app/:aid/in-app-purchase/catalogs and returns the normalised page', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            contents: [{ productId: 1, productName: 'p1' }],
            totalPage: 1,
            currentPage: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchIapProducts({ workspaceId: 3095, miniAppId: 31146 }, cookies, {
      fetchImpl,
    });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-purchase/catalogs',
    );
    expect(got.contents).toEqual([{ productId: 1, productName: 'p1' }]);
    expect(got.totalPage).toBe(1);
  });

  it('serialises search/type/catalogStatus/page into the query string', async () => {
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
    await fetchIapProducts(
      {
        workspaceId: 3095,
        miniAppId: 31146,
        page: 2,
        search: 'coin',
        type: ['CONSUMABLE', 'SUBSCRIPTION'],
        catalogStatus: ['ACTIVE'],
      },
      cookies,
      { fetchImpl },
    );
    const url = new URL(calledUrl);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('search')).toBe('coin');
    expect(url.searchParams.getAll('type')).toEqual(['CONSUMABLE', 'SUBSCRIPTION']);
    expect(url.searchParams.getAll('catalogStatus')).toEqual(['ACTIVE']);
  });

  it('propagates the live-observed 5002 (partner not registered) TossApiError', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 1, errorCode: '5002', reason: '거래처 등록이 필요합니다.' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      fetchIapProducts({ workspaceId: 3095, miniAppId: 31146 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/5002/);
  });

  it('rejects a response whose contents is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { totalPage: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchIapProducts({ workspaceId: 3095, miniAppId: 31146 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected iap products shape/);
  });
});

describe('fetchIapProduct', () => {
  it('hits /mini-app/:aid/in-app-purchase/catalog/:productId and passes the body through opaquely', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({ resultType: 'SUCCESS', success: { productId: '42', productName: 'p' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchIapProduct(
      { workspaceId: 3095, miniAppId: 31146, productId: '42' },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-purchase/catalog/42',
    );
    expect(got).toEqual({ productId: '42', productName: 'p' });
  });
});

describe('fetchIapOrders', () => {
  it('hits /mini-app/:aid/in-app-purchase/orders with an optional page param', async () => {
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
    await fetchIapOrders({ workspaceId: 3095, miniAppId: 31146, page: 1 }, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-purchase/orders?page=1',
    );
  });
});

describe('fetchIapRefunds', () => {
  it('hits /mini-app/:aid/in-app-purchase/refunds', async () => {
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
    await fetchIapRefunds({ workspaceId: 3095, miniAppId: 31146 }, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-purchase/refunds',
    );
  });
});

describe('createIapProduct', () => {
  // SECRET-HANDLING / dog-food policy: this function is never invoked
  // against the real console API in this repo (no live registration
  // testing) — only against a mocked fetchImpl, same as createMiniApp in
  // mini-apps-register.test.ts.
  it('POSTs to .../product/inspection with currency/defaultLocale hardcoded and empty discountPolicies for non-subscription types', async () => {
    let calledUrl = '';
    let calledMethod: string | undefined;
    let calledBody: string | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method;
      calledBody = typeof init?.body === 'string' ? init.body : undefined;
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { productId: 99 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await createIapProduct(
      {
        workspaceId: 3095,
        miniAppId: 31146,
        type: 'CONSUMABLE',
        name: 'coin pack',
        description: '100 coins',
        price: 1000,
        iconImgUrl: 'https://cdn.example/icon.png',
        minDeploymentId: 7,
        postInspectionStatus: 'INACTIVE',
      },
      cookies,
      { fetchImpl },
    );
    expect(calledMethod).toBe('POST');
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/mini-app/31146/in-app-purchase/product/inspection',
    );
    const parsed = calledBody ? JSON.parse(calledBody) : null;
    expect(parsed.currency).toBe('KRW');
    expect(parsed.defaultLocale).toBe('KO_KR');
    expect(parsed.discountPolicies).toEqual([]);
    expect(parsed.renewalCycle).toBeUndefined();
    expect(result.productId).toBe(99);
  });

  it('includes renewalCycle and discountPolicies for SUBSCRIPTION type', async () => {
    let calledBody: string | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
      calledBody = typeof init?.body === 'string' ? init.body : undefined;
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { productId: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await createIapProduct(
      {
        workspaceId: 3095,
        miniAppId: 31146,
        type: 'SUBSCRIPTION',
        name: 'monthly plan',
        description: 'monthly membership',
        price: 5000,
        iconImgUrl: 'https://cdn.example/icon.png',
        minDeploymentId: 7,
        postInspectionStatus: 'INACTIVE',
        renewalCycle: 'MONTHLY',
        discountPolicies: [{ discountType: 'FREE_TRIAL', period: 7 }],
      },
      cookies,
      { fetchImpl },
    );
    const parsed = calledBody ? JSON.parse(calledBody) : null;
    expect(parsed.renewalCycle).toBe('MONTHLY');
    expect(parsed.discountPolicies).toEqual([{ discountType: 'FREE_TRIAL', period: 7 }]);
  });

  it('throws TossApiError on FAIL envelope', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 1, errorCode: 'BAD_REQUEST', reason: 'reject' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      createIapProduct(
        {
          workspaceId: 3095,
          miniAppId: 31146,
          type: 'CONSUMABLE',
          name: 'x',
          description: 'y',
          price: 1000,
          iconImgUrl: 'https://cdn.example/icon.png',
          minDeploymentId: 7,
          postInspectionStatus: 'INACTIVE',
        },
        cookies,
        { fetchImpl },
      ),
    ).rejects.toThrow(/BAD_REQUEST/);
  });
});
