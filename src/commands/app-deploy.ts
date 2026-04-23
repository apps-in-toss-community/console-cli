import { type FetchLike, NetworkError, TossApiError } from '../api/http.js';
import {
  postBundleMemo,
  postBundleRelease,
  postBundleReview,
  postDeploymentsComplete,
  postDeploymentsInitialize,
  putBundleToUploadUrl,
} from '../api/mini-apps.js';
import { AitBundleError, type AitBundleInfo, readAitBundle } from '../config/ait-bundle.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { emitFailureFromError, emitJson, resolveWorkspaceContext } from './_shared.js';

// `runDeploy` is the testable seam for `aitcc app deploy`. The citty
// wrapper in `app.ts` is a thin shim; tests pass a fake `fetchImpl` and
// override the bundle reader to pin each `--json` branch without
// spawning a subprocess.
//
// --json contract (consumed by agent-plugin):
//
//   success (all requested steps completed):
//     { ok: true, workspaceId, appId, deploymentId,
//       bundleFormat: 'ait' | 'zip',
//       uploaded: true, reviewed: boolean, released: boolean,
//       bundle: { ... } | null,
//       reviewResult: { ... } | null,
//       releaseResult: { ... } | null }                            exit 0
//
//   dry run:
//     { ok: true, dryRun: true, workspaceId, appId, deploymentId,
//       bundleFormat: 'ait' | 'zip', bytes,
//       steps: ['upload', ...], memo: string|null,
//       releaseNotes: string|null, confirmed: boolean }            exit 0
//
//   usage errors:
//     { ok: false, reason: 'missing-app-id' | 'invalid-id'
//                         | 'missing-path' | 'invalid-bundle'
//                         | 'missing-release-notes' | 'not-confirmed'
//                         | 'bundle-not-prepare' | 'file-unreadable',
//       ... }                                                       exit 2
//
//   partial-success failures (keeps agent-plugin informed so it can
//   retry downstream steps without re-uploading):
//     { ok: false, uploaded: true, reviewed: false,
//       reason: 'api-error', status?, errorCode?, message }         exit 17
//     { ok: false, uploaded: true, reviewed: true, released: false,
//       reason: 'api-error', ... }                                  exit 17
//
//   Standard auth/network follow the shared contract from _shared.ts
//   (ok:true authenticated:false exit 10, network-error exit 11,
//    api-error exit 17).
//
// --release note: the server requires the bundle to be in APPROVED state
// before `/bundles/release` succeeds. In practice that means users run
// this command twice: once with `--request-review` (bundle uploaded and
// queued), then again days later with `--release --confirm` after the
// review landed. Running upload + review + release in one shot only
// works if the reviewer was already asked to auto-approve, which is
// rare — we document rather than enforce, since a future auto-approved
// workspace flow could legitimately chain all three.

export interface DeployArgs {
  readonly path: string;
  readonly app: string | undefined;
  readonly deploymentId?: string | undefined;
  readonly memo?: string | undefined;
  readonly requestReview?: boolean | undefined;
  readonly releaseNotes?: string | undefined;
  readonly release?: boolean | undefined;
  readonly confirm?: boolean | undefined;
  readonly workspace?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly json: boolean;
}

export interface DeployDeps {
  readonly fetchImpl?: FetchLike;
  readonly readBundleImpl?: (path: string) => Promise<AitBundleInfo>;
}

function parseAppIdStrict(raw: string): number | null {
  if (raw === '') return null;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export async function runDeploy(args: DeployArgs, deps: DeployDeps = {}): Promise<void> {
  // 1. Validate flag shape before loading the session so bad invocations
  //    fail fast without the Chrome-spawn detour in case the user is not
  //    logged in. Matches `app bundles upload`'s early-exit pattern.
  if (typeof args.app !== 'string' || args.app === '') {
    if (args.json) {
      emitJson({
        ok: false,
        reason: 'missing-app-id',
        message: '--app <id> is required',
      });
    } else {
      process.stderr.write('app deploy: --app <id> is required.\n');
    }
    return exitAfterFlush(ExitCode.Usage);
  }
  const appId = parseAppIdStrict(args.app);
  if (appId === null) {
    if (args.json) {
      emitJson({
        ok: false,
        reason: 'invalid-id',
        message: `--app must be a positive integer (got ${JSON.stringify(args.app)})`,
      });
    } else {
      process.stderr.write(`app deploy: invalid --app ${JSON.stringify(args.app)}\n`);
    }
    return exitAfterFlush(ExitCode.Usage);
  }

  if (typeof args.path !== 'string' || args.path === '') {
    if (args.json) {
      emitJson({ ok: false, reason: 'missing-path', message: 'path to .ait bundle is required' });
    } else {
      process.stderr.write('app deploy: path to .ait bundle is required.\n');
    }
    return exitAfterFlush(ExitCode.Usage);
  }

  const requestReview = Boolean(args.requestReview);
  const release = Boolean(args.release);
  const confirm = Boolean(args.confirm);
  const releaseNotes = typeof args.releaseNotes === 'string' ? args.releaseNotes : undefined;

  if (requestReview && releaseNotes === undefined) {
    if (args.json) {
      emitJson({
        ok: false,
        reason: 'missing-release-notes',
        message: '--release-notes <text> is required with --request-review',
      });
    } else {
      process.stderr.write(
        'app deploy: --release-notes <text> is required with --request-review.\n',
      );
    }
    return exitAfterFlush(ExitCode.Usage);
  }

  if (release && !confirm) {
    if (args.json) {
      emitJson({
        ok: false,
        reason: 'not-confirmed',
        message: '--release is destructive; pass --confirm to proceed',
      });
    } else {
      process.stderr.write(
        'app deploy: --release publishes the bundle to end users.\n' +
          '  Re-run with --confirm to proceed.\n',
      );
    }
    return exitAfterFlush(ExitCode.Usage);
  }

  // 2. Read the bundle. In dry-run mode we still read it so the plan we
  //    print matches what a real run would do (bytes count, embedded
  //    deploymentId).
  const readBundle = deps.readBundleImpl ?? readAitBundle;
  let bundleInfo: AitBundleInfo;
  try {
    bundleInfo = await readBundle(args.path);
  } catch (err) {
    if (err instanceof AitBundleError) {
      const reason = err.reason === 'file-unreadable' ? 'file-unreadable' : 'invalid-bundle';
      if (args.json) {
        emitJson({
          ok: false,
          reason,
          path: err.path,
          bundleReason: err.reason,
          message: err.message,
        });
      } else {
        process.stderr.write(`app deploy: ${err.message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    throw err;
  }

  // 3. If --deployment-id was passed explicitly, use it verbatim (the
  //    bundle's embedded id is still useful for the plan output but does
  //    not override). This matches `app bundles upload`'s flag
  //    semantics; the wrapper's convenience is auto-detect, not
  //    override.
  const deploymentId =
    typeof args.deploymentId === 'string' && args.deploymentId !== ''
      ? args.deploymentId
      : bundleInfo.deploymentId;
  if (deploymentId === '') {
    // Defensive: readAitBundle throws when the id is empty, but a
    // caller-provided impl could return one. Surface as invalid-bundle
    // so the agent-plugin error branch is consistent.
    if (args.json) {
      emitJson({
        ok: false,
        reason: 'invalid-bundle',
        path: args.path,
        message: 'deploymentId is empty',
      });
    } else {
      process.stderr.write('app deploy: deploymentId is empty.\n');
    }
    return exitAfterFlush(ExitCode.Usage);
  }

  // 4. Resolve workspace (loads session + checks auth). In dry-run we
  //    still do this because the `--json` plan includes `workspaceId`
  //    and the agent-plugin parses that field unconditionally.
  const ctx = await resolveWorkspaceContext(args);
  if (!ctx) return;
  const { session, workspaceId } = ctx;

  const memo = typeof args.memo === 'string' && args.memo.length > 0 ? args.memo : undefined;
  const steps: string[] = ['upload'];
  if (requestReview) steps.push('review');
  if (release) steps.push('release');

  if (args.dryRun) {
    if (args.json) {
      emitJson({
        ok: true,
        dryRun: true,
        workspaceId,
        appId,
        deploymentId,
        bundleFormat: bundleInfo.format,
        bytes: bundleInfo.bytes.byteLength,
        steps,
        memo: memo ?? null,
        releaseNotes: releaseNotes ?? null,
        confirmed: confirm,
      });
    } else {
      const stepsLine = steps
        .map((s) => {
          if (s === 'review') return `review (releaseNotes: ${JSON.stringify(releaseNotes ?? '')})`;
          if (s === 'release') return `release (${confirm ? 'confirmed' : 'NOT confirmed'})`;
          return s;
        })
        .join(' → ');
      process.stdout.write(
        `DRY RUN\n` +
          `  app           ${appId}\n` +
          `  workspace     ${workspaceId}\n` +
          `  bundle        ${args.path} (${bundleInfo.bytes.byteLength} bytes)\n` +
          `  deploymentId  ${deploymentId}\n` +
          `  memo          ${memo ?? '(none)'}\n` +
          `  steps         ${stepsLine}\n`,
      );
    }
    return exitAfterFlush(ExitCode.Ok);
  }

  // 5. Real execution. Each step tracks its success so a partial
  //    failure downstream can report which earlier steps already ran.
  const apiOpts = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  let uploaded = false;
  let bundleRecord: Readonly<Record<string, unknown>> | null = null;
  let reviewed = false;
  let reviewResult: Readonly<Record<string, unknown>> | null = null;

  try {
    const init = await postDeploymentsInitialize(
      workspaceId,
      appId,
      deploymentId,
      session.cookies,
      apiOpts,
    );
    if (init.reviewStatus !== 'PREPARE') {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'bundle-not-prepare',
          workspaceId,
          appId,
          deploymentId,
          reviewStatus: init.reviewStatus,
          message: '이미 존재하는 버전이에요.',
        });
      } else {
        process.stderr.write(
          `app deploy: deployment ${deploymentId} is already in state ${init.reviewStatus}; upload refused.\n`,
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    await putBundleToUploadUrl(init.uploadUrl, bundleInfo.bytes, apiOpts);
    bundleRecord = await postDeploymentsComplete(
      workspaceId,
      appId,
      deploymentId,
      session.cookies,
      apiOpts,
    );
    if (memo !== undefined) {
      await postBundleMemo(workspaceId, appId, deploymentId, memo, session.cookies, apiOpts);
    }
    uploaded = true;
  } catch (err) {
    // Upload failure — nothing downstream ran, so the shared dispatcher
    // is fine; partial-success reporting kicks in only once
    // `uploaded === true`.
    return emitFailureFromError(args.json, err);
  }

  if (requestReview) {
    try {
      reviewResult = await postBundleReview(
        {
          workspaceId,
          miniAppId: appId,
          deploymentId,
          releaseNotes: releaseNotes ?? '',
        },
        session.cookies,
        apiOpts,
      );
      reviewed = true;
    } catch (err) {
      return emitPartialFailure(args.json, err, {
        workspaceId,
        appId,
        deploymentId,
        uploaded: true,
        reviewed: false,
        released: false,
      });
    }
  }

  let releaseResult: Readonly<Record<string, unknown>> | null = null;
  if (release) {
    try {
      releaseResult = await postBundleRelease(
        { workspaceId, miniAppId: appId, deploymentId },
        session.cookies,
        apiOpts,
      );
    } catch (err) {
      return emitPartialFailure(args.json, err, {
        workspaceId,
        appId,
        deploymentId,
        uploaded: true,
        reviewed,
        released: false,
      });
    }
  }

  if (args.json) {
    emitJson({
      ok: true,
      workspaceId,
      appId,
      deploymentId,
      bundleFormat: bundleInfo.format,
      uploaded,
      reviewed,
      released: release,
      bundle: bundleRecord,
      reviewResult,
      releaseResult,
    });
    return exitAfterFlush(ExitCode.Ok);
  }

  process.stdout.write(
    `Deployed bundle for app ${appId} (ws ${workspaceId})\n` +
      `  deploymentId ${deploymentId}\n` +
      `  bytes        ${bundleInfo.bytes.byteLength}\n` +
      `  steps        ${steps.join(' → ')}\n`,
  );
  return exitAfterFlush(ExitCode.Ok);
}

/**
 * Partial-failure emitter. The upload succeeded (so the user does NOT
 * need to re-upload on retry) but a downstream step failed. Keeping the
 * `uploaded: true` bit in the JSON lets agent-plugin skip to the
 * specific failing step on retry instead of re-running the whole
 * pipeline.
 */
async function emitPartialFailure(
  json: boolean,
  err: unknown,
  progress: {
    workspaceId: number;
    appId: number;
    deploymentId: string;
    uploaded: boolean;
    reviewed: boolean;
    released: boolean;
  },
): Promise<void> {
  if (err instanceof TossApiError && err.isAuthError) {
    if (json) {
      emitJson({
        ok: true,
        authenticated: false,
        reason: 'session-expired',
        ...progress,
      });
    } else {
      process.stderr.write('Session is no longer valid. Run `aitcc login` again.\n');
    }
    return exitAfterFlush(ExitCode.NotAuthenticated);
  }
  if (err instanceof TossApiError) {
    if (json) {
      emitJson({
        ok: false,
        reason: 'api-error',
        status: err.status,
        ...(err.errorCode !== undefined ? { errorCode: err.errorCode } : {}),
        message: err.message,
        ...progress,
      });
    } else {
      process.stderr.write(`Unexpected error: ${err.message}\n`);
    }
    return exitAfterFlush(ExitCode.ApiError);
  }
  if (err instanceof NetworkError) {
    if (json) {
      emitJson({
        ok: false,
        reason: 'network-error',
        message: err.message,
        ...progress,
      });
    } else {
      process.stderr.write(`Network error reaching the console API: ${err.message}.\n`);
    }
    return exitAfterFlush(ExitCode.NetworkError);
  }
  if (json) {
    emitJson({
      ok: false,
      reason: 'api-error',
      message: (err as Error).message,
      ...progress,
    });
  } else {
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
  }
  return exitAfterFlush(ExitCode.ApiError);
}
