import { defineCommand } from 'citty';
import { openBrowser } from '../browser.js';
import { ExitCode } from '../exit.js';
import {
  CallbackMissingCodeError,
  type CallbackQuery,
  CallbackStateMismatchError,
  CallbackTimeoutError,
  startCallbackServer,
} from '../oauth.js';
import { type Session, writeSession } from '../session.js';

// The Toss developer console OAuth authorize URL and scope are not publicly
// documented as of 2026-04. Override with `AIT_CONSOLE_OAUTH_URL` (and
// optionally `AIT_CONSOLE_OAUTH_CLIENT_ID` / `AIT_CONSOLE_OAUTH_SCOPE`) while
// discovery is in progress. Without the env var we refuse to run rather than
// silently hit a placeholder endpoint.

// Cap raw callback-query fields before writing them to the session file.
// The real flow will replace this with a token-endpoint POST; until then,
// accept only short, control-char-free strings for the user label.
const MAX_FIELD_LENGTH = 512;

function sanitizeField(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_FIELD_LENGTH) return undefined;
  // Reject control chars including CR/LF so a pasted value can't forge a log
  // line or break JSON emission.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit control-char filter
  if (/[\x00-\x1f\x7f]/.test(raw)) return undefined;
  return raw;
}

function buildAuthorizeUrl(params: {
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly clientId: string | undefined;
  readonly scope: string | undefined;
}): string {
  const url = new URL(params.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  if (params.clientId) url.searchParams.set('client_id', params.clientId);
  if (params.scope) url.searchParams.set('scope', params.scope);
  return url.toString();
}

function classifyCallbackError(err: Error): {
  reason: 'timeout' | 'state-mismatch' | 'missing-code' | 'other';
  exitCode: ExitCode;
} {
  if (err instanceof CallbackTimeoutError) {
    return { reason: 'timeout', exitCode: ExitCode.LoginTimeout };
  }
  if (err instanceof CallbackStateMismatchError) {
    return { reason: 'state-mismatch', exitCode: ExitCode.LoginStateMismatch };
  }
  if (err instanceof CallbackMissingCodeError) {
    return { reason: 'missing-code', exitCode: ExitCode.Generic };
  }
  return { reason: 'other', exitCode: ExitCode.Generic };
}

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Log in via the browser; starts a localhost callback server.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    'no-browser': {
      type: 'boolean',
      description: "Don't auto-open the browser; print the URL for manual copy.",
      default: false,
    },
    timeout: {
      type: 'string',
      description: 'Abort the login if no callback arrives within N seconds (default 300).',
      default: '300',
    },
  },
  async run({ args }) {
    const rawOauthUrl = process.env.AIT_CONSOLE_OAUTH_URL;
    const authorizeUrl = rawOauthUrl && rawOauthUrl.length > 0 ? rawOauthUrl : null;
    const clientId = process.env.AIT_CONSOLE_OAUTH_CLIENT_ID;
    const scope = process.env.AIT_CONSOLE_OAUTH_SCOPE;

    const timeoutNum = Number(args.timeout);
    if (!Number.isFinite(timeoutNum) || timeoutNum <= 0) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, reason: 'invalid-timeout', given: args.timeout })}\n`,
        );
      }
      process.stderr.write(`Invalid --timeout value: ${args.timeout}\n`);
      process.exit(ExitCode.Usage);
    }
    const timeoutMs = timeoutNum * 1000;

    const emitError = (payload: Record<string, unknown>, human: string) => {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
      }
      process.stderr.write(`${human}\n`);
    };

    if (!authorizeUrl) {
      emitError(
        { reason: 'oauth-url-not-configured', hint: 'set AIT_CONSOLE_OAUTH_URL' },
        [
          'The Toss developer console OAuth URL is not configured.',
          'Discovery is pending — set AIT_CONSOLE_OAUTH_URL to override,',
          'or track the TODO in CLAUDE.md § "Open questions".',
        ].join('\n'),
      );
      process.exit(ExitCode.Usage);
    }

    const server = await startCallbackServer({ timeoutMs });
    const authUrl = buildAuthorizeUrl({
      authorizeUrl,
      redirectUri: server.redirectUri,
      state: server.expectedState,
      clientId,
      scope,
    });

    // Per the --json contract, stdout in JSON mode is strictly a single
    // JSON document. Progress/diagnostic chatter always goes to stderr so
    // behavior is consistent between modes.
    if (!args.json) {
      process.stderr.write(`Listening for the OAuth callback on ${server.redirectUri}\n`);
    }

    let launched = false;
    if (!args['no-browser']) {
      const result = await openBrowser(authUrl);
      launched = result.launched;
    }
    if (!args.json) {
      if (launched) {
        process.stderr.write('Opened your browser. Complete the login there.\n');
      } else {
        process.stderr.write(`Open this URL in your browser to continue:\n  ${authUrl}\n`);
      }
    }

    let query: CallbackQuery;
    try {
      query = await server.waitForCallback();
    } catch (err) {
      await server.close();
      const { reason, exitCode } = classifyCallbackError(err as Error);
      emitError(
        { reason, message: (err as Error).message },
        `Login failed: ${(err as Error).message}`,
      );
      process.exit(exitCode);
    }
    await server.close();

    // Token exchange / session capture is pending Toss console OAuth
    // discovery (tracked in TODO.md and CLAUDE.md § "Open questions").
    // Until then we accept optional user-label fields from the callback
    // query string, but validate them strictly and fall back to the opaque
    // `code` as a last resort. The real flow will POST to a token endpoint
    // and capture a Playwright `storageState` — at which point `cookies`
    // and `origins` become non-empty and this sanitization goes away.
    const userId = sanitizeField(query.raw.user_id) ?? query.code;
    const email = sanitizeField(query.raw.email) ?? '';
    const displayName = sanitizeField(query.raw.display_name);

    const session: Session = {
      schemaVersion: 1,
      user: displayName ? { id: userId, email, displayName } : { id: userId, email },
      // Left empty pending real token-exchange + Playwright storageState.
      cookies: [],
      origins: [],
      capturedAt: new Date().toISOString(),
    };
    await writeSession(session);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          status: 'logged-in',
          user: session.user,
          capturedAt: session.capturedAt,
        })}\n`,
      );
      return;
    }

    const label = displayName ? `${displayName} <${email}>` : email || userId;
    process.stdout.write(`Logged in as ${label}\n`);
  },
});
