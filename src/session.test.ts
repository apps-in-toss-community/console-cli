import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessionWarningsForTests,
  clearSession,
  readSession,
  type Session,
  setCurrentWorkspaceId,
  writeSession,
} from './session.js';

function freshConfigRoot(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-test-'));
}

const sample: Session = {
  schemaVersion: 2,
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

  it('readSession accepts a v1 file, reports v2 in memory, and rewrites v2 on disk', async () => {
    const sessionDir = join(root, 'aitcc');
    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, 'session.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        user: { id: 'u', email: 'x@y.z' },
        cookies: [],
        origins: [],
        capturedAt: '2026-04-19T00:00:00.000Z',
      }),
    );
    const got = await readSession();
    expect(got).not.toBeNull();
    expect(got?.schemaVersion).toBe(2);
    expect(got?.currentWorkspaceId).toBeUndefined();
    // On-disk rewrite: the file should now parse as v2 without needing
    // another migration pass.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { schemaVersion: number };
    expect(onDisk.schemaVersion).toBe(2);
  });

  it('readSession rejects currentWorkspaceId of 0 or negative', async () => {
    for (const bad of [0, -1]) {
      const sessionDir = join(root, 'aitcc');
      await mkdir(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'session.json'),
        JSON.stringify({
          schemaVersion: 2,
          user: { id: 'u', email: 'x@y.z' },
          cookies: [],
          origins: [],
          capturedAt: '2026-04-19T00:00:00.000Z',
          currentWorkspaceId: bad,
        }),
      );
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        expect(await readSession()).toBeNull();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('readSession rejects a non-integer currentWorkspaceId', async () => {
    const sessionDir = join(root, 'aitcc');
    await mkdir(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schemaVersion: 2,
        user: { id: 'u', email: 'x@y.z' },
        cookies: [],
        origins: [],
        capturedAt: '2026-04-19T00:00:00.000Z',
        currentWorkspaceId: 'not-a-number',
      }),
    );
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await readSession()).toBeNull();
      const joined = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(joined).toContain('currentWorkspaceId');
    } finally {
      spy.mockRestore();
    }
  });

  it('setCurrentWorkspaceId persists on top of an existing session', async () => {
    await writeSession(sample);
    const updated = await setCurrentWorkspaceId(36577);
    expect(updated?.currentWorkspaceId).toBe(36577);
    const reread = await readSession();
    expect(reread?.currentWorkspaceId).toBe(36577);
  });

  it('setCurrentWorkspaceId returns null when there is no session', async () => {
    expect(await setCurrentWorkspaceId(36577)).toBeNull();
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

describe('AITCC_SESSION env precedence', () => {
  // The env path is the read side of the `auth export` / `auth import`
  // CI flow. `readSession()` must prefer it when valid, fall back to
  // file when invalid (with one-shot warn), and `writeSession` /
  // `clearSession` must no-op so a stray `workspace use` on a CI host
  // doesn't materialise a 0600 file the operator never expected.

  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalEnv = process.env.AITCC_SESSION;
  let root: string;

  beforeEach(() => {
    root = freshConfigRoot();
    process.env.XDG_CONFIG_HOME = root;
    delete process.env.AITCC_SESSION;
    __resetSessionWarningsForTests();
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalEnv === undefined) delete process.env.AITCC_SESSION;
    else process.env.AITCC_SESSION = originalEnv;
  });

  it('readSession returns the env blob without touching the file', async () => {
    const blob = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64');
    process.env.AITCC_SESSION = blob;
    const got = await readSession();
    expect(got).toEqual(sample);
    // No file should have been created by reading.
    let exists = true;
    try {
      readFileSync(join(root, 'aitcc', 'session.json'), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('readSession accepts raw JSON in env (no base64)', async () => {
    process.env.AITCC_SESSION = JSON.stringify(sample);
    expect(await readSession()).toEqual(sample);
  });

  it('readSession falls back to file when env is malformed and warns once', async () => {
    // Seed the file BEFORE the env var is set — writeSession would
    // otherwise no-op under the env guard.
    await writeSession(sample);
    process.env.AITCC_SESSION = 'not-base64-or-json-or-anything-coherent::::';
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const got = await readSession();
      expect(got).toEqual(sample);
      const joined = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(joined).toMatch(/AITCC_SESSION/);
    } finally {
      spy.mockRestore();
    }
  });

  it('writeSession is a no-op (and warns once) under env mode', async () => {
    process.env.AITCC_SESSION = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64');
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await writeSession({ ...sample, currentWorkspaceId: 9999 });
      const joined = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(joined).toMatch(/not persisted/);
    } finally {
      spy.mockRestore();
    }
    // No file written.
    let exists = true;
    try {
      readFileSync(join(root, 'aitcc', 'session.json'), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('migrates a v1 env blob to v2 in memory only', async () => {
    const v1 = {
      schemaVersion: 1,
      user: { id: 'u_1', email: 'a@b.co' },
      cookies: [],
      origins: [],
      capturedAt: '2026-05-08T03:00:00.000Z',
    };
    process.env.AITCC_SESSION = Buffer.from(JSON.stringify(v1), 'utf8').toString('base64');
    const got = await readSession();
    expect(got?.schemaVersion).toBe(2);
    // No file written either.
    let exists = true;
    try {
      readFileSync(join(root, 'aitcc', 'session.json'), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
