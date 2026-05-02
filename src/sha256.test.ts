import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSha256Sums, sha256OfFile } from './sha256.js';

describe('parseSha256Sums', () => {
  it('parses canonical two-space lines', () => {
    const text = [
      `${'a'.repeat(64)}  aitcc-linux-x64`,
      `${'b'.repeat(64)}  aitcc-darwin-arm64`,
    ].join('\n');
    const map = parseSha256Sums(text);
    expect(map.get('aitcc-linux-x64')).toBe('a'.repeat(64));
    expect(map.get('aitcc-darwin-arm64')).toBe('b'.repeat(64));
  });

  it('tolerates binary-mode marker on the name', () => {
    const text = `${'c'.repeat(64)} *aitcc-windows-x64.exe`;
    const map = parseSha256Sums(text);
    expect(map.get('aitcc-windows-x64.exe')).toBe('c'.repeat(64));
  });

  it('ignores blank lines and comments', () => {
    const text = ['# header', '', `${'d'.repeat(64)}  aitcc-linux-arm64`, '   ', '# trailing'].join(
      '\n',
    );
    const map = parseSha256Sums(text);
    expect(map.size).toBe(1);
    expect(map.get('aitcc-linux-arm64')).toBe('d'.repeat(64));
  });

  it('normalizes uppercase hex to lowercase', () => {
    const text = `${'AB'.repeat(32)}  aitcc-linux-x64`;
    const map = parseSha256Sums(text);
    expect(map.get('aitcc-linux-x64')).toBe('ab'.repeat(32));
  });

  it('returns undefined for names not in the file', () => {
    const text = `${'e'.repeat(64)}  aitcc-linux-x64`;
    const map = parseSha256Sums(text);
    expect(map.get('aitcc-darwin-x64')).toBeUndefined();
  });
});

describe('sha256OfFile', () => {
  it('hashes a known buffer correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-sha256-'));
    const path = join(dir, 'sample.bin');
    writeFileSync(path, 'hello world');
    // Known SHA-256 of "hello world".
    const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    expect(await sha256OfFile(path)).toBe(expected);
  });

  it('hashes an empty file to the empty digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-sha256-'));
    const path = join(dir, 'empty.bin');
    writeFileSync(path, '');
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(await sha256OfFile(path)).toBe(expected);
  });
});
