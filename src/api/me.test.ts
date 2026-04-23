import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import { fetchConsoleMemberUserInfo, fetchUserTerms } from './me.js';

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

describe('fetchUserTerms', () => {
  it('hits /console-user-terms/me and normalises each term entry', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              required: true,
              termsId: 11157,
              revisionId: 55459,
              title: '앱인토스 콘솔 이용약관',
              contentsUrl: 'https://service.toss.im/terms/11157/revisions/55459',
              actionType: 'NONE',
              isAgreed: true,
              isOneTimeConsent: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchUserTerms(cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/console-user-terms/me',
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      required: true,
      termsId: 11157,
      revisionId: 55459,
      title: '앱인토스 콘솔 이용약관',
      contentsUrl: 'https://service.toss.im/terms/11157/revisions/55459',
      actionType: 'NONE',
      isAgreed: true,
      isOneTimeConsent: false,
    });
  });

  it('rejects a non-array success payload', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { not: 'an array' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchUserTerms(cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected user-terms shape/,
    );
  });

  it('coerces missing fields to safe defaults', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [{ required: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchUserTerms(cookies, { fetchImpl });
    expect(got[0]).toEqual({
      required: true,
      termsId: 0,
      revisionId: 0,
      title: '',
      contentsUrl: '',
      actionType: '',
      isAgreed: false,
      isOneTimeConsent: false,
    });
  });
});
