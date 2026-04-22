import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makePngBuffer } from '../test-helpers/png.js';
import { ImageDimensionError, validateImageDimensions } from './image-validator.js';

// Image dimension validation runs before any network call, so both the
// "dimensions match" happy path and the "reject gracefully" error path
// matter. We use the shared `makePngBuffer` helper to generate minimal
// PNGs — that keeps these tests hermetic (no fixtures on disk) and
// trivially catches a "big-endian vs little-endian" bug in any future
// swap of the image-size library.

function writePng(width: number, height: number, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aitcc-img-'));
  const path = join(dir, name);
  writeFileSync(path, makePngBuffer(width, height));
  return path;
}

describe('validateImageDimensions', () => {
  it('passes when dimensions match', async () => {
    const path = writePng(600, 600, 'logo.png');
    await expect(
      validateImageDimensions(path, { width: 600, height: 600 }),
    ).resolves.toBeUndefined();
  });

  it('throws ImageDimensionError with expected vs actual on mismatch', async () => {
    const path = writePng(512, 512, 'logo.png');
    const err = await validateImageDimensions(path, { width: 600, height: 600 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImageDimensionError);
    expect((err as ImageDimensionError).expected).toBe('600x600');
    expect((err as ImageDimensionError).actual).toBe('512x512');
    expect((err as ImageDimensionError).path).toBe(path);
  });

  it('throws ImageDimensionError when the file is missing', async () => {
    const err = await validateImageDimensions('/no/such/file.png', {
      width: 600,
      height: 600,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageDimensionError);
    expect((err as ImageDimensionError).reason).toBe('unreadable');
  });

  it('throws ImageDimensionError when the file is not a PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-img-'));
    const path = join(dir, 'not-a-png.txt');
    writeFileSync(path, 'hello');
    const err = await validateImageDimensions(path, { width: 600, height: 600 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImageDimensionError);
    expect((err as ImageDimensionError).reason).toBe('unreadable');
  });
});
