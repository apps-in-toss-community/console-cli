import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AitBundleError,
  deploymentIdFromBundleBytes,
  detectBundleFormat,
  readAitBundle,
} from './ait-bundle.js';

function zipWith(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Build a minimal AIT header file for tests. We only need enough bytes
// to exercise our header parser, not a full protobuf-encoded AITBundle:
// we hand-write the wire-format bytes for deploymentId (field 2) and
// optionally appName (field 3).
function aitWith(opts: {
  deploymentId?: string;
  appName?: string;
  extraBundleBytes?: Uint8Array;
  zipBlob?: Uint8Array;
  formatVersion?: number;
  bundleLen?: number; // override for truncation tests
}): Uint8Array {
  const bundleParts: Uint8Array[] = [];
  if (opts.deploymentId !== undefined) {
    bundleParts.push(encodeStringField(2, opts.deploymentId));
  }
  if (opts.appName !== undefined) {
    bundleParts.push(encodeStringField(3, opts.appName));
  }
  if (opts.extraBundleBytes !== undefined) {
    bundleParts.push(opts.extraBundleBytes);
  }
  const bundle = concat(bundleParts);
  const zipBlob = opts.zipBlob ?? new Uint8Array(0);

  const MAGIC = new Uint8Array([0x41, 0x49, 0x54, 0x42, 0x55, 0x4e, 0x44, 0x4c]);
  const out = new Uint8Array(8 + 4 + 8 + bundle.length + 8 + zipBlob.length);
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(MAGIC, offset);
  offset += 8;
  view.setUint32(offset, opts.formatVersion ?? 1, false);
  offset += 4;
  view.setBigUint64(offset, BigInt(opts.bundleLen ?? bundle.length), false);
  offset += 8;
  out.set(bundle, offset);
  offset += bundle.length;
  view.setBigUint64(offset, BigInt(zipBlob.length), false);
  offset += 8;
  out.set(zipBlob, offset);
  return out;
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const tag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  return concat([encodeVarint(BigInt(tag)), encodeVarint(BigInt(bytes.length)), bytes]);
}

function encodeVarint(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe('detectBundleFormat', () => {
  it('returns "ait" for AITBUNDL magic', () => {
    const bytes = aitWith({ deploymentId: 'd', appName: 'a' });
    expect(detectBundleFormat(bytes)).toBe('ait');
  });

  it('returns "zip" for PK magic', () => {
    const bytes = zipWith({ 'app.json': toBytes('{}') });
    expect(detectBundleFormat(bytes)).toBe('zip');
  });

  it('returns "unknown" for random bytes', () => {
    expect(detectBundleFormat(toBytes('hello world'))).toBe('unknown');
  });
});

describe('deploymentIdFromBundleBytes (legacy zip path)', () => {
  it('extracts _metadata.deploymentId from a minimal bundle', () => {
    const appJson = JSON.stringify({
      name: 'my-app',
      _metadata: { deploymentId: '00000000-0000-0000-0000-000000000001' },
    });
    const zip = zipWith({ 'app.json': toBytes(appJson) });
    expect(deploymentIdFromBundleBytes(zip, '<mem>')).toEqual({
      deploymentId: '00000000-0000-0000-0000-000000000001',
      format: 'zip',
    });
  });

  it('extracts deploymentId even when the bundle has other entries', () => {
    const appJson = JSON.stringify({
      _metadata: { deploymentId: 'abc-def' },
    });
    const zip = zipWith({
      'app.json': toBytes(appJson),
      'index.html': toBytes('<html></html>'),
      'assets/bundle.js': toBytes('console.log(1)'),
    });
    expect(deploymentIdFromBundleBytes(zip, '<mem>').deploymentId).toBe('abc-def');
  });

  it('throws unrecognized-format when bytes have neither AITBUNDL nor PK magic', () => {
    const notBundle = toBytes('hello, world — not a bundle');
    try {
      deploymentIdFromBundleBytes(notBundle, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('unrecognized-format');
    }
  });

  it('throws missing-app-json when the zip has no app.json at the root', () => {
    const zip = zipWith({ 'other.json': toBytes('{}') });
    try {
      deploymentIdFromBundleBytes(zip, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('missing-app-json');
    }
  });

  it('throws invalid-app-json when app.json is not valid JSON', () => {
    const zip = zipWith({ 'app.json': toBytes('not json {') });
    try {
      deploymentIdFromBundleBytes(zip, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('invalid-app-json');
    }
  });

  it('throws missing-deployment-id when _metadata is missing', () => {
    const zip = zipWith({ 'app.json': toBytes(JSON.stringify({ name: 'x' })) });
    try {
      deploymentIdFromBundleBytes(zip, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('missing-deployment-id');
    }
  });

  it('throws missing-deployment-id when deploymentId is empty string', () => {
    const zip = zipWith({
      'app.json': toBytes(JSON.stringify({ _metadata: { deploymentId: '' } })),
    });
    try {
      deploymentIdFromBundleBytes(zip, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('missing-deployment-id');
    }
  });
});

describe('deploymentIdFromBundleBytes (AIT header path)', () => {
  it('extracts deploymentId from a minimal AIT header', () => {
    const bytes = aitWith({
      deploymentId: '019bfa90-ad4c-799f-b227-b4159e6867f7',
      appName: 'my-mini-app',
    });
    expect(deploymentIdFromBundleBytes(bytes, '<mem>')).toEqual({
      deploymentId: '019bfa90-ad4c-799f-b227-b4159e6867f7',
      format: 'ait',
    });
  });

  it('tolerates unknown protobuf fields before deploymentId', () => {
    // Field 1 (formatVersion, varint) before field 2 (deploymentId).
    // Tag for field 1 varint = (1<<3)|0 = 8.
    const field1 = concat([encodeVarint(8n), encodeVarint(1n)]);
    const bytes = aitWith({ deploymentId: 'xyz', extraBundleBytes: field1 });
    expect(deploymentIdFromBundleBytes(bytes, '<mem>').deploymentId).toBe('xyz');
  });

  it('throws invalid-ait when buffer is shorter than the header', () => {
    const short = new Uint8Array([0x41, 0x49, 0x54, 0x42, 0x55, 0x4e, 0x44, 0x4c]); // just magic
    try {
      deploymentIdFromBundleBytes(short, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('invalid-ait');
    }
  });

  it('throws invalid-ait when bundleLen points past the buffer end', () => {
    const bytes = aitWith({ deploymentId: 'x', bundleLen: 999999 });
    try {
      deploymentIdFromBundleBytes(bytes, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('invalid-ait');
    }
  });

  it('throws missing-deployment-id when the AIT bundle has no field 2', () => {
    const bytes = aitWith({ appName: 'only-app-name' });
    try {
      deploymentIdFromBundleBytes(bytes, '<mem>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AitBundleError);
      expect((err as AitBundleError).reason).toBe('missing-deployment-id');
    }
  });
});

describe('readAitBundle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aitcc-bundle-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns deploymentId + raw bytes + format from a legacy zip file', async () => {
    const appJson = JSON.stringify({ _metadata: { deploymentId: 'dep-123' } });
    const zip = zipWith({ 'app.json': toBytes(appJson) });
    const path = join(dir, 'sample.ait');
    writeFileSync(path, zip);
    const info = await readAitBundle(path);
    expect(info.deploymentId).toBe('dep-123');
    expect(info.format).toBe('zip');
    expect(info.bytes.byteLength).toBe(zip.byteLength);
  });

  it('returns deploymentId + raw bytes + format from an AIT file', async () => {
    const bytes = aitWith({ deploymentId: 'dep-ait-456', appName: 'a' });
    const path = join(dir, 'sample.ait');
    writeFileSync(path, bytes);
    const info = await readAitBundle(path);
    expect(info.deploymentId).toBe('dep-ait-456');
    expect(info.format).toBe('ait');
    expect(info.bytes.byteLength).toBe(bytes.byteLength);
  });

  it('throws file-unreadable when the file does not exist', async () => {
    const path = join(dir, 'nope.ait');
    await expect(readAitBundle(path)).rejects.toBeInstanceOf(AitBundleError);
    try {
      await readAitBundle(path);
    } catch (err) {
      expect((err as AitBundleError).reason).toBe('file-unreadable');
    }
  });
});
