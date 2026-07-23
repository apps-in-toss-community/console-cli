import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// Workspace-level business (사업자) license verification status. Confirmed
// live 2026-07-24, workspace 3095: HTTP 200 / envelope `resultType:
// SUCCESS`, but the `success` payload itself embeds a *business-level*
// `errorCode: 500` meaning "license not registered yet". This is NOT the
// transport-level `TossApiError` (that only ever fires on `resultType:
// FAIL`, see src/api/http.ts) — it's a diagnostic field the server chose to
// nest inside an otherwise-successful envelope. Treat it as a status signal
// and never throw for it; the "500" here is unrelated to the
// generic-permission-failure `500` documented in docs/api/_error-codes.md
// (that one arrives via the FAIL envelope, this one via SUCCESS).
const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export interface BusinessVerificationStatus {
  readonly registered: boolean;
  readonly errorCode: number | null;
  readonly extra: Readonly<Record<string, unknown>>;
}

// GET .../workspaces/:wid/business-verification/license/data
export async function fetchBusinessVerificationLicense(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<BusinessVerificationStatus> {
  const url = `${BASE}/workspaces/${workspaceId}/business-verification/license/data`;
  const raw = await requestConsoleApi<Record<string, unknown>>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const errorCode = typeof raw.errorCode === 'number' ? raw.errorCode : null;
  return { registered: errorCode === null, errorCode, extra: raw };
}
