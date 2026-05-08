import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../session.js';
import { runAuthExport } from './auth-export.js';

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
      value: 'opaque-cookie-value-DO-NOT-LEAK',
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
  currentWorkspaceId: 3095,
};

describe('runAuthExport', () => {
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'aitcc-auth-export-'));
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('emits exactly one AITCC_SESSION=<base64> line on stdout for --format env (default)', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthExport(
        { json: false, format: 'env', quiet: true },
        { readSession: async () => sample, stdoutIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const stdout = spy.stdout.join('');
    // exactly one line with exactly one trailing newline — `eval` and
    // `>> $GITHUB_ENV` rely on this strict shape.
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    expect(stdout.startsWith('AITCC_SESSION=')).toBe(true);
    const base64 = stdout.replace(/^AITCC_SESSION=/, '').trim();
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    expect(JSON.parse(decoded)).toEqual(sample);
  });

  it('--format json prints the raw session shape pretty-printed', async () => {
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthExport(
        { json: false, format: 'json', quiet: true },
        { readSession: async () => sample, stdoutIsTTY: false },
      ),
    );
    spy.restore();
    const stdout = spy.stdout.join('');
    // Parsable on its own — no AITCC_SESSION= prefix.
    expect(stdout.startsWith('{')).toBe(true);
    expect(JSON.parse(stdout)).toEqual(sample);
  });

  it('--json wraps the env payload in an envelope with kr-only warning', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthExport(
        { json: true, format: 'env', quiet: true },
        { readSession: async () => sample, stdoutIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const line = spy.stdout.join('').trimEnd();
    const env = JSON.parse(line) as {
      ok: boolean;
      format: string;
      payload: string;
      warning: string;
      warningMessage: string;
    };
    expect(env.ok).toBe(true);
    expect(env.format).toBe('env');
    expect(env.payload.startsWith('AITCC_SESSION=')).toBe(true);
    expect(env.warning).toBe('kr-only-cookies');
    expect(env.warningMessage).toMatch(/KR-only/);
  });

  it('--json --format json puts the raw session in payload, not a string', async () => {
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthExport(
        { json: true, format: 'json', quiet: true },
        { readSession: async () => sample, stdoutIsTTY: false },
      ),
    );
    spy.restore();
    const env = JSON.parse(spy.stdout.join('').trimEnd()) as { payload: unknown };
    expect(env.payload).toEqual(sample);
  });

  it('exits 10 with authenticated:false when no session is present', async () => {
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthExport(
        { json: true, format: 'env', quiet: true },
        { readSession: async () => null, stdoutIsTTY: false },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(10);
    const line = spy.stdout.join('').trimEnd();
    const payload = JSON.parse(line) as { ok: boolean; authenticated: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.authenticated).toBe(false);
  });

  it('emits the KR-only warning on stderr by default but not under --quiet', async () => {
    const noisy = spyStdoutStderr();
    await captureExit(() =>
      runAuthExport(
        { json: false, format: 'env', quiet: false },
        { readSession: async () => sample, stdoutIsTTY: false },
      ),
    );
    noisy.restore();
    expect(noisy.stderr.join('')).toMatch(/KR-only/);

    const quiet = spyStdoutStderr();
    await captureExit(() =>
      runAuthExport(
        { json: false, format: 'env', quiet: true },
        { readSession: async () => sample, stdoutIsTTY: false },
      ),
    );
    quiet.restore();
    expect(quiet.stderr.join('')).not.toMatch(/KR-only/);
  });

  it('emits a TTY-redirect hint when stdout looks interactive', async () => {
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthExport(
        { json: false, format: 'env', quiet: false },
        { readSession: async () => sample, stdoutIsTTY: true },
      ),
    );
    spy.restore();
    expect(spy.stderr.join('')).toMatch(/redirect/);
  });

  it('--json never emits the TTY redirect hint or stderr noise', async () => {
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthExport(
        { json: true, format: 'env', quiet: false },
        { readSession: async () => sample, stdoutIsTTY: true },
      ),
    );
    spy.restore();
    // --json mode should keep stderr clean for agent-plugin parsers; the
    // KR-only warning is in the JSON envelope itself, not stderr.
    expect(spy.stderr.join('')).toBe('');
  });
});
