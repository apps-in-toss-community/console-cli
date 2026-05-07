import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSession } from '../session.js';
import {
  type AppContext,
  printContextHeader,
  requireMiniAppId,
  resolveAppOrFail,
} from './_shared.js';

// PR 1b wiring-helper tests. `resolveAppContext` is the pure resolver
// (covered in `_shared.app-context.test.ts`); these tests pin the
// command-facing wrappers that emit JSON/exit-code on failure and write
// the stderr context header.

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

describe('printContextHeader', () => {
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stderr.push(String(chunk));
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is silent under --json', () => {
    const ctx: AppContext = { workspaceId: 3095, workspaceSource: 'session' };
    printContextHeader(ctx, { json: true });
    expect(stderr.join('')).toBe('');
  });

  it('writes a workspace-only header for Group B commands', () => {
    const ctx: AppContext = { workspaceId: 3095, workspaceSource: 'session' };
    printContextHeader(ctx, { json: false });
    expect(stderr.join('')).toBe('[workspace: 3095 (from session)]\n');
  });

  it('includes the miniApp segment when context resolves one', () => {
    const ctx: AppContext = {
      workspaceId: 3095,
      workspaceSource: 'yaml',
      miniAppId: 31146,
      miniAppIdSource: 'yaml',
      projectFile: '/repo/aitcc.yaml',
    };
    printContextHeader(ctx, { json: false });
    expect(stderr.join('')).toBe(
      '[workspace: 3095 (from aitcc.yaml) · app: 31146 (from aitcc.yaml)]\n',
    );
  });

  it('labels each source distinctly', () => {
    const cases: Array<[AppContext, string]> = [
      [{ workspaceId: 1, workspaceSource: 'flag' }, '[workspace: 1 (from --workspace)]\n'],
      [{ workspaceId: 1, workspaceSource: 'env' }, '[workspace: 1 (from $AITCC_WORKSPACE)]\n'],
      [
        {
          workspaceId: 1,
          workspaceSource: 'flag',
          miniAppId: 2,
          miniAppIdSource: 'flag',
        },
        '[workspace: 1 (from --workspace) · app: 2 (from --app)]\n',
      ],
      [
        {
          workspaceId: 1,
          workspaceSource: 'env',
          miniAppId: 2,
          miniAppIdSource: 'env',
        },
        '[workspace: 1 (from $AITCC_WORKSPACE) · app: 2 (from $AITCC_APP)]\n',
      ],
    ];
    for (const [ctx, expected] of cases) {
      stderr.length = 0;
      printContextHeader(ctx, { json: false });
      expect(stderr.join('')).toBe(expected);
    }
  });
});

describe('requireMiniAppId', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
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
  });

  it('returns the miniAppId when context resolved one', async () => {
    const ctx: AppContext = {
      workspaceId: 1,
      workspaceSource: 'session',
      miniAppId: 31146,
      miniAppIdSource: 'yaml',
    };
    const result = await requireMiniAppId(ctx, false);
    expect(result).toBe(31146);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('');
  });

  it('emits missing-app-id JSON + exit 2 when no miniAppId in context', async () => {
    const ctx: AppContext = { workspaceId: 1, workspaceSource: 'session' };
    const exit = await captureExit(() => requireMiniAppId(ctx, true));
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"missing-app-id"');
  });

  it('emits a plain stderr line when not under --json', async () => {
    const ctx: AppContext = { workspaceId: 1, workspaceSource: 'session' };
    const exit = await captureExit(() => requireMiniAppId(ctx, false));
    expect(exit?.code).toBe(2);
    expect(stderr.join('')).toContain('app id required');
    expect(stdout.join('')).toBe('');
  });
});

describe('resolveAppOrFail', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalHome = process.env.HOME;
  const originalAppEnv = process.env.AITCC_APP;
  const originalWsEnv = process.env.AITCC_WORKSPACE;
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aitcc-resolve-app-'));
    process.env.XDG_CONFIG_HOME = root;
    process.env.HOME = '/__aitcc_test_home_does_not_exist__';
    delete process.env.AITCC_APP;
    delete process.env.AITCC_WORKSPACE;
    stdout = [];
    stderr = [];
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
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAppEnv === undefined) delete process.env.AITCC_APP;
    else process.env.AITCC_APP = originalAppEnv;
    if (originalWsEnv === undefined) delete process.env.AITCC_WORKSPACE;
    else process.env.AITCC_WORKSPACE = originalWsEnv;
  });

  async function writeSessionAt(currentWorkspaceId?: number): Promise<void> {
    const base = {
      schemaVersion: 2 as const,
      user: { id: 'u', email: 'a@b.co' },
      cookies: [],
      origins: [] as unknown[],
      capturedAt: '2026-04-22T00:00:00.000Z',
    };
    await writeSession(currentWorkspaceId === undefined ? base : { ...base, currentWorkspaceId });
  }

  it('returns context with positional appId parsed', async () => {
    await writeSessionAt(3095);
    const ctx = await resolveAppOrFail({ json: false, appIdRaw: '31146' });
    expect(ctx).not.toBeNull();
    expect(ctx?.workspaceId).toBe(3095);
    expect(ctx?.miniAppId).toBe(31146);
    expect(ctx?.miniAppIdSource).toBe('flag');
  });

  it('emits invalid-id when appIdRaw is malformed (positional)', async () => {
    await writeSessionAt(3095);
    const exit = await captureExit(() => resolveAppOrFail({ json: true, appIdRaw: '42x' }));
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"invalid-id"');
    expect(stdout.join('')).toContain('app id');
  });

  it('emits invalid-id with --app label when appIdField is "app"', async () => {
    await writeSessionAt(3095);
    const exit = await captureExit(() =>
      resolveAppOrFail({ json: true, appIdRaw: '42x', appIdField: 'app' }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"invalid-id"');
    expect(stdout.join('')).toContain('--app');
  });

  it('emits not-authenticated + exit 10 when no session exists', async () => {
    const exit = await captureExit(() => resolveAppOrFail({ json: true }));
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  it('emits no-workspace-selected + exit 2 when nothing supplies a workspace', async () => {
    await writeSessionAt(); // no currentWorkspaceId
    const exit = await captureExit(() => resolveAppOrFail({ json: true }));
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"no-workspace-selected"');
  });
});
