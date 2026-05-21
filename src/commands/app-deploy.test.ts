import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../api/http.js';
import type { CdpCookie } from '../cdp.js';
import type { AitBundleInfo } from '../config/ait-bundle.js';
import { runDeploy } from './app-deploy.js';

// Mirrors the captureExit/stdout-spy pattern used in register.test.ts.
//
// Dry-run intentionally hits read-only endpoints (members/me + the term
// buckets) so the spec can report context/permissions/blockers ahead of
// a live deploy. To keep the tests offline we wire a minimal stub fetch
// that recognizes the URL shapes touched by `runDryRun` and returns
// canned `SUCCESS` envelopes. Any URL outside that allowlist throws so
// a regression that adds a new write endpoint is loud — same intent the
// pre-enhancement `loudFetch` had, just narrowed to writes.

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ resultType: 'SUCCESS', success: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface DryRunStubOptions {
  /** Workspace id the test session points at. Must match for permissions to resolve. */
  workspaceId: number;
  /** Role surfaced by `members/me`. `null` removes the membership entry. */
  role?: string | null;
  /** Per-type workspace term overrides. Default: every bucket returns []. */
  workspaceTerms?: Partial<Record<string, ReadonlyArray<unknown>>>;
  /** User-terms override. Default: []. */
  userTerms?: ReadonlyArray<unknown>;
  /** Throw on every fetch — used for the "terms fetch failed → warning" branch. */
  failAll?: boolean;
}

function makeDryRunStub(options: DryRunStubOptions): {
  fetchImpl: FetchLike;
  writeCalls: () => string[];
} {
  const writes: string[] = [];
  const role = options.role === undefined ? 'OWNER' : options.role;

  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method !== 'GET') {
      // Dry-run must never write. Capture the offender so the failing
      // assertion can name it.
      writes.push(`${method} ${url}`);
      throw new Error(`dry-run made a write call: ${method} ${url}`);
    }
    if (options.failAll) throw new Error('network down');

    if (url.endsWith('/members/me/user-info')) {
      const workspaces =
        role === null
          ? []
          : [
              {
                workspaceId: options.workspaceId,
                workspaceName: 'test-ws',
                role,
                isOwnerDelegationRequested: false,
              },
            ];
      return jsonResponse({
        id: 1,
        bizUserNo: 1,
        name: 'tester',
        email: 'a@b.co',
        role: 'USER',
        workspaces,
        isAdult: true,
        isOverseasBusiness: false,
      });
    }
    if (url.endsWith('/console-user-terms/me')) {
      return jsonResponse(options.userTerms ?? []);
    }
    const wsTermsMatch = url.match(/console-workspace-terms\/([A-Z_]+)\/skip-permission/);
    if (wsTermsMatch) {
      const type = wsTermsMatch[1] as string;
      return jsonResponse(options.workspaceTerms?.[type] ?? []);
    }
    throw new Error(`unmocked URL in dry-run test: ${url}`);
  };

  return { fetchImpl, writeCalls: () => writes };
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

  // Fix #3: an empty or whitespace-only --release-notes used to bypass the
  // "release notes required" guard because the check was `=== undefined`.
  it('emits missing-release-notes + exit 2 when --release-notes is an empty string', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy(
        { path, app: '29397', requestReview: true, releaseNotes: '', json: true },
        { fetchImpl: loudFetch },
      ),
    );
    expect(exit?.code).toBe(2);
    expect(stdout.join('')).toContain('"reason":"missing-release-notes"');
    expect(fetchCalls).toBe(0);
  });

  it('emits missing-release-notes + exit 2 when --release-notes is whitespace only', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const exit = await captureExit(() =>
      runDeploy(
        { path, app: '29397', requestReview: true, releaseNotes: '   ', json: true },
        { fetchImpl: loudFetch },
      ),
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

  it('--dry-run reports the planned pipeline + clean pre-flight when terms agreed', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, '00000000-0000-0000-0000-000000000001');
    const stub = makeDryRunStub({ workspaceId: 3095 });
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
        { fetchImpl: stub.fetchImpl },
      ),
    );
    expect(exit?.code).toBe(0);
    expect(stub.writeCalls()).toEqual([]);
    const out = stdout.join('');
    // Single-line JSON contract preserved.
    expect(out.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      ok: true,
      dryRun: true,
      wouldSucceed: true,
      workspaceId: 3095,
      appId: 29397,
      deploymentId: '00000000-0000-0000-0000-000000000001',
      steps: ['upload', 'review', 'release'],
      memo: 'pre-flight',
      releaseNotes: 'initial release',
      confirmed: true,
    });
    expect(parsed.bundle).toMatchObject({
      path,
      format: 'zip',
      deploymentId: '00000000-0000-0000-0000-000000000001',
      embeddedDeploymentId: '00000000-0000-0000-0000-000000000001',
      deploymentIdSource: 'bundle',
      flagMatch: null,
    });
    expect(parsed.context.permissions).toEqual({ role: 'OWNER', source: 'members/me' });
    expect(parsed.terms).toEqual({ blockers: [], checked: true });
  });

  it('--dry-run reports flag-vs-embedded mismatch and flips wouldSucceed to false', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'from-bundle');
    const stub = makeDryRunStub({ workspaceId: 3095 });
    const exit = await captureExit(() =>
      runDeploy(
        {
          path,
          app: '29397',
          deploymentId: 'from-flag',
          dryRun: true,
          json: true,
        },
        { fetchImpl: stub.fetchImpl },
      ),
    );
    expect(exit?.code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.deploymentId).toBe('from-flag');
    expect(parsed.bundle.deploymentIdSource).toBe('flag');
    expect(parsed.bundle.flagMatch).toBe(false);
    expect(parsed.bundle.embeddedDeploymentId).toBe('from-bundle');
    expect(parsed.wouldSucceed).toBe(false);
  });

  it('--dry-run lists workspace term blockers when a required term is unagreed', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const stub = makeDryRunStub({
      workspaceId: 3095,
      workspaceTerms: {
        BIZ_WORKSPACE: [
          {
            required: true,
            termsId: 1,
            revisionId: 1,
            title: '워크스페이스 약관',
            contentsUrl: 'https://example.com/terms',
            actionType: 'AGREE',
            isAgreed: false,
            isOneTimeConsent: false,
          },
        ],
      },
    });
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: true }, { fetchImpl: stub.fetchImpl }),
    );
    expect(exit?.code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.wouldSucceed).toBe(false);
    expect(parsed.terms.checked).toBe(true);
    expect(parsed.terms.blockers).toEqual([
      {
        scope: 'workspace',
        type: 'BIZ_WORKSPACE',
        errorCode: 4040,
        title: '워크스페이스 약관',
        action: 'aitcc workspace terms agree BIZ_WORKSPACE',
      },
    ]);
  });

  it('--dry-run lists user-term blockers (4036 family)', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const stub = makeDryRunStub({
      workspaceId: 3095,
      userTerms: [
        {
          required: true,
          termsId: 9,
          revisionId: 1,
          title: '개인정보 처리 방침',
          contentsUrl: 'https://example.com/privacy',
          actionType: 'AGREE',
          isAgreed: false,
          isOneTimeConsent: false,
        },
      ],
    });
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: true }, { fetchImpl: stub.fetchImpl }),
    );
    expect(exit?.code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.wouldSucceed).toBe(false);
    expect(parsed.terms.blockers).toEqual([
      {
        scope: 'user',
        type: 'USER_TERMS',
        errorCode: 4036,
        title: '개인정보 처리 방침',
        action: 'aitcc me terms',
      },
    ]);
  });

  it('--dry-run treats terms-fetch failure as a warning, not an exit code', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const stub = makeDryRunStub({ workspaceId: 3095, failAll: true });
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: true }, { fetchImpl: stub.fetchImpl }),
    );
    expect(exit?.code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    // Both probes failed: permissions falls back to 'unknown', terms
    // marks itself as not-checked. wouldSucceed stays true because the
    // bundle/context checks (which gate live deploy) all passed.
    expect(parsed.context.permissions).toMatchObject({ role: null, source: 'unknown' });
    expect(parsed.terms.checked).toBe(false);
    expect(typeof parsed.terms.error).toBe('string');
    expect(parsed.wouldSucceed).toBe(true);
  });

  it('--dry-run marks permissions unknown when membership is missing', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-123');
    const stub = makeDryRunStub({ workspaceId: 3095, role: null });
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: true }, { fetchImpl: stub.fetchImpl }),
    );
    expect(exit?.code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.context.permissions).toMatchObject({ role: null, source: 'unknown' });
    expect(typeof parsed.context.permissions.error).toBe('string');
    // wouldSucceed stays true intentionally — the bundle/terms checks
    // (which gate live deploy) all passed, and the server is the
    // authority on workspace membership. The plaintext rendering carries
    // the caveat (covered by the next test).
    expect(parsed.wouldSucceed).toBe(true);
  });

  it('--dry-run plaintext result line carries a caveat when membership is missing', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-no-member');
    const stub = makeDryRunStub({ workspaceId: 3095, role: null });
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: false }, { fetchImpl: stub.fetchImpl }),
    );
    expect(exit?.code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('permissions   unknown');
    // Operator-facing line must NOT claim "all clear" when membership
    // could not be confirmed — that would mask a server-side
    // permissions failure that the live deploy would hit.
    expect(out).not.toContain('Live deploy would clear every pre-flight check.');
    expect(out).toContain('membership could not be confirmed');
  });

  it('--dry-run plaintext mode renders the structured report', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-abc');
    const stub = makeDryRunStub({ workspaceId: 3095 });
    const exit = await captureExit(() =>
      runDeploy({ path, app: '29397', dryRun: true, json: false }, { fetchImpl: stub.fetchImpl }),
    );
    expect(exit?.code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('DRY RUN — app deploy 29397');
    expect(out).toContain('Bundle');
    expect(out).toContain('deploymentId  dep-abc');
    expect(out).toContain('Context');
    expect(out).toContain('workspace     3095');
    expect(out).toContain('permissions   OWNER');
    expect(out).toContain('Terms');
    expect(out).toContain('all deploy-related terms are agreed');
    expect(out).toContain('Result');
    expect(out).toContain('Live deploy would clear every pre-flight check.');
  });

  it('--dry-run never makes write calls (POST/PUT/DELETE)', async () => {
    await writeSessionAt(3095);
    const path = writeBundleFile(root, 'dep-no-writes');
    const stub = makeDryRunStub({ workspaceId: 3095 });
    const exit = await captureExit(() =>
      runDeploy(
        {
          path,
          app: '29397',
          dryRun: true,
          requestReview: true,
          releaseNotes: 'x',
          release: true,
          confirm: true,
          json: true,
        },
        { fetchImpl: stub.fetchImpl },
      ),
    );
    expect(exit?.code).toBe(0);
    expect(stub.writeCalls()).toEqual([]);
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

  it('partial-failure: emits ok:false (not ok:true) when session expires after upload succeeds', async () => {
    // Regression test for the session-expired partial-failure shape fix.
    // The upload step succeeds; `--request-review` then hits a 401 → the
    // emitter must emit `ok: false` (not `ok: true`) so consumers can
    // distinguish a failed partial deploy from a fully-succeeded one.
    await writeSessionAt(3095);

    const fakeBundle: AitBundleInfo = {
      format: 'ait',
      deploymentId: 'test-dep-id',
      bytes: new Uint8Array(4),
    };

    const stubFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      // Initialize deploy → succeed (deployment.reviewStatus must be 'PREPARE')
      if (url.includes('/deployments/initialize')) {
        return new Response(
          JSON.stringify({
            resultType: 'SUCCESS',
            success: {
              uploadUrl: 'https://upload.example.com/put',
              deployment: { reviewStatus: 'PREPARE' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // S3-style PUT upload → succeed
      if (url.includes('upload.example.com')) {
        return new Response(null, { status: 200 });
      }
      // deployments/complete → succeed
      if (url.includes('/deployments/complete')) {
        return new Response(
          JSON.stringify({ resultType: 'SUCCESS', success: { deploymentId: 'test-dep-id' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // bundles/reviews → 401 auth error (session expired mid-flight after upload).
      // Must be a Toss envelope FAILURE (not a thrown error) so the http layer
      // converts it to a TossApiError with isAuthError === true.
      if (url.includes('/bundles/reviews')) {
        return new Response(
          JSON.stringify({
            resultType: 'FAILURE',
            error: { errorCode: '4010', reason: 'Unauthorized', errorType: 0 },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unmocked URL: ${url}`);
    };

    const exit = await captureExit(() =>
      runDeploy(
        {
          path: '/fake/bundle.ait',
          app: '29397',
          requestReview: true,
          releaseNotes: 'v1',
          json: true,
        },
        {
          fetchImpl: stubFetch,
          readBundleImpl: async () => fakeBundle,
        },
      ),
    );

    expect(exit?.code).toBe(10);
    const parsed = JSON.parse(stdout.join(''));
    // Must be false — uploading succeeded but the review step did NOT.
    expect(parsed.ok).toBe(false);
    expect(parsed.authenticated).toBe(false);
    expect(parsed.reason).toBe('session-expired');
    expect(parsed.uploaded).toBe(true);
    expect(parsed.reviewed).toBe(false);
  });
});
