import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchWorkspaceDetail, fetchWorkspacePartner } from './workspaces.js';

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

describe('fetchWorkspaceDetail', () => {
  it('hits /workspaces/:id and normalises id/name to workspaceId/workspaceName', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            id: 3095,
            name: '(주)프로덕트팩토리',
            licenseType: 'CORP',
            verified: true,
            reviewState: 'APPROVED',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchWorkspaceDetail(3095, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095',
    );
    expect(got.workspaceId).toBe(3095);
    expect(got.workspaceName).toBe('(주)프로덕트팩토리');
    expect(got.extra?.licenseType).toBe('CORP');
    expect(got.extra?.verified).toBe(true);
    expect(got.extra?.reviewState).toBe('APPROVED');
    // The normalised fields should not leak back into `extra`.
    expect(got.extra).not.toHaveProperty('id');
    expect(got.extra).not.toHaveProperty('name');
  });

  it('rejects a response missing id', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { name: 'no id here' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchWorkspaceDetail(3095, cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected workspace detail shape/,
    );
  });
});

describe('fetchWorkspacePartner', () => {
  it('hits /workspaces/:id/partner and returns the normalised state', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            registered: false,
            approvalType: 'DRAFT',
            rejectMessage: null,
            partner: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchWorkspacePartner(3095, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/partner',
    );
    expect(got).toEqual({
      registered: false,
      approvalType: 'DRAFT',
      rejectMessage: null,
      partner: null,
    });
  });

  it('keeps an opaque partner object when approval is populated', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            registered: true,
            approvalType: 'APPROVED',
            rejectMessage: null,
            partner: { id: 42, displayName: 'My Co.', unknownField: 1 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchWorkspacePartner(3095, cookies, { fetchImpl });
    expect(got.registered).toBe(true);
    expect(got.approvalType).toBe('APPROVED');
    expect(got.partner).toEqual({ id: 42, displayName: 'My Co.', unknownField: 1 });
  });

  it('rejects a response missing registered', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { approvalType: 'DRAFT', partner: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchWorkspacePartner(3095, cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected workspace partner shape/,
    );
  });

  it('nulls rejectMessage and partner when they are the wrong type', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            registered: false,
            approvalType: 42, // non-string
            rejectMessage: 123, // non-string
            partner: 'not-an-object',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchWorkspacePartner(3095, cookies, { fetchImpl });
    expect(got.approvalType).toBeNull();
    expect(got.rejectMessage).toBeNull();
    expect(got.partner).toBeNull();
  });
});
