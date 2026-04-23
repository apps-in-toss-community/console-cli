import type { CdpCookie } from '../cdp.js';
import {
  cookieHeaderFor,
  executeAndUnwrap,
  type FetchLike,
  MalformedResponseError,
  requestConsoleApi,
} from './http.js';

// Two endpoints cover the "list my apps" surface:
//
//   GET /workspaces/:id/mini-app              → array of app summaries
//   GET /workspaces/:id/mini-apps/review-status → { hasPolicyViolation, miniApps: [...] }
//
// Note the singular/plural inconsistency (`mini-app` vs `mini-apps`) is
// how the upstream API actually spells them, not a transcription error —
// see TODO.md's console feature inventory.
//
// The detailed field shape inside each array element is not yet known to
// us (the confirmed workspaces currently have zero apps). We model each
// element as a minimal "id + name + extras" envelope so the CLI can show
// something useful today and layer on specific fields as they're observed.
// `extra` is typed as unknown-valued so we don't pretend to know more.

const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export interface MiniAppSummary {
  readonly id: string | number;
  readonly name: string | undefined;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface ReviewStatusSummary {
  readonly hasPolicyViolation: boolean;
  readonly miniApps: readonly Readonly<Record<string, unknown>>[];
}

export async function fetchMiniApps(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<MiniAppSummary[]> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected mini-app list shape for workspace=${workspaceId}`);
  }
  return raw.map((item, index) => normalizeMiniApp(item, workspaceId, index));
}

function normalizeMiniApp(item: unknown, workspaceId: number, index: number): MiniAppSummary {
  if (item === null || typeof item !== 'object') {
    throw new Error(
      `Unexpected mini-app entry at index ${index} for workspace=${workspaceId}: not an object`,
    );
  }
  const rec = item as Record<string, unknown>;
  const rawId = rec.id ?? rec.miniAppId ?? rec.appId;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new Error(
      `Unexpected mini-app entry at index ${index} for workspace=${workspaceId}: missing id`,
    );
  }
  const rawName = rec.name ?? rec.miniAppName ?? rec.appName;
  const name = typeof rawName === 'string' ? rawName : undefined;
  const {
    id: _id,
    miniAppId: _mid,
    appId: _aid,
    name: _n,
    miniAppName: _mn,
    appName: _an,
    ...extra
  } = rec;
  return { id: rawId, name, extra };
}

export async function fetchReviewStatus(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ReviewStatusSummary> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-apps/review-status`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected review-status shape for workspace=${workspaceId}`);
  }
  const rec = raw as Record<string, unknown>;
  const hasPolicyViolation = Boolean(rec.hasPolicyViolation);
  const miniAppsRaw = rec.miniApps;
  if (!Array.isArray(miniAppsRaw)) {
    throw new Error(
      `Unexpected review-status shape for workspace=${workspaceId}: miniApps is not an array`,
    );
  }
  const miniApps = miniAppsRaw.map((m) => {
    if (m === null || typeof m !== 'object') return {};
    return m as Record<string, unknown>;
  });
  return { hasPolicyViolation, miniApps };
}

export interface MiniAppWithDraft {
  readonly current: Record<string, unknown> | null;
  readonly draft: Record<string, unknown> | null;
  // Top-level envelope fields (not inside current/draft). Present on every
  // with-draft response. `approvalType` distinguishes REVIEW-submitted apps
  // from drafts that haven't been sent for review; `rejectedMessage` is
  // non-null iff the review came back rejected. Together with `current`
  // (null until an approved record exists) they derive the UI banner state.
  readonly approvalType: string | null;
  readonly rejectedMessage: string | null;
}

export async function fetchMiniAppWithDraft(
  workspaceId: number,
  miniAppId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<MiniAppWithDraft> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/with-draft`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected with-draft shape for mini-app=${miniAppId}`);
  }
  const rec = raw as Record<string, unknown>;
  const current = isRecordOrNull(rec.current)
    ? (rec.current as Record<string, unknown> | null)
    : null;
  const draft = isRecordOrNull(rec.draft) ? (rec.draft as Record<string, unknown> | null) : null;
  const approvalType = typeof rec.approvalType === 'string' ? rec.approvalType : null;
  const rejectedMessage = typeof rec.rejectedMessage === 'string' ? rec.rejectedMessage : null;
  return { current, draft, approvalType, rejectedMessage };
}

function isRecordOrNull(v: unknown): v is Record<string, unknown> | null {
  return v === null || (typeof v === 'object' && !Array.isArray(v));
}

// --- Ratings & reviews ---
//
// GET /workspaces/:wid/mini-app/:aid/app-ratings
//   ?page=0&size=20&sortField=CREATED_AT&sortDirection=DESC
//
// Response envelope (observed 2026-04-23 on app 29405, empty case):
//   { ratings: [...], paging: { pageNumber, pageSize, hasNext, totalCount },
//     averageRating, totalReviewCount }
//
// Individual rating records have not yet been observed (sdk-example has
// zero reviews while under review). We pass each record through as an
// opaque Record<string, unknown> for now; once a real review lands we can
// pin the per-row shape without breaking the wrapper.

export type RatingSortField = 'CREATED_AT' | 'SCORE';
export type RatingSortDirection = 'ASC' | 'DESC';

export interface RatingsPaging {
  readonly pageNumber: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly totalCount: number;
}

export interface MiniAppRatingsPage {
  readonly ratings: readonly Readonly<Record<string, unknown>>[];
  readonly paging: RatingsPaging;
  readonly averageRating: number;
  readonly totalReviewCount: number;
}

export interface FetchRatingsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
  readonly size?: number;
  readonly sortField?: RatingSortField;
  readonly sortDirection?: RatingSortDirection;
}

export async function fetchMiniAppRatings(
  params: FetchRatingsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<MiniAppRatingsPage> {
  const page = params.page ?? 0;
  const size = params.size ?? 20;
  const sortField = params.sortField ?? 'CREATED_AT';
  const sortDirection = params.sortDirection ?? 'DESC';
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/app-ratings` +
    `?page=${page}&size=${size}&sortField=${sortField}&sortDirection=${sortDirection}`;

  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected ratings shape for app=${params.miniAppId}`);
  }
  const rec = raw as Record<string, unknown>;
  const ratingsRaw = rec.ratings;
  if (!Array.isArray(ratingsRaw)) {
    throw new Error(`Unexpected ratings shape: ratings is not an array (app=${params.miniAppId})`);
  }
  const ratings = ratingsRaw.map((r) => {
    if (r === null || typeof r !== 'object') return {};
    return r as Record<string, unknown>;
  });
  const pagingRaw = rec.paging;
  if (pagingRaw === null || typeof pagingRaw !== 'object') {
    throw new Error(`Unexpected ratings shape: paging missing (app=${params.miniAppId})`);
  }
  const p = pagingRaw as Record<string, unknown>;
  const paging: RatingsPaging = {
    pageNumber: typeof p.pageNumber === 'number' ? p.pageNumber : page,
    pageSize: typeof p.pageSize === 'number' ? p.pageSize : size,
    hasNext: Boolean(p.hasNext),
    totalCount: typeof p.totalCount === 'number' ? p.totalCount : 0,
  };
  const averageRating = typeof rec.averageRating === 'number' ? rec.averageRating : 0;
  const totalReviewCount = typeof rec.totalReviewCount === 'number' ? rec.totalReviewCount : 0;
  return { ratings, paging, averageRating, totalReviewCount };
}

// --- User reports (신고 내역) ---
//
// GET /workspaces/:wid/mini-apps/:aid/user-reports?pageSize=N[&cursor=...]
//
// Note the URL uses **plural** `mini-apps` — same split-personality as
// `mini-apps/review-status`. Don't "normalize" it.
//
// Response envelope (observed 2026-04-23 on app 29405, empty case):
//   { reports: [...], nextCursor: null | string, hasMore: boolean }
//
// Pagination is cursor-based here (unlike ratings which is page-based).
// We expose `cursor` as an optional param and echo back `nextCursor` /
// `hasMore` so callers can page through without guessing the scheme.

export interface UserReportsPage {
  readonly reports: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface FetchUserReportsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export async function fetchUserReports(
  params: FetchUserReportsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<UserReportsPage> {
  const pageSize = params.pageSize ?? 20;
  const qs = new URLSearchParams();
  qs.set('pageSize', String(pageSize));
  if (params.cursor !== undefined) qs.set('cursor', params.cursor);
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-apps/${params.miniAppId}/user-reports?` +
    qs.toString();

  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected user-reports shape for app=${params.miniAppId}`);
  }
  const rec = raw as Record<string, unknown>;
  const reportsRaw = rec.reports;
  if (!Array.isArray(reportsRaw)) {
    throw new Error(
      `Unexpected user-reports shape: reports is not an array (app=${params.miniAppId})`,
    );
  }
  const reports = reportsRaw.map((r) => {
    if (r === null || typeof r !== 'object') return {};
    return r as Record<string, unknown>;
  });
  const nextCursor = typeof rec.nextCursor === 'string' ? rec.nextCursor : null;
  const hasMore = Boolean(rec.hasMore);
  return { reports, nextCursor, hasMore };
}

// --- Bundles (앱 번들 배포) ---
//
// GET /workspaces/:wid/mini-app/:aid/bundles[?page=&tested=&deployStatus=]
// GET /workspaces/:wid/mini-app/:aid/bundles/deployed  → single bundle | null
//
// Response envelope (observed 2026-04-23 on app 29405, empty case):
//   { contents: [...], totalPage: 0, currentPage: 0 }
//
// Page-based pagination (unlike ratings's {paging:{...}} or user-reports
// cursor-based). Filter query params: `tested=true` for TESTED-only, and
// `deployStatus=DEPLOYED` to narrow to live bundles. We expose those as
// optional opaque-string filters so callers can pass them through without
// the API layer enumerating every enum value ahead of time.
//
// `bundles/deployed` (singular route) returns null until a first deploy
// lands; the shape of a populated record is not yet observed, so we pass
// it through opaquely.

export interface BundlesPage {
  readonly contents: readonly Readonly<Record<string, unknown>>[];
  readonly totalPage: number;
  readonly currentPage: number;
}

export interface FetchBundlesParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
  readonly tested?: boolean;
  readonly deployStatus?: string;
}

export async function fetchBundles(
  params: FetchBundlesParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<BundlesPage> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.tested !== undefined) qs.set('tested', String(params.tested));
  if (params.deployStatus !== undefined) qs.set('deployStatus', params.deployStatus);
  const query = qs.toString();
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/bundles` +
    (query ? `?${query}` : '');

  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected bundles shape for app=${params.miniAppId}`);
  }
  const rec = raw as Record<string, unknown>;
  const contentsRaw = rec.contents;
  if (!Array.isArray(contentsRaw)) {
    throw new Error(`Unexpected bundles shape: contents is not an array (app=${params.miniAppId})`);
  }
  const contents = contentsRaw.map((b) => {
    if (b === null || typeof b !== 'object') return {};
    return b as Record<string, unknown>;
  });
  const totalPage = typeof rec.totalPage === 'number' ? rec.totalPage : 0;
  const currentPage = typeof rec.currentPage === 'number' ? rec.currentPage : 0;
  return { contents, totalPage, currentPage };
}

// --- Conversion metrics ---
//
// GET /workspaces/:wid/mini-app/:aid/conversion-metrics
//   ?refresh=false&timeUnitType=DAY|WEEK|MONTH&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// Response envelope (observed 2026-04-23 on app 29405, empty case):
//   { metrics: [], cacheTime: '2026-04-23T13:49:42.693498831' }
//
// All apps in the current workspace are PREPARE-state (no live traffic),
// so the shape of a populated `metrics[]` entry isn't observed yet — we
// pass records through opaquely until a live app lands. `cacheTime` is
// the server-side cache timestamp (ISO-ish with nanoseconds); we surface
// it verbatim so agent-plugin can reason about freshness.
//
// `refresh=true` bypasses the server cache; we default to `false` to
// match the console UI's default request and avoid hammering the
// underlying data warehouse.

export type MetricsTimeUnit = 'DAY' | 'WEEK' | 'MONTH';

export interface MetricsResult {
  readonly metrics: readonly Readonly<Record<string, unknown>>[];
  readonly cacheTime: string | undefined;
}

export interface FetchMetricsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly timeUnitType: MetricsTimeUnit;
  readonly startDate: string;
  readonly endDate: string;
  readonly refresh?: boolean;
}

export async function fetchConversionMetrics(
  params: FetchMetricsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<MetricsResult> {
  const qs = new URLSearchParams();
  qs.set('refresh', String(params.refresh ?? false));
  qs.set('timeUnitType', params.timeUnitType);
  qs.set('startDate', params.startDate);
  qs.set('endDate', params.endDate);
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/conversion-metrics` +
    `?${qs.toString()}`;

  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected metrics shape for app=${params.miniAppId}`);
  }
  const rec = raw as Record<string, unknown>;
  const metricsRaw = rec.metrics;
  if (!Array.isArray(metricsRaw)) {
    throw new Error(`Unexpected metrics shape: metrics is not an array (app=${params.miniAppId})`);
  }
  const metrics = metricsRaw.map((m) => {
    if (m === null || typeof m !== 'object') return {};
    return m as Record<string, unknown>;
  });
  const cacheTime = typeof rec.cacheTime === 'string' ? rec.cacheTime : undefined;
  return { metrics, cacheTime };
}

// --- mTLS certs ---
//
// GET /workspaces/:wid/mini-app/:aid/certs → array of cert records.
//
// Observed empty case on app 29405 (2026-04-23): `[]`. Per-record shape
// not yet observed; passed through opaquely. The console UI exposes
// "mTLS 인증서" for generating client certificates, so a real app
// will eventually populate this and we can pin fields (probably
// `certId` / `commonName` / `createdAt` / expiry).

export async function fetchCerts(
  workspaceId: number,
  miniAppId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/certs`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected certs shape for app=${miniAppId}: not an array`);
  }
  return raw.map((c) => {
    if (c === null || typeof c !== 'object') return {};
    return c as Record<string, unknown>;
  });
}

// --- Share rewards ---
//
// GET /workspaces/:wid/mini-app/:aid/share-rewards[?search=]
//
// Response envelope (observed 2026-04-23 on app 29405, empty case):
//   []
//
// Simple array. The console UI passes `search=` as a title-contains
// filter (observed as the default XHR on the 공유 리워드 page) — the empty
// string matches everything. Per-record shape is passed through opaquely
// until a populated response is observed; promotions won't exist on
// unreleased apps.

export interface FetchShareRewardsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly search?: string;
}

export async function fetchShareRewards(
  params: FetchShareRewardsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const qs = new URLSearchParams();
  // Match the console UI's default (always sends `search=`). Callers that
  // don't pass a filter still include it as empty so the request shape
  // matches what the server expects.
  qs.set('search', params.search ?? '');
  const url = `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/share-rewards?${qs.toString()}`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected share-rewards shape for app=${params.miniAppId}: not an array`);
  }
  return raw.map((r) => {
    if (r === null || typeof r !== 'object') return {};
    return r as Record<string, unknown>;
  });
}

// --- Smart-message campaigns ---
//
// "스마트 발송" (smart-message) is the replacement for the legacy
// push-notifications menu. List endpoint is a POST with the filter body
// in JSON and paging in the querystring — that shape is the console
// UI's XHR, and we mirror it so the request is indistinguishable.
//
// Empirical response shape (live workspace 3095, PREPARE-state app):
//   { items: [], paging: { pageNumber, pageSize, hasNext, totalCount } }
// Items are passed through opaquely until a populated campaign is
// observed.

export type SmartMessageSort = { field: string; direction: 'ASC' | 'DESC' };
// Open-ended filters bag. The UI currently sends `{}` or
// `{ channelTypes: [] }` depending on which tab is active — we keep
// the type permissive because more facets may surface over time.
export type SmartMessageFilters = Readonly<Record<string, unknown>>;

export interface FetchSmartMessageCampaignsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
  readonly size?: number;
  readonly search?: string;
  readonly sort?: readonly SmartMessageSort[];
  readonly filters?: SmartMessageFilters;
}

export interface SmartMessagePaging {
  readonly pageNumber: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly totalCount: number;
}

export interface SmartMessageCampaignsResult {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly paging: SmartMessagePaging;
}

export async function fetchSmartMessageCampaigns(
  params: FetchSmartMessageCampaignsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<SmartMessageCampaignsResult> {
  const page = params.page ?? 0;
  const size = params.size ?? 20;
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('size', String(size));
  const url = `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/smart-message/campaigns?${qs.toString()}`;
  const body = {
    sort: params.sort ?? [{ field: 'regTs', direction: 'DESC' }],
    search: params.search ?? '',
    filters: params.filters ?? {},
  };
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected smart-message campaigns shape for app=${params.miniAppId}`);
  }
  const data = raw as Record<string, unknown>;
  const items = Array.isArray(data.items) ? data.items : [];
  const rawPaging = data.paging as Record<string, unknown> | undefined;
  const paging: SmartMessagePaging = {
    pageNumber: typeof rawPaging?.pageNumber === 'number' ? rawPaging.pageNumber : page,
    pageSize: typeof rawPaging?.pageSize === 'number' ? rawPaging.pageSize : size,
    hasNext: Boolean(rawPaging?.hasNext),
    totalCount: typeof rawPaging?.totalCount === 'number' ? rawPaging.totalCount : items.length,
  };
  return {
    items: items.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {})),
    paging,
  };
}

// --- Event catalogs (log search) ---
//
// The console "이벤트" (events) page is powered by a POST search endpoint
// that returns the catalog of custom events recorded for a mini-app.
// Body shape from observed UI XHR: `{isRefresh, pageNumber, pageSize, search}`.
// Response: `{results, cacheTime, paging: {pageNumber, pageSize, hasNext,
// totalCount, totalPages}}`. On a PREPARE-state app with no traffic,
// `results` is empty and `cacheTime` carries a server-cache timestamp —
// same pattern as conversion-metrics.

export interface FetchAppEventCatalogsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly pageNumber?: number;
  readonly pageSize?: number;
  readonly search?: string;
  readonly refresh?: boolean;
}

export interface AppEventCatalogsPaging {
  readonly pageNumber: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly totalCount: number;
  readonly totalPages: number;
}

export interface AppEventCatalogsResult {
  readonly results: readonly Readonly<Record<string, unknown>>[];
  readonly cacheTime: string | undefined;
  readonly paging: AppEventCatalogsPaging;
}

export async function fetchAppEventCatalogs(
  params: FetchAppEventCatalogsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<AppEventCatalogsResult> {
  const pageNumber = params.pageNumber ?? 0;
  const pageSize = params.pageSize ?? 20;
  const url = `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/log/catalogs/search`;
  const body = {
    isRefresh: params.refresh ?? false,
    pageNumber,
    pageSize,
    search: params.search ?? '',
  };
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected event-catalogs shape for app=${params.miniAppId}`);
  }
  const data = raw as Record<string, unknown>;
  const results = Array.isArray(data.results) ? data.results : [];
  const rawPaging = data.paging as Record<string, unknown> | undefined;
  const paging: AppEventCatalogsPaging = {
    pageNumber: typeof rawPaging?.pageNumber === 'number' ? rawPaging.pageNumber : pageNumber,
    pageSize: typeof rawPaging?.pageSize === 'number' ? rawPaging.pageSize : pageSize,
    hasNext: Boolean(rawPaging?.hasNext),
    totalCount: typeof rawPaging?.totalCount === 'number' ? rawPaging.totalCount : results.length,
    totalPages: typeof rawPaging?.totalPages === 'number' ? rawPaging.totalPages : 0,
  };
  return {
    results: results.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {})),
    cacheTime: typeof data.cacheTime === 'string' ? data.cacheTime : undefined,
    paging,
  };
}

// --- Templates (smart-message composer) ---
//
// GET /mini-app/:id/templates/search
//   ?page=0&size=20&contentReachType=FUNCTIONAL|MARKETING&isSmartMessage=true|false
//
// Response shape (observed on empty app 29405):
//   { page: { totalPageCount }, groupSendContextSimpleView: [] }
//
// The odd bucket key name (`groupSendContextSimpleView`) is the server's
// own — we surface it as `templates` at the CLI layer so the output is
// readable without leaking the internal naming. Per-template record
// shape is passed through opaquely until a populated response is seen.

export type TemplateContentReachType = 'FUNCTIONAL' | 'MARKETING';
export const TEMPLATE_CONTENT_REACH_TYPES: readonly TemplateContentReachType[] = [
  'FUNCTIONAL',
  'MARKETING',
];

export interface FetchAppTemplatesParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
  readonly size?: number;
  readonly contentReachType?: TemplateContentReachType;
  readonly isSmartMessage?: boolean;
}

export interface AppTemplatesResult {
  readonly templates: readonly Readonly<Record<string, unknown>>[];
  readonly totalPageCount: number;
}

export async function fetchAppTemplates(
  params: FetchAppTemplatesParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<AppTemplatesResult> {
  const page = params.page ?? 0;
  const size = params.size ?? 20;
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('size', String(size));
  if (params.contentReachType) qs.set('contentReachType', params.contentReachType);
  if (params.isSmartMessage !== undefined) qs.set('isSmartMessage', String(params.isSmartMessage));
  const url = `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/templates/search?${qs.toString()}`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected templates shape for app=${params.miniAppId}`);
  }
  const data = raw as Record<string, unknown>;
  const list = Array.isArray(data.groupSendContextSimpleView)
    ? data.groupSendContextSimpleView
    : [];
  const pageMeta = data.page as Record<string, unknown> | undefined;
  return {
    templates: list.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {})),
    totalPageCount: typeof pageMeta?.totalPageCount === 'number' ? pageMeta.totalPageCount : 0,
  };
}

// --- Impression category tree ---
//
// GET /impression/category-list returns the full category hierarchy used
// by `app register`. It's a global, workspace-independent lookup — the
// console navigates directly to the `/impression` prefix (NOT
// `/workspaces/:id/impression`). `isSelectable: true` marks which
// entries callers may actually reference from `categoryIds`.
//
// Tree: [{ categoryGroup, categoryList: [{ id, name, isSelectable,
// subCategoryList: [{ id, name, isSelectable }] }] }]

export interface CategoryGroupNode {
  readonly id: number;
  readonly name: string;
  readonly isSelectable: boolean;
}

export interface SubCategoryNode {
  readonly id: number;
  readonly name: string;
  readonly isSelectable: boolean;
}

export interface CategoryNode {
  readonly id: number;
  readonly name: string;
  readonly isSelectable: boolean;
  readonly subCategoryList: readonly SubCategoryNode[];
}

export interface CategoryTreeEntry {
  readonly categoryGroup: CategoryGroupNode;
  readonly categoryList: readonly CategoryNode[];
}

export async function fetchImpressionCategoryList(
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<readonly CategoryTreeEntry[]> {
  const url = `${BASE}/impression/category-list`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected impression/category-list shape: not an array');
  }
  return raw.map((entry, i): CategoryTreeEntry => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Unexpected category-list entry at index ${i}`);
    }
    const e = entry as Record<string, unknown>;
    const group = e.categoryGroup as Record<string, unknown> | undefined;
    const list = Array.isArray(e.categoryList) ? e.categoryList : [];
    return {
      categoryGroup: {
        id: typeof group?.id === 'number' ? group.id : 0,
        name: typeof group?.name === 'string' ? group.name : '',
        isSelectable: Boolean(group?.isSelectable),
      },
      categoryList: list.map((c): CategoryNode => {
        if (!c || typeof c !== 'object') {
          return { id: 0, name: '', isSelectable: false, subCategoryList: [] };
        }
        const cr = c as Record<string, unknown>;
        const subs = Array.isArray(cr.subCategoryList) ? cr.subCategoryList : [];
        return {
          id: typeof cr.id === 'number' ? cr.id : 0,
          name: typeof cr.name === 'string' ? cr.name : '',
          isSelectable: Boolean(cr.isSelectable),
          subCategoryList: subs.map((s): SubCategoryNode => {
            if (!s || typeof s !== 'object') {
              return { id: 0, name: '', isSelectable: false };
            }
            const sr = s as Record<string, unknown>;
            return {
              id: typeof sr.id === 'number' ? sr.id : 0,
              name: typeof sr.name === 'string' ? sr.name : '',
              isSelectable: Boolean(sr.isSelectable),
            };
          }),
        };
      }),
    };
  });
}

// --- App service status (per-mini-app shutdown/service state) ---
//
// GET /mini-app/:id/review-status (singular `mini-app`) returns the
// runtime service status of a single mini-app. Distinct from the
// workspace-level `mini-apps/review-status` (plural) which reports the
// pending/approved state of every app in a workspace; this one is the
// server-authoritative view of whether the app is live, preparing, or
// scheduled for shutdown.
//
// Observed shape on a PREPARE app:
//   { shutdownCandidateStatus: null, scheduledShutdownAt: null,
//     serviceStatus: 'PREPARE' }

export interface AppServiceStatus {
  readonly shutdownCandidateStatus: string | null;
  readonly scheduledShutdownAt: string | null;
  readonly serviceStatus: string;
}

export async function fetchAppServiceStatus(
  workspaceId: number,
  miniAppId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<AppServiceStatus> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/review-status`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected app service-status shape for app=${miniAppId}`);
  }
  const data = raw as Record<string, unknown>;
  const serviceStatus = data.serviceStatus;
  if (typeof serviceStatus !== 'string') {
    throw new Error(
      `Unexpected app service-status shape for app=${miniAppId}: missing serviceStatus`,
    );
  }
  return {
    shutdownCandidateStatus:
      typeof data.shutdownCandidateStatus === 'string' ? data.shutdownCandidateStatus : null,
    scheduledShutdownAt:
      typeof data.scheduledShutdownAt === 'string' ? data.scheduledShutdownAt : null,
    serviceStatus,
  };
}

export async function fetchDeployedBundle(
  workspaceId: number,
  miniAppId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Record<string, unknown> | null> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/bundles/deployed`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected deployed-bundle shape for app=${miniAppId}`);
  }
  return raw as Record<string, unknown>;
}

// --- Bundle upload (deploy) ---
//
// The console's "앱 출시 > 등록하기" dialog walks a 3-step server dance
// plus an optional memo write:
//
//   1. POST /mini-app/:id/deployments/initialize   body {deploymentId}
//        → { deployment: { reviewStatus, ... }, uploadUrl }
//   2. PUT <uploadUrl>   Content-Type: application/zip, body = raw .ait bytes
//        (S3 presigned URL; goes direct to S3, no Toss envelope)
//   3. POST /mini-app/:id/deployments/complete     body {deploymentId}
//        → bundle record (server-side confirmation)
//   4. (optional) POST /mini-app/:id/bundles/memos body {deploymentId, memo}
//
// `deploymentId` is embedded in the .ait bundle itself — the toolchain
// that packs the bundle writes it into `app.json._metadata.deploymentId`
// (observed via static analysis of the console's client-side parser in
// `index.ZIQgZB74.js`, 2026-04-23). We take it as an explicit parameter
// here to keep this layer free of zip-parsing logic; the command layer
// can either crack the zip or let the user pass `--deployment-id` by
// hand.
//
// The initialize response's `deployment.reviewStatus` must be `PREPARE`
// before the PUT fires — any other value means the deploymentId has
// already been used and the console raises "이미 존재하는 버전이에요."

export interface DeploymentInitializeResult {
  readonly uploadUrl: string;
  readonly deployment: Readonly<Record<string, unknown>>;
  readonly reviewStatus: string;
}

export async function postDeploymentsInitialize(
  workspaceId: number,
  miniAppId: number,
  deploymentId: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<DeploymentInitializeResult> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/deployments/initialize`;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body: { deploymentId },
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Unexpected deployments/initialize shape for app=${miniAppId}`);
  }
  const data = raw as Record<string, unknown>;
  const uploadUrl = data.uploadUrl;
  if (typeof uploadUrl !== 'string') {
    throw new Error(
      `Unexpected deployments/initialize shape for app=${miniAppId}: missing uploadUrl`,
    );
  }
  const deployment =
    data.deployment && typeof data.deployment === 'object'
      ? (data.deployment as Record<string, unknown>)
      : {};
  const reviewStatus =
    typeof deployment.reviewStatus === 'string' ? deployment.reviewStatus : 'UNKNOWN';
  return { uploadUrl, deployment, reviewStatus };
}

export async function postDeploymentsComplete(
  workspaceId: number,
  miniAppId: number,
  deploymentId: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/deployments/complete`;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body: { deploymentId },
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  // Complete returns the persisted bundle record; pass it through opaquely
  // until we see populated shape in dog-food.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export async function postBundleMemo(
  workspaceId: number,
  miniAppId: number,
  deploymentId: string,
  memo: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/bundles/memos`;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body: { deploymentId, memo },
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * PUT the raw .ait bytes to the S3 presigned URL returned by
 * `postDeploymentsInitialize`. This is a direct-to-S3 call with NO Toss
 * envelope — the response is empty on success (HTTP 200). Any cookies are
 * intentionally NOT sent because S3 would reject the signed request if
 * extra auth headers contradict the signature.
 */
export async function putBundleToUploadUrl(
  uploadUrl: string,
  body: Uint8Array,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const impl: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  // BodyInit's Uint8Array overload requires `ArrayBufferView<ArrayBuffer>`,
  // so we explicitly view the bytes with a plain ArrayBuffer backing — same
  // trick used in `uploadMiniAppResource` above. A `Buffer` from readFile
  // may be backed by a `SharedArrayBuffer` which `BodyInit` rejects.
  const view = new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  let res: Response;
  try {
    res = await impl(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: view,
    });
  } catch (err) {
    throw new Error(`PUT to upload URL failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new Error(`PUT to upload URL returned HTTP ${res.status}: ${preview.slice(0, 200)}`);
  }
}

// --- Bundle review / release / withdraw / test ---
//
// After a bundle is uploaded it sits in reviewStatus=PREPARE on the server.
// To actually ship it, three further mutations may fire:
//
//   POST /bundles/reviews                body {deploymentId, releaseNotes, featureList?, screenshotImagePaths?}
//     → submits for Toss review. reviewAppBundle()
//   POST /bundles/reviews/withdrawal     body {deploymentId}
//     → cancels an in-flight review. postWithdrawAppBundleReview()
//   POST /bundles/release                body {deploymentId, contentImages?}
//     → flips an APPROVED bundle live in the marketplace. releaseAppBundle()
//
// Plus two read/test helpers:
//
//   POST /bundles/test-push              body {deploymentId}  → sends a push so the uploader can open the build on their device
//   GET  /bundles/test-links             → returns per-device test URLs
//
// All four mutation bodies, plus the test-push trigger, were observed
// via static analysis of the console's `index.ZIQgZB74.js` chunk
// (2026-04-23). No live XHR was triggered for these from the CLI — they
// are destructive write paths (release especially is visible to end
// users) and must be dog-fooded with care.

export interface ReviewAppBundleParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly deploymentId: string;
  readonly releaseNotes: string;
  readonly featureList?: readonly Readonly<Record<string, unknown>>[];
  readonly screenshotImagePaths?: readonly string[];
}

export async function postBundleReview(
  params: ReviewAppBundleParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/bundles/reviews`;
  const body: Record<string, unknown> = {
    deploymentId: params.deploymentId,
    releaseNotes: params.releaseNotes,
  };
  if (params.featureList !== undefined) body.featureList = params.featureList;
  if (params.screenshotImagePaths !== undefined)
    body.screenshotImagePaths = params.screenshotImagePaths;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export async function postBundleReviewWithdrawal(
  workspaceId: number,
  miniAppId: number,
  deploymentId: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/bundles/reviews/withdrawal`;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body: { deploymentId },
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export interface ReleaseAppBundleParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly deploymentId: string;
  readonly contentImages?: readonly string[];
}

export async function postBundleRelease(
  params: ReleaseAppBundleParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/bundles/release`;
  const body: Record<string, unknown> = { deploymentId: params.deploymentId };
  if (params.contentImages !== undefined) body.contentImages = params.contentImages;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export async function postBundleTestPush(
  workspaceId: number,
  miniAppId: number,
  deploymentId: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/bundles/test-push`;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    body: { deploymentId },
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export async function fetchBundleTestLinks(
  workspaceId: number,
  miniAppId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/bundles/test-links`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

// --- Register (create) ---
//
// `createMiniApp` and `uploadMiniAppResource` back the `app register`
// command. The submit payload shape below is *inferred* from static
// bundle analysis (`VALIDATION-RULES.md` in the umbrella `.playwright-
// mcp/`); the console UI never round-trips intermediate drafts, so the
// only authoritative record will come from dog-food task #23. Field
// names here intentionally mirror the `Xc` function from the bundle so
// when #23 runs, any correction is a direct rename rather than a
// restructure.

// Exposed as `unknown` per-image so the caller (not this layer) is the
// place where a cross-field invariant like "at least 3 PREVIEW/VERTICAL"
// is enforced. Keeping this type open also makes it trivial to add the
// `LOGO` imageType or other orientation values without touching the
// network module.
export type MiniAppImageType = 'LOGO' | 'THUMBNAIL' | 'PREVIEW';
export type MiniAppImageOrientation = 'HORIZONTAL' | 'VERTICAL';

export interface MiniAppImageEntry {
  readonly imageUrl: string;
  readonly imageType: MiniAppImageType;
  readonly orientation: MiniAppImageOrientation;
}

export interface MiniAppSubmitPayload {
  readonly miniApp: {
    readonly title: string;
    readonly titleEn: string;
    readonly appName: string;
    readonly iconUri: string;
    readonly status: 'PREPARE';
    readonly darkModeIconUri?: string;
    readonly homePageUri?: string;
    readonly csEmail: string;
    readonly description: string; // subtitle (≤20 chars)
    readonly detailDescription: string;
    readonly images: readonly MiniAppImageEntry[];
  };
  readonly impression: {
    readonly keywordList: readonly string[];
    readonly categoryIds: readonly number[];
    readonly subCategoryIds?: readonly number[];
  };
}

export interface CreateMiniAppResult {
  readonly miniAppId: string | number | undefined;
  readonly reviewState: string | undefined;
  readonly extra: Readonly<Record<string, unknown>>;
}

export async function createMiniApp(
  workspaceId: number,
  payload: MiniAppSubmitPayload,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CreateMiniAppResult> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/review`;
  const raw = await requestConsoleApi<unknown>({
    url,
    method: 'POST',
    cookies,
    body: payload,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeCreateResult(raw);
}

function normalizeCreateResult(raw: unknown): CreateMiniAppResult {
  if (raw === null || typeof raw !== 'object') {
    return { miniAppId: undefined, reviewState: undefined, extra: {} };
  }
  const rec = raw as Record<string, unknown>;
  const rawId = rec.miniAppId ?? rec.id ?? rec.appId;
  const miniAppId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : undefined;
  const rawState = rec.reviewState ?? rec.status;
  const reviewState = typeof rawState === 'string' ? rawState : undefined;
  return { miniAppId, reviewState, extra: rec };
}

export interface UploadFile {
  readonly buffer: Buffer;
  readonly fileName: string;
  readonly contentType: string;
}

export interface UploadParams {
  readonly workspaceId: number;
  readonly validWidth: number;
  readonly validHeight: number;
  readonly file: UploadFile;
  readonly cookies: readonly CdpCookie[];
}

/**
 * Upload an image to `/resource/:wid/upload?validWidth=W&validHeight=H`
 * and return the CDN URL the server hands back. The endpoint is a
 * multipart/form-data POST; we build a FormData with a single `resource`
 * field because that matches the bundle analysis for the console's
 * uploader, which pairs a `fileName` string field with a `resource`
 * Blob (see VALIDATION-RULES.md → iconUri). Dog-food #23 may reveal that
 * the field name is actually `file` — if so, swap it in one place here.
 */
export async function uploadMiniAppResource(
  params: UploadParams,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<string> {
  const url = new URL(`${BASE}/resource/${params.workspaceId}/upload`);
  url.searchParams.set('validWidth', String(params.validWidth));
  url.searchParams.set('validHeight', String(params.validHeight));

  const form = new FormData();
  // A `Buffer` is already a `Uint8Array`, but its `ArrayBufferLike`
  // backing can be a `SharedArrayBuffer` which `BlobPart` doesn't accept.
  // Wrapping in a `Uint8Array` view over the same bytes (byteOffset +
  // byteLength) keeps the type happy without the extra copy that
  // `new Uint8Array(buffer)` would force.
  const view = new Uint8Array(
    params.file.buffer.buffer as ArrayBuffer,
    params.file.buffer.byteOffset,
    params.file.buffer.byteLength,
  );
  const blob = new Blob([view], { type: params.file.contentType });
  form.append('resource', blob, params.file.fileName);
  form.append('fileName', params.file.fileName);

  const cookieHeader = cookieHeaderFor(url, params.cookies);
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const imageUrl = await executeAndUnwrap<unknown>(
    url,
    { method: 'POST', headers, body: form },
    opts.fetchImpl,
  );
  if (typeof imageUrl !== 'string') {
    throw new MalformedResponseError(
      url.toString(),
      200,
      `expected string imageUrl, got ${typeof imageUrl}`,
    );
  }
  return imageUrl;
}
