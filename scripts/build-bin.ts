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
  { target: 'bun-linux-x64', out: 'ait-console-linux-x64' },
  { target: 'bun-linux-arm64', out: 'ait-console-linux-arm64' },
  { target: 'bun-darwin-x64', out: 'ait-console-darwin-x64' },
  { target: 'bun-darwin-arm64', out: 'ait-console-darwin-arm64' },
  { target: 'bun-windows-x64', out: 'ait-console-windows-x64.exe' },
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
  await $`bun build ./src/cli.ts \
    --compile \
    --target=${target} \
    --define AIT_CONSOLE_VERSION=${JSON.stringify(version)} \
    --outfile=dist-bin/${out}`;
}

console.log('Done.');
