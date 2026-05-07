import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type CreateMiniAppResult,
  createMiniApp,
  type UploadParams,
  uploadMiniAppResource,
} from '../api/mini-apps.js';
import type { CdpCookie } from '../cdp.js';
import {
  type AppManifest,
  loadAppManifest,
  ManifestError,
  resolveManifestPath,
} from '../config/app-manifest.js';
import {
  DIMENSIONS,
  ImageDimensionError,
  validateImageDimensions,
} from '../config/image-validator.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitFailureFromError,
  emitJson,
  printContextHeader,
  resolveWorkspaceContext,
} from './_shared.js';
import { buildSubmitPayload, type UploadedImageUrls } from './register-payload.js';

// `runRegister` is the testable seam for `aitcc app register`. The public
// command (defined in `app.ts`) is a thin citty wrapper that supplies the
// real `uploadMiniAppResource` and `createMiniApp` implementations;
// tests pass stubs so each branch of the documented `--json` contract
// gets pinned byte-for-byte without spawning a subprocess.
//
// --json contract (consumed by agent-plugin):
//
//   success:
//     { ok: true, workspaceId, appId, reviewState, consoleUrl }            exit 0
//     consoleUrl:
//       https://apps-in-toss.toss.im/console/workspace/<wid>/mini-app/<id>
//       (null when the server response omitted miniAppId)
//
//   failures:
//     { ok: false, reason: 'no-workspace-selected' }                        exit 2
//     { ok: false, reason: 'invalid-config', message }                      exit 2
//     { ok: false, reason: 'missing-required-field', field, message }       exit 2
//     { ok: false, reason: 'image-dimension-mismatch',
//         path, expected, actual, message }                                 exit 2
//     { ok: false, reason: 'image-unreadable', path, message }              exit 2
//     { ok: true, authenticated: false }                                    exit 10
//     { ok: false, reason: 'network-error', message }                       exit 11
//     { ok: false, reason: 'api-error',
//         status?, errorCode?, message }                                    exit 17
//
//   --dry-run:
//     { ok: true, dryRun: true, workspaceId, payload }                      exit 0
//     (no uploads, no submit — manifest + image dimensions are still
//     validated so dry-run catches the same local errors as a real run.)
//
//   --accept-terms required for real submits:
//     The console UI gates "검토 요청하기" on several mandatory legal-
//     agreement checkboxes (common + category-dependent — see
//     VALIDATION-RULES.md). We can't see those on the wire yet (payload
//     shape is inferred), so the CLI enforces the gate locally: submit
//     refuses without --accept-terms. The flag is not required for
//     --dry-run.
//     { ok: false, reason: 'terms-not-accepted', message }                  exit 2

export interface RegisterArgs {
  readonly workspace?: string | undefined;
  readonly config?: string | undefined;
  readonly json: boolean;
  readonly dryRun?: boolean | undefined;
  readonly acceptTerms?: boolean | undefined;
}

export interface RegisterDeps {
  readonly cwd?: string;
  readonly uploadImpl?: (params: UploadParams) => Promise<string>;
  readonly submitImpl?: (
    workspaceId: number,
    payload: ReturnType<typeof buildSubmitPayload>,
    cookies: readonly CdpCookie[],
  ) => Promise<CreateMiniAppResult>;
}

// `runRegister` returns `Promise<void>` as a type-level handshake — at
// runtime every code path either awaits `exitAfterFlush` (which calls
// `process.exit` and never returns) or bubbles a thrown exception. A
// future maintainer should not try to `catch` the absence of a return
// value as "success"; the success signal is `process.exit(0)` itself.
//
// `deps` defaults to `{}` so the citty wrapper (`app.ts`) doesn't need
// to pass a literal every call; tests override specific fields.
export async function runRegister(args: RegisterArgs, deps: RegisterDeps = {}): Promise<void> {
  const ctx = await resolveWorkspaceContext({
    json: args.json,
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
  });
  if (!ctx) return;
  const { session, workspaceId } = ctx;
  printContextHeader(ctx, { json: args.json });

  const manifest = await loadAndValidateManifest(args, deps);
  if (!manifest) return;

  // --accept-terms gate: required for real submits only. --dry-run
  // skips it so users can iterate on their manifest without being
  // forced to attest to the legal-agreement checkboxes each time.
  if (!args.dryRun && !args.acceptTerms) {
    emitTermsNotAccepted(args.json);
    await exitAfterFlush(ExitCode.Usage);
    return;
  }

  try {
    if (args.dryRun) {
      // Emit the payload with placeholder URLs so the user can
      // inspect exactly what would be sent without spending a round
      // of uploads. Useful during dog-food verification when the
      // inferred payload shape is in flight.
      const placeholderUrls: UploadedImageUrls = {
        logo: '<dry-run:logo>',
        logoDarkMode: manifest.logoDarkMode !== undefined ? '<dry-run:logoDarkMode>' : undefined,
        horizontalThumbnail: '<dry-run:horizontalThumbnail>',
        verticalScreenshots: manifest.verticalScreenshots.map(
          (_, i) => `<dry-run:verticalScreenshots[${i}]>`,
        ),
        horizontalScreenshots: manifest.horizontalScreenshots.map(
          (_, i) => `<dry-run:horizontalScreenshots[${i}]>`,
        ),
      };
      const payload = buildSubmitPayload(manifest, placeholderUrls);
      emitDryRun(args.json, workspaceId, payload);
      return exitAfterFlush(ExitCode.Ok);
    }

    const urls = await uploadAllImages(workspaceId, manifest, session.cookies, deps);
    const payload = buildSubmitPayload(manifest, urls);
    const submitImpl = deps.submitImpl ?? ((wid, p, c) => createMiniApp(wid, p, c));
    const result = await submitImpl(workspaceId, payload, session.cookies);
    emitSuccess(args.json, workspaceId, result);
    return exitAfterFlush(ExitCode.Ok);
  } catch (err) {
    return emitFailureAndExit(args.json, err);
  }
}

async function loadAndValidateManifest(
  args: RegisterArgs,
  deps: RegisterDeps,
): Promise<AppManifest | null> {
  const cwd = deps.cwd ?? process.cwd();
  let manifest: AppManifest;
  try {
    const manifestPath = await resolveManifestPath(args.config, cwd);
    manifest = await loadAppManifest(manifestPath);
  } catch (err) {
    if (err instanceof ManifestError) {
      emitManifestError(args.json, err);
      await exitAfterFlush(ExitCode.Usage);
      return null;
    }
    throw err;
  }

  // Image dimension checks run after manifest validation because they
  // need paths that the manifest already resolved to absolute.
  try {
    await validateImageDimensions(manifest.logo, DIMENSIONS.logo);
    if (manifest.logoDarkMode !== undefined) {
      await validateImageDimensions(manifest.logoDarkMode, DIMENSIONS.logo);
    }
    await validateImageDimensions(manifest.horizontalThumbnail, DIMENSIONS.horizontalThumbnail);
    for (const p of manifest.verticalScreenshots) {
      await validateImageDimensions(p, DIMENSIONS.verticalScreenshot);
    }
    for (const p of manifest.horizontalScreenshots) {
      await validateImageDimensions(p, DIMENSIONS.horizontalScreenshot);
    }
  } catch (err) {
    if (err instanceof ImageDimensionError) {
      emitImageDimensionError(args.json, err);
      await exitAfterFlush(ExitCode.Usage);
      return null;
    }
    throw err;
  }

  return manifest;
}

async function uploadAllImages(
  workspaceId: number,
  manifest: AppManifest,
  cookies: readonly CdpCookie[],
  deps: RegisterDeps,
): Promise<UploadedImageUrls> {
  // Serial on purpose: dog-food task #23 has not yet confirmed that the
  // console's `/resource/:wid/upload` endpoint tolerates concurrent
  // POSTs from the same session. `Promise.all` would shave a few seconds
  // off a 5-image upload, but until we've observed the server under
  // parallel load, the failure mode ("429? 503? silent drop?") is
  // unknown and a first-registration flake is much more expensive to
  // debug than a slower linear run.
  const uploadImpl = deps.uploadImpl ?? ((p) => uploadMiniAppResource(p));

  const logo = await uploadOne(uploadImpl, {
    workspaceId,
    validWidth: DIMENSIONS.logo.width,
    validHeight: DIMENSIONS.logo.height,
    cookies,
    path: manifest.logo,
  });
  const logoDarkMode =
    manifest.logoDarkMode !== undefined
      ? await uploadOne(uploadImpl, {
          workspaceId,
          validWidth: DIMENSIONS.logo.width,
          validHeight: DIMENSIONS.logo.height,
          cookies,
          path: manifest.logoDarkMode,
        })
      : undefined;
  const horizontalThumbnail = await uploadOne(uploadImpl, {
    workspaceId,
    validWidth: DIMENSIONS.horizontalThumbnail.width,
    validHeight: DIMENSIONS.horizontalThumbnail.height,
    cookies,
    path: manifest.horizontalThumbnail,
  });
  const verticalScreenshots: string[] = [];
  for (const p of manifest.verticalScreenshots) {
    verticalScreenshots.push(
      await uploadOne(uploadImpl, {
        workspaceId,
        validWidth: DIMENSIONS.verticalScreenshot.width,
        validHeight: DIMENSIONS.verticalScreenshot.height,
        cookies,
        path: p,
      }),
    );
  }
  const horizontalScreenshots: string[] = [];
  for (const p of manifest.horizontalScreenshots) {
    horizontalScreenshots.push(
      await uploadOne(uploadImpl, {
        workspaceId,
        validWidth: DIMENSIONS.horizontalScreenshot.width,
        validHeight: DIMENSIONS.horizontalScreenshot.height,
        cookies,
        path: p,
      }),
    );
  }
  return { logo, logoDarkMode, horizontalThumbnail, verticalScreenshots, horizontalScreenshots };
}

async function uploadOne(
  uploadImpl: (params: UploadParams) => Promise<string>,
  input: {
    workspaceId: number;
    validWidth: number;
    validHeight: number;
    cookies: readonly CdpCookie[];
    path: string;
  },
): Promise<string> {
  const buffer = await readFile(input.path);
  return uploadImpl({
    workspaceId: input.workspaceId,
    validWidth: input.validWidth,
    validHeight: input.validHeight,
    cookies: input.cookies,
    file: {
      buffer,
      fileName: basename(input.path),
      contentType: 'image/png',
    },
  });
}

// Errors that touch `categoryIds` always reference that key explicitly in
// the message (see `config/app-manifest.ts`). Point the user at
// `aitcc app categories --selectable` so they don't have to hunt for a
// live example — this is the only plain-text hint we surface beyond the
// raw message, and we keep the JSON payload unchanged so the contract
// with agent-plugin is stable.
function categoryHintFor(err: ManifestError): string | null {
  const target = err.field ?? '';
  if (target === 'categoryIds' || /categoryIds/.test(err.message)) {
    return 'Tip: run `aitcc app categories --selectable` to list valid category ids.';
  }
  return null;
}

function emitManifestError(json: boolean, err: ManifestError): void {
  if (json) {
    if (err.kind === 'missing-required-field') {
      emitJson({
        ok: false,
        reason: 'missing-required-field',
        field: err.field ?? null,
        message: err.message,
      });
    } else {
      emitJson({ ok: false, reason: 'invalid-config', message: err.message });
    }
  } else {
    process.stderr.write(`${err.message}\n`);
    const hint = categoryHintFor(err);
    if (hint) process.stderr.write(`${hint}\n`);
  }
}

function emitImageDimensionError(json: boolean, err: ImageDimensionError): void {
  if (json) {
    if (err.reason === 'mismatch') {
      emitJson({
        ok: false,
        reason: 'image-dimension-mismatch',
        path: err.path,
        expected: err.expected,
        actual: err.actual ?? null,
        message: err.message,
      });
    } else {
      // 'unreadable' covers missing files, permission errors, and
      // decode failures — distinct from a genuine dimension mismatch
      // so agent-plugin can branch (e.g., "path typo" vs "resize me").
      emitJson({
        ok: false,
        reason: 'image-unreadable',
        path: err.path,
        message: err.message,
      });
    }
  } else {
    process.stderr.write(`${err.message}\n`);
  }
}

function emitTermsNotAccepted(json: boolean): void {
  const message =
    'The console requires several legal-agreement checkboxes before submitting a mini-app for review. ' +
    'Re-run with --accept-terms to attest that you have read and agree to each of them ' +
    '(see VALIDATION-RULES.md or the console UI), or use --dry-run to preview the payload without submitting.';
  if (json) {
    emitJson({ ok: false, reason: 'terms-not-accepted', message });
  } else {
    process.stderr.write(`${message}\n`);
  }
}

function emitDryRun(
  json: boolean,
  workspaceId: number,
  payload: ReturnType<typeof buildSubmitPayload>,
): void {
  if (json) {
    emitJson({ ok: true, dryRun: true, workspaceId, payload });
  } else {
    process.stdout.write('[dry-run] Would POST to ');
    process.stdout.write(
      `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/workspaces/${workspaceId}/mini-app/review\n`,
    );
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

function consoleUrlFor(workspaceId: number, appId: string | number): string {
  return `https://apps-in-toss.toss.im/console/workspace/${workspaceId}/mini-app/${appId}`;
}

function emitSuccess(json: boolean, workspaceId: number, result: CreateMiniAppResult): void {
  const consoleUrl =
    result.miniAppId !== undefined ? consoleUrlFor(workspaceId, result.miniAppId) : null;
  if (json) {
    emitJson({
      ok: true,
      workspaceId,
      appId: result.miniAppId ?? null,
      reviewState: result.reviewState ?? null,
      consoleUrl,
    });
  } else {
    process.stdout.write(
      `Registered mini-app ${result.miniAppId ?? '(id unknown)'} in workspace ${workspaceId}` +
        ` (reviewState=${result.reviewState ?? 'unknown'}).\n`,
    );
    if (consoleUrl !== null) {
      process.stdout.write(`🔗 console: ${consoleUrl}\n`);
    }
  }
}

// Thin wrapper kept for local readability — the real dispatch lives in
// `_shared.ts::emitFailureFromError` and is shared with app/keys/
// members/workspace so every command's auth/network/api-error JSON
// shape agrees.
async function emitFailureAndExit(json: boolean, err: unknown): Promise<void> {
  return emitFailureFromError(json, err);
}
