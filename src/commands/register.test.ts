import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpCookie } from '../cdp.js';
import { makePngBuffer } from '../test-helpers/png.js';
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

function writeManifest(dir: string, body: Record<string, unknown>, name = 'aitcc.yaml'): string {
  const path = join(dir, name);
  // JSON is a valid YAML subset; avoiding yaml-stringify keeps the test
  // free from a second YAML-formatting dependency.
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function writePng(dir: string, name: string, width: number, height: number): string {
  const path = join(dir, name);
  writeFileSync(path, makePngBuffer(width, height));
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
  const originalXdg = process.env.XDG_CONFIG_HOME;
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
    // Restore env so a future multi-file test worker doesn't inherit the
    // tmpdir pointer. Matches the pattern in `_shared.test.ts` / `session.test.ts`.
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
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

  // Pin `deps.cwd` to the test's tmpdir in every call so the `aitcc.yaml`
  // auto-detect path resolves inside the sandbox, not against whatever the
  // ambient `process.cwd()` happens to contain. Tests with explicit
  // `args.config` don't strictly need this, but passing it uniformly keeps
  // the suite hermetic if someone later drops a repo-root `aitcc.yaml`.
  function depsWith(
    overrides: Parameters<typeof runRegister>[1] = {},
  ): Parameters<typeof runRegister>[1] {
    return { cwd: dir, ...overrides };
  }

  it('emits { ok: true, authenticated: false } + exit 10 when no session exists', async () => {
    const exit = await captureExit(() => runRegister({ json: true }, depsWith()));
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  it('emits no-workspace-selected + exit 2 when session has no workspace', async () => {
    await writeSessionAt();
    const manifest = writeManifest(dir, validManifestBody(dir));
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, depsWith()));
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"no-workspace-selected"');
  });

  it('emits invalid-config + exit 2 when the manifest is missing', async () => {
    await writeSessionAt(3095);
    const exit = await captureExit(() =>
      runRegister({ json: true, config: join(dir, 'missing.yaml') }, depsWith()),
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
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, depsWith()));
    expect(exit?.code).toBe(2);
    const out = stdout.join('');
    expect(out).toContain('"reason":"missing-required-field"');
    expect(out).toContain('"field":"titleKo"');
  });

  it('adds a `app categories` hint to stderr when categoryIds fails validation', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    // `categoryIds: []` triggers the manifest validator's min-length
    // check — an `invalid-config` error whose message references the
    // categoryIds key.
    body.categoryIds = [];
    const manifest = writeManifest(dir, body);
    // Plain-text mode: the hint goes to stderr alongside the raw message.
    const exit = await captureExit(() =>
      runRegister({ json: false, config: manifest }, depsWith()),
    );
    expect(exit?.code).toBe(2);
    expect(stderr.join('')).toContain('aitcc app categories --selectable');
  });

  it('does not leak the category hint into --json stdout', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    body.categoryIds = [];
    const manifest = writeManifest(dir, body);
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, depsWith()));
    expect(exit?.code).toBe(2);
    // JSON payload is unchanged — hint is plain-text only so agent-plugin's
    // parser never has to worry about it.
    expect(stdout.join('')).not.toContain('app categories');
  });

  it('emits image-dimension-mismatch + exit 2 when an image has wrong dimensions', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    writePng(dir, 'logo.png', 512, 512);
    const manifest = writeManifest(dir, body);
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, depsWith()));
    expect(exit?.code).toBe(2);
    const out = stdout.join('');
    expect(out).toContain('"reason":"image-dimension-mismatch"');
    expect(out).toContain('"expected":"600x600"');
    expect(out).toContain('"actual":"512x512"');
  });

  it('emits image-unreadable + exit 2 when a referenced image file is missing', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    // Delete the file that the manifest still references. image-validator
    // raises `unreadable`, which is a distinct --json shape from the
    // dimension-mismatch case so agent-plugin can branch.
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'logo.png'));
    const manifest = writeManifest(dir, body);
    const exit = await captureExit(() => runRegister({ json: true, config: manifest }, depsWith()));
    expect(exit?.code).toBe(2);
    const out = stdout.join('');
    expect(out).toContain('"reason":"image-unreadable"');
    expect(out).toContain('"path"');
  });

  it('emits terms-not-accepted + exit 2 when neither --dry-run nor --accept-terms is set', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    let uploadCalls = 0;
    const exit = await captureExit(() =>
      runRegister(
        { json: true, config: manifest },
        depsWith({
          uploadImpl: async () => {
            uploadCalls += 1;
            return 'https://cdn.example/x.png';
          },
        }),
      ),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"terms-not-accepted"');
    // Critically: no uploads should have happened — the gate runs before
    // the upload loop so users don't burn network on a bounced submit.
    expect(uploadCalls).toBe(0);
  });

  it('--dry-run skips the terms gate and emits the inferred payload without uploading', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    let uploadCalls = 0;
    let submitCalls = 0;
    const exit = await captureExit(() =>
      runRegister(
        { json: true, dryRun: true, config: manifest },
        depsWith({
          uploadImpl: async () => {
            uploadCalls += 1;
            return 'https://cdn.example/x.png';
          },
          submitImpl: async () => {
            submitCalls += 1;
            return { miniAppId: 0, reviewState: 'PENDING', extra: {} };
          },
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    expect(uploadCalls).toBe(0);
    expect(submitCalls).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('"dryRun":true');
    expect(out).toContain('"workspaceId":3095');
    expect(out).toContain('<dry-run:logo>');
  });

  it('emits api-error + exit 17 when the upload fails (status + errorCode exposed)', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { TossApiError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async () => {
            throw new TossApiError(400, 'IMG_TOO_LARGE', 'no', 1);
          },
        }),
      ),
    );
    expect(exit?.code).toBe(17);
    const out = stdout.join('');
    expect(out).toContain('"reason":"api-error"');
    expect(out).toContain('"status":400');
    expect(out).toContain('"errorCode":"IMG_TOO_LARGE"');
  });

  it('emits network-error + exit 11 when the upload has a network failure', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { NetworkError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async () => {
            throw new NetworkError('https://x', new Error('ECONNRESET'));
          },
        }),
      ),
    );
    expect(exit?.code).toBe(11);
    expect(stdout.join('')).toContain('"reason":"network-error"');
  });

  it('emits api-error + exit 17 when the submit itself returns a 400', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { TossApiError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => {
            throw new TossApiError(400, 'INVALID_APP_NAME', 'nope', 1);
          },
        }),
      ),
    );
    expect(exit?.code).toBe(17);
    const out = stdout.join('');
    expect(out).toContain('"reason":"api-error"');
    expect(out).toContain('"errorCode":"INVALID_APP_NAME"');
  });

  it('emits network-error + exit 11 when the submit itself has a network failure', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { NetworkError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => {
            throw new NetworkError('https://submit', new Error('ETIMEDOUT'));
          },
        }),
      ),
    );
    expect(exit?.code).toBe(11);
    expect(stdout.join('')).toContain('"reason":"network-error"');
  });

  it('emits { ok: true, authenticated: false } + exit 10 when the submit sees an auth failure', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const { TossApiError } = await import('../api/http.js');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => {
            throw new TossApiError(401, '4010', 'auth', 1);
          },
        }),
      ),
    );
    expect(exit?.code).toBe(10);
    expect(stdout.join('')).toContain('"authenticated":false');
  });

  it('emits { ok: true, workspaceId, appId, reviewState } + exit 0 on success, and wires manifest fields into the submit payload', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    type UploadCall = { width: number; height: number; fileName: string };
    const uploads: UploadCall[] = [];
    let submitted: ReturnType<typeof JSON.parse> | undefined;
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async (params) => {
            uploads.push({
              width: params.validWidth,
              height: params.validHeight,
              fileName: params.file.fileName,
            });
            return `https://cdn.example/${params.file.fileName}`;
          },
          submitImpl: async (_wid, payload) => {
            submitted = payload;
            return { miniAppId: 123, reviewState: 'PENDING', extra: {} };
          },
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('"ok":true');
    expect(out).toContain('"workspaceId":3095');
    expect(out).toContain('"appId":123');
    expect(out).toContain('"reviewState":"PENDING"');
    expect(out).toContain(
      '"consoleUrl":"https://apps-in-toss.toss.im/console/workspace/3095/mini-app/123"',
    );

    // Upload ordering: logo (600²) → thumbnail (1932×828) → 3× vertical (636×1048).
    expect(uploads).toEqual([
      { width: 600, height: 600, fileName: 'logo.png' },
      { width: 1932, height: 828, fileName: 'thumb.png' },
      { width: 636, height: 1048, fileName: 's1.png' },
      { width: 636, height: 1048, fileName: 's2.png' },
      { width: 636, height: 1048, fileName: 's3.png' },
    ]);
    // End-to-end data flow: manifest fields → correct payload fields.
    expect(submitted?.miniApp?.title).toBe('테스트 앱');
    expect(submitted?.miniApp?.titleEn).toBe('Test App');
    expect(submitted?.miniApp?.appName).toBe('test-app');
    expect(submitted?.miniApp?.iconUri).toBe('https://cdn.example/logo.png');
    expect(submitted?.impression?.categoryIds).toEqual([1]);
  });

  it('honors --workspace override even when the session has no currentWorkspaceId', async () => {
    // No currentWorkspaceId in the session — the override alone should
    // be enough to satisfy resolveWorkspaceContext.
    await writeSessionAt();
    const manifest = writeManifest(dir, validManifestBody(dir));
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, workspace: '9999', config: manifest },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 7, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    expect(stdout.join('')).toContain('"workspaceId":9999');
  });

  it('writes the success line to stdout (not stderr) in human mode', async () => {
    await writeSessionAt(3095);
    const manifest = writeManifest(dir, validManifestBody(dir));
    const exit = await captureExit(() =>
      runRegister(
        { json: false, acceptTerms: true, config: manifest },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 123, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('Registered mini-app 123');
    expect(out).toContain(
      '🔗 console: https://apps-in-toss.toss.im/console/workspace/3095/mini-app/123',
    );
    // stderr carries the context header (PR 1b) and the write-back
    // confirmation (PR 2). Order is fixed: header before submit, write-
    // back after.
    expect(stderr.join('')).toBe(
      `[workspace: 3095 (from session)]\nUpdated ${manifest} with miniAppId: 123.\n`,
    );
  });

  it('writes error diagnostics to stderr (not stdout) in human mode', async () => {
    await writeSessionAt(3095);
    const body = validManifestBody(dir);
    writePng(dir, 'logo.png', 512, 512);
    const manifest = writeManifest(dir, body);
    const exit = await captureExit(() =>
      runRegister({ json: false, acceptTerms: true, config: manifest }, depsWith()),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('512x512');
  });

  // PR 2: yaml write-back on register. The submit handler returns a
  // miniAppId; runRegister persists it back into the discovered project
  // context file so follow-up commands can resolve the same app without
  // an explicit `--app`. Tests pin the four cases the user can hit:
  // file present (gets updated), no file in the tree (stderr hint),
  // --json mode (writes file but suppresses stderr), --dry-run (skipped).

  async function writeProjectFile(name: string, body: string): Promise<string> {
    const { writeFileSync } = await import('node:fs');
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  async function readFileUtf8(path: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
  }

  it('writes miniAppId back to aitcc.yaml when register succeeds (preserves comments)', async () => {
    await writeSessionAt(3095);
    const projectPath = await writeProjectFile(
      'aitcc.yaml',
      '# project context\nworkspaceId: 3095 # community\n',
    );
    // Use a separate manifest path so the project-context file and the
    // manifest file are visibly distinct — write-back must target the
    // project-context file even when --config points elsewhere.
    const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
    const exit = await captureExit(() =>
      runRegister(
        { json: false, acceptTerms: true, config: manifestPath },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    const updated = await readFileUtf8(projectPath);
    expect(updated).toContain('# project context');
    expect(updated).toContain('# community');
    expect(updated).toMatch(/miniAppId:\s+31146/);
    expect(stderr.join('')).toContain(`Updated ${projectPath} with miniAppId: 31146.`);
  });

  it('persists miniAppId silently under --json (no stderr write-back line)', async () => {
    await writeSessionAt(3095);
    const projectPath = await writeProjectFile('aitcc.yaml', 'workspaceId: 3095\n');
    const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifestPath },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    // File is updated…
    expect(await readFileUtf8(projectPath)).toMatch(/miniAppId:\s+31146/);
    // …but stderr stays free of write-back diagnostics. agent-plugin
    // shells out with --json and ignores stderr, but we still keep it
    // clean to avoid log noise.
    expect(stderr.join('')).not.toContain('miniAppId:');
    expect(stderr.join('')).not.toContain('Updated');
  });

  it('emits a stderr hint when no aitcc.yaml exists in the project tree', async () => {
    await writeSessionAt(3095);
    // Create a `.git` marker so findProjectContext halts inside the
    // tmpdir instead of walking up to the umbrella repo's real .git
    // (which might shadow the test with an unrelated aitcc.yaml).
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, '.git'), '');
    const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
    const exit = await captureExit(() =>
      runRegister(
        { json: false, acceptTerms: true, config: manifestPath },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    expect(stderr.join('')).toContain('tip: drop an aitcc.yaml');
    expect(stderr.join('')).toContain('miniAppId: 31146');
  });

  it('does not emit the no-yaml hint under --json', async () => {
    await writeSessionAt(3095);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, '.git'), '');
    const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, acceptTerms: true, config: manifestPath },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    expect(stderr.join('')).not.toContain('tip:');
  });

  it('does not write back during --dry-run', async () => {
    await writeSessionAt(3095);
    const projectPath = await writeProjectFile('aitcc.yaml', 'workspaceId: 3095\n');
    const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
    const exit = await captureExit(() =>
      runRegister(
        { json: true, dryRun: true, config: manifestPath },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    // dry-run returns before the submit/write-back stage; the project
    // file must be untouched.
    expect(await readFileUtf8(projectPath)).toBe('workspaceId: 3095\n');
  });

  it('keeps exit 0 and emits a stderr warning when the project file is read-only', async () => {
    await writeSessionAt(3095);
    const projectPath = await writeProjectFile('aitcc.yaml', 'workspaceId: 3095\n');
    const { chmodSync } = await import('node:fs');
    // chmod 0444 only blocks the open-for-write step on POSIX. Skip on
    // Windows where the test runner ignores chmod and the assertion
    // would not exercise the failure branch.
    if (process.platform === 'win32') return;
    chmodSync(projectPath, 0o444);
    try {
      const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
      const exit = await captureExit(() =>
        runRegister(
          { json: false, acceptTerms: true, config: manifestPath },
          depsWith({
            uploadImpl: async () => 'https://cdn.example/x.png',
            submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
          }),
        ),
      );
      // Submit succeeded → exit stays 0 even though write-back failed.
      expect(exit?.code).toBe(0);
      expect(stderr.join('')).toContain(`warning: could not persist miniAppId to ${projectPath}`);
      // Success line still printed to stdout.
      expect(stdout.join('')).toContain('Registered mini-app 31146');
    } finally {
      chmodSync(projectPath, 0o644);
    }
  });

  it('is a no-op when aitcc.yaml already pins the same miniAppId', async () => {
    await writeSessionAt(3095);
    const original = '# header\nworkspaceId: 3095\nminiAppId: 31146\n';
    const projectPath = await writeProjectFile('aitcc.yaml', original);
    const manifestPath = writeManifest(dir, validManifestBody(dir), 'manifest.json');
    const exit = await captureExit(() =>
      runRegister(
        { json: false, acceptTerms: true, config: manifestPath },
        depsWith({
          uploadImpl: async () => 'https://cdn.example/x.png',
          submitImpl: async () => ({ miniAppId: 31146, reviewState: 'PENDING', extra: {} }),
        }),
      ),
    );
    expect(exit?.code).toBe(0);
    // File untouched, no write-back diagnostic on stderr.
    expect(await readFileUtf8(projectPath)).toBe(original);
    expect(stderr.join('')).not.toContain('Updated');
  });
});
