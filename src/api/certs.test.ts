import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { fetchCerts, issueCert, revokeCert } from './certs.js';
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
