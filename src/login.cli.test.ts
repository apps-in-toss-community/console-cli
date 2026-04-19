import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// End-to-end smoke for the built CLI binary. Skipped when `dist/cli.mjs` is
// absent so plain `pnpm test` still passes without a prior `pnpm build`.
// `import.meta.url` points at the compiled test module (src/*.test.ts), so
// `../dist/cli.mjs` resolves from the repo root — no build-output layout
// changes should be needed if tsdown's out-dir moves.

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

  it('completes the callback round-trip and writes a session file', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'ait-console-cli-it-'));
    const env = { ...process.env };
    // Strip any ambient OAuth config from the developer's shell so the test
    // asserts on values we control.
    delete env.AIT_CONSOLE_OAUTH_CLIENT_ID;
    delete env.AIT_CONSOLE_OAUTH_SCOPE;
    env.AIT_CONSOLE_OAUTH_URL = 'https://example.com/oauth/authorize';
    env.AIT_CONSOLE_NO_BROWSER = '1';
    env.XDG_CONFIG_HOME = configRoot;

    const child = spawn(process.execPath, [distCli, 'login', '--json', '--timeout=30'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    const authUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for URL on stderr')),
        5000,
      );
      const check = () => {
        const match = stderr.match(/https:\/\/example\.com\/oauth\/authorize\?[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      child.stderr.on('data', check);
      check();
    });

    const parsed = new URL(authUrl);
    const redirectUri = parsed.searchParams.get('redirect_uri');
    const state = parsed.searchParams.get('state');
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const res = await fetch(
      `${redirectUri}?code=authcode&state=${state}&user_id=u_1&email=alice%40example.com&display_name=Alice`,
    ).catch((err: Error) => {
      // Surface the child's stderr on fetch failure so test output points
      // at the real cause rather than a generic ECONNREFUSED.
      throw new Error(`Callback fetch failed: ${err.message}\n--- child stderr ---\n${stderr}`);
    });
    expect(res.status).toBe(200);

    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(0);

    const jsonLine = stdout.trim();
    const payload = JSON.parse(jsonLine) as { ok: boolean; user: { id: string; email: string } };
    expect(payload.ok).toBe(true);
    expect(payload.user.id).toBe('u_1');
    expect(payload.user.email).toBe('alice@example.com');

    const sessionPath = join(configRoot, 'ait-console', 'session.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    expect(session.user.id).toBe('u_1');
    expect(session.user.email).toBe('alice@example.com');
  }, 15000);
});
