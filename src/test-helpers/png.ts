// Build a minimal PNG that carries the 13-byte IHDR chunk with the given
// dimensions. The file is not renderable, but image-size only reads the
// header, so it's enough for anything that wants "a file with these
// dimensions" in a test. Kept here (rather than alongside either
// consumer) so adding a third caller doesn't spawn a third copy.

export function makePngBuffer(width: number, height: number): Buffer {
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
  // CRC is ignored by image-size for the IHDR parse, so any 4 bytes
  // suffice. A real PNG decoder would validate it.
  const crc = Buffer.alloc(4);
  return Buffer.concat([signature, length, type, ihdr, crc]);
}
