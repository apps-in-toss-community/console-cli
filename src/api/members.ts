import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// GET /workspaces/:id/members — confirmed shape (as of 2026-04):
//   [{ workspaceId, bizUserNo, name, email, status, role,
//      isOwnerDelegationRequested, isAdult }]
// `bizUserNo` is the stable per-person identifier across workspaces —
// future `members remove` / role-change commands will key off it.

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
