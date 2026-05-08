import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Session, sessionPathForDiagnostics } from '../session.js';
import { runAuthImport } from './auth-import.js';

type Exited = { code: number };

async function captureExit(fn: () => Promise<unknown>): Promise<Exited | null> {
  const original = process.exit;
  let exited: Exited | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch for tests
  (process as any).exit = ((code?: number) => {
    exited = { code: code ?? 0 };
    throw new Error(`__test_exit_${code ?? 0}__`);
  }) as never;
  try {
    await fn().catch((err) => {
      if (!(err instanceof Error) || !err.message.startsWith('__test_exit_')) throw err;
    });
  } finally {
    process.exit = original;
  }
  return exited;
}

function spyStdoutStderr(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
    stdout.push(String(chunk));
    const cb = rest.find((a): a is () => void => typeof a === 'function');
    cb?.();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
    stderr.push(String(chunk));
    const cb = rest.find((a): a is () => void => typeof a === 'function');
    cb?.();
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      vi.restoreAllMocks();
    },
  };
}

const sample: Session = {
  schemaVersion: 2,
  user: { id: 'u_1', email: 'a@b.co', displayName: 'Tester' },
  cookies: [
    {
      name: 'TBIZAUTH',
      value: 'opaque',
      domain: '.toss.im',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      session: true,
    },
  ],
  origins: [],
  capturedAt: '2026-05-08T03:00:00.000Z',
};

describe('runAuthImport', () => {
  let originalXdg: string | undefined;
  let originalEnvSession: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalEnvSession = process.env.AITCC_SESSION;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'aitcc-auth-import-'));
    delete process.env.AITCC_SESSION;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalEnvSession === undefined) delete process.env.AITCC_SESSION;
    else process.env.AITCC_SESSION = originalEnvSession;
  });

  it('reads raw JSON from stdin and writes the session file', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: false, dryRun: false },
        {
          readStdin: async () => JSON.stringify(sample),
          stdinIsTTY: false,
        },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const path = sessionPathForDiagnostics();
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual(sample);
    if (process.platform !== 'win32') {
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    }
  });

  it('reads base64 from stdin (auto-detect)', async () => {
    const blob = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64');
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: false, dryRun: false },
        { readStdin: async () => blob, stdinIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(sessionPathForDiagnostics(), 'utf8'));
    expect(onDisk).toEqual(sample);
  });

  it('reads from AITCC_SESSION env when --from-env is set', async () => {
    const blob = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64');
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: true, dryRun: false },
        { env: { AITCC_SESSION: blob }, stdinIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(sessionPathForDiagnostics(), 'utf8'));
    expect(onDisk).toEqual(sample);
  });

  it('passes forceWrite: true to writeSession (bypasses env-mode no-op)', async () => {
    // Regression guard: under --from-env, AITCC_SESSION is set, which
    // makes the production writeSession() a no-op unless forceWrite is
    // threaded through. If a future refactor drops it, this test
    // catches the call-site regression.
    const blob = Buffer.from(JSON.stringify(sample), 'utf8').toString('base64');
    const calls: Array<{ session: Session; opts: unknown }> = [];
    const writeSpy = async (session: Session, opts?: unknown) => {
      calls.push({ session, opts });
    };
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: true, dryRun: false },
        {
          env: { AITCC_SESSION: blob },
          stdinIsTTY: false,
          writeSession: writeSpy,
        },
      ),
    );
    spy.restore();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toEqual({ forceWrite: true });
  });

  it('exits 2 with env-not-set when --from-env but env unset', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport({ json: true, fromEnv: true, dryRun: false }, { env: {}, stdinIsTTY: false }),
    );
    spy.restore();
    expect(exited?.code).toBe(2);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as { reason: string };
    expect(payload.reason).toBe('env-not-set');
  });

  it('exits 2 with no-input when stdin is a TTY and no flag', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport({ json: true, fromEnv: false, dryRun: false }, { stdinIsTTY: true, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(2);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as { reason: string };
    expect(payload.reason).toBe('no-input');
  });

  it('exits 2 with invalid-blob when shape fails validation', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: false, dryRun: false },
        {
          readStdin: async () => JSON.stringify({ schemaVersion: 99, junk: true }),
          stdinIsTTY: false,
        },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(2);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as { reason: string; detail: string };
    expect(payload.reason).toBe('invalid-blob');
    expect(payload.detail).toContain('schemaVersion');
  });

  it('migrates a v1 blob to v2 on import', async () => {
    const v1 = {
      schemaVersion: 1,
      user: { id: 'u_1', email: 'a@b.co' },
      cookies: [],
      origins: [],
      capturedAt: '2026-05-08T03:00:00.000Z',
    };
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: false, dryRun: false },
        { readStdin: async () => JSON.stringify(v1), stdinIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(sessionPathForDiagnostics(), 'utf8'));
    expect(onDisk.schemaVersion).toBe(2);
  });

  it('--dry-run validates without writing', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: false, dryRun: true },
        { readStdin: async () => JSON.stringify(sample), stdinIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as { dryRun: boolean };
    expect(payload.dryRun).toBe(true);
    // No file written.
    let exists = true;
    try {
      readFileSync(sessionPathForDiagnostics(), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('reports replaced=true when an existing session is overwritten', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthImport(
        { json: true, fromEnv: false, dryRun: false },
        {
          readStdin: async () => JSON.stringify(sample),
          stdinIsTTY: false,
          // simulate an already-existing session.
          readExistingSession: async () => sample,
        },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as { replaced: boolean };
    expect(payload.replaced).toBe(true);
  });

  it('does not echo cookie values on stdout/stderr in plain mode', async () => {
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthImport(
        { json: false, fromEnv: false, dryRun: false },
        { readStdin: async () => JSON.stringify(sample), stdinIsTTY: false },
      ),
    );
    spy.restore();
    const all = spy.stdout.join('') + spy.stderr.join('');
    expect(all).not.toContain('opaque');
  });
});
