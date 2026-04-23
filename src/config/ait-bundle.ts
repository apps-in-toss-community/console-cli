import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

// An .ait bundle is a zip whose root contains `app.json`. The toolchain
// that packs the bundle embeds the deployment id at
// `_metadata.deploymentId`, and `aitcc app bundles upload` needs that id
// to drive the 3-step init → PUT → complete dance. Reading it here keeps
// zip-cracking out of the API layer (`src/api/mini-apps.ts` stays
// transport-only) and gives us a unit-testable seam.

export type AitBundleErrorReason =
  | 'file-unreadable'
  | 'invalid-zip'
  | 'missing-app-json'
  | 'invalid-app-json'
  | 'missing-deployment-id';

export class AitBundleError extends Error {
  readonly path: string;
  readonly reason: AitBundleErrorReason;

  constructor(args: { path: string; reason: AitBundleErrorReason; message: string }) {
    super(args.message);
    this.name = 'AitBundleError';
    this.path = args.path;
    this.reason = args.reason;
  }
}

export interface AitBundleInfo {
  readonly deploymentId: string;
  readonly bytes: Uint8Array;
}

/**
 * Read the `.ait` at `path`, extract `app.json`, and pull out
 * `_metadata.deploymentId`. Returns both the id and the raw bytes so the
 * caller can forward them to the S3 upload without re-reading the file.
 *
 * Errors are all surfaced as `AitBundleError` with a structured `reason`
 * so the command layer can render a typed `--json` failure.
 */
export async function readAitBundle(path: string): Promise<AitBundleInfo> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    throw new AitBundleError({
      path,
      reason: 'file-unreadable',
      message: (err as Error).message,
    });
  }
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const deploymentId = deploymentIdFromBundleBytes(bytes, path);
  return { deploymentId, bytes };
}

/**
 * Pure helper split out so tests can feed raw zip bytes without a tmp
 * file. Throws `AitBundleError` on any parse failure.
 */
export function deploymentIdFromBundleBytes(bytes: Uint8Array, pathForError: string): string {
  let entries: Record<string, Uint8Array>;
  try {
    // `filter` restricts extraction to just `app.json` so we don't
    // decompress megabytes of asset payload just to read a few lines of
    // metadata. fflate's unzipSync is synchronous but operates in-memory
    // on a Uint8Array, which is fine for `.ait` bundles (tens of MB
    // worst case; zip central directory is at the tail so partial
    // reads would need an async streaming parser we'd then have to
    // maintain — not worth the complexity for current bundle sizes).
    entries = unzipSync(bytes, { filter: (file) => file.name === 'app.json' });
  } catch (err) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'invalid-zip',
      message: `not a valid zip: ${(err as Error).message}`,
    });
  }
  const entry = entries['app.json'];
  if (!entry) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'missing-app-json',
      message: 'app.json is not present at the root of the bundle',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(entry));
  } catch (err) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'invalid-app-json',
      message: `app.json is not valid JSON: ${(err as Error).message}`,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'invalid-app-json',
      message: 'app.json is not a JSON object',
    });
  }
  const metadata = (parsed as Record<string, unknown>)._metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'missing-deployment-id',
      message:
        'app.json._metadata is missing; is your build outputting the modern app.json schema?',
    });
  }
  const deploymentId = (metadata as Record<string, unknown>).deploymentId;
  if (typeof deploymentId !== 'string' || deploymentId === '') {
    throw new AitBundleError({
      path: pathForError,
      reason: 'missing-deployment-id',
      message:
        'app.json._metadata.deploymentId is missing or empty; is your build outputting the modern app.json schema?',
    });
  }
  return deploymentId;
}
