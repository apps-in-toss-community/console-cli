import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { runDeploy } from './app-deploy.js';

// Mirrors the captureExit/stdout-spy pattern used in register.test.ts.
// We never touch the network in these tests — `fetchImpl` is forced to
// throw so a regression that accidentally makes a call in --dry-run is
// loud and testable.

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

const cookies: readonly CdpCookie[] = [
  {
    name: 'session',
    value: 'x',
    domain: 'apps-in-toss.toss.im',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    session: true,
  },
];

function writeBundleFile(dir: string, deploymentId: string): string {
  // Synthesize a minimal .ait: a zip with app.json carrying the
  // embedded deploymentId. The bundle reader's unit tests cover the
  // parsing branches; here we just need a real file runDeploy can open
  // when we don't override readBundleImpl.
  const zip = zipSync({
    'app.json': new TextEncoder().encode(JSON.stringify({ _metadata: { deploymentId } })),
  });
  const path = join(dir, 'sample.ait');
  writeFileSync(path, zip);
  return path;
}

describe('runDeploy', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let root: string;
  let stdout: string[];
  let stderr: string[];
  let fetchCalls: number;

  const loudFetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch should not have been called');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aitcc-deploy-test-'));
    process.env.XDG_CONFIG_HOME = root;
    stdout = [];
    stderr = [];
    fetchCalls = 0;
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

  async function writeSessionAt(currentWorkspaceId?: number): Promise<void> {
    const { writeSession } = await import('../session.js');
    const base = {
      schemaVersion: 2 as const,
      user: { id: 'u', email: 'a@b.co' },
      cookies,
      origins: [] as unknown[],
      capturedAt: '2026-04-22T00:00:00.000Z',
    };
    await writeSession(currentWorkspaceId === undefined ? base : { ...base, currentWorkspaceId });
  }

  it('emits missing-app-id + exit 2 when --app is not passed and no yaml/env supplies one', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy({ path, app: undefined, json: true }, { fetchImpl: loudFetch }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"missing-app-id"');
    expect(fetchCalls).toBe(0);
  });

  it('emits invalid-id + exit 2 when --app is not a positive integer', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy({ path, app: 'abc', json: true }, { fetchImpl: loudFetch }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"invalid-id"');
    expect(fetchCalls).toBe(0);
  });

  it('emits missing-release-notes + exit 2 when --request-review is set without --release-notes', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', requestReview: true, json: true }, { fetchImpl: loudFetch }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"missing-release-notes"');
    expect(fetchCalls).toBe(0);
  });

  it('emits not-confirmed + exit 2 when --release is set without --confirm', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', release: true, json: true }, { fetchImpl: loudFetch }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"not-confirmed"');
    expect(fetchCalls).toBe(0);
  });

  it('emits invalid-bundle + exit 2 when the .ait has no deploymentId', async () => {
    await writeSessionAt(3095);
    // Bundle with no _metadata — reader raises missing-deployment-id,
    // which the command surfaces as `invalid-bundle` in --json.
    const zip = zipSync({
      'app.json': new TextEncoder().encode(JSON.stringify({ name: 'x' })),
    });
    const path = join(root, 'bad.ait');
    writeFileSync(path, zip);
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', json: true }, { fetchImpl: loudFetch }),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"invalid-bundle"');
    expect(fetchCalls).toBe(0);
  });

  it('--dry-run emits the planned pipeline without firing any network call', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, '00000000-0000-0000-0000-000000000001');
    const exit = await captureExit(() =>
      runDeploy(
        {
          path,
          app: '29397',
          dryRun: true,
          requestReview: true,
          releaseNotes: 'initial release',
          release: true,
          confirm: true,
          memo: 'pre-flight',
          json: true,
        },
        { fetchImpl: loudFetch },
      ),
    );
    expect(exit?.code).toBe(0);
    expect(fetchCalls).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('"dryRun":true');
    expect(out).toContain('"workspaceId":3095');
    expect(out).toContain('"appId":29397');
    expect(out).toContain('"deploymentId":"00000000-0000-0000-0000-000000000001"');
    expect(out).toContain('"steps":["upload","review","release"]');
    expect(out).toContain('"memo":"pre-flight"');
    expect(out).toContain('"releaseNotes":"initial release"');
    expect(out).toContain('"confirmed":true');
  });

  it('--dry-run with explicit --deployment-id overrides the embedded one', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'from-bundle');
    const exit = await captureExit(() =>
      runDeploy(
        {
          path,
          app: '29397',
          deploymentId: 'from-flag',
          dryRun: true,
          json: true,
        },
        { fetchImpl: loudFetch },
      ),
    );
    expect(exit?.code).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(stdout.join('')).toContain('"deploymentId":"from-flag"');
  });

  it('--dry-run plaintext mode renders a human-readable plan', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-abc');
    const exit = await captureExit(() =>
      runDeploy(
        {
          path,
          app: '29397',
          dryRun: true,
          json: false,
        },
        { fetchImpl: loudFetch },
      ),
    );
    expect(exit?.code).toBe(0);
    expect(fetchCalls).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('DRY RUN');
    expect(out).toContain('app           29397');
    expect(out).toContain('workspace     3095');
    expect(out).toContain('deploymentId  dep-abc');
    expect(out).toContain('steps         upload');
  });

  it('emits not-authenticated + exit 10 when no session is present', async () => {
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: true }, { fetchImpl: loudFetch }),
    );
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
    expect(fetchCalls).toBe(0);
  });
});
