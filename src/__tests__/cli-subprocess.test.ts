import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Subprocess harness: spawns the built `dist/cli.mjs` to lock down the
// `--json` contract that agent-plugin consumes. Each case picks a failure
// branch that does not require a live session or HTTP, so the test stays
// hermetic. The invariants we assert are command-agnostic:
//   1. stdout is exactly one line ending with `\n` (single JSON document).
//   2. stdout parses as JSON matching the documented `ok` shape.
//   3. exit code matches the contract in `commands/workspace.ts`.
//   4. stderr never contains JSON — it is plain-text diagnostics only,
//      and is empty for `--json` mode on these failure paths.

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = resolve(HERE, '..', '..', 'dist', 'cli.mjs');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: readonly string[], xdgConfigHome: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [DIST_CLI, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: xdgConfigHome },
      timeout: 20_000,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    // execFile rejects on non-zero exit; the rejection carries `code`,
    // `stdout`, `stderr`. We treat any branch other than "spawn failed"
    // as a normal CLI exit.
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof e.code !== 'number') {
      throw err;
    }
    return {
      exitCode: e.code,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function assertSingleJsonLine(stdout: string): unknown {
  // Single line + trailing \n is the `_shared.ts` `emitJson` invariant.
  // We split on \n and require exactly two segments: the JSON line and an
  // empty trailer. `endsWith('\n')` alone isn't enough — multi-line output
  // would also satisfy it.
  expect(stdout.endsWith('\n')).toBe(true);
  const parts = stdout.split('\n');
  expect(parts.length).toBe(2);
  expect(parts[1]).toBe('');
  const line = parts[0] as string;
  expect(line.length).toBeGreaterThan(0);
  // JSON.parse throws on malformed input — that's the assertion we want.
  return JSON.parse(line);
}

function assertStderrHasNoJson(stderr: string): void {
  // Any line that parses as JSON on stderr is a contract violation. Plain
  // diagnostic text is fine. We scan line-by-line so a stray brace inside
  // a sentence doesn't trip us up.
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    throw new Error(`stderr contained a JSON document: ${JSON.stringify(parsed)}`);
  }
}

describe('aitcc workspace --json subprocess contract', () => {
  const tmpDirs: string[] = [];

  beforeAll(() => {
    if (!existsSync(DIST_CLI)) {
      throw new Error(
        `dist/cli.mjs not found at ${DIST_CLI}. Run \`pnpm build\` before \`pnpm test\`.`,
      );
    }
  });

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  async function freshXdg(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aitcc-cli-subproc-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('workspace ls --json with no session emits not-authenticated and exits 10', async () => {
    const xdg = await freshXdg();
    const { exitCode, stdout, stderr } = await runCli(['workspace', 'ls', '--json'], xdg);
    expect(exitCode).toBe(10);
    const payload = assertSingleJsonLine(stdout);
    expect(payload).toEqual({ ok: true, authenticated: false });
    assertStderrHasNoJson(stderr);
    // `--json` must not leak diagnostics on this failure branch.
    expect(stderr).toBe('');
  }, 30_000);

  it('workspace use abc --json emits invalid-id and exits 2', async () => {
    const xdg = await freshXdg();
    const { exitCode, stdout, stderr } = await runCli(['workspace', 'use', 'abc', '--json'], xdg);
    expect(exitCode).toBe(2);
    const payload = assertSingleJsonLine(stdout) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('invalid-id');
    expect(typeof payload.message).toBe('string');
    expect((payload.message as string).length).toBeGreaterThan(0);
    assertStderrHasNoJson(stderr);
    expect(stderr).toBe('');
  }, 30_000);

  it('workspace use 0 --json rejects zero as non-positive integer (exit 2)', async () => {
    const xdg = await freshXdg();
    const { exitCode, stdout, stderr } = await runCli(['workspace', 'use', '0', '--json'], xdg);
    expect(exitCode).toBe(2);
    const payload = assertSingleJsonLine(stdout) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('invalid-id');
    expect(typeof payload.message).toBe('string');
    assertStderrHasNoJson(stderr);
    expect(stderr).toBe('');
  }, 30_000);

  // `workspace show` reads the session before validating the workspace
  // id, so with no session every branch — including `--workspace abc`
  // and the no-selection case — collapses to the not-authenticated
  // failure (exit 10). The `--json contract` block in commands/workspace.ts
  // documents the `invalid-id` and `no-workspace-selected` shapes for the
  // post-auth path; without HTTP-layer mocking we can only exercise the
  // pre-auth gate from a subprocess. That still covers the framing and
  // shape invariants for `show --json`.
  it('workspace show --workspace abc --json with no session falls through to not-authenticated (exit 10)', async () => {
    const xdg = await freshXdg();
    const { exitCode, stdout, stderr } = await runCli(
      ['workspace', 'show', '--workspace', 'abc', '--json'],
      xdg,
    );
    expect(exitCode).toBe(10);
    const payload = assertSingleJsonLine(stdout);
    expect(payload).toEqual({ ok: true, authenticated: false });
    assertStderrHasNoJson(stderr);
    expect(stderr).toBe('');
  }, 30_000);

  it('workspace show --json with no session emits not-authenticated (exit 10)', async () => {
    const xdg = await freshXdg();
    const { exitCode, stdout, stderr } = await runCli(['workspace', 'show', '--json'], xdg);
    expect(exitCode).toBe(10);
    const payload = assertSingleJsonLine(stdout);
    expect(payload).toEqual({ ok: true, authenticated: false });
    assertStderrHasNoJson(stderr);
    expect(stderr).toBe('');
  }, 30_000);
});
