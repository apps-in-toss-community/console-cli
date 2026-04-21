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

const MEMBER_USER_INFO_URL =
  'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/members/me/user-info';

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
