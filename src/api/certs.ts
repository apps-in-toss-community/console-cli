import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// mTLS certs: three endpoints with one path quirk worth pinning at the
// import site:
//
//   GET    /workspaces/:wid/mini-app/:aid/certs                     → list
//   POST   /workspaces/:wid/mini-app/:aid/cert/issue                → issue (singular!)
//   POST   /workspaces/:wid/mini-app/:aid/certs/:certId/disable     → revoke
//
// The console SPA defines all three side-by-side; only `issue` uses the
// singular `cert` segment. Confirmed by static-analysing the mTLS page
// chunk (`index.Bw6JQUAu.js`) — see docs/api/mini-app-misc.md
// "mTLS cert issue / disable / list" for the receipts.

const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

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

// Issue (`POST .../cert/issue`) is the only path that exposes the private
// key — list responses only carry metadata. Callers that intend to persist
// the material must do so atomically; the server side has no re-issue
// endpoint for the same `name`, just disable + create-fresh.
export interface IssueCertResult {
  readonly privateKey: string;
  readonly publicKey: string;
}

export async function issueCert(
  workspaceId: number,
  miniAppId: number,
  name: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<IssueCertResult> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/cert/issue`;
  const raw = await requestConsoleApi<unknown>({
    url,
    method: 'POST',
    body: { name },
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected issue-cert shape for app=${miniAppId}: not an object`);
  }
  const rec = raw as Record<string, unknown>;
  const privateKey = typeof rec.privateKey === 'string' ? rec.privateKey : null;
  const publicKey = typeof rec.publicKey === 'string' ? rec.publicKey : null;
  if (privateKey === null || publicKey === null) {
    throw new Error(
      `Unexpected issue-cert shape for app=${miniAppId}: missing privateKey/publicKey`,
    );
  }
  return { privateKey, publicKey };
}

// `disable` is what the wire calls it; the CLI surfaces it as `revoke`
// because the console UI itself has no reactivate path.
export async function revokeCert(
  workspaceId: number,
  miniAppId: number,
  certId: string,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const url = `${BASE}/workspaces/${workspaceId}/mini-app/${miniAppId}/certs/${encodeURIComponent(certId)}/disable`;
  await requestConsoleApi<unknown>({
    url,
    method: 'POST',
    body: {},
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
