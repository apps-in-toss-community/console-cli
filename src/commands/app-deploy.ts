import { describeApiError } from '../api/error-messages.js';
import { type FetchLike, NetworkError, TossApiError } from '../api/http.js';
import { fetchConsoleMemberUserInfo, fetchUserTerms } from '../api/me.js';
import {
  postBundleMemo,
  postBundleRelease,
  postBundleReview,
  postDeploymentsComplete,
  postDeploymentsInitialize,
  putBundleToUploadUrl,
} from '../api/mini-apps.js';
import {
  fetchWorkspaceTerms,
  WORKSPACE_TERM_TYPES,
  type WorkspaceTermType,
} from '../api/workspaces.js';
import { AitBundleError, type AitBundleInfo, readAitBundle } from '../config/ait-bundle.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import type { Session } from '../session.js';
import {
  emitFailureFromError,
  emitJson,
  parsePositiveInt,
  printContextHeader,
  requireMiniAppId,
  resolveAppOrFail,
} from './_shared.js';

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
//   dry run (always exit 0 — dry-run never returns a deploy-blocking
//   exit code; the `wouldSucceed` boolean is how callers learn whether
//   a live deploy would clear the same checks):
//     { ok: true, dryRun: true, wouldSucceed,
//       workspaceId, appId, deploymentId,
//       bundleFormat: 'ait' | 'zip', bytes,
//       steps: ['upload', ...], memo: string|null,
//       releaseNotes: string|null, confirmed: boolean,
//       bundle: { path, format, deploymentId, embeddedDeploymentId|null,
//                 deploymentIdSource: 'flag'|'bundle',
//                 flagMatch: boolean|null, size },
//       context: { workspaceId, appId, sessionValid: true,
//                  permissions: { role|null, source: 'members/me'|'unknown',
//                                 error?: string } },
//       terms: { blockers: [{ scope, type, errorCode, title, action }],
//                checked: boolean, error?: string } }              exit 0
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

export async function runDeploy(args: DeployArgs, deps: DeployDeps = {}): Promise<void> {
  // 1. Validate flag shape before reading the bundle / loading the session
  //    so bad invocations fail fast without disk I/O or the Chrome-spawn
  //    detour. `--app`'s presence is now optional (yaml/env can supply it),
  //    but a malformed *value* should still short-circuit before we read
  //    the bundle file — same fast-fail invariant the pre-PR-1b code had.
  //    `resolveAppOrFail` re-parses below; this guard is only here to
  //    reject `--app abc` before the bundle is opened.
  if (typeof args.app === 'string' && args.app !== '' && parsePositiveInt(args.app) === null) {
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

  // 4. Resolve workspace + miniApp (loads session + checks auth). In
  //    dry-run we still do this because the `--json` plan includes
  //    `workspaceId`/`appId` and the agent-plugin parses those fields
  //    unconditionally. `--app` is now optional when `aitcc.yaml` (or
  //    `AITCC_APP`) supplies a `miniAppId`.
  const ctx = await resolveAppOrFail({
    json: args.json,
    appIdRaw: args.app,
    appIdField: 'app',
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
  });
  if (!ctx) return;
  const appId = await requireMiniAppId(ctx, args.json);
  if (appId === null) return;
  printContextHeader(ctx, { json: args.json });
  const { session, workspaceId } = ctx;

  const memo = typeof args.memo === 'string' && args.memo.length > 0 ? args.memo : undefined;
  const steps: DeployStep[] = ['upload'];
  if (requestReview) steps.push('review');
  if (release) steps.push('release');

  if (args.dryRun) {
    return runDryRun({
      json: args.json,
      path: args.path,
      bundleInfo,
      deploymentId,
      explicitDeploymentId: typeof args.deploymentId === 'string' && args.deploymentId !== '',
      workspaceId,
      appId,
      session,
      steps,
      memo,
      releaseNotes,
      confirm,
      fetchImpl: deps.fetchImpl,
    });
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
    const message = describeApiError({
      errorCode: err.errorCode,
      reason: err.reason,
      fallback: err.message,
    });
    if (json) {
      emitJson({
        ok: false,
        reason: 'api-error',
        status: err.status,
        ...(err.errorCode !== undefined ? { errorCode: err.errorCode } : {}),
        message,
        ...progress,
      });
    } else {
      process.stderr.write(`Unexpected error: ${message}\n`);
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

// --- dry-run pre-flight ---------------------------------------------------
//
// `runDryRun` runs the same up-front checks a live `app deploy` does
// (bundle parse + workspace/app/session resolve), then layers on
// read-only network probes (`members/me`, `console-user-terms/me`, the
// five `console-workspace-terms/<type>/skip-permission` buckets) so the
// caller sees every failure that a live deploy would surface — without
// any write happening.
//
// Always exits 0. The `wouldSucceed` boolean tells the caller whether a
// live run would clear the same checks; agent-plugin reads that field
// and reads `terms.blockers` to derive a remediation step. Failure modes
// like "terms fetch errored" are reported as warnings on top of the
// payload, not as exit codes — dry-run is meant to be informational.

// Workspace-term types whose missing-required entries map to a
// terms-family errorCode the live deploy would emit. Mapping is from
// docs/api/_error-codes.md "Auth / 약관 family". `BIZ_WORKSPACE` is the
// one that explicitly gates `app deploy` per docs/api workspaces.md;
// the other types gate adjacent surfaces (login scopes, IAP, IAA,
// promotion money) and we surface them too because (a) they share the
// "must agree before this workspace works" character, and (b) the
// agent-plugin can decide which subset blocks its specific flow.
type DeployStep = 'upload' | 'review' | 'release';

const WORKSPACE_TERM_ERROR_CODES: Record<WorkspaceTermType, number> = {
  TOSS_LOGIN: 4037,
  BIZ_WORKSPACE: 4040,
  TOSS_PROMOTION_MONEY: 4039,
  IAA: 4099,
  IAP: 5001,
};

interface DryRunInput {
  readonly json: boolean;
  readonly path: string;
  readonly bundleInfo: AitBundleInfo;
  readonly deploymentId: string;
  readonly explicitDeploymentId: boolean;
  readonly workspaceId: number;
  readonly appId: number;
  readonly session: Session;
  readonly steps: readonly DeployStep[];
  readonly memo: string | undefined;
  readonly releaseNotes: string | undefined;
  readonly confirm: boolean;
  readonly fetchImpl: FetchLike | undefined;
}

interface PermissionsReport {
  readonly role: string | null;
  readonly source: 'members/me' | 'unknown';
  readonly error?: string;
}

interface TermsBlocker {
  readonly scope: 'user' | 'workspace';
  readonly type: string;
  readonly errorCode: number;
  readonly title: string;
  readonly action: string;
}

interface TermsReport {
  readonly blockers: readonly TermsBlocker[];
  readonly checked: boolean;
  readonly error?: string;
}

async function runDryRun(input: DryRunInput): Promise<void> {
  const apiOpts = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};
  const embedded = input.bundleInfo.deploymentId;
  const flagMatch = input.explicitDeploymentId ? input.deploymentId === embedded : null;

  const [permissions, terms] = await Promise.all([
    fetchPermissions(input.workspaceId, input.session, apiOpts),
    fetchTermsBlockers(input.workspaceId, input.session, apiOpts),
  ]);

  const wouldSucceed = (flagMatch === null || flagMatch === true) && terms.blockers.length === 0;

  if (input.json) {
    emitJson({
      ok: true,
      dryRun: true,
      wouldSucceed,
      // Top-level fields kept for backwards compatibility with the
      // pre-enhancement --json shape (agent-plugin and existing
      // consumers reach for `workspaceId`/`appId`/`deploymentId`/etc
      // directly, not the nested `context`/`bundle` blocks).
      workspaceId: input.workspaceId,
      appId: input.appId,
      deploymentId: input.deploymentId,
      bundleFormat: input.bundleInfo.format,
      bytes: input.bundleInfo.bytes.byteLength,
      steps: input.steps,
      memo: input.memo ?? null,
      releaseNotes: input.releaseNotes ?? null,
      confirmed: input.confirm,
      bundle: {
        path: input.path,
        format: input.bundleInfo.format,
        deploymentId: input.deploymentId,
        embeddedDeploymentId: embedded,
        deploymentIdSource: input.explicitDeploymentId ? 'flag' : 'bundle',
        flagMatch,
        size: input.bundleInfo.bytes.byteLength,
      },
      context: {
        workspaceId: input.workspaceId,
        appId: input.appId,
        sessionValid: true,
        permissions,
      },
      terms,
    });
    return exitAfterFlush(ExitCode.Ok);
  }

  process.stdout.write(
    renderDryRunText(input, { embedded, flagMatch, permissions, terms, wouldSucceed }),
  );
  return exitAfterFlush(ExitCode.Ok);
}

async function fetchPermissions(
  workspaceId: number,
  session: Session,
  apiOpts: { fetchImpl?: FetchLike },
): Promise<PermissionsReport> {
  // Best-effort: a non-fatal failure here just means we render
  // `permissions: unknown` and live deploy would still try. We do NOT
  // map a 401 here to a session-expired exit — it would mask the rest
  // of the dry-run report. The user runs `aitcc whoami` to investigate.
  try {
    const info = await fetchConsoleMemberUserInfo(session.cookies, apiOpts);
    const ws = info.workspaces.find((w) => w.workspaceId === workspaceId);
    if (!ws) {
      return {
        role: null,
        source: 'unknown',
        error: `current user has no membership in workspace ${workspaceId}`,
      };
    }
    return { role: ws.role, source: 'members/me' };
  } catch (err) {
    return { role: null, source: 'unknown', error: (err as Error).message };
  }
}

async function fetchTermsBlockers(
  workspaceId: number,
  session: Session,
  apiOpts: { fetchImpl?: FetchLike },
): Promise<TermsReport> {
  // We fetch user-terms (account-level — 4032/4036 family) and every
  // workspace-terms bucket in parallel. Any single failure flips the
  // whole report into "checked: false" with a warning — partial term
  // results would mislead the wouldSucceed gate (a missing bucket
  // could hide a blocker), so we treat the surface as all-or-nothing.
  // Split the heterogeneous fetches into two homogeneous Promise.all
  // groups so TS can infer each tuple slot precisely (a single mixed
  // spread collapses everything to a union and forces casts at the use
  // sites).
  try {
    const [userTerms, workspaceResults] = await Promise.all([
      fetchUserTerms(session.cookies, apiOpts),
      Promise.all(
        WORKSPACE_TERM_TYPES.map(
          async (t) =>
            [t, await fetchWorkspaceTerms(workspaceId, t, session.cookies, apiOpts)] as const,
        ),
      ),
    ]);

    const blockers: TermsBlocker[] = [];
    for (const t of userTerms) {
      if (t.required && !t.isAgreed) {
        blockers.push({
          scope: 'user',
          type: 'USER_TERMS',
          // 4036 (유저_약관_미동의) is the consistent code; 4032
          // (앱인토스_미가입) only fires when the account itself is
          // unregistered, which we'd hit at session capture rather
          // than in this surface.
          errorCode: 4036,
          title: t.title,
          action: 'aitcc me terms',
        });
      }
    }
    for (const [type, terms] of workspaceResults) {
      for (const t of terms) {
        if (!t.required || t.isAgreed) continue;
        blockers.push({
          scope: 'workspace',
          type,
          errorCode: WORKSPACE_TERM_ERROR_CODES[type],
          title: t.title,
          action: `aitcc workspace terms --type ${type}`,
        });
      }
    }
    return { blockers, checked: true };
  } catch (err) {
    return { blockers: [], checked: false, error: (err as Error).message };
  }
}

function renderDryRunText(
  input: DryRunInput,
  derived: {
    embedded: string;
    flagMatch: boolean | null;
    permissions: PermissionsReport;
    terms: TermsReport;
    wouldSucceed: boolean;
  },
): string {
  const lines: string[] = [];
  lines.push(`DRY RUN — app deploy ${input.appId}\n`);

  // Bundle section
  lines.push('\nBundle\n');
  lines.push(`  path          ${input.path}\n`);
  lines.push(`  format        ${input.bundleInfo.format.toUpperCase()}\n`);
  lines.push(`  deploymentId  ${input.deploymentId}\n`);
  if (derived.flagMatch === false) {
    lines.push(`  flag match    MISMATCH (bundle embeds ${derived.embedded})\n`);
  } else if (derived.flagMatch === true) {
    lines.push(`  flag match    ok (matches embedded)\n`);
  }
  lines.push(`  size          ${formatBytes(input.bundleInfo.bytes.byteLength)}\n`);

  // Context section
  lines.push('\nContext\n');
  lines.push(`  workspace     ${input.workspaceId}\n`);
  lines.push(`  app           ${input.appId}\n`);
  lines.push(`  session       valid\n`);
  if (derived.permissions.role !== null) {
    lines.push(`  permissions   ${derived.permissions.role}\n`);
  } else {
    lines.push(
      `  permissions   unknown${derived.permissions.error ? ` (${derived.permissions.error})` : ''}\n`,
    );
  }

  // Terms section
  lines.push('\nTerms\n');
  if (!derived.terms.checked) {
    lines.push(
      `  warning: could not check terms status (${derived.terms.error ?? 'unknown error'}).\n`,
    );
    lines.push(
      '  live deploy may still fail with a 4032/4036/4037/4039/4040/4099/5001 errorCode.\n',
    );
  } else if (derived.terms.blockers.length === 0) {
    lines.push('  all deploy-related terms are agreed\n');
  } else {
    for (const b of derived.terms.blockers) {
      lines.push(
        `  blocked: ${b.scope}/${b.type} — ${b.title} (errorCode ${b.errorCode})\n` +
          `    action: ${b.action}\n`,
      );
    }
  }

  // Steps + memo (kept from the pre-enhancement output so existing
  // operators reading the dry-run still see the planned pipeline).
  lines.push('\nPlan\n');
  const stepsLine = input.steps
    .map((s) => {
      if (s === 'review')
        return `review (releaseNotes: ${JSON.stringify(input.releaseNotes ?? '')})`;
      if (s === 'release') return `release (${input.confirm ? 'confirmed' : 'NOT confirmed'})`;
      return s;
    })
    .join(' → ');
  lines.push(`  steps         ${stepsLine}\n`);
  lines.push(`  memo          ${input.memo ?? '(none)'}\n`);

  // Result. `wouldSucceed` is the gated bundle/terms/flag-match check —
  // it intentionally does NOT factor in `permissions.role === null` (the
  // server is the authority on membership and the live deploy would
  // surface a precise error). Surface that caveat in the human-readable
  // line so an operator who skipped reading the Context block above
  // doesn't read "all clear" and then get a server failure.
  lines.push('\nResult\n');
  if (!derived.wouldSucceed) {
    lines.push('  Live deploy would fail. Resolve the blocked items above, then re-run.\n');
  } else if (derived.permissions.role === null) {
    lines.push(
      '  Live deploy would clear bundle + terms checks. Workspace membership could not be confirmed; live deploy may still fail with a permissions error.\n',
    );
  } else {
    lines.push('  Live deploy would clear every pre-flight check.\n');
  }
  return lines.join('');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
