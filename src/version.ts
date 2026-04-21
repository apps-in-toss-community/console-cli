// Single source of truth for the embedded CLI version.
//
// The value is replaced at build time:
//   - tsdown → via the `define` block in `tsdown.config.ts`
//   - bun    → via `--define AITCC_VERSION=...` in `scripts/build-bin.ts`
//
// During `pnpm test` / `ts-node` execution the define isn't applied, so we fall
// back to reading `package.json` at runtime. That path is never hit in the
// shipped artifacts.

declare const AITCC_VERSION: string | undefined;

function resolveVersion(): string {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: globalThis lookup for optional build-time define
    const injected = (globalThis as any).AITCC_VERSION as string | undefined;
    if (typeof injected === 'string' && injected.length > 0) return injected;
  } catch {
    // ignore
  }
  try {
    if (typeof AITCC_VERSION === 'string' && AITCC_VERSION.length > 0) {
      return AITCC_VERSION;
    }
  } catch {
    // ignore
  }
  return '0.0.0-dev';
}

export const VERSION = resolveVersion();
