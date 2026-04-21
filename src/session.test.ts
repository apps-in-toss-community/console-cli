import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, readSession, type Session, writeSession } from './session.js';

function freshConfigRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-test-'));
}

const sample: Session = {
  schemaVersion: 1,
  user: { id: 'u_1', email: 'a@b.co', displayName: 'Tester' },
  cookies: [
    {
      name: 'auth',
      value: 'opaque',
      domain: 'apps-in-toss.toss.im',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      session: true,
    },
  ],
  origins: [],
  capturedAt: '2026-04-19T00:00:00.000Z',
};

describe('session file IO', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let root: string;

  beforeEach(() => {
    root = freshConfigRoot();
    process.env.XDG_CONFIG_HOME = root;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('writes the session file with 0600 perms on POSIX (exists on Windows)', async () => {
    await writeSession(sample);
    const path = join(root, 'aitcc', 'session.json');
    const st = statSync(path);
    if (process.platform === 'win32') {
      // Windows: POSIX mode is best-effort; at minimum the file must exist
      // and be non-empty so we have a positive signal on that platform.
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);
    } else {
      expect((st.mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('round-trips through readSession', async () => {
    await writeSession(sample);
    const roundtrip = await readSession();
    expect(roundtrip).toEqual(sample);
  });

  it('clearSession removes the file and is idempotent', async () => {
    await writeSession(sample);
    const first = await clearSession();
    expect(first.existed).toBe(true);
    const second = await clearSession();
    expect(second.existed).toBe(false);
    expect(await readSession()).toBeNull();
  });

  it('readSession rejects a session with malformed cookies and warns on stderr', async () => {
    const sessionDir = join(root, 'aitcc');
    await mkdir(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schemaVersion: 1,
        user: { id: 'u', email: 'x@y.z' },
        cookies: 'not-an-array',
        origins: [],
        capturedAt: '2026-04-19T00:00:00.000Z',
      }),
    );
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await readSession()).toBeNull();
      const joined = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(joined).toContain('cookies is not an array');
    } finally {
      spy.mockRestore();
    }
  });

  it('readSession warns and returns null on an unknown schemaVersion', async () => {
    const sessionDir = join(root, 'aitcc');
    await mkdir(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schemaVersion: 99,
        user: { id: 'u', email: 'x@y.z' },
        cookies: [],
        origins: [],
        capturedAt: '2026-04-19T00:00:00.000Z',
      }),
    );
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await readSession()).toBeNull();
      const joined = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(joined).toContain('unknown schemaVersion');
    } finally {
      spy.mockRestore();
    }
  });

  it('readSession warns and returns null on malformed JSON', async () => {
    const sessionDir = join(root, 'aitcc');
    await mkdir(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), '{ not json');
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await readSession()).toBeNull();
      const joined = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(joined).toContain('corrupt');
    } finally {
      spy.mockRestore();
    }
  });
});
