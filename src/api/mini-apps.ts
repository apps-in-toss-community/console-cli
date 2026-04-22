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
