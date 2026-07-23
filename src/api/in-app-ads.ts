import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// In-app advertising (IAA) placement-group inventory + abuse/serving status,
// scoped to a single mini-app (mirrors in-app-purchase.ts's app-scoped
// shape). Confirmed live 2026-07-24, workspace 3095 / app 31146 — see
// issue #226 for the endpoint discovery session. Read-only: this module
// never issues a write.
const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

// --- Placement groups ---

// GET .../mini-app/:aid/in-app-ads-v2/placement-groups
// Confirmed live (2026-07-24, workspace 3095 / app 31146): 200 with an empty
// array — no placement groups registered yet for this app. Entry shape is
// unobserved; pass entries through opaquely (same policy as
// fetchIapProduct in in-app-purchase.ts) rather than typing fields we've
// never seen populated.
export async function fetchAdsPlacementGroups(
  params: { workspaceId: number; miniAppId: number },
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}` +
    '/in-app-ads-v2/placement-groups';
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected ads placement-groups shape for app=${params.miniAppId}`);
  }
  return raw.map((entry) =>
    entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {},
  );
}

// --- Abuse status ---

export interface AdsAbuseStatus {
  readonly abuseLevel: string;
  readonly isServingBlocked: boolean;
  readonly blockedPlacementGroups: readonly Readonly<Record<string, unknown>>[];
}

// GET .../mini-app/:aid/in-app-ads-v2/abuse-status
// Confirmed live (2026-07-24, workspace 3095 / app 31146):
//   {"abuseLevel":"NONE","isServingBlocked":false,"blockedPlacementGroups":[]}
export async function fetchAdsAbuseStatus(
  params: { workspaceId: number; miniAppId: number },
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<AdsAbuseStatus> {
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}` +
    '/in-app-ads-v2/abuse-status';
  const raw = await requestConsoleApi<Record<string, unknown>>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const abuseLevel = typeof raw.abuseLevel === 'string' ? raw.abuseLevel : 'UNKNOWN';
  const isServingBlocked = Boolean(raw.isServingBlocked);
  const blockedRaw = raw.blockedPlacementGroups;
  const blockedPlacementGroups = Array.isArray(blockedRaw)
    ? blockedRaw.map((entry) =>
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {},
      )
    : [];
  return { abuseLevel, isServingBlocked, blockedPlacementGroups };
}
