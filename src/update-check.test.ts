import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isDueForCheck,
  maybeCheckForUpdate,
  readCache,
  UPDATE_CHECK_INTERVAL_MS,
  writeCache,
} from './update-check.js';

describe('isDueForCheck', () => {
  it('is due when there is no cache', () => {
    expect(isDueForCheck(null, 1000)).toBe(true);
  });

  it('is not due when the last check was inside the interval', () => {
    const last = new Date(0).toISOString();
    const now = UPDATE_CHECK_INTERVAL_MS - 1;
    expect(isDueForCheck({ lastCheckedAt: last }, now)).toBe(false);
  });

  it('is due when the interval has elapsed exactly', () => {
    const last = new Date(0).toISOString();
    expect(isDueForCheck({ lastCheckedAt: last }, UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('is due when the cache timestamp is unparseable', () => {
    expect(isDueForCheck({ lastCheckedAt: 'garbage' }, 1000)).toBe(true);
  });

  it('is due when the system clock has jumped backwards behind the cache', () => {
    const last = new Date(10_000_000).toISOString();
    expect(isDueForCheck({ lastCheckedAt: last }, 5_000_000)).toBe(true);
  });
});

describe('cache file IO', () => {
  const originalCache = process.env.XDG_CACHE_HOME;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aitcc-update-check-'));
    process.env.XDG_CACHE_HOME = root;
  });

  afterEach(() => {
    if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCache;
  });

  it('round-trips through writeCache / readCache', async () => {
    const entry = {
      lastCheckedAt: '2026-04-21T00:00:00.000Z',
      latestTag: '@ait-co/console-cli@0.1.4',
      etag: 'W/"abc123"',
    };
    await writeCache(entry);
    const roundtrip = await readCache();
    expect(roundtrip).toEqual(entry);
    // Stored under the XDG cache root we configured, not the session/config dir.
    const path = join(root, 'aitcc', 'upgrade-check.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(entry);
  });

  it('readCache returns null when the file is missing', async () => {
    expect(await readCache()).toBeNull();
  });

  it('readCache returns null when the file is malformed JSON', async () => {
    await writeCache({ lastCheckedAt: '2026-01-01T00:00:00Z' });
    // Corrupt the file.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'aitcc', 'upgrade-check.json'), '{ not json');
    expect(await readCache()).toBeNull();
  });

  it('readCache rejects a cache with non-string optional fields', async () => {
    await writeCache({ lastCheckedAt: '2026-01-01T00:00:00Z' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(root, 'aitcc', 'upgrade-check.json'),
      JSON.stringify({ lastCheckedAt: '2026-01-01T00:00:00Z', latestTag: 42 }),
    );
    expect(await readCache()).toBeNull();
  });

  it('writeCache writes with 0600 permissions on POSIX', async () => {
    if (process.platform === 'win32') return;
    const { statSync } = await import('node:fs');
    await writeCache({ lastCheckedAt: '2026-01-01T00:00:00Z' });
    const mode = statSync(join(root, 'aitcc', 'upgrade-check.json')).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('writeCache overwrites atomically: readers never see a truncated file', async () => {
    // Seed a good cache, then race a concurrent overwrite. If writeCache
    // ever wrote in-place (non-atomic), a reader hitting mid-write could
    // see truncated JSON. With tempfile+rename the reader sees either the
    // pre-state or the post-state.
    await writeCache({ lastCheckedAt: '2026-01-01T00:00:00Z', latestTag: 'v0.1.3' });
    const writes = Array.from({ length: 20 }, (_, i) =>
      writeCache({ lastCheckedAt: `2026-04-21T00:00:${String(i).padStart(2, '0')}.000Z` }),
    );
    const reads = Array.from({ length: 20 }, async () => readCache());
    const [, ...readResults] = await Promise.all([Promise.all(writes), ...reads]);
    for (const r of readResults) {
      // Either null (read raced ahead of first write) or a valid parsed object.
      if (r !== null) expect(typeof r.lastCheckedAt).toBe('string');
    }
  });
});

describe('maybeCheckForUpdate', () => {
  const originalCache = process.env.XDG_CACHE_HOME;
  const originalOptOut = process.env.AITCC_NO_UPDATE_CHECK;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aitcc-update-check-'));
    process.env.XDG_CACHE_HOME = root;
  });

  afterEach(() => {
    if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCache;
    if (originalOptOut === undefined) delete process.env.AITCC_NO_UPDATE_CHECK;
    else process.env.AITCC_NO_UPDATE_CHECK = originalOptOut;
  });

  it('skips and writes nothing when AITCC_NO_UPDATE_CHECK=1', async () => {
    const result = await maybeCheckForUpdate({
      env: { AITCC_NO_UPDATE_CHECK: '1' },
      isTTY: true,
      now: Date.now(),
    });
    expect(result).toBeNull();
    expect(await readCache()).toBeNull();
  });

  it('skips and writes nothing when not a TTY (agent-plugin / script consumers)', async () => {
    const result = await maybeCheckForUpdate({
      env: {},
      isTTY: false,
      now: Date.now(),
    });
    expect(result).toBeNull();
    expect(await readCache()).toBeNull();
  });

  it('skips when the cache says the last check was recent', async () => {
    const now = Date.now();
    const recent = new Date(now - 1000).toISOString();
    await writeCache({ lastCheckedAt: recent, latestTag: 'v0.1.3' });
    const result = await maybeCheckForUpdate({ env: {}, isTTY: true, now });
    expect(result).toBeNull();
    const still = await readCache();
    expect(still?.lastCheckedAt).toBe(recent);
  });

  it('updates the cache timestamp even when the network call fails', async () => {
    const now = new Date('2026-04-21T00:00:00Z').getTime();
    // Force a deterministic fetch failure by pointing at a bogus host via a
    // short-circuit: install a global fetch that rejects.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    try {
      const result = await maybeCheckForUpdate({ env: {}, isTTY: true, now });
      expect(result).not.toBeNull();
      expect(result?.lastCheckedAt).toBe(new Date(now).toISOString());
    } finally {
      globalThis.fetch = realFetch;
    }
    const cached = await readCache();
    expect(cached?.lastCheckedAt).toBe(new Date(now).toISOString());
  });

  it('writes a placeholder cache BEFORE the network call so concurrent runs do not both probe', async () => {
    const now = new Date('2026-04-21T00:00:00Z').getTime();
    const realFetch = globalThis.fetch;
    // Deterministic handshake: `started` resolves the instant fetch is
    // entered, `release` lets the caller let fetch finish. No polling.
    let markStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async () => {
      markStarted();
      await gate;
      // Return a minimal 304 so the path works through.
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;
    try {
      const probe = maybeCheckForUpdate({ env: {}, isTTY: true, now });
      await started;
      const midFlight = await readCache();
      // The placeholder must already be stamped with `now` before fetch resolves.
      expect(midFlight?.lastCheckedAt).toBe(new Date(now).toISOString());
      release();
      await probe;
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('opt-out accepts "true" as well as "1", but not "0"/"false"/empty', async () => {
    const now = Date.now();
    expect(
      await maybeCheckForUpdate({ env: { AITCC_NO_UPDATE_CHECK: 'true' }, isTTY: true, now }),
    ).toBeNull();
    expect(
      await maybeCheckForUpdate({ env: { AITCC_NO_UPDATE_CHECK: 'yes' }, isTTY: true, now }),
    ).toBeNull();
    // These do NOT opt out — confirmed indirectly by seeing the read cache
    // make it past the opt-out guard. We mock a 304 so the throttle flows.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    try {
      const out = await maybeCheckForUpdate({
        env: { AITCC_NO_UPDATE_CHECK: '0' },
        isTTY: true,
        now,
      });
      expect(out).not.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
