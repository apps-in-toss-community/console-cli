import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageDimensionError, validateImageDimensions } from './image-validator.js';

// Image dimension validation runs before any network call, so both the
// "dimensions match" happy path and the "reject gracefully" error path
// matter. We generate minimal-but-valid PNG buffers with the IHDR block
// set to the width/height we care about — that keeps these tests hermetic
// (no fixtures on disk) and trivially catches a "big-endian vs little-
// endian" bug in any future swap of the image-size library.

// Build a minimal PNG that carries the 13-byte IHDR chunk with the given
// dimensions. The file is not renderable, but image-size only reads the
// header, so it's enough for the validator.
function makePngBuffer(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR', 'ascii');
  // CRC field is ignored by image-size for the IHDR parse, so any 4 bytes
  // suffice here.
  const crc = Buffer.alloc(4);
  return Buffer.concat([signature, length, type, ihdr, crc]);
}

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
