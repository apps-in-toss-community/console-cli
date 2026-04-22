import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { NetworkError, TossApiError } from '../api/http.js';
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
  emitApiError,
  emitJson,
  emitNetworkError,
  emitNotAuthenticated,
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
//     { ok: true, workspaceId, appId, reviewState }                        exit 0
//
//   failures:
//     { ok: false, reason: 'no-workspace-selected' }                        exit 2
//     { ok: false, reason: 'invalid-config', message }                      exit 2
//     { ok: false, reason: 'missing-required-field', field }                exit 2
//     { ok: false, reason: 'image-dimension-mismatch',
//         path, expected, actual }                                          exit 2
//     { ok: true, authenticated: false }                                    exit 10
//     { ok: false, reason: 'network-error', message }                       exit 11
//     { ok: false, reason: 'api-error', status?, message }                  exit 17

export interface RegisterArgs {
  readonly workspace?: string | undefined;
  readonly config?: string | undefined;
  readonly json: boolean;
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

export async function runRegister(args: RegisterArgs, deps: RegisterDeps): Promise<void> {
  const ctx = await resolveWorkspaceContext({
    json: args.json,
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
  });
  if (!ctx) return;
  const { session, workspaceId } = ctx;

  const manifest = await loadAndValidateManifest(args, deps);
  if (!manifest) return;

  try {
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
  }
}

function emitImageDimensionError(json: boolean, err: ImageDimensionError): void {
  if (json) {
    emitJson({
      ok: false,
      reason: 'image-dimension-mismatch',
      path: err.path,
      expected: err.expected,
      actual: err.actual ?? null,
    });
  } else {
    process.stderr.write(`${err.message}\n`);
  }
}

function emitSuccess(json: boolean, workspaceId: number, result: CreateMiniAppResult): void {
  if (json) {
    emitJson({
      ok: true,
      workspaceId,
      appId: result.miniAppId ?? null,
      reviewState: result.reviewState ?? null,
    });
  } else {
    process.stdout.write(
      `Registered mini-app ${result.miniAppId ?? '(id unknown)'} in workspace ${workspaceId}` +
        ` (reviewState=${result.reviewState ?? 'unknown'}).\n`,
    );
  }
}

async function emitFailureAndExit(json: boolean, err: unknown): Promise<void> {
  if (err instanceof TossApiError && err.isAuthError) {
    emitNotAuthenticated(json, 'session-expired');
    return exitAfterFlush(ExitCode.NotAuthenticated);
  }
  if (err instanceof TossApiError) {
    if (json) {
      emitJson({
        ok: false,
        reason: 'api-error',
        status: err.status,
        errorCode: err.errorCode,
        message: err.message,
      });
    } else {
      process.stderr.write(`Console API error: ${err.message}\n`);
    }
    return exitAfterFlush(ExitCode.ApiError);
  }
  if (err instanceof NetworkError) {
    emitNetworkError(json, err.message);
    return exitAfterFlush(ExitCode.NetworkError);
  }
  emitApiError(json, (err as Error).message);
  return exitAfterFlush(ExitCode.ApiError);
}
