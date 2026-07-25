import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';
import { fetchMiniAppDetail } from './mini-apps.js';

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

// --- Ad category id resolution (issue #231) ---
//
// #229 shipped `placement-groups create` with `--category` as a hard
// requirement for non-BANNER formats because no category-candidate
// endpoint was known. #231's 2026-07-24 live measurement closed that gap:
// the ad categoryId is simply the mini-app's OWN impression category — the
// same `category.id` `app show` already surfaces at
// `miniApp.impression.categoryPaths[].category.id` (see
// `extractAppCategoryId` below, mirroring the read logic in
// `commands/app.ts`'s `app show`). A second endpoint sanity-checks that id
// against a given ad format:
//
//   GET .../mini-app/:aid/in-app-ads-v2/category/:categoryId/ad-mob-ad-info/:adFormat
//
// Observed (workspace 3095 / app 31146, categoryId 3882):
//   valid   → { resultType: 'SUCCESS', success: { id: 179, categoryId: 3882, category: {...} } }
//   invalid → { resultType: 'SUCCESS', success: { reason: 'not exist category : N' } }
//   cat 0   → { resultType: 'SUCCESS', success: null }  (placeholder/fallback, not a real category)
//
// `resolveAdCategoryId` composes both calls: resolve the app's own category
// id, then best-effort validate it for the requested `adFormat`. The
// validation step is deliberately soft — a network hiccup on the
// second call must not block an otherwise-correct resolution, so any
// error from `fetchAdMobAdInfo` degrades to `validated: false` rather than
// throwing. Only an explicit "not a valid category for this format" answer
// from the server is treated as a hard failure (`category-invalid`) — the
// command layer then asks the caller to pass `--category` explicitly.

export interface AdMobAdInfo {
  readonly id: string | number;
  readonly categoryId: number;
  readonly category: Readonly<Record<string, unknown>>;
}

export interface AdMobAdInfoResult {
  readonly valid: boolean;
  readonly info: AdMobAdInfo | null;
  readonly reason: string | null;
}

export interface FetchAdMobAdInfoParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly categoryId: number;
  readonly adFormat: AdFormat;
}

export async function fetchAdMobAdInfo(
  params: FetchAdMobAdInfoParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<AdMobAdInfoResult> {
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}` +
    `/in-app-ads-v2/category/${params.categoryId}/ad-mob-ad-info/${params.adFormat}`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeAdMobAdInfo(raw);
}

function normalizeAdMobAdInfo(raw: unknown): AdMobAdInfoResult {
  // `success: null` — the cat-0 placeholder/fallback case (or any other
  // non-object payload we don't recognise). Not a real category.
  if (raw === null || typeof raw !== 'object') {
    return { valid: false, info: null, reason: null };
  }
  const rec = raw as Record<string, unknown>;

  const rawReason = rec.reason;
  if (typeof rawReason === 'string') {
    return { valid: false, info: null, reason: rawReason };
  }

  const rawId = rec.id;
  const rawCategoryId = rec.categoryId;
  const rawCategory = rec.category;
  if (
    (typeof rawId === 'string' || typeof rawId === 'number') &&
    typeof rawCategoryId === 'number' &&
    rawCategory !== null &&
    typeof rawCategory === 'object'
  ) {
    return {
      valid: true,
      info: {
        id: rawId,
        categoryId: rawCategoryId,
        category: rawCategory as Record<string, unknown>,
      },
      reason: null,
    };
  }

  return { valid: false, info: null, reason: null };
}

/**
 * Pull the mini-app's own ad-relevant category id out of a
 * `fetchMiniAppDetail` response — `miniApp.impression.categoryPaths[0]
 * .category.id`. Mirrors the display logic `app show` already uses for the
 * same field (see `pickMiniAppView`'s category rendering in
 * `commands/app.ts`), pulled out as a pure function so the resolution path
 * is unit-testable without a citty invocation.
 */
export function extractAppCategoryId(miniApp: Record<string, unknown> | null): number | null {
  if (miniApp === null) return null;
  const impression = miniApp.impression;
  if (impression === null || typeof impression !== 'object') return null;
  const categoryPaths = (impression as Record<string, unknown>).categoryPaths;
  if (!Array.isArray(categoryPaths) || categoryPaths.length === 0) return null;
  const firstPath = categoryPaths[0];
  if (firstPath === null || typeof firstPath !== 'object') return null;
  const category = (firstPath as Record<string, unknown>).category;
  if (category === null || typeof category !== 'object') return null;
  const id = (category as Record<string, unknown>).id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

export interface ResolveAdCategoryIdParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly adFormat: AdFormat;
}

export type ResolveAdCategoryIdResult =
  | { readonly ok: true; readonly categoryId: number; readonly validated: boolean }
  | { readonly ok: false; readonly reason: 'category-not-resolved'; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: 'category-invalid';
      readonly categoryId: number;
      readonly message: string;
    };

/**
 * Auto-resolve the ad categoryId for a non-BANNER placement group from the
 * mini-app's own impression category, then best-effort validate it via
 * `fetchAdMobAdInfo`. Both calls are read-only GETs — safe to run even
 * ahead of a `--dry-run` preview, same as any other read command in this
 * module.
 */
export async function resolveAdCategoryId(
  params: ResolveAdCategoryIdParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ResolveAdCategoryIdResult> {
  const detail = await fetchMiniAppDetail(params.workspaceId, params.miniAppId, cookies, opts);
  const categoryId = extractAppCategoryId(detail.miniApp);
  if (categoryId === null) {
    return {
      ok: false,
      reason: 'category-not-resolved',
      message:
        `Could not determine an ad category id from app ${params.miniAppId}'s own category ` +
        '(impression.categoryPaths is empty or missing). Pass --category <id> explicitly.',
    };
  }

  // Best-effort sanity check — never let a hiccup on this secondary lookup
  // block a resolution that otherwise succeeded.
  let adInfo: AdMobAdInfoResult | null;
  try {
    adInfo = await fetchAdMobAdInfo(
      {
        workspaceId: params.workspaceId,
        miniAppId: params.miniAppId,
        categoryId,
        adFormat: params.adFormat,
      },
      cookies,
      opts,
    );
  } catch {
    adInfo = null;
  }

  if (adInfo === null) {
    return { ok: true, categoryId, validated: false };
  }
  if (!adInfo.valid) {
    return {
      ok: false,
      reason: 'category-invalid',
      categoryId,
      message:
        `App category id ${categoryId} is not a valid ad category for format ${params.adFormat}` +
        (adInfo.reason ? ` (${adInfo.reason})` : '') +
        '. Pass --category <id> explicitly with a known-valid category id.',
    };
  }
  return { ok: true, categoryId, validated: true };
}
