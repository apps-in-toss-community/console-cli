// Reusable headless-login helper — factored out of `commands/login.ts` so
// `acquireSessionOrReauth` and future callers can trigger a headless re-login
// without going through the full login command's interactive flow.
//
// Contract:
//   - Always headless (never opens a visible browser window).
//   - Single attempt — no retry loop (rate-limit / lockout risk).
//   - Disposes Chrome + CDP on every exit path.
//   - Never logs the password, cookie values, or any secret material.
//   - Env paths (AITCC_SESSION / AITCC_EMAIL+PASSWORD) are NOT fired here;
//     the caller is responsible for that carve-out.

import { TossApiError } from '../api/http.js';
import { attachToFirstPage, CdpClient, getAllCookies } from '../cdp.js';
import {
  ChromeEndpointTimeoutError,
  ChromeLaunchError,
  ChromeNotFoundError,
  launchChrome,
} from '../chrome.js';
import { resolveUserWithRetry } from '../commands/login.js';
import { runHeadlessLogin } from '../login-headless.js';
import { readSession, type Session, writeSession } from '../session.js';

export type HeadlessLoginResult =
  | { readonly kind: 'ok'; readonly session: Session }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'step-up-needed' };

export interface HeadlessLoginFromCredentialsInput {
  readonly email: string;
  readonly password: string;
  readonly timeoutMs?: number;
  readonly endpointTimeoutMs?: number;
}

/**
 * Perform a headless login using the supplied credentials and write the
 * resulting session to disk.
 *
 * Returns:
 *   `{ kind: 'ok', session }` — login succeeded, session written.
 *   `{ kind: 'step-up-needed' }` — Toss app push / OTP was required and
 *       the step-up window expired without completion.
 *   `{ kind: 'failed', reason }` — Chrome not found, CDP error, cookie
 *       capture failure, wrong-password banner, captcha, etc.  The
 *       `reason` string is a benign label (never password/cookie/token).
 */
export async function headlessLoginFromCredentials(
  input: HeadlessLoginFromCredentialsInput,
): Promise<HeadlessLoginResult> {
  const timeoutMs = input.timeoutMs ?? 300_000;
  const endpointTimeoutMs =
    input.endpointTimeoutMs ?? Math.min(60_000, Math.max(30_000, Math.floor(timeoutMs / 2)));

  // Toss Business authorize URL (same as the login command's authorize URL).
  // We open this page directly in headless Chrome so the form is immediately
  // present — avoiding an extra navigation round-trip.
  const authorizeUrl =
    'https://business.toss.im/login' +
    '?response_type=code' +
    '&client_id=4uktpjgqd0cp9txybqzuxc2y6w0cuupb' +
    '&redirect_uri=https%3A%2F%2Fapps-in-toss.toss.im%2Fsign-up' +
    '&scope=openid+email+profile';

  const launched = await launchChrome({
    initialUrl: authorizeUrl,
    endpointTimeoutMs,
    headless: true,
  }).catch((err: Error) => err);

  if (
    launched instanceof ChromeNotFoundError ||
    launched instanceof ChromeLaunchError ||
    launched instanceof ChromeEndpointTimeoutError
  ) {
    return { kind: 'failed', reason: 'chrome-launch-failed' };
  }
  if (launched instanceof Error) {
    return { kind: 'failed', reason: 'chrome-launch-failed' };
  }

  let client: CdpClient | null = null;
  const disposeAll = async (): Promise<void> => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    await launched.dispose().catch(() => {});
  };

  try {
    client = await CdpClient.connect({ url: launched.webSocketDebuggerUrl });
  } catch {
    await disposeAll();
    return { kind: 'failed', reason: 'cdp-connect-failed' };
  }

  let attached: Awaited<ReturnType<typeof attachToFirstPage>>;
  try {
    attached = await attachToFirstPage(client);
  } catch {
    await disposeAll();
    return { kind: 'failed', reason: 'cdp-attach-failed' };
  }

  let outcome: Awaited<ReturnType<typeof runHeadlessLogin>>;
  try {
    outcome = await runHeadlessLogin({
      client,
      sessionId: attached.sessionId,
      credentials: { email: input.email, password: input.password },
      submitObservationMs: 30_000,
      stepUpTimeoutMs: timeoutMs,
      // No onStepUp callback — reauth is silent on stderr here; the caller
      // (_shared.ts) prints the diagnostic before handing off to us.
    });
  } catch {
    await disposeAll();
    return { kind: 'failed', reason: 'headless-login-io-error' };
  }

  if (outcome.kind === 'fallback') {
    await disposeAll();
    return { kind: 'failed', reason: `headless-fallback-${outcome.reason}` };
  }

  if (outcome.kind === 'timeout') {
    await disposeAll();
    if (outcome.stage === 'step-up') {
      // The user was asked to confirm a step-up prompt in the Toss app and
      // the window elapsed without completion. This can't be completed
      // headlessly — the caller routes it to the "run `aitcc login`" path.
      return { kind: 'step-up-needed' };
    }
    // submit-stage timeout: the form never resolved (unhandled interstitial,
    // captcha, network). This is NOT a step-up situation — auto-reauth can't
    // open a visible browser to recover, so surface a generic failure rather
    // than the misleading "complete the step-up in your Toss app" message.
    return { kind: 'failed', reason: 'submit-timeout' };
  }

  // outcome.kind === 'ok' — pull cookies, resolve identity, write session.
  const cookies = await getAllCookies(client, attached.sessionId).catch((err: Error) => err);
  if (cookies instanceof Error) {
    await disposeAll();
    return { kind: 'failed', reason: 'cookie-capture-failed' };
  }

  const user = await resolveUserWithRetry(cookies).catch((err: Error) => err);
  if (user instanceof Error) {
    await disposeAll();
    if (user instanceof TossApiError && user.isAuthError) {
      return { kind: 'failed', reason: 'session-not-active' };
    }
    return { kind: 'failed', reason: 'member-info-failed' };
  }

  const session: Session = {
    schemaVersion: 2,
    user: {
      id: String(user.id),
      email: user.email,
      ...(user.name ? { displayName: user.name } : {}),
    },
    cookies,
    origins: [],
    capturedAt: new Date().toISOString(),
  };

  try {
    await writeSession(session);
  } catch {
    await disposeAll();
    return { kind: 'failed', reason: 'session-write-failed' };
  }

  await disposeAll();

  // Re-read the session so the caller always gets the canonical on-disk
  // shape (e.g. the v1→v2 upgrade path if anything touched it).
  const written = await readSession();
  if (!written) {
    return { kind: 'failed', reason: 'session-read-back-failed' };
  }

  return { kind: 'ok', session: written };
}
