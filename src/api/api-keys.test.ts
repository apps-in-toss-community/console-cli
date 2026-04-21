import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { fetchApiKeys } from './api-keys.js';
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

  it('normalises id/name and stashes the rest under extra', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            { id: 'k_abc', name: 'ci deploy', createdAt: '2026-04-20T00:00:00Z' },
            { apiKeyId: 42, apiKeyName: 'alt-keys entry' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const keys = await fetchApiKeys(1, cookies, { fetchImpl });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({
      id: 'k_abc',
      name: 'ci deploy',
      extra: { createdAt: '2026-04-20T00:00:00Z' },
    });
    expect(keys[1]).toMatchObject({ id: 42, name: 'alt-keys entry' });
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
