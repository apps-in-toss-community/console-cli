import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// Workspace-level Toss Pay credential *presence* check.
//
// SECRET-HANDLING (same class as Deploy Key — CLAUDE.md §3.1): this module
// never returns the actual key values to callers. The raw response is
// inspected and immediately collapsed into a SET/UNSET state right here, so
// no downstream layer (command output, --json emit, logs) ever holds a
// plaintext value it could accidentally leak. There is intentionally no
// escape hatch (no `--reveal` flag, no `extra` passthrough) — unlike
// `api-keys.ts`, which surfaces a plaintext key exactly once at issuance,
// these are pre-existing workspace configuration values with no equivalent
// "just issued it, show it once" moment.
const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export type PayConfigFieldState = 'SET' | 'UNSET';

export interface PayConfigStatus {
  readonly workspaceId: number;
  readonly payApiKey: PayConfigFieldState;
  readonly testPayApiKey: PayConfigFieldState;
  readonly billingPayApiKey: PayConfigFieldState;
  readonly testBillingPayApiKey: PayConfigFieldState;
  readonly tossCertClientId: PayConfigFieldState;
}

function fieldState(raw: unknown): PayConfigFieldState {
  return typeof raw === 'string' && raw.length > 0 ? 'SET' : 'UNSET';
}

// GET .../workspaces/:wid/configs
// Confirmed live (2026-07-24, workspace 3095): every field unset (null or
// empty string) — `{workspaceId, payApiKey, testPayApiKey, billingPayApiKey,
// testBillingPayApiKey, tossCertClientId}`.
export async function fetchPayConfigStatus(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<PayConfigStatus> {
  const url = `${BASE}/workspaces/${workspaceId}/configs`;
  const raw = await requestConsoleApi<Record<string, unknown>>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return {
    workspaceId: typeof raw.workspaceId === 'number' ? raw.workspaceId : workspaceId,
    payApiKey: fieldState(raw.payApiKey),
    testPayApiKey: fieldState(raw.testPayApiKey),
    billingPayApiKey: fieldState(raw.billingPayApiKey),
    testBillingPayApiKey: fieldState(raw.testBillingPayApiKey),
    tossCertClientId: fieldState(raw.tossCertClientId),
  };
}
