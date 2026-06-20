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

// Optional `termsScope` query bucket on `/console-user-terms/me`. The
// console SPA reads this same account-level endpoint with a `termsScope`
// query param to surface scope-specific terms. The only non-default scope
// we've captured is `AI_RISK_USE` — the AI-risk disclosure + usage terms
// (혁신금융서비스 위험 고지) that gate errorCode 5010 at the account level
// (blocking every workspace, not just one). Captured 2026-06-17 from
// `혁신금융서비스약관동의Page` → `console-user-terms/me?termsScope=AI_RISK_USE`
// GET / `console-user-terms/me` POST. The SPA route is `/ai-risk-use-terms`.
export const USER_TERM_SCOPES = ['AI_RISK_USE'] as const;
export type UserTermScope = (typeof USER_TERM_SCOPES)[number];

export async function fetchUserTerms(
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike; scope?: UserTermScope } = {},
): Promise<readonly UserTerm[]> {
  // Default (no scope) returns the top-level console TOS bucket. A scope
  // such as `AI_RISK_USE` selects the scope-specific bucket on the same
  // account-level endpoint.
  const url =
    opts.scope !== undefined
      ? `${BASE}/console-user-terms/me?termsScope=${encodeURIComponent(opts.scope)}`
      : `${BASE}/console-user-terms/me`;
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

// `(termsId, revisionId)` pair the agree endpoint expects per term. Kept
// narrow on purpose — `UserTerm` carries title/actionType/isAgreed that
// the server has no use for on submit. Mirrors `WorkspaceTermAgreement`.
export interface UserTermAgreement {
  readonly termsId: number;
  readonly revisionId: number;
}

/**
 * Persist agreement for one-or-more account-level (`/console-user-terms/me`)
 * terms. Used for AI-risk usage terms (`AI_RISK_USE` scope) among others.
 * The endpoint takes a single `agreedList` regardless of scope — the scope
 * is implicit in the (termsId, revisionId) pairs.
 *
 * Captured shape (2026-06-17, `혁신금융서비스약관동의Page`):
 *   - `POST /console-user-terms/me` with body
 *     `{"agreedList":[{"termsId": <int>, "revisionId": <int>}, ...]}`
 *   - The submit mirrors the workspace-terms POST exactly (no workspaceId
 *     in the path — this is account-level, blocking every workspace).
 *
 * This is a LEGAL consent. Callers must surface `contentsUrl`/title and
 * gate on explicit user confirmation before invoking — no auto-agree.
 *
 * Failure surfaces through `TossApiError` like every other write helper.
 */
export async function agreeUserTerms(
  terms: readonly UserTermAgreement[],
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  if (terms.length === 0) {
    throw new Error('agreeUserTerms requires at least one term');
  }
  const url = `${BASE}/console-user-terms/me`;
  await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    cookies,
    body: { agreedList: terms.map(({ termsId, revisionId }) => ({ termsId, revisionId })) },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
