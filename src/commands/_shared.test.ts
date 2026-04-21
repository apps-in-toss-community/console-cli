import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSession } from '../session.js';
import { resolveWorkspaceContext } from './_shared.js';

// `resolveWorkspaceContext` is the shared boilerplate every workspace-
// scoped command (`app ls`, `members ls`, `keys ls`, …) depends on for
// the "load session + resolve workspace id" pre-amble. Agent-plugin
// parses the JSON shapes it emits on failure, so the contract is pinned
// here rather than exercised only through the indirect command paths.

type Exited = { code: number };

async function captureExit(fn: () => Promise<unknown>): Promise<Exited | null> {
  const original = process.exit;
  let exited: Exited | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch for tests
  (process as any).exit = ((code?: number) => {
    exited = { code: code ?? 0 };
    // Throw so the surrounding await promptly rejects — the real
    // process.exit never returns either.
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

describe('resolveWorkspaceContext', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aitcc-test-'));
    process.env.XDG_CONFIG_HOME = root;
    stdout = [];
    stderr = [];
    // exitAfterFlush writes '' with a callback to drain stdout; our mock has
    // to invoke any trailing callback argument, otherwise the flush promise
    // never resolves and the test hangs.
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('emits { ok: true, authenticated: false } + exit 10 when no session exists', async () => {
    const exit = await captureExit(() => resolveWorkspaceContext({ json: true }));
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  it('emits invalid-id + exit 2 on a bad --workspace', async () => {
    await writeSession({
      schemaVersion: 2,
      user: { id: 'u', email: 'a@b.co' },
      cookies: [],
      origins: [],
      capturedAt: '2026-04-19T00:00:00.000Z',
    });
    const exit = await captureExit(() =>
      resolveWorkspaceContext({ json: true, workspace: '36577x' }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toMatchInlineSnapshot(
      '"{"ok":false,"reason":"invalid-id","message":"--workspace must be a positive integer (got 36577x)"}\n"',
    );
  });

  it('emits no-workspace-selected + exit 2 when session has no currentWorkspaceId and no --workspace is passed', async () => {
    await writeSession({
      schemaVersion: 2,
      user: { id: 'u', email: 'a@b.co' },
      cookies: [],
      origins: [],
      capturedAt: '2026-04-19T00:00:00.000Z',
    });
    const exit = await captureExit(() => resolveWorkspaceContext({ json: true }));
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"no-workspace-selected"');
  });

  it('returns the resolved context when --workspace is valid', async () => {
    await writeSession({
      schemaVersion: 2,
      user: { id: 'u', email: 'a@b.co' },
      cookies: [],
      origins: [],
      capturedAt: '2026-04-19T00:00:00.000Z',
    });
    const ctx = await resolveWorkspaceContext({ json: false, workspace: '36577' });
    expect(ctx).not.toBeNull();
    expect(ctx?.workspaceId).toBe(36577);
  });

  it('falls back to session.currentWorkspaceId when --workspace is absent', async () => {
    await writeSession({
      schemaVersion: 2,
      user: { id: 'u', email: 'a@b.co' },
      cookies: [],
      origins: [],
      capturedAt: '2026-04-19T00:00:00.000Z',
      currentWorkspaceId: 42,
    });
    const ctx = await resolveWorkspaceContext({ json: false });
    expect(ctx?.workspaceId).toBe(42);
  });
});
