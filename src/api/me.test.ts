import { describe, expect, it } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { type FetchLike, TossApiError } from './http.js';
import {
  agreeUserTerms,
  fetchConsoleMemberUserInfo,
  fetchUserTerms,
  probeAiRiskTerms,
} from './me.js';

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

  it('appends ?termsScope=AI_RISK_USE when a scope is given', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      return new Response(
        JSON.stringify({
          resultType: 'SUCCESS',
          success: [
            {
              required: true,
              termsId: 87304,
              revisionId: 65672,
              title: '앱인토스 혁신금융서비스에 관한 위험 고지 및 이용 약관',
              contentsUrl: 'https://service.toss.im/terms/87304/revisions/65672',
              actionType: 'NONE',
              isAgreed: false,
              isOneTimeConsent: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const got = await fetchUserTerms(cookies, { fetchImpl, scope: 'AI_RISK_USE' });
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/console-user-terms/me?termsScope=AI_RISK_USE',
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.termsId).toBe(87304);
    expect(got[0]?.isAgreed).toBe(false);
  });
});

describe('probeAiRiskTerms', () => {
  function makeTermsFetch(terms: unknown[]): FetchLike {
    return async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: terms }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }

  it('returns agreed when all required terms are isAgreed', async () => {
    const fetchImpl = makeTermsFetch([
      {
        required: true,
        termsId: 1,
        revisionId: 1,
        title: 'T',
        contentsUrl: 'U',
        actionType: 'NONE',
        isAgreed: true,
        isOneTimeConsent: false,
      },
    ]);
    const result = await probeAiRiskTerms(cookies, { fetchImpl });
    expect(result.status).toBe('agreed');
  });

  it('returns pending with the unagreed term when required && !isAgreed', async () => {
    const fetchImpl = makeTermsFetch([
      {
        required: true,
        termsId: 2,
        revisionId: 1,
        title: 'AI Risk',
        contentsUrl: 'https://example.com/ai-risk',
        actionType: 'NONE',
        isAgreed: false,
        isOneTimeConsent: false,
      },
    ]);
    const result = await probeAiRiskTerms(cookies, { fetchImpl });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      expect(result.pending).toHaveLength(1);
      expect(result.pending[0]?.title).toBe('AI Risk');
    }
  });

  it('returns agreed (not pending) when optional (!required) && !isAgreed (false nag prevention)', async () => {
    const fetchImpl = makeTermsFetch([
      {
        required: false,
        termsId: 3,
        revisionId: 1,
        title: 'Optional',
        contentsUrl: 'U',
        actionType: 'NONE',
        isAgreed: false,
        isOneTimeConsent: false,
      },
    ]);
    const result = await probeAiRiskTerms(cookies, { fetchImpl });
    expect(result.status).toBe('agreed');
  });

  it('returns agreed when the array is empty (nothing required)', async () => {
    const fetchImpl = makeTermsFetch([]);
    const result = await probeAiRiskTerms(cookies, { fetchImpl });
    expect(result.status).toBe('agreed');
  });

  it('returns unknown when fetch throws (network error) — never throws itself', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await probeAiRiskTerms(cookies, { fetchImpl });
    expect(result.status).toBe('unknown');
  });

  it('returns unknown when success payload is not an array (fetchUserTerms throws)', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ resultType: 'SUCCESS', success: { not: 'an array' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const result = await probeAiRiskTerms(cookies, { fetchImpl });
    expect(result.status).toBe('unknown');
  });

  it('returns unknown when fetchImpl never resolves (timeout guard)', async () => {
    const fetchImpl: FetchLike = () => new Promise(() => {}); // hangs forever
    const result = await probeAiRiskTerms(cookies, { fetchImpl, timeoutMs: 50 });
    expect(result.status).toBe('unknown');
  });
});

describe('agreeUserTerms', () => {
  it('POSTs to /console-user-terms/me with an agreedList payload', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody = '';
    const fetchImpl: FetchLike = async (input, init) => {
      calledUrl = input instanceof URL ? input.toString() : String(input);
      calledMethod = init?.method ?? 'GET';
      calledBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({ resultType: 'SUCCESS', success: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await agreeUserTerms([{ termsId: 87304, revisionId: 65672 }], cookies, { fetchImpl });
    expect(calledMethod).toBe('POST');
    expect(calledUrl).toBe(
      'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/console-user-terms/me',
    );
    expect(JSON.parse(calledBody)).toEqual({
      agreedList: [{ termsId: 87304, revisionId: 65672 }],
    });
  });

  it('throws synchronously on an empty term list (server is non-idempotent)', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response('', { status: 200 });
    };
    await expect(agreeUserTerms([], cookies, { fetchImpl })).rejects.toThrow(/at least one term/);
    expect(called).toBe(false);
  });

  it('surfaces server-side failures as TossApiError', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          resultType: 'FAIL',
          success: null,
          error: { errorType: 0, errorCode: '500', reason: 'already-agreed' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    await expect(
      agreeUserTerms([{ termsId: 1, revisionId: 1 }], cookies, { fetchImpl }),
    ).rejects.toBeInstanceOf(TossApiError);
  });
});
