/**
 * Telemetry client — internal to @ait-co/console-cli.
 *
 * Usage: import { trackInvocation, trackInstall } from './telemetry/index.js'
 *
 * Events are fire-and-forget (non-blocking). Consent is opt-in only.
 * First invocation on a TTY prompts the user; non-TTY (CI) defaults to deny.
 *
 * Endpoint override for staging: AITCC_TELEMETRY_ENV=staging
 * (or automatically when VERSION contains '-dev').
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { VERSION } from '../version.js';
import { send } from './send.js';
import { acceptConsent, denyConsent, resolveEffectiveConsent, telemetryFilePath } from './state.js';

// ---------------------------------------------------------------------------
// Endpoint selection
// ---------------------------------------------------------------------------

function resolveEndpoint(): string {
  const override = process.env.AITCC_TELEMETRY_ENV;
  if (override === 'staging') return 'https://t-staging.aitc.dev';
  // Dev builds auto-route to staging
  if (VERSION.includes('-dev')) return 'https://t-staging.aitc.dev';
  return 'https://t.aitc.dev';
}

export const TELEMETRY_ENDPOINT = resolveEndpoint();

// ---------------------------------------------------------------------------
// First-run consent prompt (TTY only)
// ---------------------------------------------------------------------------

/** Returns true if this is the very first run (telemetry.json does not exist). */
function isFirstRun(): boolean {
  return !existsSync(telemetryFilePath());
}

/**
 * Prompt for consent on TTY. Defaults to deny on any non-TTY or error.
 * Called once per install (no file yet) when stdin/stdout are both TTYs.
 */
async function promptConsent(): Promise<void> {
  // Guard: only prompt on interactive TTY, never in CI or pipes
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await denyConsent();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stderr.write(
      [
        '',
        'aitcc 사용 개선을 위해 익명 사용 통계를 수집해도 될까요?',
        '  · 개인 식별 정보 없음  · 랜덤 익명 ID만 사용  · 언제든 off 가능',
        '  자세한 내용: https://docs.aitc.dev/privacy',
        '',
      ].join('\n'),
    );
    const answer = await rl.question('보내도 될까요? [y/N] ');
    if (answer.trim().toLowerCase() === 'y') {
      await acceptConsent();
    } else {
      await denyConsent();
    }
  } catch {
    // Error (e.g. stdin closed unexpectedly) → default deny
    await denyConsent();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Install-once marker
// ---------------------------------------------------------------------------

/** True only on the first invocation after a fresh install. */
async function isNewInstall(): Promise<boolean> {
  const markerPath = `${telemetryFilePath()}.install`;
  if (existsSync(markerPath)) return false;
  try {
    await writeFile(markerPath, '1', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public tracking API
// ---------------------------------------------------------------------------

/**
 * Called at CLI entry point with the resolved top-level command name.
 * Handles first-run consent prompt, install detection, and event send.
 * Fire-and-forget: do NOT await this.
 */
export async function trackInvocation(command: string): Promise<void> {
  try {
    // First run: prompt for consent (TTY), default deny (non-TTY)
    if (isFirstRun()) {
      await promptConsent();
    }

    const consent = await resolveEffectiveConsent();
    if (consent !== 'granted') return;

    // Send cli_install on very first run after consent granted
    const freshInstall = await isNewInstall();
    if (freshInstall) {
      void send(TELEMETRY_ENDPOINT, 'cli_install', VERSION, {
        platform: process.platform,
        arch: process.arch,
      });
    }

    // Send cli_invoked for every command
    void send(TELEMETRY_ENDPOINT, 'cli_invoked', VERSION, { command });
  } catch {
    // Never let telemetry crash the CLI
  }
}

// Re-export state primitives for the `aitcc telemetry` command
export {
  acceptConsent,
  CURRENT_POLICY_VERSION,
  deleteMyData,
  denyConsent,
  getOrCreateAnonId,
  readConsentState,
  resolveEffectiveConsent,
  telemetryFilePath,
} from './state.js';
