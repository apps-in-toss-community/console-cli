import { readFile } from 'node:fs/promises';
import { imageSize } from 'image-size';

// Image dimension validation lives here (rather than inline in the
// command) so a future swap of the underlying library is confined. The
// console upload endpoint validates validWidth/validHeight server-side
// with a hard 400, but failing locally gives the agent-plugin consumer
// a structured error (path + expected + actual) instead of a pass-
// through api-error reason.
//
// image-size reads the PNG/JPEG/etc. header directly; we pass a Buffer
// so we can distinguish "file missing" (ENOENT → unreadable) from
// "unknown format" (library throws → unreadable) without two code paths.

export type ImageDimensionErrorReason = 'mismatch' | 'unreadable';

export class ImageDimensionError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly actual: string | undefined;
  readonly reason: ImageDimensionErrorReason;

  constructor(args: {
    path: string;
    expected: string;
    actual: string | undefined;
    reason: ImageDimensionErrorReason;
    message: string;
  }) {
    super(args.message);
    this.name = 'ImageDimensionError';
    this.path = args.path;
    this.expected = args.expected;
    this.actual = args.actual;
    this.reason = args.reason;
  }
}

export interface Dimension {
  readonly width: number;
  readonly height: number;
}

function format(dim: Dimension): string {
  return `${dim.width}x${dim.height}`;
}

export async function validateImageDimensions(path: string, expected: Dimension): Promise<void> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    throw new ImageDimensionError({
      path,
      expected: format(expected),
      actual: undefined,
      reason: 'unreadable',
      message: `could not read image at ${path}: ${(err as Error).message}`,
    });
  }
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(buffer);
  } catch (err) {
    throw new ImageDimensionError({
      path,
      expected: format(expected),
      actual: undefined,
      reason: 'unreadable',
      message: `could not decode image header at ${path}: ${(err as Error).message}`,
    });
  }
  if (typeof dims.width !== 'number' || typeof dims.height !== 'number') {
    throw new ImageDimensionError({
      path,
      expected: format(expected),
      actual: undefined,
      reason: 'unreadable',
      message: `image header at ${path} did not expose width/height`,
    });
  }
  if (dims.width !== expected.width || dims.height !== expected.height) {
    const actual = `${dims.width}x${dims.height}`;
    throw new ImageDimensionError({
      path,
      expected: format(expected),
      actual,
      reason: 'mismatch',
      message: `image ${path} has dimensions ${actual}; expected ${format(expected)}`,
    });
  }
}

// Canonical dimension specs for the register flow. Centralising here keeps
// the command and the payload builder agreeing on the same source of truth.
export const DIMENSIONS = {
  logo: { width: 600, height: 600 },
  horizontalThumbnail: { width: 1932, height: 828 },
  verticalScreenshot: { width: 636, height: 1048 },
  horizontalScreenshot: { width: 1504, height: 741 },
} as const;
