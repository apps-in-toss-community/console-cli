import { defineCommand } from 'citty';
import { type FetchLike, TossApiError } from '../api/http.js';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import {
  attachToFirstPage,
  CdpClient,
  type CdpCookie,
  getAllCookies,
  watchMainFrameNavigations,
} from '../cdp.js';
import {
  ChromeEndpointTimeoutError,
  ChromeLaunchError,
  ChromeNotFoundError,
  launchChrome,
} from '../chrome.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { type Session, writeSession } from '../session.js';

// Login flow (replaces the prior OAuth-callback-server scaffold):
//
//   1. Launch a Chrome-family browser with an isolated user-data-dir,
//      pointed at the Toss Business sign-in URL that redirects into the
//      Apps in Toss console after authentication.
//   2. Watch main-frame navigations over CDP. Once the URL lands on the
//      console's post-login workspace page, we know the auth cookies have
//      been set (HttpOnly, so JS can't see them — CDP can).
//   3. Dump all cookies via `Network.getAllCookies`, resolve the member
//      user-info from the console API to capture a stable identity, and
//      persist `{ user, cookies, capturedAt }` at `$XDG_CONFIG_HOME/
//      aitcc/session.json` (0600).
//   4. Dispose the Chrome process and wipe the ephemeral user-data-dir.
//
// The CDP-discovered redirect URL (`https://apps-in-toss.toss.im/workspace`
// with optional `?code=...&state=...` auth-code tail) is the production
// redirect configured on the client_id. We never need a localhost callback.

const DEFAULT_AUTHORIZE_URL =
  'https://business.toss.im/account/sign-in' +
  '?client_id=4uktpjgqd0cp9txybqzuxc2y6w0cuupb' +
  '&redirect_uri=https%3A%2F%2Fapps-in-toss.toss.im%2Fsign-up' +
  '&state=%2Fworkspace';

// The CDP login is complete once the main frame lands on the workspace URL.
const LOGIN_LANDING_HOST = 'apps-in-toss.toss.im';
const LOGIN_LANDING_PATH_PREFIX = '/workspace';

// Hosts we'll drive a login flow to. `AITCC_OAUTH_URL` is meant as a
// staging-environment escape hatch, not a way to redirect the CLI to an
// attacker-controlled URL via a tampered shell rc. A `.toss.im` suffix
// match is the tightest allowlist that still permits internal hosts.
const ALLOWED_AUTHORIZE_HOST_SUFFIXES = ['.toss.im'] as const;

export function isAllowedAuthorizeHost(host: string): boolean {
  const lower = host.toLowerCase();
  return ALLOWED_AUTHORIZE_HOST_SUFFIXES.some(
    (suffix) => lower === suffix.slice(1) || lower.endsWith(suffix),
  );
}

export function isLoginLanding(url: string): boolean {
  try {
    const u = new URL(url);
    // Use hostname (no port) so a same-host landing on a non-default port
    // still matches — the console hasn't shipped a custom port in the
    // wild but we shouldn't trip on one if it appears.
    if (u.hostname !== LOGIN_LANDING_HOST) return false;
    if (
      u.pathname !== LOGIN_LANDING_PATH_PREFIX &&
      !u.pathname.startsWith(`${LOGIN_LANDING_PATH_PREFIX}/`)
    ) {
      return false;
    }
    // Reject things like `/workspacely`: require the prefix to be followed
    // by end-of-path or a '/'.
    return true;
  } catch {
    return false;
  }
}

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Open a browser to sign in, then capture the console session cookies.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    timeout: {
      type: 'string',
      description: 'Abort if login does not complete within N seconds (default 300).',
      default: '300',
    },
  },
  async run({ args }) {
    const emitError = (payload: Record<string, unknown>, human: string) => {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
      }
      process.stderr.write(`${human}\n`);
    };

    const timeoutSec = Number(args.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
      emitError(
        { reason: 'invalid-timeout', given: args.timeout },
        `Invalid --timeout value: ${args.timeout}`,
      );
      return exitAfterFlush(ExitCode.Usage);
    }
    const timeoutMs = timeoutSec * 1000;

    const rawAuthorizeUrl = process.env.AITCC_OAUTH_URL;
    const authorizeUrl = rawAuthorizeUrl ?? DEFAULT_AUTHORIZE_URL;
    if (rawAuthorizeUrl) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(rawAuthorizeUrl);
      } catch {
        // fall through
      }
      if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        emitError(
          { reason: 'invalid-authorize-url' },
          `AITCC_OAUTH_URL is not a valid http(s) URL: ${rawAuthorizeUrl}`,
        );
        return exitAfterFlush(ExitCode.Usage);
      }
      if (!isAllowedAuthorizeHost(parsed.hostname)) {
        emitError(
          { reason: 'authorize-host-not-allowed', host: parsed.hostname },
          `Refusing to open ${parsed.hostname}: only *.toss.im hosts are allowed for sign-in.`,
        );
        return exitAfterFlush(ExitCode.Usage);
      }
      process.stderr.write(`Using custom authorize URL from AITCC_OAUTH_URL: ${authorizeUrl}\n`);
    }

    // Cap Chrome's own startup window at half the overall --timeout, with
    // a 30-second floor and 60-second ceiling. Corporate anti-virus can
    // easily push a cold Chrome launch past the default 15s; short
    // `--timeout` values shouldn't starve the launch itself.
    const endpointTimeoutMs = Math.min(60_000, Math.max(30_000, Math.floor(timeoutMs / 2)));

    // Launch Chrome.
    const launched = await launchChrome({
      initialUrl: authorizeUrl,
      endpointTimeoutMs,
    }).catch((err: Error) => err);
    if (launched instanceof ChromeNotFoundError) {
      emitError({ reason: 'chrome-not-found', candidates: launched.candidates }, launched.message);
      return exitAfterFlush(ExitCode.LoginBrowserNotFound);
    }
    if (launched instanceof ChromeLaunchError || launched instanceof ChromeEndpointTimeoutError) {
      emitError(
        { reason: 'chrome-launch-failed', message: launched.message },
        `Failed to launch browser: ${launched.message}`,
      );
      return exitAfterFlush(ExitCode.LoginBrowserFailed);
    }
    if (launched instanceof Error) {
      // An unexpected Error type — keep enough context to diagnose later.
      emitError(
        {
          reason: 'chrome-launch-failed',
          errorName: launched.name,
          message: launched.message,
        },
        `Failed to launch browser (${launched.name}): ${launched.message}`,
      );
      return exitAfterFlush(ExitCode.LoginBrowserFailed);
    }

    process.stderr.write(
      'Opened a browser window — complete the sign-in there. The CLI will capture the session automatically.\n',
    );

    // Resource disposal must happen BEFORE `exitAfterFlush` is called:
    // `exitAfterFlush` terminates the process, and Chrome children on POSIX
    // are not killed automatically when the parent exits. A `try/finally`
    // wrapper is *not* safe here — the enclosing async function's finally
    // races `process.exit` and may skip the SIGTERM + rm -rf.
    let client: CdpClient | null = null;
    const disposeAll = async (): Promise<void> => {
      if (client) {
        await client.close().catch(() => {});
        client = null;
      }
      await launched.dispose().catch(() => {});
    };
    const exitWith = async (code: number): Promise<never> => {
      await disposeAll();
      return exitAfterFlush(code);
    };

    try {
      client = await CdpClient.connect({ url: launched.webSocketDebuggerUrl });
    } catch (err) {
      emitError(
        { reason: 'cdp-connect-failed', message: (err as Error).message },
        `Could not connect to the browser over CDP: ${(err as Error).message}`,
      );
      return exitWith(ExitCode.LoginBrowserFailed);
    }

    let attached: Awaited<ReturnType<typeof attachToFirstPage>>;
    try {
      attached = await attachToFirstPage(client);
    } catch (err) {
      emitError(
        { reason: 'cdp-attach-failed', message: (err as Error).message },
        `Could not attach to the browser tab: ${(err as Error).message}`,
      );
      return exitWith(ExitCode.LoginBrowserFailed);
    }

    const landing = await waitForLanding(client, attached.sessionId, timeoutMs);
    if (landing === 'timeout') {
      emitError({ reason: 'login-timeout', timeoutSec }, `Login timed out after ${timeoutSec}s.`);
      return exitWith(ExitCode.LoginTimeout);
    }
    if (landing === 'aborted') {
      emitError(
        { reason: 'login-aborted' },
        'Login was aborted (browser closed before reaching the console).',
      );
      return exitWith(ExitCode.LoginBrowserFailed);
    }

    // Pull all cookies across all origins the browser has collected.
    // `Network.getAllCookies` requires a target session (it isn't exposed
    // on the browser-level endpoint), so we route through the attached
    // page. The returned set still spans every origin the browser has
    // stored cookies for (business.toss.im, business-accounts.toss.im,
    // apps-in-toss.toss.im), not just the current page.
    const cookies = await getAllCookies(client, attached.sessionId).catch((err: Error) => err);
    if (cookies instanceof Error) {
      emitError(
        { reason: 'cookie-capture-failed', message: cookies.message },
        `Failed to capture cookies: ${cookies.message}`,
      );
      return exitWith(ExitCode.LoginCookieCaptureFailed);
    }

    // Resolve identity via the console member info endpoint. This also
    // doubles as a liveness check — a session that can't call /me means
    // we captured cookies too early (before the auth-code exchange
    // completed). If so, we wait briefly and retry once.
    const user = await resolveUserWithRetry(cookies, {
      onRetry: (ms) =>
        process.stderr.write(
          `Cookies not yet accepted by the console API — retrying in ${ms}ms...\n`,
        ),
    }).catch((err: Error) => err);
    if (user instanceof Error) {
      const authFailed = user instanceof TossApiError && user.isAuthError;
      emitError(
        {
          reason: authFailed ? 'login-auth-not-active' : 'member-info-failed',
          message: user.message,
        },
        authFailed
          ? 'Browser session did not produce valid console cookies. Try again and wait for the workspace page to load.'
          : `Failed to read member info: ${user.message}`,
      );
      return exitWith(authFailed ? ExitCode.LoginCookieCaptureFailed : ExitCode.ApiError);
    }

    const session: Session = {
      schemaVersion: 1,
      user: {
        id: String(user.id),
        email: user.email,
        displayName: user.name,
      },
      cookies,
      origins: [],
      capturedAt: new Date().toISOString(),
    };
    try {
      await writeSession(session);
    } catch (err) {
      emitError(
        { reason: 'session-write-failed', message: (err as Error).message },
        `Failed to write session file: ${(err as Error).message}`,
      );
      return exitWith(ExitCode.Generic);
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          status: 'logged-in',
          user: session.user,
          capturedAt: session.capturedAt,
          cookieCount: cookies.length,
        })}\n`,
      );
    } else {
      process.stdout.write(`Logged in as ${user.name} <${user.email}>\n`);
    }
    return exitWith(ExitCode.Ok);
  },
});

export async function waitForLanding(
  client: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<'ok' | 'timeout' | 'aborted'> {
  // Two signals, run together, first wins:
  //   (a) Page.frameNavigated events — responsive, catches the final redirect.
  //   (b) Polling Page.getFrameTree — a safety net for the race where Chrome
  //       finishes the auth redirects before we finish attaching and
  //       subscribing. The navigation event won't re-fire for pages that
  //       already landed, so we have to poll the current URL at least once
  //       (and continue polling in case CDP events are dropped on slow links).
  return await new Promise<'ok' | 'timeout' | 'aborted'>((resolve) => {
    let settled = false;
    const stops: Array<() => void | Promise<void>> = [];
    const settle = (outcome: 'ok' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      for (const s of stops) {
        try {
          void s();
        } catch {
          // best effort
        }
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // Target-destroyed → the user closed the tab before landing.
    stops.push(
      client.on((event) => {
        if (event.method === 'Target.targetDestroyed') settle('aborted');
      }),
    );

    // (a) Live event subscription. Fires on fresh navigations after we
    //     Page.enable — may not trigger if Chrome already finished all
    //     redirects before we attached (handled by (b)).
    watchMainFrameNavigations(client, sessionId, (ev) => {
      if (!ev.isMainFrame) return;
      if (isLoginLanding(ev.url)) settle('ok');
    })
      .then((off) => {
        // Polling may have already settled by the time subscribe returns;
        // in that case unregister the listener immediately rather than
        // leaving it dangling on the client.
        if (settled) off();
        else stops.push(off);
      })
      .catch((err: Error) => {
        if (settled) return;
        process.stderr.write(`Could not watch for navigation: ${err.message}\n`);
      });

    // (b) Poll the current main-frame URL every second. Cheap, robust.
    const checkCurrent = async () => {
      if (settled) return;
      const tree = await client
        .send<{ frameTree: { frame: { url?: string; parentId?: string } } }>(
          'Page.getFrameTree',
          {},
          sessionId,
        )
        .catch(() => null);
      const url = tree?.frameTree.frame?.url;
      if (url && isLoginLanding(url)) settle('ok');
    };
    // Kick off an immediate check — covers the "already landed" case.
    void checkCurrent();
    const pollTimer = setInterval(() => {
      void checkCurrent();
    }, 1000);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  });
}

// The console issues auth cookies a beat after the landing navigation
// fires — if the first /me call 401s, we wait this long and retry once.
// Larger than the fastest observed exchange (~200 ms), small enough to
// keep the user from wondering whether the CLI hung.
export const AUTH_SETTLE_DELAY_MS = 750;

export async function resolveUserWithRetry(
  cookies: readonly CdpCookie[],
  opts: {
    onRetry?: (delayMs: number) => void;
    fetchImpl?: FetchLike;
  } = {},
): Promise<Awaited<ReturnType<typeof fetchConsoleMemberUserInfo>>> {
  const callArgs = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  try {
    return await fetchConsoleMemberUserInfo(cookies, callArgs);
  } catch (err) {
    if (err instanceof TossApiError && err.isAuthError) {
      opts.onRetry?.(AUTH_SETTLE_DELAY_MS);
      await new Promise((r) => {
        const t = setTimeout(r, AUTH_SETTLE_DELAY_MS);
        if (typeof t.unref === 'function') t.unref();
      });
      return await fetchConsoleMemberUserInfo(cookies, callArgs);
    }
    throw err;
  }
}
