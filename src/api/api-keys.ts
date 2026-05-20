import type { CdpCookie } from '../cdp.js';
import { type FetchLike, requestConsoleApi } from './http.js';

// Deploy Keys (the console UI labels them "API key"): workspace-scoped
// credentials used for deploy automation (see docs/api/api-keys.md). Three
// endpoints, all confirmed against the console UI bundle
// (`static/index.ZsA5htf8.js`):
//
//   GET  /workspaces/:wid/api-keys                  → list (`{id, name, expireTs}`)
//   POST /workspaces/:wid/api-keys                  → issue (returns `{apiKey, ...}`)
//   PUT  /workspaces/:wid/api-keys/:keyId/disable   → revoke
//
// The plaintext key is surfaced **once** in the POST response under the
// `apiKey` field. The list response intentionally omits it (the UI only
// shows the user-supplied `name` plus an expiry countdown), so a key that
// wasn't captured at creation cannot be recovered — same pattern as GitHub
// PATs and `gh`'s `auth token`.
//
// `name` is the user-supplied label (≤16 chars, no whitespace/Korean per UI
// validation). `expireTs` is epoch ms.

const BASE = 'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole';

export interface ApiKeySummary {
  readonly id: string | number;
  readonly name: string | undefined;
  readonly expireTs: number | undefined;
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
  // Field names confirmed from the management page chunk
  // (`static/index.ZsA5htf8.js`); fallbacks kept for `id`/`name` because
  // the bundle only proves they exist on the read path, not what the
  // server emits if a future migration renames them.
  const rawId = rec.id ?? rec.apiKeyId ?? rec.keyId;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new Error(
      `Unexpected api-key entry at index ${index} for workspace=${workspaceId}: missing id`,
    );
  }
  const rawName = rec.name ?? rec.apiKeyName ?? rec.keyName ?? rec.description;
  const name = typeof rawName === 'string' ? rawName : undefined;
  const expireTs = typeof rec.expireTs === 'number' ? rec.expireTs : undefined;
  const {
    id: _id,
    apiKeyId: _aid,
    keyId: _kid,
    name: _n,
    apiKeyName: _an,
    keyName: _kn,
    description: _d,
    expireTs: _e,
    ...extra
  } = rec;
  return { id: rawId, name, expireTs, extra };
}

// `target` mirrors the console UI dialog: `isAll: true` issues a key valid
// for every mini-app in the workspace; `isAll: false` scopes it to a list
// of `appName` slugs (the kebab-case slug, not numeric `miniAppId`).
//
// The upstream component (`he` in `static/index.ZsA5htf8.js`) sends `[]` in
// the all-apps case rather than omitting the field; we replicate that to
// avoid relying on the server treating an absent key as "all apps".
export interface CreateApiKeyTarget {
  readonly isAll: boolean;
  readonly appNames: readonly string[];
}

export interface CreateApiKeyResult {
  /** Plaintext key, surfaced **only** in the create response. */
  readonly apiKey: string;
  /** Any fields the server returned beyond `apiKey` (`id`, `expireTs`, ...). */
  readonly extra: Readonly<Record<string, unknown>>;
}

export async function createApiKey(
  workspaceId: number,
  body: { name: string; target: CreateApiKeyTarget },
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CreateApiKeyResult> {
  const url = `${BASE}/workspaces/${workspaceId}/api-keys`;
  const raw = await requestConsoleApi<unknown>({
    method: 'POST',
    url,
    cookies,
    body: { workspaceId, name: body.name, target: body.target },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Unexpected api-keys create response for workspace=${workspaceId}`);
  }
  const rec = raw as Record<string, unknown>;
  const apiKey = rec.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(
      `Unexpected api-keys create response for workspace=${workspaceId}: missing plaintext key`,
    );
  }
  const { apiKey: _k, ...extra } = rec;
  return { apiKey, extra };
}

export async function disableApiKey(
  workspaceId: number,
  apiKeyId: string | number,
  cookies: readonly CdpCookie[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const url = `${BASE}/workspaces/${workspaceId}/api-keys/${apiKeyId}/disable`;
  await requestConsoleApi<unknown>({
    method: 'PUT',
    url,
    cookies,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
