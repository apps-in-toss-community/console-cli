import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { runRegister } from './register.js';

// Integration test for the `app register` command orchestration layer.
// We stub the three external collaborators (image validation + upload +
// submit) so we can exercise the full decision tree (missing session,
// missing manifest, missing field, dimension mismatch, upload failure,
// submit failure, success) without touching the network.
//
// Output is captured from process.stdout/stderr so the --json contract
// is pinned byte-for-byte. agent-plugin parses these exact shapes.

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

function writeManifest(
  dir: string,
  body: Record<string, unknown>,
  name = 'aitcc.app.yaml',
): string {
  const path = join(dir, name);
  // JSON is a valid YAML subset; avoiding yaml-stringify keeps the test
  // free from a second YAML-formatting dependency.
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR', 'ascii');
  const crc = Buffer.alloc(4);
  return Buffer.concat([signature, length, type, ihdr, crc]);
}

function writePng(dir: string, name: string, width: number, height: number): string {
  const path = join(dir, name);
  writeFileSync(path, makePng(width, height));
  return path;
}

function validManifestBody(dir: string): Record<string, unknown> {
  writePng(dir, 'logo.png', 600, 600);
  writePng(dir, 'thumb.png', 1932, 828);
  writePng(dir, 's1.png', 636, 1048);
  writePng(dir, 's2.png', 636, 1048);
  writePng(dir, 's3.png', 636, 1048);
  return {
    titleKo: '테스트 앱',
    titleEn: 'Test App',
    appName: 'test-app',
    csEmail: 'a@b.co',
    logo: 'logo.png',
    horizontalThumbnail: 'thumb.png',
    categoryIds: [1],
    subtitle: '부제',
    description: '상세',
    verticalScreenshots: ['s1.png', 's2.png', 's3.png'],
  };
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

describe('runRegister', () => {
  let root: string;
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aitcc-register-test-'));
    dir = root;
    process.env.XDG_CONFIG_HOME = root;
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

  async function writeSessionAt(currentWorkspaceId?: number): Promise<void> {
    // Import lazily so the XDG env is already set when session.ts reads it.
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

  it('emits { ok: true, authenticated: false } + exit 10 when no session exists', async () => {
    const exit = await captureExit(() => runRegister({ json: true }, {}));
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  it('emits no-workspace-selected + exit 2 when session has no workspace', async () => {
    await writeSessionAt();
    const manifest = writeManifest(dir, validManifestBody(dir));
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, {}));
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"no-workspace-selected"');
  });

  it('emits invalid-config + exit 2 when the manifest is missing', async () => {
    await writeSessionAt(3095);
    const exit = await captureExit(() =>
      runRegister({ json: true, config: join(dir, 'missing.yaml') }, {}),
    );
    expect(exit?.code).toBe(2);
    const out = stdout.join('');
    expect(out).toContain('"reason":"invalid-config"');
  });

  it('emits missing-required-field + exit 2 when the manifest is missing a field', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    delete body.titleKo;
    const manifest = writeManifest(dir, body);
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, {}));
    expect(exit?.code).toBe(2);
    const out = stdout.join('');
    expect(out).toContain('"reason":"missing-required-field"');
    expect(out).toContain('"field":"titleKo"');
  });

  it('emits image-dimension-mismatch + exit 2 when an image has wrong dimensions', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    writePng(dir, 'logo.png', 512, 512);
    const manifest = writeManifest(dir, body);
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, {}));
    expect(exit?.code).toBe(2);
    const out = stdout.join('');
    expect(out).toContain('"reason":"image-dimension-mismatch"');
    expect(out).toContain('"expected":"600x600"');
    expect(out).toContain('"actual":"512x512"');
  });

  it('emits api-error + exit 17 when the upload fails', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { TossApiError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, config: manifest },
        {
          uploadImpl: async () => {
            throw new TossApiError(400, 'IMG_TOO_LARGE', 'no', 1);
          },
        },
      ),
    );
    expect(exit?.code).toBe(17);
    expect(stdout.join('')).toContain('"reason":"api-error"');
  });

  it('emits network-error + exit 11 when the upload has a network failure', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { NetworkError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, config: manifest },
        {
          uploadImpl: async () => {
            throw new NetworkError('https://x', new Error('ECONNRESET'));
          },
        },
      ),
    );
    expect(exit?.code).toBe(11);
    expect(stdout.join('')).toContain('"reason":"network-error"');
  });

  it('emits { ok: true, authenticated: false } + exit 10 when the submit sees an auth failure', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { TossApiError } = await import('../api/http.js');
    let uploadCalls = 0;
    const exit = await captureExit(() =>
      runRegister(
        { json: true, config: manifest },
        {
          uploadImpl: async () => {
            uploadCalls += 1;
            return `https://cdn.example/u-${uploadCalls}.png`;
          },
          submitImpl: async () => {
            throw new TossApiError(401, '4010', 'auth', 1);
          },
        },
      ),
    );
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  it('emits { ok: true, workspaceId, appId, reviewState } + exit 0 on success', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const exit = await captureExit(() =>
      runRegister(
        { json: true, config: manifest },
        {
          uploadImpl: async (params) =>
            `https://cdn.example/${params.validWidth}x${params.validHeight}.png`,
          submitImpl: async () => ({
            miniAppId: 123,
            reviewState: 'PENDING',
            extra: {},
          }),
        },
      ),
    );
    expect(exit?.code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('"ok":true');
    expect(out).toContain('"workspaceId":3095');
    expect(out).toContain('"appId":123');
    expect(out).toContain('"reviewState":"PENDING"');
  });
});
