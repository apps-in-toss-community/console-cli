import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// Workspace-level "promotion money" — the budget a workspace spends
// promoting its OWN apps inside Toss (banners/placements the workspace
// buys). This is a DIFFERENT axis from in-app advertising (IAA, see
// `in-app-ads.ts`): promotion money is spend, IAA is revenue earned by
// serving ads inside the mini-app. Confirmed live 2026-07-24, workspace
// 3095 — both endpoints returned empty/zeroed (no campaigns run yet).
const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export interface PromotionMoneyBalance {
  readonly balance: number;
  readonly availableBalance: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

// GET .../workspaces/:wid/promotion-money
// Confirmed live (2026-07-24, workspace 3095): {"balance":0,"availableBalance":0}
export async function fetchPromotionMoneyBalance(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<PromotionMoneyBalance> {
  const url = `${BASE}/workspaces/${workspaceId}/promotion-money`;
  const raw = await requestConsoleApi<Record<string, unknown>>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const { balance: _balance, availableBalance: _availableBalance, ...extra } = raw;
  return {
    balance: typeof raw.balance === 'number' ? raw.balance : 0,
    availableBalance: typeof raw.availableBalance === 'number' ? raw.availableBalance : 0,
    extra,
  };
}

export interface PromotionMoneyHistoryPage {
  readonly contents: readonly Readonly<Record<string, unknown>>[];
  readonly totalPage: number;
  readonly currentPage: number;
}

export interface FetchPromotionMoneyHistoriesParams {
  readonly workspaceId: number;
  readonly page?: number;
}

// GET .../workspaces/:wid/promotion-money/histories
// Confirmed live (2026-07-24, workspace 3095): 200 with an empty list. The
// exact envelope shape beyond "empty" (bare array vs page-object like every
// other list endpoint in this API family) wasn't pinned down — ⚠️ inferred,
// see docs/api/promotion-money.md. This normaliser accepts either shape so
// a real entry doesn't surprise-break the CLI on first sight.
export async function fetchPromotionMoneyHistories(
  params: FetchPromotionMoneyHistoriesParams,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<PromotionMoneyHistoryPage> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  const query = qs.toString();
  const url =
    `${BASE}/workspaces/${params.workspaceId}/promotion-money/histories` +
    (query ? `?${query}` : '');
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return normalizeHistoryResponse(raw, params.page ?? 0);
}

function normalizeHistoryResponse(raw: unknown, page: number): PromotionMoneyHistoryPage {
  if (Array.isArray(raw)) {
    const contents = raw.map((c) =>
      c && typeof c === 'object' ? (c as Record<string, unknown>) : {},
    );
    return { contents, totalPage: contents.length > 0 ? 1 : 0, currentPage: page };
  }
  if (raw !== null && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const contentsRaw = rec.contents;
    if (Array.isArray(contentsRaw)) {
      return {
        contents: contentsRaw.map((c) =>
          c && typeof c === 'object' ? (c as Record<string, unknown>) : {},
        ),
        totalPage: typeof rec.totalPage === 'number' ? rec.totalPage : 0,
        currentPage: typeof rec.currentPage === 'number' ? rec.currentPage : page,
      };
    }
  }
  throw new Error('Unexpected promotion-money histories shape');
}
