import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'node',
  define: {
    AITCC_VERSION: JSON.stringify(pkg.version),
  },
});
