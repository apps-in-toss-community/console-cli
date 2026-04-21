// Tiny Chrome DevTools Protocol client. Enough to navigate a tab, listen for
// frame-navigation events, and dump cookies via `Network.getAllCookies`.
//
// Deliberately does NOT pull in `ws` or any WebSocket userland lib: Node 22+
// and Bun both expose `globalThis.WebSocket` with the standard interface,
// which is what we use. Keeps `bun build --compile` tiny and avoids the
// optional-native-deps dance.
//
// Threading model: one `CdpClient` wraps one WebSocket connection to the
// *browser* (the URL printed on Chrome's stderr). Per-target sessions are
// attached lazily via `Target.attachToTarget` — we shuttle messages over
// the single connection using `sessionId` routing, the same way the DevTools
// frontend and `chrome-remote-interface` do. Only the APIs we actually need
// for login capture are wrapped; everything else is available through the
// raw `send(method, params, sessionId?)` escape hatch.

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

interface CdpSuccess {
  readonly id: number;
  readonly result: Record<string, unknown>;
  readonly sessionId?: string;
}

interface CdpError {
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly sessionId?: string;
}

interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

type CdpMessage = CdpSuccess | CdpError | CdpEvent;

function isResponse(m: CdpMessage): m is CdpSuccess | CdpError {
  return 'id' in m;
}

export class CdpProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`CDP error for ${method}: ${message} (code=${code})`);
    this.name = 'CdpProtocolError';
  }
}

export class CdpConnectionClosedError extends Error {
  constructor() {
    super('CDP connection closed before the response arrived.');
    this.name = 'CdpConnectionClosedError';
  }
}

export interface CdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly session: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
}

export type CdpEventListener = (event: CdpEvent) => void;

export interface ConnectCdpOptions {
  readonly url: string;
  // Injected for tests. Must match the subset of WebSocket we use: `onopen`,
  // `onmessage`, `onerror`, `onclose`, `send`, `close`, and the `readyState`
  // constants (OPEN, CLOSED).
  readonly webSocketFactory?: (url: string) => WebSocket;
}

export class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(result: Record<string, unknown>): void; reject(err: Error): void; method: string }
  >();
  private readonly listeners = new Set<CdpEventListener>();
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (ev: MessageEvent) => this.handleMessage(ev));
    socket.addEventListener('close', () => this.handleClose());
    socket.addEventListener('error', () => {
      // Let the `close` event handle pending-promise rejection. Surfacing the
      // error here as well would double-reject; browsers emit both events in
      // quick succession on a failed handshake.
    });
  }

  static async connect(options: ConnectCdpOptions): Promise<CdpClient> {
    const factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(options.url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to open CDP WebSocket at ${options.url}`));
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`CDP WebSocket closed before opening (${options.url})`));
      };
      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
    return new CdpClient(socket);
  }

  on(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, JsonValue>,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) throw new CdpConnectionClosedError();
    const id = this.nextId++;
    // Assemble as a plain record and let the JSON serialiser drop keys
    // that are absent — matches the exactOptionalPropertyTypes contract
    // without the triple-nested ternary.
    const req: Record<string, unknown> = { id, method };
    if (params) req.params = params;
    if (sessionId) req.sessionId = sessionId;
    const waiter = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.socket.send(JSON.stringify(req));
    const result = await waiter;
    return result as T;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Reject any outstanding requests so callers don't hang forever.
    for (const [, pending] of this.pending) {
      pending.reject(new CdpConnectionClosedError());
    }
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let parsed: CdpMessage;
    try {
      const raw =
        typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      parsed = JSON.parse(raw) as CdpMessage;
    } catch {
      // Non-JSON payload — shouldn't happen on CDP, ignore.
      return;
    }
    if (isResponse(parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if ('error' in parsed) {
        pending.reject(
          new CdpProtocolError(pending.method, parsed.error.code, parsed.error.message),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(parsed);
      } catch {
        // Listener errors should not crash the dispatch loop.
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new CdpConnectionClosedError());
    }
    this.pending.clear();
  }
}

// --- High-level helpers ---

export interface AttachedTarget {
  readonly sessionId: string;
  readonly targetId: string;
}

/**
 * Attach to the first "page" target exposed by the browser. Chrome always
 * opens at least one page target when launched with an initial URL, so this
 * is a reliable way to grab a session without guessing target IDs.
 */
export async function attachToFirstPage(client: CdpClient): Promise<AttachedTarget> {
  const { targetInfos } = await client.send<{
    targetInfos: Array<{ targetId: string; type: string }>;
  }>('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  if (!page) {
    throw new Error('No page target found; Chrome launched without an initial tab.');
  }
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });
  return { sessionId, targetId: page.targetId };
}

export interface FrameNavigatedEvent {
  readonly url: string;
  readonly frameId: string;
  readonly isMainFrame: boolean;
}

/**
 * Subscribe to main-frame navigations on the attached page session. Returns
 * an unsubscribe function.
 *
 * Chrome emits `Page.frameNavigated` for every frame — we filter to the main
 * frame (top-level document) since auxiliary iframes (analytics, chat
 * widgets) would otherwise trigger false matches.
 */
export async function watchMainFrameNavigations(
  client: CdpClient,
  sessionId: string,
  onNavigate: (ev: FrameNavigatedEvent) => void,
): Promise<() => void> {
  await client.send('Page.enable', {}, sessionId);
  const off = client.on((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method !== 'Page.frameNavigated') return;
    const frame = event.params.frame as
      | { url?: string; id?: string; parentId?: string }
      | undefined;
    if (!frame?.url || !frame.id) return;
    onNavigate({
      url: frame.url,
      frameId: frame.id,
      isMainFrame: frame.parentId === undefined,
    });
  });
  return off;
}

/**
 * `Network.getAllCookies` is scoped to a target session — Chrome rejects it
 * on the browser-level endpoint with `method not found`. Requiring sessionId
 * here surfaces that constraint at compile time.
 *
 * The response shape is fixed in the CDP spec, but we still validate every
 * cookie's required string/number fields at runtime so a malformed entry
 * (from a future Chrome change, say) fails loud instead of propagating
 * `undefined` into the Cookie: header or the on-disk session file.
 */
export async function getAllCookies(
  client: CdpClient,
  sessionId: string,
): Promise<readonly CdpCookie[]> {
  const result = await client.send<{ cookies: unknown }>('Network.getAllCookies', {}, sessionId);
  if (!Array.isArray(result.cookies)) {
    throw new Error('Network.getAllCookies returned a non-array payload');
  }
  return result.cookies.map((raw, index) => validateCookie(raw, index));
}

function validateCookie(raw: unknown, index: number): CdpCookie {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Cookie #${index} is not an object`);
  }
  const c = raw as Record<string, unknown>;
  const str = (field: string): string => {
    const v = c[field];
    if (typeof v !== 'string') throw new Error(`Cookie #${index}.${field} is not a string`);
    return v;
  };
  const num = (field: string): number => {
    const v = c[field];
    if (typeof v !== 'number') throw new Error(`Cookie #${index}.${field} is not a number`);
    return v;
  };
  const bool = (field: string): boolean => {
    const v = c[field];
    if (typeof v !== 'boolean') throw new Error(`Cookie #${index}.${field} is not a boolean`);
    return v;
  };
  const base = {
    name: str('name'),
    value: str('value'),
    domain: str('domain'),
    path: str('path'),
    expires: num('expires'),
    httpOnly: bool('httpOnly'),
    secure: bool('secure'),
    session: bool('session'),
  };
  const sameSite = c.sameSite;
  if (sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None') {
    return { ...base, sameSite };
  }
  return base;
}
