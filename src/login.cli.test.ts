import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// End-to-end smoke for the built CLI binary. Skipped when `dist/cli.mjs` is
// absent so plain `pnpm test` still passes without a prior `pnpm build`.

const distCli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const hasDist = existsSync(distCli);

describe.runIf(hasDist)('ait-console login (integration)', () => {
  it('exits Usage(2) with oauth-url-not-configured when AIT_CONSOLE_OAUTH_URL is unset', () => {
    const env = { ...process.env };
    delete env.AIT_CONSOLE_OAUTH_URL;
    env.AIT_CONSOLE_NO_BROWSER = '1';
    const res = spawnSync(process.execPath, [distCli, 'login', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(res.status).toBe(2);
    const line = res.stdout.trim();
    const parsed = JSON.parse(line) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('oauth-url-not-configured');
    // Diagnostics go to stderr per the --json contract.
    expect(res.stderr).toContain('OAuth URL is not configured');
  });

  it('rejects an invalid --timeout value', () => {
    const env = { ...process.env };
    env.AIT_CONSOLE_OAUTH_URL = 'https://example.com/oauth/authorize';
    env.AIT_CONSOLE_NO_BROWSER = '1';
    const res = spawnSync(
      process.execPath,
      [distCli, 'login', '--json', '--timeout=not-a-number'],
      { env, encoding: 'utf8', timeout: 5000 },
    );
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout.trim()) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('invalid-timeout');
  });
});
