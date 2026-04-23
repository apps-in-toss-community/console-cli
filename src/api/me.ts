import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// Console-scoped "who am I" endpoint, discovered by observing the console UI
// boot requests. Returned shape is stable across the sample workspace; new
// fields may appear but we read it conservatively.

export interface ConsoleMemberWorkspace {
  readonly workspaceId: number;
  readonly workspaceName: string;
  readonly role: string;
  readonly isOwnerDelegationRequested: boolean;
}

export interface ConsoleMemberUserInfo {
  readonly id: number;
  readonly bizUserNo: number;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly workspaces: readonly ConsoleMemberWorkspace[];
  readonly isAdult: boolean;
  readonly isOverseasBusiness: boolean;
}

const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';
const MEMBER_USER_INFO_URL = `${BASE}/members/me/user-info`;

export async function fetchConsoleMemberUserInfo(
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ConsoleMemberUserInfo> {
  return requestConsoleApi<ConsoleMemberUserInfo>({
    url: MEMBER_USER_INFO_URL,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

// Console account-level terms (distinct from workspace-level terms).
// `/console-user-terms/me` returns the user's own acceptance of the
// top-level console TOS, which is required to use the console at all.
// Shape matches the workspace-terms bucket entries exactly.
export interface UserTerm {
  readonly required: boolean;
  readonly termsId: number;
  readonly revisionId: number;
  readonly title: string;
  readonly contentsUrl: string;
  readonly actionType: string;
  readonly isAgreed: boolean;
  readonly isOneTimeConsent: boolean;
}

export async function fetchUserTerms(
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly UserTerm[]> {
  const url = `${BASE}/console-user-terms/me`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected user-terms shape: not an array');
  }
  return raw.map((entry, i): UserTerm => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Unexpected user-terms entry at index ${i}`);
    }
    const e = entry as Record<string, unknown>;
    return {
      required: Boolean(e.required),
      termsId: typeof e.termsId === 'number' ? e.termsId : 0,
      revisionId: typeof e.revisionId === 'number' ? e.revisionId : 0,
      title: typeof e.title === 'string' ? e.title : '',
      contentsUrl: typeof e.contentsUrl === 'string' ? e.contentsUrl : '',
      actionType: typeof e.actionType === 'string' ? e.actionType : '',
      isAgreed: Boolean(e.isAgreed),
      isOneTimeConsent: Boolean(e.isOneTimeConsent),
    };
  });
}
