import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import type { FetchLike } from './http.js';
import {
  fetchWorkspaceDetail,
  fetchWorkspacePartner,
  fetchWorkspaceSegments,
  fetchWorkspaceTerms,
} from './workspaces.js';

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

describe('fetchWorkspaceTerms', () => {
  it('hits /console-workspace-terms/:type/skip-permission with the type segment', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              required: true,
              termsId: 11660,
              revisionId: 56702,
              title: '[제휴용] 개인(신용)정보 보안관리 약정서',
              contentsUrl: 'https://service.toss.im/terms/11660/revisions/56702',
              actionType: 'NONE',
              isAgreed: false,
              isOneTimeConsent: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchWorkspaceTerms(3095, 'TOSS_LOGIN', cookies, { fetchImpl });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/console-workspace-terms/TOSS_LOGIN/skip-permission',
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      required: true,
      termsId: 11660,
      revisionId: 56702,
      title: '[제휴용] 개인(신용)정보 보안관리 약정서',
      contentsUrl: 'https://service.toss.im/terms/11660/revisions/56702',
      actionType: 'NONE',
      isAgreed: false,
      isOneTimeConsent: false,
    });
  });

  it('returns an empty array when the feature has no prerequisite terms', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const got = await fetchWorkspaceTerms(3095, 'IAA', cookies, { fetchImpl });
    expect(got).toEqual([]);
  });

  it('rejects a non-array success payload', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { not: 'an array' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchWorkspaceTerms(3095, 'IAP', cookies, { fetchImpl })).rejects.toThrow(
      /Unexpected workspace terms shape/,
    );
  });

  it('coerces missing string fields to empty strings so consumers can trust the types', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              required: true,
              // all other fields missing
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchWorkspaceTerms(3095, 'BIZ_WORKSPACE', cookies, { fetchImpl });
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

describe('fetchWorkspaceSegments', () => {
  it('hits /segments/list with category/search/page defaults', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { contents: [], totalPage: 0, currentPage: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchWorkspaceSegments({ workspaceId: 3095 }, cookies, { fetchImpl });
    // Default category matches the UI's initial tab ('생성된 세그먼트') — URL-encoded.
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/3095/segments/list?category=%EC%83%9D%EC%84%B1%EB%90%9C+%EC%84%B8%EA%B7%B8%EB%A8%BC%ED%8A%B8&search=&page=0',
    );
    expect(got).toEqual({ contents: [], totalPage: 0, currentPage: 0 });
  });

  it('forwards category/search/page overrides', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: { contents: [], totalPage: 3, currentPage: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchWorkspaceSegments(
      { workspaceId: 3095, category: '추천 세그먼트', search: 'vip', page: 1 },
      cookies,
      { fetchImpl },
    );
    expect(calledUrl).toContain('category=%EC%B6%94%EC%B2%9C+%EC%84%B8%EA%B7%B8%EB%A8%BC%ED%8A%B8');
    expect(calledUrl).toContain('search=vip');
    expect(calledUrl).toContain('page=1');
    expect(got.currentPage).toBe(1);
    expect(got.totalPage).toBe(3);
  });

  it('passes segment records through opaquely', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: {
            contents: [{ id: 1, name: 'VIP users', userCount: 1234, newField: 1 }],
            totalPage: 1,
            currentPage: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const got = await fetchWorkspaceSegments({ workspaceId: 3095 }, cookies, { fetchImpl });
    expect(got.contents).toHaveLength(1);
    expect(got.contents[0]).toEqual({ id: 1, name: 'VIP users', userCount: 1234, newField: 1 });
  });

  it('rejects non-object success payloads', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchWorkspaceSegments({ workspaceId: 3095 }, cookies, { fetchImpl }),
    ).rejects.toThrow(/Unexpected segments shape/);
  });
});
