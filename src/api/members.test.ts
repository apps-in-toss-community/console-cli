import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchWorkspaceMembers } from './members.js';

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

describe('fetchWorkspaceMembers', () => {
  it('hits /workspaces/:id/members and normalises the shape', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              workspaceId: 36577,
              bizUserNo: 248610,
              name: '최병훈',
              email: 'dave.dev@icloud.com',
              status: 'ACTIVE',
              role: 'OWNER',
              isOwnerDelegationRequested: false,
              isAdult: true,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const members = await fetchWorkspaceMembers(36577, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/members',
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      workspaceId: 36577,
      bizUserNo: 248610,
      name: '최병훈',
      email: 'dave.dev@icloud.com',
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });

  it('throws when the response is not an array', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { bizUserNo: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchWorkspaceMembers(1, cookies, { fetchImpl })).rejects.toThrow(/not an array/);
  });

  it('throws when a required string field is missing', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            { workspaceId: 1, bizUserNo: 2, email: 'a@b', status: 'ACTIVE', role: 'OWNER' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(fetchWorkspaceMembers(1, cookies, { fetchImpl })).rejects.toThrow(/missing name/);
  });
});
