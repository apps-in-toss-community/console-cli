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
