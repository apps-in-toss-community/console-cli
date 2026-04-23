import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AitBundleError, deploymentIdFromBundleBytes, readAitBundle } from './ait-bundle.js';

function zipWith(files: Record<string, Uint8Array>): Uint8Array {
  // fflate's zipSync takes a nested dir tree of Uint8Array leaves; a flat
  // `{name: bytes}` map produces a zip whose central directory lists
  // those names at the root, which is exactly the .ait shape.
  return zipSync(files);
}

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('deploymentIdFromBundleBytes', () => {
  it('extracts _metadata.deploymentId from a minimal bundle', () => {
    const appJson = JSON.stringify({
      name: 'my-app',
      _metadata: { deploymentId: '00000000-0000-0000-0000-000000000001' },
    });
    const zip = zipWith({ 'app.json': toBytes(appJson) });
    const id = deploymentIdFromBundleBytes(zip, '<mem>');
    expect(id).toBe('00000000-0000-0000-0000-000000000001');
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
    expect(deploymentIdFromBundleBytes(zip, '<mem>')).toBe('abc-def');
  });

  it('throws invalid-zip when the bytes are not a zip', () => {
    const notZip = toBytes('hello, world — not a zip');
    expect(() => deploymentIdFromBundleBytes(notZip, '<mem>')).toThrow(AitBundleError);
    try {
      deploymentIdFromBundleBytes(notZip, '<mem>');
    } catch (err) {
      expect((err as AitBundleError).reason).toBe('invalid-zip');
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

describe('readAitBundle', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aitcc-bundle-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns deploymentId + raw bytes from a real file', async () => {
    const appJson = JSON.stringify({ _metadata: { deploymentId: 'dep-123' } });
    const zip = zipWith({ 'app.json': toBytes(appJson) });
    const path = join(dir, 'sample.ait');
    writeFileSync(path, zip);
    const info = await readAitBundle(path);
    expect(info.deploymentId).toBe('dep-123');
    expect(info.bytes.byteLength).toBe(zip.byteLength);
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
