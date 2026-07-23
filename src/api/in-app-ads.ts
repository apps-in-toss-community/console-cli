import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// In-app advertising (IAA) placement-group inventory + abuse/serving status,
// scoped to a single mini-app (mirrors in-app-purchase.ts's app-scoped
// shape). Confirmed live 2026-07-24, workspace 3095 / app 31146 — see
// issue #226 for the endpoint discovery session. The create path
// (createAdsPlacementGroup, below) is the one mutation in this module —
// its request body is ⚠️ inferred from static analysis of the console SPA's
// placement-group wizard serialization logic + the public developer docs
// (issue #229), never live-confirmed. Per SECRET-HANDLING policy it is never
// invoked against the live console in this repo (dry-run only in CI/
// dog-food); the real first call happens behind a maintainer-approved
// `--confirm` invocation. See docs/api/in-app-ads.md "placement-group
// create — inferred body shape".
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

// --- Create placement group ---
//
// POST .../mini-app/:aid/in-app-ads-v2/placement-group (singular — note this
// differs from the plural `placement-groups` list path above). ⚠️ Inferred:
// recovered from the console SPA's placement-group creation wizard
// form→body serialization logic, cross-checked against the public developer
// docs (issue #229) — never live-confirmed. No AdMob mediation/waterfall/
// adUnitId-style keys appear in the body: Toss auto-configures mediation by
// app category, so this is a plain POST with no AdMob credentials required.
export const AD_FORMATS = ['BANNER', 'INTERSTITIAL', 'REWARDED'] as const;
export type AdFormat = (typeof AD_FORMATS)[number];

export const AD_BANNER_STYLES = ['NORMAL', 'NATIVE_IMAGE'] as const;
export type AdBannerStyle = (typeof AD_BANNER_STYLES)[number];

export interface AdRewardSettingsInput {
  readonly unitType: string;
  readonly unitAmount: number;
}

export interface CreateAdsPlacementGroupInput {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly displayName: string;
  readonly adFormat: AdFormat;
  readonly categoryId?: number;
  readonly rewardSettings?: AdRewardSettingsInput;
  readonly adStyles?: readonly AdBannerStyle[];
}

export interface CreateAdsPlacementGroupResult {
  readonly groupId: string | number | undefined;
  readonly extra: Readonly<Record<string, unknown>>;
}

export async function createAdsPlacementGroup(
  input: CreateAdsPlacementGroupInput,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CreateAdsPlacementGroupResult> {
  const url =
    `${BASE}/workspaces/${input.workspaceId}/mini-app/${input.miniAppId}` +
    '/in-app-ads-v2/placement-group';
  const body: Record<string, unknown> = {
    displayName: input.displayName,
    adFormat: input.adFormat,
  };
  if (input.categoryId !== undefined) body.categoryId = input.categoryId;
  if (input.rewardSettings !== undefined) body.rewardSettings = input.rewardSettings;
  if (input.adStyles !== undefined) body.adStyles = input.adStyles;

  const raw = await requestConsoleApi<unknown>({
    url,
    method: 'POST',
    body,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeCreatePlacementGroupResult(raw);
}

function normalizeCreatePlacementGroupResult(raw: unknown): CreateAdsPlacementGroupResult {
  if (raw === null || typeof raw !== 'object') {
    return { groupId: undefined, extra: {} };
  }
  const rec = raw as Record<string, unknown>;
  const rawId = rec.groupId ?? rec.id;
  const groupId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : undefined;
  return { groupId, extra: rec };
}
