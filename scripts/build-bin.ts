#!/usr/bin/env bun
/// <reference types="bun" />

// Cross-platform standalone binary builder using `bun build --compile`.
// Runs in CI on tag push; produces dist-bin/ait-console-{platform}-{arch}.

import { $ } from 'bun';

const targets = [
  { target: 'bun-linux-x64', out: 'ait-console-linux-x64' },
  { target: 'bun-linux-arm64', out: 'ait-console-linux-arm64' },
  { target: 'bun-darwin-x64', out: 'ait-console-darwin-x64' },
  { target: 'bun-darwin-arm64', out: 'ait-console-darwin-arm64' },
  { target: 'bun-windows-x64', out: 'ait-console-windows-x64.exe' },
];

await $`mkdir -p dist-bin`;

for (const { target, out } of targets) {
  console.log(`Building ${out}...`);
  await $`bun build ./src/cli.ts --compile --target=${target} --outfile=dist-bin/${out}`;
}

console.log('Done.');
