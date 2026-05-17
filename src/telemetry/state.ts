/**
 * Telemetry consent state + anon_id I/O for console-cli.
 *
 * Storage: ~/.config/aitcc/telemetry.json  (0600, XDG-aware via configDir())
 * Consistent with devtools' localStorage schema names where applicable.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from '../paths.js';

export type ConsentState = 'granted' | 'denied' | 'undecided';

/** Current policy version. Bump whenever the privacy policy changes. */
export const CURRENT_POLICY_VERSION = '2026-05-18';

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

export function telemetryFilePath(): string {
  return join(configDir(), 'telemetry.json');
}

// ---------------------------------------------------------------------------
// Persistent state shape
// ---------------------------------------------------------------------------

interface TelemetryState {
  readonly schemaVersion: 1;
  readonly consent: ConsentState;
  readonly policyVersion: string;
  readonly anonId?: string;
  /** ISO date (YYYY-MM-DD) of the last successfully sent Tier 0 ping. */
  readonly tier0LastSent?: string;
  /** When true, the user has permanently opted out of Tier 0 pings. */
  readonly tier0OptOut?: boolean;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export async function readStateFile(): Promise<TelemetryState | null> {
  let raw: string;
  try {
    raw = await readFile(telemetryFilePath(), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return null;
  if (obj.consent !== 'granted' && obj.consent !== 'denied' && obj.consent !== 'undecided')
    return null;
  if (typeof obj.policyVersion !== 'string') return null;
  return {
    schemaVersion: 1,
    consent: obj.consent as ConsentState,
    policyVersion: obj.policyVersion,
    ...(typeof obj.anonId === 'string' ? { anonId: obj.anonId } : {}),
    ...(typeof obj.tier0LastSent === 'string' ? { tier0LastSent: obj.tier0LastSent } : {}),
    ...(obj.tier0OptOut === true ? { tier0OptOut: true } : {}),
  };
}

async function writeStateFile(state: TelemetryState): Promise<void> {
  const path = telemetryFilePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read the raw consent from disk. Returns 'undecided' if no file. */
export async function readConsentState(): Promise<ConsentState> {
  const s = await readStateFile();
  if (!s) return 'undecided';
  return s.consent;
}

/**
 * Resolve effective consent with policy-version bump rule:
 *   - Previously 'granted' but on an old policy version → revert to 'undecided'
 *   - Previously 'denied' on any version → stay 'denied'
 */
export async function resolveEffectiveConsent(): Promise<ConsentState> {
  const s = await readStateFile();
  if (!s) return 'undecided';
  if (s.consent === 'granted') {
    if (s.policyVersion !== CURRENT_POLICY_VERSION) return 'undecided';
    return 'granted';
  }
  return s.consent;
}

/**
 * Returns the stored anon_id, or generates + persists a new UUID v4.
 * Once generated it is never overwritten except after a successful deleteMyData call.
 */
export async function getOrCreateAnonId(): Promise<string> {
  const s = await readStateFile();
  if (s?.anonId) return s.anonId;

  const id = crypto.randomUUID();
  const current: TelemetryState = s ?? {
    schemaVersion: 1,
    consent: 'undecided',
    policyVersion: CURRENT_POLICY_VERSION,
  };
  await writeStateFile({ ...current, anonId: id });
  return id;
}

export async function acceptConsent(): Promise<void> {
  const s = await readStateFile();
  const anonId = s?.anonId ?? crypto.randomUUID();
  await writeStateFile({
    schemaVersion: 1,
    consent: 'granted',
    policyVersion: CURRENT_POLICY_VERSION,
    anonId,
  });
}

export async function denyConsent(): Promise<void> {
  const s = await readStateFile();
  await writeStateFile({
    schemaVersion: 1,
    consent: 'denied',
    policyVersion: CURRENT_POLICY_VERSION,
    ...(s?.anonId ? { anonId: s.anonId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tier 0 opt-out
// ---------------------------------------------------------------------------

/** Returns true if Tier 0 pings are permanently opted out. */
export async function isTier0OptedOut(): Promise<boolean> {
  const s = await readStateFile();
  return s?.tier0OptOut === true;
}

/** Permanently opt out of Tier 0 pings (sets tier0OptOut: true). */
export async function setTier0OptOut(optOut: boolean): Promise<void> {
  const s = await readStateFile();
  const current: TelemetryState = s ?? {
    schemaVersion: 1,
    consent: 'undecided',
    policyVersion: CURRENT_POLICY_VERSION,
  };
  if (optOut) {
    await writeStateFile({ ...current, tier0OptOut: true });
  } else {
    // Remove tier0OptOut by rebuilding without it
    const { tier0OptOut: _removed, ...rest } = current;
    await writeStateFile(rest as TelemetryState);
  }
}

/**
 * Returns the ISO date (YYYY-MM-DD) of the last sent Tier 0 ping, or null.
 */
export async function getTier0LastSent(): Promise<string | null> {
  const s = await readStateFile();
  return s?.tier0LastSent ?? null;
}

/**
 * Record that a Tier 0 ping was sent today (ISO date marker).
 */
export async function markTier0Sent(date: string): Promise<void> {
  const s = await readStateFile();
  const current: TelemetryState = s ?? {
    schemaVersion: 1,
    consent: 'undecided',
    policyVersion: CURRENT_POLICY_VERSION,
  };
  await writeStateFile({ ...current, tier0LastSent: date });
}

// ---------------------------------------------------------------------------
// Data deletion
// ---------------------------------------------------------------------------

/**
 * Delete data: send DELETE /e?anon_id=... to the server (if we have an id),
 * then rotate local anon_id so subsequent events are unlinkable.
 */
export async function deleteMyData(endpoint: string): Promise<boolean> {
  const s = await readStateFile();
  if (!s?.anonId) return false;
  try {
    const res = await fetch(`${endpoint}/e?anon_id=${encodeURIComponent(s.anonId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) return false;
    // Rotate anon_id so subsequent events are unlinkable from deleted history
    await writeStateFile({ ...s, anonId: crypto.randomUUID() });
    return true;
  } catch {
    return false;
  }
}
