import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// Parse the GNU coreutils `sha256sum` output format: one entry per line,
// `<hex>  <name>`. The two-space separator is canonical; a leading `*` on
// the name marks binary mode, which we strip. Blank lines and `#` comments
// are ignored. Hex is normalized to lowercase so callers can compare with
// `===`.
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const hash = match[1]?.toLowerCase();
    const name = match[2]?.trim();
    if (!hash || !name) continue;
    out.set(name, hash);
  }
  return out;
}

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
