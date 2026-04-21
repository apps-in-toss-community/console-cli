import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

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
