import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Localhost OAuth callback server. Binds to 127.0.0.1 on an ephemeral port,
// waits for exactly one request to `/callback`, validates the `state`
// parameter, and resolves with the query fields. The server is single-use —
// any second request is rejected and the server shuts down on resolution.
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

export function randomState(): string {
  // 32 bytes → 43 chars base64url. Sufficient for CSRF.
  return randomBytes(32).toString('base64url');
}

function parseCallbackUrl(
  reqUrl: string | undefined,
  expectedState: string,
): { kind: 'ok'; query: CallbackQuery } | { kind: 'error'; status: number; message: string } {
  if (!reqUrl) {
    return { kind: 'error', status: 400, message: 'Missing request URL' };
  }
  let parsed: URL;
  try {
    parsed = new URL(reqUrl, 'http://127.0.0.1');
  } catch {
    return { kind: 'error', status: 400, message: 'Malformed request URL' };
  }
  if (parsed.pathname !== '/callback') {
    return { kind: 'error', status: 404, message: 'Not found' };
  }
  const raw: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) raw[k] = v;
  const state = raw.state ?? '';
  const code = raw.code ?? '';
  if (!state || state !== expectedState) {
    return { kind: 'error', status: 400, message: 'Invalid or missing state parameter' };
  }
  if (!code) {
    return { kind: 'error', status: 400, message: 'Missing code parameter' };
  }
  return { kind: 'ok', query: { code, state, raw } };
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ait-console</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}</style>
</head>
<body>
<h1>Logged in to ait-console</h1>
<p>You can close this window and return to your terminal.</p>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ait-console — error</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem;color:#b00020}</style>
</head>
<body>
<h1>Login failed</h1>
<p>${msg}</p>
<p>Return to your terminal for details.</p>
</body></html>`;

export async function startCallbackServer(
  options: StartCallbackServerOptions = {},
): Promise<CallbackServer> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const expectedState = randomState();

  const server: Server = createServer();
  // Bind to 127.0.0.1 only — never expose the callback on a routable address.
  // Try `preferredPort` first; on EADDRINUSE fall back to ephemeral (0).
  const boundPort = await new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (options.preferredPort && options.preferredPort !== 0 && err.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo | null;
          if (!addr) reject(new Error('Failed to bind callback server'));
          else resolve(addr.port);
        });
        return;
      }
      server.removeListener('error', onError);
      reject(err);
    };
    server.on('error', onError);
    server.listen(options.preferredPort ?? 0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error('Failed to bind callback server'));
        return;
      }
      server.removeListener('error', onError);
      resolve(addr.port);
    });
  });

  const redirectUri = `http://127.0.0.1:${boundPort}/callback`;

  let settled = false;
  let resolveCb: (q: CallbackQuery) => void = () => {};
  let rejectCb: (e: Error) => void = () => {};
  const waiter = new Promise<CallbackQuery>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });

  const finish = (outcome: { kind: 'ok'; q: CallbackQuery } | { kind: 'err'; e: Error }) => {
    if (settled) return;
    settled = true;
    if (outcome.kind === 'ok') resolveCb(outcome.q);
    else rejectCb(outcome.e);
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const result = parseCallbackUrl(req.url, expectedState);
    if (result.kind === 'error') {
      res.statusCode = result.status;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(ERROR_HTML(result.message));
      // Don't settle on arbitrary 404s — the user might have a noisy
      // extension. Only settle on structural errors at /callback itself.
      if (result.status !== 404) {
        finish({ kind: 'err', e: new Error(result.message) });
      }
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(SUCCESS_HTML);
    finish({ kind: 'ok', q: result.query });
  });

  const timer = setTimeout(() => {
    finish({ kind: 'err', e: new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s`) });
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const close = async (): Promise<void> => {
    clearTimeout(timer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Dangling keep-alive sockets would block close(); force them down.
      server.closeAllConnections?.();
    });
  };

  return {
    port: boundPort,
    redirectUri,
    expectedState,
    async waitForCallback() {
      try {
        return await waiter;
      } finally {
        clearTimeout(timer);
      }
    },
    close,
  };
}
