import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialBackend } from '../auth/credentials.js';
import { runAuthClear, runAuthSet, runAuthStatus } from './auth.js';

// `runAuth*` exits via `process.exit`. Mirror the captureExit pattern
// used elsewhere in the test suite so we can assert exit codes without
// terminating the test runner.

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

class InMemoryBackend implements CredentialBackend {
  readonly name = 'in-memory';
  readonly store = new Map<string, string>();
  setCalls = 0;

  async get(account: string): Promise<string | null> {
    return this.store.get(account) ?? null;
  }
  async set(account: string, password: string): Promise<void> {
    this.setCalls += 1;
    this.store.set(account, password);
  }
  async clear(account: string): Promise<{ existed: boolean }> {
    return { existed: this.store.delete(account) };
  }
}

describe('runAuthSet', () => {
  let originalXdg: string | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'aitcc-auth-set-'));
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalStdoutIsTTY !== undefined) {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
    if (originalStdinIsTTY !== undefined) {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
      });
    }
  });

  it('saves credentials with both --email and --password (JSON shape: created)', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthSet({ json: true, email: 'a@example.com', password: 'pw1' }, { backend, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const line = spy.stdout.join('').trimEnd();
    const payload = JSON.parse(line) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('created');
    expect(payload.email).toBe('a@example.com');
    expect(backend.store.get('a@example.com')).toBe('pw1');
  });

  it('emits a process-list warning when --password is on argv', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthSet({ json: true, email: 'a@example.com', password: 'pw1' }, { backend, env: {} }),
    );
    spy.restore();
    expect(spy.stderr.join('')).toContain('visible in `ps`');
  });

  it('takes the unchanged path on identical re-save', async () => {
    const backend = new InMemoryBackend();
    const spy1 = spyStdoutStderr();
    await captureExit(() =>
      runAuthSet({ json: true, email: 'a@example.com', password: 'pw1' }, { backend, env: {} }),
    );
    spy1.restore();
    const callsBefore = backend.setCalls;

    const spy2 = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthSet({ json: true, email: 'a@example.com', password: 'pw1' }, { backend, env: {} }),
    );
    spy2.restore();
    expect(exited?.code).toBe(0);
    const payload = JSON.parse(spy2.stdout.join('').trimEnd()) as Record<string, unknown>;
    expect(payload.status).toBe('unchanged');
    // No additional keychain write — that's the whole point of the
    // `unchanged` discriminant; stale tests would let this regress
    // and re-prompt users on every re-run.
    expect(backend.setCalls).toBe(callsBefore);
  });

  it('refuses non-TTY without --email (interactive-required)', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthSet({ json: true, password: 'pw1' }, { backend, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(2);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('interactive-required');
  });

  it('rejects an obviously bad email (no @)', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthSet({ json: true, email: 'not-an-email', password: 'pw1' }, { backend, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(2);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as Record<string, unknown>;
    expect(payload.reason).toBe('invalid-email');
  });

  it('reads AITCC_EMAIL + AITCC_PASSWORD from injected env when flags are absent', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthSet(
        { json: true },
        { backend, env: { AITCC_EMAIL: 'env@example.com', AITCC_PASSWORD: 'envpw' } },
      ),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    expect(backend.store.get('env@example.com')).toBe('envpw');
  });

  it('never echoes the password in stdout/stderr', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthSet(
        { json: false, email: 'a@example.com', password: 'super-secret-12345' },
        { backend, env: {} },
      ),
    );
    spy.restore();
    const all = spy.stdout.join('') + spy.stderr.join('');
    expect(all).not.toContain('super-secret-12345');
  });
});

describe('runAuthClear', () => {
  let originalXdg: string | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'aitcc-auth-clear-'));
    // Default to non-TTY so the confirm prompt is bypassed by --yes alone.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalStdoutIsTTY !== undefined) {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
    if (originalStdinIsTTY !== undefined) {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
      });
    }
  });

  it('reports absent when nothing is stored (idempotent)', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthClear({ json: true, yes: true }, { backend, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('absent');
  });

  it('refuses non-TTY without --yes (confirmation-required)', async () => {
    // Regression guard for the blocker spotted in pass 1 review: a
    // piped/scripted invocation that omitted --yes used to silently
    // delete because the confirm block was gated on `interactive`.
    // Now non-TTY + missing --yes must hard-fail with exit 2 so the
    // operator notices and adds --yes explicitly.
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthClear({ json: true, yes: false }, { backend, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(2);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('confirmation-required');
  });

  it('deletes both keychain entry and pointer when present', async () => {
    const backend = new InMemoryBackend();
    // Seed by going through saveCredentials so the auth-state file exists.
    const spy0 = spyStdoutStderr();
    await captureExit(() =>
      runAuthSet({ json: true, email: 'a@example.com', password: 'pw1' }, { backend, env: {} }),
    );
    spy0.restore();
    expect(backend.store.has('a@example.com')).toBe(true);

    const spy = spyStdoutStderr();
    const exited = await captureExit(() =>
      runAuthClear({ json: true, yes: true }, { backend, env: {} }),
    );
    spy.restore();
    expect(exited?.code).toBe(0);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as Record<string, unknown>;
    expect(payload.status).toBe('deleted');
    expect(backend.store.has('a@example.com')).toBe(false);
  });
});

describe('runAuthStatus', () => {
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'aitcc-auth-status-'));
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('reports stored=false + session active=false when nothing is configured', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    const exited = await captureExit(() => runAuthStatus({ json: true }, { backend, env: {} }));
    spy.restore();
    expect(exited?.code).toBe(0);
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as {
      credentials: { stored: boolean };
      session: { active: boolean };
    };
    expect(payload.credentials.stored).toBe(false);
    expect(payload.session.active).toBe(false);
  });

  it('reports source=keychain after a save', async () => {
    const backend = new InMemoryBackend();
    const spy0 = spyStdoutStderr();
    await captureExit(() =>
      runAuthSet({ json: true, email: 'a@example.com', password: 'pw1' }, { backend, env: {} }),
    );
    spy0.restore();

    const spy = spyStdoutStderr();
    await captureExit(() => runAuthStatus({ json: true }, { backend, env: {} }));
    spy.restore();
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as {
      credentials: { stored: boolean; email?: string; source?: string };
    };
    expect(payload.credentials.stored).toBe(true);
    expect(payload.credentials.email).toBe('a@example.com');
    expect(payload.credentials.source).toBe('keychain');
  });

  it('reports source=env when AITCC_EMAIL + AITCC_PASSWORD are set, without touching backend', async () => {
    const backend = new InMemoryBackend();
    const spy = spyStdoutStderr();
    await captureExit(() =>
      runAuthStatus(
        { json: true },
        {
          backend,
          env: { AITCC_EMAIL: 'env@example.com', AITCC_PASSWORD: 'envpw' },
        },
      ),
    );
    spy.restore();
    const payload = JSON.parse(spy.stdout.join('').trimEnd()) as {
      credentials: { stored: boolean; email?: string; source?: string };
    };
    expect(payload.credentials.stored).toBe(true);
    expect(payload.credentials.source).toBe('env');
  });
});
