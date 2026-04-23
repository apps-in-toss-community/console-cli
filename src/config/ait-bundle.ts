import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

// A `.ait` bundle today comes in two on-disk shapes, and we have to read
// both. `@apps-in-toss/web-framework`'s build toolchain packs via
// `@apps-in-toss/ait-format`, which writes the modern shape:
//
//   [0..8)           MAGIC   = ASCII "AITBUNDL"
//   [8..12)          formatVersion : uint32 BE
//   [12..20)         bundleLen     : uint64 BE
//   [20..20+bundleLen) protobuf-encoded AITBundle (deploymentId, appName,
//                                                   permissions, …)
//   next 8 bytes     zipLen        : uint64 BE
//   next zipLen      zip blob (fflate-compatible)
//   next 8 bytes     sigLen        : uint64 BE (may be 0)
//   next sigLen      signature (optional)
//
// Legacy builds just emit a plain zip whose root contains `app.json`,
// and the console's own uploader still accepts that shape (it branches
// on the first 8 bytes: `AITBUNDL` → AIT, `PK\x03\x04` → ZIP). We
// replicate the same branch so `aitcc app deploy` works on either
// toolchain version without the user having to know which one their
// build produced.
//
// For the AIT path we only need `app.json._metadata.deploymentId`
// (really: the protobuf `deploymentId`, which the console mirrors into
// app.json). The header's bundle protobuf carries it directly, so we
// read it from the header instead of cracking the inner zip — cheaper
// and avoids depending on `@apps-in-toss/ait-format` (which would pull
// in protobufjs + long just to read two string fields). A tiny inline
// wire-format reader for protobuf fields 2 (deploymentId) and 3
// (appName) is enough.

export type AitBundleErrorReason =
  | 'file-unreadable'
  | 'unrecognized-format'
  | 'invalid-ait'
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

export type AitBundleFormat = 'ait' | 'zip';

export interface AitBundleInfo {
  readonly deploymentId: string;
  readonly bytes: Uint8Array;
  readonly format: AitBundleFormat;
}

// ASCII "AITBUNDL"
const AIT_MAGIC = new Uint8Array([0x41, 0x49, 0x54, 0x42, 0x55, 0x4e, 0x44, 0x4c]);
// Standard zip local file header signature "PK\x03\x04"
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

export function detectBundleFormat(bytes: Uint8Array): AitBundleFormat | 'unknown' {
  if (startsWith(bytes, AIT_MAGIC)) return 'ait';
  if (startsWith(bytes, ZIP_MAGIC)) return 'zip';
  return 'unknown';
}

/**
 * Read the `.ait` at `path` and pull out `deploymentId`, auto-detecting
 * whether the file is the modern AIT header format or a legacy plain
 * zip. Returns the raw bytes so the caller can forward them to S3
 * without re-reading the file.
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
  const { deploymentId, format } = deploymentIdFromBundleBytes(bytes, path);
  return { deploymentId, bytes, format };
}

/**
 * Pure helper split out so tests can feed raw bytes without a tmp file.
 * Throws `AitBundleError` on any parse failure. Returns the detected
 * format so callers that want to log it can.
 */
export function deploymentIdFromBundleBytes(
  bytes: Uint8Array,
  pathForError: string,
): { deploymentId: string; format: AitBundleFormat } {
  const format = detectBundleFormat(bytes);
  if (format === 'ait') {
    return { deploymentId: deploymentIdFromAitHeader(bytes, pathForError), format };
  }
  if (format === 'zip') {
    return { deploymentId: deploymentIdFromLegacyZip(bytes, pathForError), format };
  }
  throw new AitBundleError({
    path: pathForError,
    reason: 'unrecognized-format',
    message:
      'bundle does not start with AITBUNDL or PK magic bytes — not a valid .ait or legacy zip bundle',
  });
}

// --- AIT header path ------------------------------------------------------

// Header layout sizes, mirrored from @apps-in-toss/ait-format constants.
const AIT_MAGIC_SIZE = 8;
const AIT_VERSION_SIZE = 4;
const AIT_LENGTH_SIZE = 8;
const AIT_HEADER_SIZE = AIT_MAGIC_SIZE + AIT_VERSION_SIZE + AIT_LENGTH_SIZE; // 20

function deploymentIdFromAitHeader(bytes: Uint8Array, pathForError: string): string {
  if (bytes.length < AIT_HEADER_SIZE) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'invalid-ait',
      message: 'buffer too small to be a valid AIT file',
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // AIT uses big-endian for header integers (see ait-format/index.mjs:
  // `view.getUint32(h, !1)` / `view.getBigUint64(..., !1)`).
  const bundleLen = Number(view.getBigUint64(AIT_MAGIC_SIZE + AIT_VERSION_SIZE, false));
  if (!Number.isFinite(bundleLen) || bundleLen <= 0) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'invalid-ait',
      message: `AIT bundle length is invalid (${bundleLen})`,
    });
  }
  const bundleStart = AIT_HEADER_SIZE;
  const bundleEnd = bundleStart + bundleLen;
  if (bytes.length < bundleEnd) {
    throw new AitBundleError({
      path: pathForError,
      reason: 'invalid-ait',
      message: 'unexpected end of buffer reading AIT bundle protobuf',
    });
  }
  const bundleBytes = bytes.subarray(bundleStart, bundleEnd);
  const fields = readProtobufStringFields(bundleBytes, [2, 3]);
  const deploymentId = fields.get(2);
  if (typeof deploymentId !== 'string' || deploymentId === '') {
    throw new AitBundleError({
      path: pathForError,
      reason: 'missing-deployment-id',
      message: 'AIT bundle protobuf is missing deploymentId (field 2)',
    });
  }
  return deploymentId;
}

// Minimal protobuf reader: scans a length-delimited varint/string
// stream and returns the most recent value for each of the requested
// string field numbers. Only understands the wire types we expect to
// see in an AITBundle header (varint = 0, 64-bit = 1, length-delimited
// = 2, 32-bit = 5); for other fields it skips the payload. Good enough
// to extract deploymentId (field 2) and appName (field 3) without
// linking protobufjs.
function readProtobufStringFields(
  bytes: Uint8Array,
  wantedFieldNumbers: number[],
): Map<number, string> {
  const wanted = new Set(wantedFieldNumbers);
  const out = new Map<number, string>();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = 0;
  while (offset < bytes.length) {
    const { value: tag, next } = readVarint(bytes, offset);
    offset = next;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === 0) {
      // varint
      offset = readVarint(bytes, offset).next;
    } else if (wireType === 1) {
      // fixed 64-bit
      offset += 8;
    } else if (wireType === 2) {
      // length-delimited (strings, bytes, submessages, packed repeated)
      const { value: len, next: afterLen } = readVarint(bytes, offset);
      offset = afterLen;
      const payloadEnd = offset + Number(len);
      if (payloadEnd > bytes.length) {
        // Truncated; stop scanning. We return whatever we've already
        // extracted, and the caller decides whether that's enough.
        break;
      }
      if (wanted.has(fieldNumber)) {
        out.set(fieldNumber, decoder.decode(bytes.subarray(offset, payloadEnd)));
      }
      offset = payloadEnd;
    } else if (wireType === 5) {
      // fixed 32-bit
      offset += 4;
    } else {
      // Wire type 3 (start-group) / 4 (end-group) / 6+ (reserved). Not
      // expected inside AITBundle, and we can't safely skip them, so
      // stop.
      break;
    }
  }
  return out;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = start;
  // Varints are capped at 10 bytes in the protobuf wire format.
  for (let n = 0; n < 10 && i < bytes.length; n++, i++) {
    const byte = bytes[i];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: i + 1 };
    }
    shift += 7n;
  }
  // Malformed — return what we've got so the caller aborts.
  return { value, next: i };
}

// --- Legacy zip path ------------------------------------------------------

function deploymentIdFromLegacyZip(bytes: Uint8Array, pathForError: string): string {
  let entries: Record<string, Uint8Array>;
  try {
    // `filter` restricts extraction to just `app.json` so we don't
    // decompress megabytes of asset payload just to read a few lines of
    // metadata. fflate's unzipSync operates in-memory on a Uint8Array,
    // which is fine for `.ait` bundles (tens of MB worst case).
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
