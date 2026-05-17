import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We override XDG_CONFIG_HOME so telemetryFilePath() resolves under a temp dir.
let root: string;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aitcc-telemetry-'));
  process.env.XDG_CONFIG_HOME = root;
  vi.resetModules();
});

afterEach(() => {
  if (originalConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// State module tests
// ---------------------------------------------------------------------------

describe('readConsentState', () => {
  it('returns undecided when no file exists', async () => {
    const { readConsentState } = await import('../state.js');
    expect(await readConsentState()).toBe('undecided');
  });
});

describe('resolveEffectiveConsent', () => {
  it('returns undecided when no file', async () => {
    const { resolveEffectiveConsent } = await import('../state.js');
    expect(await resolveEffectiveConsent()).toBe('undecided');
  });

  it('returns granted after acceptConsent', async () => {
    const { acceptConsent, resolveEffectiveConsent } = await import('../state.js');
    await acceptConsent();
    expect(await resolveEffectiveConsent()).toBe('granted');
  });

  it('returns denied after denyConsent', async () => {
    const { denyConsent, resolveEffectiveConsent } = await import('../state.js');
    await denyConsent();
    expect(await resolveEffectiveConsent()).toBe('denied');
  });

  it('reverts granted to undecided when policy version is stale', async () => {
    // Write a state file with an old policy version
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(root, 'aitcc');
    await mkdir(dir, { recursive: true });
    const stale = JSON.stringify({
      schemaVersion: 1,
      consent: 'granted',
      policyVersion: '2020-01-01',
      anonId: 'aaaaaaaa-0000-4000-8000-000000000000',
    });
    await writeFile(join(dir, 'telemetry.json'), stale);

    const { resolveEffectiveConsent } = await import('../state.js');
    expect(await resolveEffectiveConsent()).toBe('undecided');
  });

  it('keeps denied across policy version change', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(root, 'aitcc');
    await mkdir(dir, { recursive: true });
    const stale = JSON.stringify({
      schemaVersion: 1,
      consent: 'denied',
      policyVersion: '2020-01-01',
    });
    await writeFile(join(dir, 'telemetry.json'), stale);

    const { resolveEffectiveConsent } = await import('../state.js');
    expect(await resolveEffectiveConsent()).toBe('denied');
  });
});

describe('getOrCreateAnonId', () => {
  it('generates a UUID v4 on first call', async () => {
    const { acceptConsent, getOrCreateAnonId } = await import('../state.js');
    await acceptConsent();
    const id = await getOrCreateAnonId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns the same ID on repeated calls', async () => {
    const { acceptConsent, getOrCreateAnonId } = await import('../state.js');
    await acceptConsent();
    const a = await getOrCreateAnonId();
    const b = await getOrCreateAnonId();
    expect(a).toBe(b);
  });

  it('persists the anon_id in the state file', async () => {
    const { acceptConsent, getOrCreateAnonId, telemetryFilePath } = await import('../state.js');
    await acceptConsent();
    const id = await getOrCreateAnonId();
    const raw = await readFile(telemetryFilePath(), 'utf8');
    expect(JSON.parse(raw).anonId).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// send module tests (mocked fetch)
// ---------------------------------------------------------------------------

describe('send (mocked fetch)', () => {
  it('does not call fetch when consent is not granted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const { denyConsent } = await import('../state.js');
    await denyConsent();
    const { send } = await import('../send.js');
    await send('https://t.aitc.dev', 'cli_invoked', '0.1.0', { command: 'whoami' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fetch with correct payload when consent is granted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const { acceptConsent } = await import('../state.js');
    await acceptConsent();
    const { send } = await import('../send.js');
    await send('https://t.aitc.dev', 'cli_invoked', '0.1.28', { command: 'whoami' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://t.aitc.dev/e');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.source).toBe('console-cli');
    expect(body.event).toBe('cli_invoked');
    expect(body.version).toBe('0.1.28');
    expect((body.meta as Record<string, unknown>).command).toBe('whoami');
  });

  it('retries once on network failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const { acceptConsent } = await import('../state.js');
    const { send, setRetryDelayMs } = await import('../send.js');
    // Shorten delay so test doesn't wait 2 s
    setRetryDelayMs(0);
    await acceptConsent();
    await send('https://t.aitc.dev', 'cli_invoked', '0.1.28');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('drops oversized meta silently', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const { acceptConsent } = await import('../state.js');
    await acceptConsent();
    const { send } = await import('../send.js');
    // Build a meta object that exceeds 256 bytes when JSON-serialized
    const bigMeta = { padding: 'x'.repeat(300) };
    await send('https://t.aitc.dev', 'cli_invoked', '0.1.28', bigMeta);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // meta should be stripped (undefined → not present in JSON)
    expect(body.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteMyData tests
// ---------------------------------------------------------------------------

describe('deleteMyData', () => {
  it('returns false and does not call fetch when no anon_id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    // Fresh state: no anon_id
    const { deleteMyData } = await import('../state.js');
    const result = await deleteMyData('https://t.aitc.dev');
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends DELETE and rotates anon_id on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const { acceptConsent, getOrCreateAnonId, deleteMyData } = await import('../state.js');
    await acceptConsent();
    const originalId = await getOrCreateAnonId();
    const result = await deleteMyData('https://t.aitc.dev');
    expect(result).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/e?anon_id=');
    expect(url).toContain(encodeURIComponent(originalId));
    expect((init as RequestInit).method).toBe('DELETE');
    // anon_id should be rotated
    const newId = await getOrCreateAnonId();
    expect(newId).not.toBe(originalId);
  });
});
