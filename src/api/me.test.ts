import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchConsoleMemberUserInfo } from './me.js';

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

describe('fetchConsoleMemberUserInfo', () => {
  it('hits the discovered /members/me/user-info endpoint and returns the shape', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            id: 19375,
            bizUserNo: 290326,
            name: '최병훈',
            email: 'dave.v2@toss.im',
            role: 'MEMBER',
            workspaces: [
              {
                workspaceId: 59,
                workspaceName: 'rn-framework',
                role: 'MEMBER',
                isOwnerDelegationRequested: false,
              },
            ],
            isAdult: true,
            isOverseasBusiness: false,
            minorConsents: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const result = await fetchConsoleMemberUserInfo(cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/members/me/user-info',
    );
    expect(result.id).toBe(19375);
    expect(result.email).toBe('dave.v2@toss.im');
    expect(result.workspaces[0]?.workspaceName).toBe('rn-framework');
  });
});
