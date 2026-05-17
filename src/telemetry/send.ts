/**
 * Telemetry send — fire-and-forget with one retry.
 *
 * Rules:
 *   1. If consent ≠ "granted" — drop silently.
 *   2. POST event as JSON with 5 s timeout.
 *   3. On network error or non-2xx: retry ONCE after 2 s. On second failure: drop.
 *   4. Meta is capped at 256 bytes (JSON-serialized); oversized meta is dropped.
 *   5. All calls are non-blocking — caller never awaits send().
 */

import { getOrCreateAnonId, readConsentState } from './state.js';

/** Console-cli event names. Extend here as new command-level signals are needed. */
export type CliTelemetryEvent = 'cli_invoked' | 'cli_install';

export interface CliEventPayload {
  source: 'console-cli';
  event: CliTelemetryEvent;
  anon_id: string;
  version: string;
  ts: number;
  meta?: Record<string, unknown> | undefined;
}

/** Meta size cap per server contract (JSON bytes). */
const META_BYTE_CAP = 256;

function sanitizeMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  const serialized = JSON.stringify(meta);
  if (new TextEncoder().encode(serialized).byteLength > META_BYTE_CAP) return undefined;
  return meta;
}

async function doFetch(endpoint: string, payload: CliEventPayload): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${endpoint}/e`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry delay in ms — injectable for tests. */
export let RETRY_DELAY_MS = 2_000;
/** Override for tests only. */
export function setRetryDelayMs(ms: number): void {
  RETRY_DELAY_MS = ms;
}

/**
 * Send a telemetry event. Drops silently if consent is not 'granted'.
 * Returns a Promise but callers should NOT await it — fire-and-forget only.
 */
export async function send(
  endpoint: string,
  event: CliTelemetryEvent,
  version: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  if ((await readConsentState()) !== 'granted') return;

  const sanitized = sanitizeMeta(meta);
  const payload: CliEventPayload = {
    source: 'console-cli',
    event,
    anon_id: await getOrCreateAnonId(),
    version,
    ts: Date.now(),
    ...(sanitized !== undefined ? { meta: sanitized } : {}),
  };

  const ok = await doFetch(endpoint, payload);
  if (ok) return;

  // Retry once after the configured delay
  await delay(RETRY_DELAY_MS);
  await doFetch(endpoint, payload);
  // Second failure → drop silently
}
