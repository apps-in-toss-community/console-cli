import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Localhost OAuth callback server. Binds to 127.0.0.1 on an ephemeral port,
// waits for exactly one request to `/callback`, validates the `state`
// parameter, and resolves with the query fields. The server is single-use —
// subsequent requests receive 410 Gone and the server closes on settle.
//
// The Toss developer console OAuth URL and token-exchange flow are not
// publicly documented (see CLAUDE.md § "Open questions"), so this module is
// deliberately generic: it only knows how to receive a redirect, not how to
// shape the outbound authorize URL. The caller composes that URL.

export interface CallbackQuery {
  readonly code: string;
  readonly state: string;
  readonly raw: Record<string, string>;
}

export interface CallbackServer {
  readonly port: number;
  readonly redirectUri: string;
  readonly expectedState: string;
  waitForCallback(): Promise<CallbackQuery>;
  close(): Promise<void>;
}

export interface StartCallbackServerOptions {
  // Overall timeout for waitForCallback, in ms. Defaults to 5 minutes.
  readonly timeoutMs?: number;
  // Preferred port. 0 = OS-assigned ephemeral. If a preferred port is in use,
  // the server transparently falls back to 0.
  readonly preferredPort?: number;
}

export class CallbackTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Login timed out after ${seconds}s`);
    this.name = 'CallbackTimeoutError';
  }
}

export class CallbackStateMismatchError extends Error {
  constructor() {
    super('Invalid or missing state parameter');
    this.name = 'CallbackStateMismatchError';
  }
}

export class CallbackMissingCodeError extends Error {
  constructor() {
    super('Missing code parameter');
    this.name = 'CallbackMissingCodeError';
  }
}

export function randomState(): string {
  // 32 bytes → 43 chars base64url. Sufficient for CSRF.
  return randomBytes(32).toString('base64url');
}

// Constant-time string comparison. Falls back to a simple `false` when the
// lengths differ, matching `crypto.timingSafeEqual`'s own precondition.
function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;')
    .replace(/`/g, '&#96;');
}

type ParseResult =
  | { kind: 'ok'; query: CallbackQuery }
  | { kind: 'state-mismatch' }
  | { kind: 'missing-code' }
  | { kind: 'malformed' }
  | { kind: 'not-found' };

function parseCallbackUrl(reqUrl: string | undefined, expectedState: string): ParseResult {
  if (!reqUrl) return { kind: 'malformed' };
  let parsed: URL;
  try {
    parsed = new URL(reqUrl, 'http://127.0.0.1');
  } catch {
    return { kind: 'malformed' };
  }
  if (parsed.pathname !== '/callback') {
    return { kind: 'not-found' };
  }
  const raw: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) raw[k] = v;
  const state = raw.state ?? '';
  const code = raw.code ?? '';
  if (!state || !constantTimeStringEqual(state, expectedState)) {
    return { kind: 'state-mismatch' };
  }
  if (!code) {
    return { kind: 'missing-code' };
  }
  return { kind: 'ok', query: { code, state, raw } };
}

const ERROR_MESSAGES: Record<Exclude<ParseResult['kind'], 'ok'>, string> = {
  'state-mismatch': 'Invalid or missing state parameter',
  'missing-code': 'Missing code parameter',
  malformed: 'Malformed request URL',
  'not-found': 'Not found',
};

const ERROR_STATUS: Record<Exclude<ParseResult['kind'], 'ok'>, number> = {
  'state-mismatch': 400,
  'missing-code': 400,
  malformed: 400,
  'not-found': 404,
};

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ait-console</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}</style>
</head>
<body>
<h1>Logged in to ait-console</h1>
<p>You can close this window and return to your terminal.</p>
</body></html>`;

const GONE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ait-console</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}</style>
</head>
<body>
<h1>This login flow is already complete</h1>
<p>Return to your terminal.</p>
</body></html>`;

function errorHtml(message: string): string {
  // Messages are currently a fixed enum (see ERROR_MESSAGES) but we escape
  // unconditionally so future callers can't introduce a reflected-XSS hole.
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ait-console — error</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem;color:#b00020}</style>
</head>
<body>
<h1>Login failed</h1>
<p>${escapeHtml(message)}</p>
<p>Return to your terminal for details.</p>
</body></html>`;
}

async function bindServer(server: Server, preferredPort: number | undefined): Promise<number> {
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo | null;
        if (!addr) reject(new Error('Failed to bind callback server'));
        else resolve(addr.port);
      });
    });

  if (preferredPort && preferredPort !== 0) {
    try {
      return await tryListen(preferredPort);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      // Fall through to ephemeral port.
    }
  }
  return tryListen(0);
}

export async function startCallbackServer(
  options: StartCallbackServerOptions = {},
): Promise<CallbackServer> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const expectedState = randomState();

  const server: Server = createServer();
  // Bind to 127.0.0.1 only — never expose the callback on a routable address.
  // Try `preferredPort` first; on EADDRINUSE fall back to ephemeral (0).
  const boundPort = await bindServer(server, options.preferredPort);

  const redirectUri = `http://127.0.0.1:${boundPort}/callback`;

  let settled = false;
  let closed = false;
  let resolveCb!: (q: CallbackQuery) => void;
  let rejectCb!: (e: Error) => void;
  const waiter = new Promise<CallbackQuery>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });
  // Attach a noop catch so an early rejection (e.g. state mismatch fired
  // before the caller calls waitForCallback) is not treated as unhandled.
  // The real error surface is the Promise returned from waitForCallback(),
  // which re-receives the same rejection via its rejectCb. Don't route
  // diagnostics through this handler — it exists solely to appease the
  // runtime's unhandled-rejection tracker.
  waiter.catch(() => {});

  const finish = (outcome: { kind: 'ok'; q: CallbackQuery } | { kind: 'err'; e: Error }) => {
    if (settled) return;
    settled = true;
    if (outcome.kind === 'ok') resolveCb(outcome.q);
    else rejectCb(outcome.e);
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Once the flow is settled, further hits (duplicate redirects, noisy
    // extensions) get 410 Gone rather than another success page. This
    // prevents a late attacker-crafted callback from rendering as "logged in".
    if (settled) {
      res.statusCode = 410;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(GONE_HTML);
      return;
    }
    const result = parseCallbackUrl(req.url, expectedState);
    if (result.kind === 'ok') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // Settle only after the response body has actually been flushed to
      // the client — otherwise `server.close()` / `closeAllConnections()`
      // on the caller's side can tear the socket down mid-write and the
      // user sees "connection reset" instead of the success page.
      res.end(SUCCESS_HTML, () => finish({ kind: 'ok', q: result.query }));
      return;
    }
    const status = ERROR_STATUS[result.kind];
    const message = ERROR_MESSAGES[result.kind];
    res.statusCode = status;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Don't settle on arbitrary 404s — the user might have a noisy
    // extension or favicon probe. Only settle on structural errors at the
    // /callback path itself. Once we settle (success or structural error),
    // every subsequent request — including a legitimate-looking redirect —
    // gets 410 Gone via the `settled` branch above. The first-wins contract
    // is intentional: a CSRF attacker can't race a real redirect by firing
    // a bad callback first (it'll reject with state-mismatch), and a noisy
    // browser reload after success can't re-render a login page.
    const onFlushed = () => {
      switch (result.kind) {
        case 'state-mismatch':
          finish({ kind: 'err', e: new CallbackStateMismatchError() });
          return;
        case 'missing-code':
          finish({ kind: 'err', e: new CallbackMissingCodeError() });
          return;
        case 'malformed':
          finish({ kind: 'err', e: new Error(message) });
          return;
        case 'not-found':
          // Intentional no-op: a /favicon.ico probe shouldn't end the flow.
          return;
        default:
          // Exhaustiveness check — a new ParseResult kind will fail to
          // compile here because `result` is narrowed to `never`.
          ((_: never) => {})(result);
      }
    };
    res.end(errorHtml(message), onFlushed);
  });

  const timer = setTimeout(() => {
    // Ceil so the reported number is an upper bound on the real cap —
    // a `timeoutMs` of 1500 ms reports "after 2s", never "after 1s".
    finish({ kind: 'err', e: new CallbackTimeoutError(Math.ceil(timeoutMs / 1000)) });
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    // Race `server.close()` against a 1s timeout — a misbehaving keep-alive
    // client shouldn't be able to hold the CLI from exiting.
    await new Promise<void>((resolve) => {
      let done = false;
      const finishClose = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(() => finishClose());
      server.closeAllConnections?.();
      const fallback = setTimeout(finishClose, 1000);
      if (typeof fallback.unref === 'function') fallback.unref();
    });
  };

  return {
    port: boundPort,
    redirectUri,
    expectedState,
    waitForCallback: () => waiter,
    close,
  };
}
