import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// In-app purchase (IAP) product catalog / orders / refunds, scoped to a
// single mini-app (unlike `workspace partner`, which is workspace-level).
// Endpoint inventory recovered by static-analysing the console SPA's public
// Vite chunks (no auth, no console API touched — see issue #220 "정적 분석
// inventory"). Read paths below are ⚠️ inferred for their *response* shape
// (the only live observation we have is the `errorCode: 5002` gate on
// `catalogs` for an unregistered partner — see docs/api/in-app-purchase.md)
// but the *paths themselves* are directly read out of the SPA's route
// registration table (`M(D.path("...").method("get").create())`), so we
// treat the URLs as confirmed and the body shape as inferred.
const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export const IAP_PRODUCT_TYPES = ['CONSUMABLE', 'NON_CONSUMABLE', 'SUBSCRIPTION'] as const;
export type IapProductType = (typeof IAP_PRODUCT_TYPES)[number];

export const IAP_RENEWAL_CYCLES = ['WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type IapRenewalCycle = (typeof IAP_RENEWAL_CYCLES)[number];

// --- Products (catalog) ---

export interface IapProductsPage {
  readonly contents: readonly Readonly<Record<string, unknown>>[];
  readonly totalPage: number;
  readonly currentPage: number;
}

export interface FetchIapProductsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
  readonly search?: string;
  // Repeated query params, mirroring the console UI's multi-select filters
  // (call-site passes arrays through opaquely — not live-confirmed).
  readonly type?: readonly IapProductType[];
  readonly catalogStatus?: readonly string[];
}

function buildListQuery(params: {
  page?: number;
  search?: string;
  type?: readonly string[];
  catalogStatus?: readonly string[];
}): string {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.search !== undefined) qs.set('search', params.search);
  for (const t of params.type ?? []) qs.append('type', t);
  for (const s of params.catalogStatus ?? []) qs.append('catalogStatus', s);
  return qs.toString();
}

// GET .../mini-app/:aid/in-app-purchase/catalogs
// Confirmed live (2026-07-23, workspace 3095 / app 31146): an unregistered
// partner gets `resultType: FAIL, errorCode: '5002', reason: '거래처 등록이
// 필요합니다.'` — see `hintForErrorCode('5002')` in src/commands/_shared.ts
// for the CLI-level remedy hint. The SUCCESS response shape below (page-based
// `{contents, totalPage, currentPage}`, matching every other list endpoint
// in this API family) is ⚠️ inferred, not live-observed.
export async function fetchIapProducts(
  params: FetchIapProductsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<IapProductsPage> {
  const query = buildListQuery(params);
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/in-app-purchase/catalogs` +
    (query ? `?${query}` : '');
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected iap products shape for app=${params.miniAppId}`);
  }
  const rec = raw as Record<string, unknown>;
  const contentsRaw = rec.contents;
  if (!Array.isArray(contentsRaw)) {
    throw new Error(
      `Unexpected iap products shape: contents is not an array (app=${params.miniAppId})`,
    );
  }
  const contents = contentsRaw.map((c) => {
    if (c === null || typeof c !== 'object') return {};
    return c as Record<string, unknown>;
  });
  const totalPage = typeof rec.totalPage === 'number' ? rec.totalPage : 0;
  const currentPage = typeof rec.currentPage === 'number' ? rec.currentPage : 0;
  return { contents, totalPage, currentPage };
}

// GET .../mini-app/:aid/in-app-purchase/catalog/:productId
// ⚠️ Inferred (never returned a body — every live call in the current
// workspace hits the same 5002 partner gate as `catalogs`). Field names
// (productId/productName/netPrice/productType/minAppDeployment/...) are
// reconstructed from the edit page's reverse-mapper
// (`index.ClMdTz7O.js` function `U`) — see docs/api/in-app-purchase.md.
// Passed through opaquely rather than typed field-by-field since we have
// no live example to pin the shape against.
export async function fetchIapProduct(
  params: { workspaceId: number; miniAppId: number; productId: string },
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}` +
    `/in-app-purchase/catalog/${encodeURIComponent(params.productId)}`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected iap product shape for productId=${params.productId}`);
  }
  return raw as Record<string, unknown>;
}

// --- Orders / refunds ---
//
// Both are thin list wrappers: the SPA's call sites pass their params
// object straight through to the query-string builder, so no additional
// field names beyond `page` were recoverable by static analysis (see issue
// #220 "정적 분석 inventory" — orders/refunds are listed as inferred path-only).

export interface IapListPage {
  readonly contents: readonly Readonly<Record<string, unknown>>[];
  readonly totalPage: number;
  readonly currentPage: number;
}

export interface FetchIapOrdersParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
}

export async function fetchIapOrders(
  params: FetchIapOrdersParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<IapListPage> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  const query = qs.toString();
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/in-app-purchase/orders` +
    (query ? `?${query}` : '');
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeListPage(raw, `iap orders (app=${params.miniAppId})`);
}

export interface FetchIapRefundsParams {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly page?: number;
}

export async function fetchIapRefunds(
  params: FetchIapRefundsParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<IapListPage> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  const query = qs.toString();
  const url =
    `${BASE}/workspaces/${params.workspaceId}/mini-app/${params.miniAppId}/in-app-purchase/refunds` +
    (query ? `?${query}` : '');
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeListPage(raw, `iap refunds (app=${params.miniAppId})`);
}

function normalizeListPage(raw: unknown, label: string): IapListPage {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected ${label} shape`);
  }
  const rec = raw as Record<string, unknown>;
  const contentsRaw = rec.contents;
  if (!Array.isArray(contentsRaw)) {
    throw new Error(`Unexpected ${label} shape: contents is not an array`);
  }
  const contents = contentsRaw.map((c) => {
    if (c === null || typeof c !== 'object') return {};
    return c as Record<string, unknown>;
  });
  const totalPage = typeof rec.totalPage === 'number' ? rec.totalPage : 0;
  const currentPage = typeof rec.currentPage === 'number' ? rec.currentPage : 0;
  return { contents, totalPage, currentPage };
}

// --- Create product ---
//
// POST .../mini-app/:aid/in-app-purchase/product/inspection — create AND
// submit for inspection in one call, the same "one POST does both" shape
// already confirmed for mini-app registration (`POST .../mini-app/review`,
// see docs/api/mini-apps.md "Update mode"). ⚠️ Inferred: recovered by
// tracing the shared `IAPProductEditor` form component's `handleSubmit`
// composition (`IAPProductEditor.BQeOKeLb.js`) through to the create page's
// wrapper (`index.C6av4Lke.js`) — never live-confirmed, and per
// SECRET-HANDLING policy this function is never invoked against the real
// console API outside of a maintainer-approved live registration.
//
// Field-level rules mirrored from the form's react-hook-form `rules`
// (see docs/api/in-app-purchase.md "products create — inferred body shape"
// for the exact source lines):
//   - name: required, <=30 chars
//   - description: required, <=45 chars
//   - price: required, 400 <= price <= 1,400,000 (KRW, integer)
//   - renewalCycle: required iff type === 'SUBSCRIPTION', absent otherwise
//   - discountPolicies: only meaningful for SUBSCRIPTION, [] otherwise
//   - currency / defaultLocale: hardcoded 'KRW' / 'KO_KR' by the form itself
export interface IapDiscountPolicyInput {
  readonly discountType: 'FREE_TRIAL' | 'NEW_SUBSCRIPTION' | 'RETURNING';
  readonly period?: number;
  readonly durationMonths?: number;
  readonly discountedNetPrice?: number;
}

export interface CreateIapProductInput {
  readonly workspaceId: number;
  readonly miniAppId: number;
  readonly type: IapProductType;
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly iconImgUrl: string;
  readonly minDeploymentId: number;
  readonly postInspectionStatus: 'ACTIVE' | 'INACTIVE';
  readonly renewalCycle?: IapRenewalCycle;
  readonly discountPolicies?: readonly IapDiscountPolicyInput[];
}

export interface CreateIapProductResult {
  readonly productId: string | number | undefined;
  readonly extra: Readonly<Record<string, unknown>>;
}

export async function createIapProduct(
  input: CreateIapProductInput,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CreateIapProductResult> {
  const url =
    `${BASE}/workspaces/${input.workspaceId}/mini-app/${input.miniAppId}` +
    '/in-app-purchase/product/inspection';
  const isSubscription = input.type === 'SUBSCRIPTION';
  const body: Record<string, unknown> = {
    type: input.type,
    name: input.name,
    description: input.description,
    price: input.price,
    iconImgUrl: input.iconImgUrl,
    minDeploymentId: input.minDeploymentId,
    postInspectionStatus: input.postInspectionStatus,
    discountPolicies: isSubscription ? (input.discountPolicies ?? []) : [],
    currency: 'KRW',
    defaultLocale: 'KO_KR',
  };
  if (isSubscription && input.renewalCycle !== undefined) {
    body.renewalCycle = input.renewalCycle;
  }
  const raw = await requestConsoleApi<unknown>({
    url,
    method: 'POST',
    body,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeCreateResult(raw);
}

function normalizeCreateResult(raw: unknown): CreateIapProductResult {
  if (raw === null || typeof raw !== 'object') {
    return { productId: undefined, extra: {} };
  }
  const rec = raw as Record<string, unknown>;
  const rawId = rec.productId ?? rec.id;
  const productId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : undefined;
  return { productId, extra: rec };
}
