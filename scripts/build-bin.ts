#!/usr/bin/env bun
/// <reference types="bun" />

// Cross-platform standalone binary builder using `bun build --compile`.
// Usage:
//   bun run scripts/build-bin.ts                 # build all targets
//   bun run scripts/build-bin.ts linux-x64       # build a single target
//
// The release workflow invokes the per-target form on a matching runner so
// each job only ships one binary.

import { readFileSync } from 'node:fs';
import { $ } from 'bun';

interface Target {
  target: string;
  out: string;
}

const TARGETS: Target[] = [
  { target: 'bun-linux-x64', out: 'aitcc-linux-x64' },
  { target: 'bun-linux-arm64', out: 'aitcc-linux-arm64' },
  { target: 'bun-darwin-x64', out: 'aitcc-darwin-x64' },
  { target: 'bun-darwin-arm64', out: 'aitcc-darwin-arm64' },
  { target: 'bun-windows-x64', out: 'aitcc-windows-x64.exe' },
];

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const version = pkg.version;

const arg = process.argv[2];
const selected = arg ? TARGETS.filter((t) => t.target === `bun-${arg}`) : TARGETS;
if (selected.length === 0) {
  console.error(`No target matched "${arg}". Known: ${TARGETS.map((t) => t.target).join(', ')}`);
  process.exit(2);
}

await $`mkdir -p dist-bin`;

for (const { target, out } of selected) {
  console.log(`Building ${out} (version ${version})...`);
  // --minify + --sourcemap=none trims the userland JS payload. Most of the
  // binary is the bundled Bun runtime (~55 MB floor) so we're not going to
  // get dramatic savings, but every MB shaved helps the install.sh UX and
  // GitHub Release asset size.
  await $`bun build ./src/cli.ts \
    --compile \
    --target=${target} \
    --minify \
    --sourcemap=none \
    --define AITCC_VERSION=${JSON.stringify(version)} \
    --outfile=dist-bin/${out}`;

  if (target.startsWith('bun-darwin-') && process.platform === 'darwin') {
    console.log(`Ad-hoc signing ${out} with rcodesign...`);
    // Strip Bun's malformed LC_CODE_SIGNATURE stub first so rcodesign
    // can write a fresh signature. `codesign --remove-signature` exits 0
    // even if there's nothing to remove.
    await $`codesign --remove-signature dist-bin/${out}`.nothrow();
    await $`rcodesign sign \
      --entitlements-xml-path scripts/macos-entitlements.plist \
      dist-bin/${out}`;
  }
}

console.log('Done.');
