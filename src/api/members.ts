import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// GET /workspaces/:id/members — confirmed shape (as of 2026-04):
//   [{ workspaceId, bizUserNo, name, email, status, role,
//      isOwnerDelegationRequested, isAdult }]
// `bizUserNo` is the stable per-person identifier across workspaces.
//
// POST /workspaces/:id/invites/send/by-email — inferred (bundle static
//   analysis, 2026-05-08). method/path confirmed; payload shape inferred
//   as { email, role? } based on the UI "+ 초대하기" dialog. Response
//   shape uncaptured — we treat any SUCCESS as success and surface the
//   raw success payload opaquely for now.
//
// DELETE /workspaces/:id/members/:bizUserNo — inferred (bundle static
//   analysis, 2026-05-08). method/path confirmed; path param name
//   `memberBizUserNo` confirmed. Response shape uncaptured.

const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export interface WorkspaceMember {
  readonly workspaceId: number;
  readonly bizUserNo: number;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly role: string;
  readonly isOwnerDelegationRequested: boolean;
  readonly isAdult: boolean;
}

export async function fetchWorkspaceMembers(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<WorkspaceMember[]> {
  const url = `${BASE}/workspaces/${workspaceId}/members`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected members shape for workspace=${workspaceId}: not an array`);
  }
  return raw.map((entry, index) => normalizeMember(entry, workspaceId, index));
}

// --- Invite ---

export interface InviteMemberResult {
  /** Raw success payload from the server (shape uncaptured; opaque). */
  readonly raw: unknown;
}

/**
 * Invite a user by email to the workspace.
 *
 * Maps to `POST /workspaces/:wid/invites/send/by-email`. Payload shape is
 * inferred from static bundle analysis (PR #118); `role` is optional —
 * omit to use the server default.
 *
 * ⚠️ Inferred endpoint: method/path confirmed, payload/response/errorCodes
 * not live-captured. See docs/api/members.md "Invite 관련 endpoint".
 */
export async function inviteMember(
  workspaceId: number,
  email: string,
  role: string | undefined,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<InviteMemberResult> {
  const url = `${BASE}/workspaces/${workspaceId}/invites/send/by-email`;
  const body: Record<string, unknown> = { email };
  if (role !== undefined) body.role = role;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    cookies,
    body,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { raw };
}

// --- Remove member ---

/**
 * Remove a member from the workspace by their `bizUserNo`.
 *
 * Maps to `DELETE /workspaces/:wid/members/:memberBizUserNo`. The path
 * param name `memberBizUserNo` is confirmed from bundle analysis (PR #118).
 * Response body shape is uncaptured; we treat any SUCCESS as success.
 *
 * ⚠️ Inferred endpoint: method/path confirmed, response/errorCodes not
 * live-captured. See docs/api/members.md "DELETE …/members/<memberBizUserNo>".
 */
export async function removeMember(
  workspaceId: number,
  memberBizUserNo: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const url = `${BASE}/workspaces/${workspaceId}/members/${memberBizUserNo}`;
  await requestConsoleApi<unknown>({
    method: 'DELETE',
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

function normalizeMember(raw: unknown, workspaceId: number, index: number): WorkspaceMember {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      `Unexpected member entry at index ${index} for workspace=${workspaceId}: not an object`,
    );
  }
  const rec = raw as Record<string, unknown>;
  const stringField = (k: string): string => {
    const v = rec[k];
    if (typeof v !== 'string') {
      throw new Error(
        `Unexpected member entry at index ${index} for workspace=${workspaceId}: missing ${k}`,
      );
    }
    return v;
  };
  const numField = (k: string): number => {
    const v = rec[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(
        `Unexpected member entry at index ${index} for workspace=${workspaceId}: missing ${k}`,
      );
    }
    return v;
  };
  return {
    workspaceId: numField('workspaceId'),
    bizUserNo: numField('bizUserNo'),
    name: stringField('name'),
    email: stringField('email'),
    status: stringField('status'),
    role: stringField('role'),
    isOwnerDelegationRequested: Boolean(rec.isOwnerDelegationRequested),
    isAdult: Boolean(rec.isAdult),
  };
}
