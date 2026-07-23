import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchPayConfigStatus } from './pay-config.js';

// ★ SECRET-HANDLING ★ — these tests only ever assert on the masked
// 'SET'/'UNSET' output. The fixture bodies below include throwaway literal
// strings purely to drive the mocked fetchImpl (never real credentials);
// none of those literal values are asserted against in `expect(...)`.

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

describe('fetchPayConfigStatus', () => {
  it('hits /workspaces/:wid/configs and masks every field UNSET when null/empty', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            workspaceId: 3095,
            payApiKey: null,
            testPayApiKey: '',
            billingPayApiKey: null,
            testBillingPayApiKey: null,
            tossCertClientId: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchPayConfigStatus(3095, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/configs',
    );
    expect(got).toEqual({
      workspaceId: 3095,
      payApiKey: 'UNSET',
      testPayApiKey: 'UNSET',
      billingPayApiKey: 'UNSET',
      testBillingPayApiKey: 'UNSET',
      tossCertClientId: 'UNSET',
    });
  });

  it('masks a populated field as SET without leaking the value into the return shape', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            workspaceId: 3095,
            payApiKey: 'not-a-real-key-fixture-value',
            testPayApiKey: null,
            billingPayApiKey: null,
            testBillingPayApiKey: null,
            tossCertClientId: 'not-a-real-client-id-fixture-value',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchPayConfigStatus(3095, cookies, { fetchImpl });
    expect(got.payApiKey).toBe('SET');
    expect(got.tossCertClientId).toBe('SET');
    expect(got.testPayApiKey).toBe('UNSET');
    // The returned object has exactly the masked keys — no raw-value field
    // sneaks through under a different name.
    expect(Object.keys(got).sort()).toEqual(
      [
        'workspaceId',
        'payApiKey',
        'testPayApiKey',
        'billingPayApiKey',
        'testBillingPayApiKey',
        'tossCertClientId',
      ].sort(),
    );
    expect(JSON.stringify(got)).not.toContain('fixture-value');
  });

  it('falls back to the requested workspaceId when the response omits it', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            payApiKey: null,
            testPayApiKey: null,
            billingPayApiKey: null,
            testBillingPayApiKey: null,
            tossCertClientId: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchPayConfigStatus(3095, cookies, { fetchImpl });
    expect(got.workspaceId).toBe(3095);
  });
});
