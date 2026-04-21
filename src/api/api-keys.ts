import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// GET /workspaces/:id/api-keys — returns an array of console API keys used
// for deploy automation. Our confirmed workspaces have zero keys (the UI
// shows a "발급받기" CTA when the list is empty), so the entry shape is
// unconfirmed. We normalise `id`/`name` across a few plausible spellings
// and stash everything else under `extra`, matching the mini-app pattern.
//
// `keys create` is a deliberate follow-up — once an issued key lands we can
// tighten this client against the real shape. See TODO.md's Medium list.

const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export interface ApiKeySummary {
  readonly id: string | number;
  readonly name: string | undefined;
  readonly extra: Readonly<Record<string, unknown>>;
}

export async function fetchApiKeys(
  workspaceId: number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ApiKeySummary[]> {
  const url = `${BASE}/workspaces/${workspaceId}/api-keys`;
  const raw = await requestConsoleApi<unknown>({
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected api-keys shape for workspace=${workspaceId}: not an array`);
  }
  return raw.map((entry, index) => normalizeKey(entry, workspaceId, index));
}

function normalizeKey(raw: unknown, workspaceId: number, index: number): ApiKeySummary {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      `Unexpected api-key entry at index ${index} for workspace=${workspaceId}: not an object`,
    );
  }
  const rec = raw as Record<string, unknown>;
  const rawId = rec.id ?? rec.apiKeyId ?? rec.keyId;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new Error(
      `Unexpected api-key entry at index ${index} for workspace=${workspaceId}: missing id`,
    );
  }
  const rawName = rec.name ?? rec.apiKeyName ?? rec.keyName ?? rec.description;
  const name = typeof rawName === 'string' ? rawName : undefined;
  const {
    id: _id,
    apiKeyId: _aid,
    keyId: _kid,
    name: _n,
    apiKeyName: _an,
    keyName: _kn,
    description: _d,
    ...extra
  } = rec;
  return { id: rawId, name, extra };
}
