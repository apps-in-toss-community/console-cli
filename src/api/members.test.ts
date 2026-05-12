import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchWorkspaceMembers, inviteMember, removeMember } from './members.js';

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

describe('inviteMember', () => {
  it('POSTs to /workspaces/:id/invites/send/by-email with email body', async () => {
    let calledUrl = '';
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await inviteMember(36577, 'bob@example.com', undefined, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/invites/send/by-email',
    );
    expect(calledBody).toEqual({ email: 'bob@example.com' });
    expect(result.raw).toBeNull();
  });

  it('includes role in the body when provided', async () => {
    let calledBody: unknown;
    const fetchImpl: FetchLike = async (_input, init) => {
      calledBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: { invited: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await inviteMember(36577, 'bob@example.com', 'MEMBER', cookies, { fetchImpl });
    expect(calledBody).toEqual({ email: 'bob@example.com', role: 'MEMBER' });
  });
});

describe('removeMember', () => {
  it('DELETEs /workspaces/:id/members/:bizUserNo', async () => {
    let calledUrl = '';
    let calledMethod = '';
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? 'GET';
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await removeMember(36577, 248610, cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/36577/members/248610',
    );
    expect(calledMethod).toBe('DELETE');
  });
});
