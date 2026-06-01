// ait-token-profile.ts
//
// `ait token add` stores Deploy Keys in `~/.ait/credentials` as a simple
// JSON map:  `{ "<profile>": "<plaintext-key>" }`.
//
// We write the same file directly rather than spawning `ait token add`
// for four reasons:
//   1. `ait` is often not on PATH — it lives inside project node_modules.
//   2. The format is stable and trivially simple.
//   3. Spawn would expose the key on argv on systems without /proc/pid/cmdline
//      protection (e.g. older macOS `ps`).
//   4. Non-TTY spawn of `ait token add` without --api-key triggers an
//      interactive password prompt — fragile in CI and agent contexts.
//
// If direct-write fails (e.g. ait changes location) we fall back to
// spawning `ait token add --api-key <key> <profile>` if `ait` is found
// on PATH.  The fallback is best-effort and never throws.
//
// SECRET-HANDLING: The plaintext key must NEVER appear in logs, errors,
// or stderr output.  All functions in this module honour that contract.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AIT_CREDENTIALS_PATH = join(homedir(), '.ait', 'credentials');

export type SaveProfileResult =
  | { ok: true; method: 'direct'; profile: string }
  | { ok: true; method: 'spawn'; profile: string }
  | { ok: false; reason: 'write-failed'; detail: string }
  | { ok: false; reason: 'spawn-failed'; detail: string };

// Override the credentials path for tests via this env variable.
// Production code never sets this.
function credentialsPath(): string {
  const override = process.env._AIT_CREDENTIALS_PATH_OVERRIDE;
  if (override && override.length > 0) return override;
  return AIT_CREDENTIALS_PATH;
}

function readCredentials(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeCredentials(path: string, map: Record<string, string>): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Save a Deploy Key to the `ait` token profile store.
 *
 * Tries direct-write first.  If that fails and `ait` is on PATH, falls back
 * to spawning `ait token add --api-key ... <profile>`.
 *
 * SECRET-HANDLING: `apiKey` must not appear in any log or thrown message.
 * The `detail` field in failure results contains only non-secret context.
 */
export function saveAitTokenProfile(profile: string, apiKey: string): SaveProfileResult {
  const path = credentialsPath();

  // --- attempt 1: direct write ---
  try {
    const map = readCredentials(path);
    map[profile] = apiKey;
    writeCredentials(path, map);
    return { ok: true, method: 'direct', profile };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Don't include apiKey in detail.

    // --- attempt 2: spawn fallback ---
    try {
      execFileSync('ait', ['token', 'add', '--api-key', apiKey, profile], {
        stdio: 'ignore',
        timeout: 10_000,
        env: { ...process.env },
      });
      return { ok: true, method: 'spawn', profile };
    } catch {
      // Return the original write error as context; spawn error is secondary.
      return { ok: false, reason: 'write-failed', detail };
    }
  }
}

/**
 * Check whether a profile already exists in the credentials file.
 * Used in tests; not called from command path.
 */
export function hasAitTokenProfile(profile: string): boolean {
  const path = credentialsPath();
  const map = readCredentials(path);
  return profile in map;
}
