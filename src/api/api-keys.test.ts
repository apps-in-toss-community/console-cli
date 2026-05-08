import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { createApiKey, disableApiKey, fetchApiKeys } from './api-keys.js';
import type { FetchLike } from './http.js';

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

describe('fetchApiKeys', () => {
  it('hits /workspaces/:id/api-keys and returns [] on an empty workspace', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const keys = await fetchApiKeys(36577, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/api-keys',
    );
    expect(keys).toEqual([]);
  });

  it('normalises id/name/expireTs and stashes the rest under extra', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              id: 'k_abc',
              name: 'ci-deploy',
              expireTs: 1_800_000_000_000,
              target: { isAll: true, appNames: [] },
            },
            { apiKeyId: 42, apiKeyName: 'alt-keys-entry' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const keys = await fetchApiKeys(1, cookies, { fetchImpl });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({
      id: 'k_abc',
      name: 'ci-deploy',
      expireTs: 1_800_000_000_000,
      extra: { target: { isAll: true, appNames: [] } },
    });
    // Fallback path: alternative field names still produce a usable summary.
    expect(keys[1]).toMatchObject({ id: 42, name: 'alt-keys-entry', expireTs: undefined });
    expect(keys[1]?.extra).toEqual({});
  });

  it('throws when a key entry is missing an id', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [{ name: 'no id here' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchApiKeys(1, cookies, { fetchImpl })).rejects.toThrow(/missing id/);
  });
});

describe('createApiKey', () => {
  it('POSTs name + target to /workspaces/:id/api-keys and returns the plaintext', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? '';
      calledBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { apiKey: 'aitc_live_xxxxxxxx', id: 'k_new', expireTs: 1_900_000_000_000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const result = await createApiKey(
      36577,
      { name: 'ci-deploy', target: { isAll: true, appNames: [] } },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/api-keys',
    );
    expect(calledMethod).toBe('POST');
    expect(calledBody).toEqual({
      workspaceId: 36577,
      name: 'ci-deploy',
      target: { isAll: true, appNames: [] },
    });
    expect(result.apiKey).toBe('aitc_live_xxxxxxxx');
    // `apiKey` is stripped from `extra`; everything else surfaces verbatim.
    expect(result.extra).toEqual({ id: 'k_new', expireTs: 1_900_000_000_000 });
  });

  it('passes appNames through unmodified for scoped keys', async () => {
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (_input, init) => {
      calledBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { apiKey: 'k' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await createApiKey(
      1,
      { name: 'scoped', target: { isAll: false, appNames: ['ait-sdk-example', 'foo'] } },
      cookies,
      { fetchImpl },
    );
    expect(calledBody).toEqual({
      workspaceId: 1,
      name: 'scoped',
      target: { isAll: false, appNames: ['ait-sdk-example', 'foo'] },
    });
  });

  it('throws when the response omits the plaintext key', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { id: 'k_x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      createApiKey(1, { name: 'x', target: { isAll: true, appNames: [] } }, cookies, { fetchImpl }),
    ).rejects.toThrow(/missing plaintext key/);
  });
});

describe('disableApiKey', () => {
  it('PUTs /workspaces/:id/api-keys/:keyId/disable', async () => {
    let calledUrl = '';
    let calledMethod = '';
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? '';
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await disableApiKey(36577, 'k_abc', cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/api-keys/k_abc/disable',
    );
    expect(calledMethod).toBe('PUT');
  });
});
