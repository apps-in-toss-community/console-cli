import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAppInit } from './app-init.js';

// `runAppInit` exits via `process.exit`. Mirror the captureExit pattern
// from the other command tests so we can assert exit codes without
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
  // Mirror the chunk+optional-callback signature of `process.stdout.write`
  // so `exitAfterFlush`'s `process.stdout.write('', cb)` drain step
  // actually invokes the callback — otherwise the test hangs on the
  // never-resolving Promise inside `exitAfterFlush`.
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

describe('runAppInit', () => {
  let cwd: string;
  let originalIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'aitcc-init-handler-'));
    originalIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    if (originalIsTTY !== undefined) {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
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

  it('refuses --json with interactive-required', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const spy = spyStdoutStderr();
    const exited = await captureExit(() => runAppInit({ cwd, force: false, json: true }));
    spy.restore();
    expect(exited?.code).toBe(2);
    const line = spy.stdout.join('');
    expect(line).toContain('"reason":"interactive-required"');
    expect(line).toContain('"ok":false');
  });

  it('refuses non-TTY with a stderr message', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const spy = spyStdoutStderr();
    const exited = await captureExit(() => runAppInit({ cwd, force: false, json: false }));
    spy.restore();
    expect(exited?.code).toBe(2);
    expect(spy.stderr.join('')).toContain('requires an interactive TTY');
    expect(spy.stdout.join('')).toBe('');
  });

  it('refuses to overwrite an existing aitcc.yaml without --force', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const path = join(cwd, 'aitcc.yaml');
    writeFileSync(path, 'workspaceId: 1\n', 'utf8');
    const spy = spyStdoutStderr();
    const exited = await captureExit(() => runAppInit({ cwd, force: false, json: false }));
    spy.restore();
    expect(exited?.code).toBe(2);
    expect(spy.stderr.join('')).toContain('A project file already exists');
    // Existing content is untouched.
    expect(readFileSync(path, 'utf8')).toBe('workspaceId: 1\n');
  });

  it('refuses to overwrite an existing aitcc.json without --force', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const path = join(cwd, 'aitcc.json');
    writeFileSync(path, '{"workspaceId":1}\n', 'utf8');
    const spy = spyStdoutStderr();
    const exited = await captureExit(() => runAppInit({ cwd, force: false, json: false }));
    spy.restore();
    expect(exited?.code).toBe(2);
    expect(spy.stderr.join('')).toContain('A project file already exists');
    expect(readFileSync(path, 'utf8')).toBe('{"workspaceId":1}\n');
  });
});
