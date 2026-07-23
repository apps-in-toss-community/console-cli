import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { fetchBusinessVerificationLicense } from './business-verification.js';
import type { FetchLike } from './http.js';

// Confirmed live 2026-07-24, workspace 3095 (issue #226): HTTP 200 /
// resultType SUCCESS, but the success payload embeds a business-level
// `errorCode: 500` meaning "license not registered". This is NOT a
// TossApiError (that only fires on resultType FAIL) — see module comment.

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

describe('fetchBusinessVerificationLicense', () => {
  it('hits /workspaces/:wid/business-verification/license/data', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { errorCode: 500 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await fetchBusinessVerificationLicense(3095, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/business-verification/license/data',
    );
  });

  it('does NOT throw on the confirmed embedded errorCode:500 — surfaces registered:false instead', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { errorCode: 500 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchBusinessVerificationLicense(3095, cookies, { fetchImpl });
    expect(got.registered).toBe(false);
    expect(got.errorCode).toBe(500);
  });

  it('treats an errorCode-free payload as registered', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { businessName: '<workspace_name>', licenseType: 'INDIVIDUAL' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchBusinessVerificationLicense(3095, cookies, { fetchImpl });
    expect(got.registered).toBe(true);
    expect(got.errorCode).toBeNull();
    expect(got.extra).toEqual({ businessName: '<workspace_name>', licenseType: 'INDIVIDUAL' });
  });

  it('still throws TossApiError on a genuine transport-level FAIL envelope', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 1, errorCode: '4010', reason: 'unauthorized' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchBusinessVerificationLicense(3095, cookies, { fetchImpl })).rejects.toThrow(
      /4010/,
    );
  });
});
