import { describe, expect, it } from 'vitest';
import { CdpClient, CdpConnectionClosedError, CdpProtocolError } from './cdp.js';

// Minimal stand-in for the WHATWG WebSocket interface that the CDP client
// needs. Enough to exercise the request/response routing, event fan-out,
// and shutdown semantics without booting Chrome.

type Listener = (ev: unknown) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];
  private listeners: Record<string, Set<Listener>> = {};

  constructor(public readonly url: string) {
    // Fire open on the next microtask so `connect()` consumers see the same
    // ordering real WebSockets produce.
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners[type];
    if (!set) {
      set = new Set();
      this.listeners[type] = set;
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners[type]?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', {});
  }

  /** Simulate a server-pushed message. */
  serverSend(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  /** Simulate the server closing the transport. */
  serverClose(): void {
    this.close();
  }

  private emit(type: string, ev: unknown) {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

describe('CdpClient', () => {
  it('routes responses to the matching request id', async () => {
    const socket = new MockWebSocket('ws://x');
    const client = await CdpClient.connect({
      url: 'ws://x',
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    const pending = client.send<{ ok: boolean }>('Foo.bar', { a: 1 });
    // First request uses id=1 (see `nextId` seed).
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      id: 1,
      method: 'Foo.bar',
      params: { a: 1 },
    });
    socket.serverSend({ id: 1, result: { ok: true } });
    expect(await pending).toEqual({ ok: true });
  });

  it('maps CDP error responses to CdpProtocolError', async () => {
    const socket = new MockWebSocket('ws://x');
    const client = await CdpClient.connect({
      url: 'ws://x',
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const pending = client.send('Foo.bar');
    socket.serverSend({ id: 1, error: { code: -32000, message: 'bad' } });
    await expect(pending).rejects.toBeInstanceOf(CdpProtocolError);
  });

  it('fans out events to registered listeners but not pending-response waiters', async () => {
    const socket = new MockWebSocket('ws://x');
    const client = await CdpClient.connect({
      url: 'ws://x',
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    const seen: string[] = [];
    client.on((ev) => seen.push(ev.method));
    socket.serverSend({ method: 'Page.frameNavigated', params: { frame: { url: 'about:blank' } } });
    expect(seen).toEqual(['Page.frameNavigated']);
  });

  it('rejects outstanding requests when the transport closes', async () => {
    const socket = new MockWebSocket('ws://x');
    const client = await CdpClient.connect({
      url: 'ws://x',
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const pending = client.send('Foo.bar');
    socket.serverClose();
    await expect(pending).rejects.toBeInstanceOf(CdpConnectionClosedError);
  });

  it('close() is idempotent and further sends reject immediately', async () => {
    const socket = new MockWebSocket('ws://x');
    const client = await CdpClient.connect({
      url: 'ws://x',
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.send('Foo.bar')).rejects.toBeInstanceOf(CdpConnectionClosedError);
  });
});
