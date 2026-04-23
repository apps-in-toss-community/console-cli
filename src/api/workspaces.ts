import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// The list of workspaces a user can see is already baked into the
// `members/me/user-info` response (see `./me.ts`), so we don't expose a
// separate `GET /workspaces` wrapper — every caller that needs the list
// goes through `fetchConsoleMemberUserInfo` and keys off `workspaces`.
// This module only covers per-workspace detail and future write endpoints.

// Note: the list endpoint (members/me/user-info) and the detail endpoint
// disagree on field names — list uses workspaceId/workspaceName while
// detail uses id/name. We normalise detail into the same vocabulary so
// callers don't have to track which endpoint they came from.
export interface WorkspaceDetail {
  readonly workspaceId: number;
  readonly workspaceName: string;
  // The full shape of `/workspaces/:id` has many secondary fields (business
  // registration, verification, licence type, review state, etc) that may
  // grow over time. Stash everything beyond the normalised keys under
  // `extra` so commands like `workspace show --json` can dump the payload
  // without us having to type every field up-front.
  readonly extra?: Readonly<Record<string, unknown>>;
}

const WORKSPACES_BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export async function fetchWorkspaceDetail(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<WorkspaceDetail> {
  // workspaceId is a number at compile time — `encodeURIComponent` on the
  // stringified form would be a no-op, so we inline the interpolation.
  const url = `${WORKSPACES_BASE}/workspaces/${workspaceId}`;
  const raw = await requestConsoleApi<Record<string, unknown>>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const id = raw.id;
  const name = raw.name;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || typeof name !== 'string') {
    throw new Error(`Unexpected workspace detail shape for id=${workspaceId}`);
  }
  const { id: _id, name: _name, ...extra } = raw;
  return { workspaceId: id, workspaceName: name, extra };
}

// Partner = the billing/payout entity that must be registered before
// promotions/IAP can be used. `registered: false` + `approvalType: 'DRAFT'`
// is the initial state we observed on a fresh workspace. `partner` is the
// detail record once approval lands; keep it opaque until we see a live
// example.
export interface WorkspacePartnerState {
  readonly registered: boolean;
  readonly approvalType: string | null;
  readonly rejectMessage: string | null;
  readonly partner: Readonly<Record<string, unknown>> | null;
}

export async function fetchWorkspacePartner(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<WorkspacePartnerState> {
  const url = `${WORKSPACES_BASE}/workspaces/${workspaceId}/partner`;
  const raw = await requestConsoleApi<Record<string, unknown>>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const registered = raw.registered;
  if (typeof registered !== 'boolean') {
    throw new Error(`Unexpected workspace partner shape for id=${workspaceId}`);
  }
  const approvalType = typeof raw.approvalType === 'string' ? raw.approvalType : null;
  const rejectMessage = typeof raw.rejectMessage === 'string' ? raw.rejectMessage : null;
  const partner =
    raw.partner && typeof raw.partner === 'object'
      ? (raw.partner as Readonly<Record<string, unknown>>)
      : null;
  return { registered, approvalType, rejectMessage, partner };
}

// `console-workspace-terms/:type/skip-permission` returns the terms a
// workspace owner must agree to before the feature gated by `:type`
// becomes available. The supported types are enumerated here verbatim
// from the console UI — each one gates a distinct feature surface
// (Toss login scopes, biz workspace eligibility, promotion-money,
// in-app advertising, in-app purchase). Other values currently 404.
export const WORKSPACE_TERM_TYPES = [
  'TOSS_LOGIN',
  'BIZ_WORKSPACE',
  'TOSS_PROMOTION_MONEY',
  'IAA',
  'IAP',
] as const;
export type WorkspaceTermType = (typeof WORKSPACE_TERM_TYPES)[number];

export interface WorkspaceTerm {
  readonly required: boolean;
  readonly termsId: number;
  readonly revisionId: number;
  readonly title: string;
  readonly contentsUrl: string;
  readonly actionType: string;
  readonly isAgreed: boolean;
  readonly isOneTimeConsent: boolean;
}

export async function fetchWorkspaceTerms(
  workspaceId: number,
  type: WorkspaceTermType,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly WorkspaceTerm[]> {
  const url = `${WORKSPACES_BASE}/workspaces/${workspaceId}/console-workspace-terms/${type}/skip-permission`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected workspace terms shape for type=${type}`);
  }
  return raw.map((entry, i): WorkspaceTerm => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Unexpected workspace terms entry at index ${i} for type=${type}`);
    }
    const e = entry as Record<string, unknown>;
    // The console UI currently always sends all fields, and Zod-level
    // strict validation would break if Toss adds an enum value. Trust
    // the types we rely on and pass through with a narrow normalisation.
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
