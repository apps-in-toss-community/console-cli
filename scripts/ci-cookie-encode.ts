#!/usr/bin/env bun
// THROWAWAY HELPER. Encodes the local session.json cookies into a base64
// JSON blob suitable for AITCC_COOKIE_BLOB. Writes the blob to a path
// (default `spike-output/ci/blob.txt`, mode 0600) — never stdout — and
// prints only the byte length + recommended next step. Delete after use.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sessionFilePath } from '../src/paths.js';

const out = process.argv[2] ?? 'spike-output/ci/blob.txt';

const raw = await readFile(sessionFilePath(), 'utf8');
const session = JSON.parse(raw) as { cookies?: unknown };
if (!Array.isArray(session.cookies) || session.cookies.length === 0) {
  process.stderr.write('no cookies in session.json — run `aitcc login` first\n');
  process.exit(1);
}

const blob = Buffer.from(JSON.stringify(session.cookies)).toString('base64');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, blob, { mode: 0o600 });

process.stdout.write(`wrote ${blob.length} bytes to ${out}\n`);
process.stdout.write('\nNext steps:\n');
process.stdout.write(
  `  1) gh secret set AITCC_COOKIE_BLOB --repo apps-in-toss-community/console-cli < ${out}\n`,
);
process.stdout.write(
  '  2) gh workflow run "spike — CI cookie" --repo apps-in-toss-community/console-cli --ref spike-ci-cookie\n',
);
process.stdout.write(`  3) After the run, shred ${out} and: gh secret delete AITCC_COOKIE_BLOB\n`);
