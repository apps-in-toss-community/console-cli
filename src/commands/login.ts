import { defineCommand } from 'citty';
import { openBrowser } from '../browser.js';
import { ExitCode } from '../exit.js';
import { startCallbackServer } from '../oauth.js';
import { type Session, writeSession } from '../session.js';

// The Toss developer console OAuth authorize URL and scope are not publicly
// documented as of 2026-04. Override with `AIT_CONSOLE_OAUTH_URL` (and
// optionally `AIT_CONSOLE_OAUTH_CLIENT_ID` / `AIT_CONSOLE_OAUTH_SCOPE`) while
// discovery is in progress. The placeholder scheme is intentionally invalid
// so we fail loudly rather than silently hit the wrong endpoint.
const DEFAULT_AUTHORIZE_URL = 'TBD://console.example.com/oauth/authorize';

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
    const authorizeUrl = process.env.AIT_CONSOLE_OAUTH_URL ?? DEFAULT_AUTHORIZE_URL;
    const clientId = process.env.AIT_CONSOLE_OAUTH_CLIENT_ID;
    const scope = process.env.AIT_CONSOLE_OAUTH_SCOPE;

    const timeoutSec = Number.parseInt(args.timeout, 10);
    const timeoutMs = (Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 300) * 1000;

    const emitError = (payload: Record<string, unknown>, human: string) => {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
      }
      process.stderr.write(`${human}\n`);
    };

    if (authorizeUrl === DEFAULT_AUTHORIZE_URL) {
      // Fail fast — the placeholder URL can't succeed and we don't want to
      // pretend otherwise. Discovery of the real endpoint is tracked in
      // CLAUDE.md § "Open questions".
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

    if (!args.json) {
      process.stdout.write(`Listening for the OAuth callback on ${server.redirectUri}\n`);
    }

    let launched = false;
    if (!args['no-browser']) {
      const result = await openBrowser(authUrl);
      launched = result.launched;
    }
    if (!launched && !args.json) {
      process.stdout.write(`Open this URL in your browser to continue:\n  ${authUrl}\n`);
    } else if (launched && !args.json) {
      process.stdout.write('Opened your browser. Complete the login there.\n');
    }

    let query: Awaited<ReturnType<typeof server.waitForCallback>>;
    try {
      query = await server.waitForCallback();
    } catch (err) {
      await server.close();
      emitError(
        { reason: 'callback-failed', message: (err as Error).message },
        `Login failed: ${(err as Error).message}`,
      );
      process.exit(ExitCode.Generic);
    }
    await server.close();

    // Token exchange / session capture is pending Toss console OAuth
    // discovery. For now we accept optional user fields from the callback
    // query — real deployments will replace this with a token-endpoint POST
    // and a Playwright storageState capture (see console-client.ts).
    const userId = query.raw.user_id ?? query.code;
    const email = query.raw.email ?? '';
    const displayName = query.raw.display_name;

    const session: Session = {
      schemaVersion: 1,
      user: displayName ? { id: userId, email, displayName } : { id: userId, email },
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
