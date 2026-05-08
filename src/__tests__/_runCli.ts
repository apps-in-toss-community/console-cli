import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'vitest';

// Subprocess harness used by `cli-subprocess.test.ts` and any future
// suites that lock down the `--json` contract by spawning the built CLI.
//
// Why a real subprocess (vs. importing `runMain` in-process)?
//   - `--json` is what agent-plugin sees through `Bash`, so we want to
//     exercise process exit codes, the real stdout/stderr split, and any
//     wrapping behavior (citty/runMain, exitAfterFlush) without mocks.
//   - The contract is defined per-stream: stdout = single-line JSON,
//     stderr = plain diagnostics. Only a real spawn proves they don't
//     accidentally interleave.

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST_CLI = resolve(HERE, '..', '..', 'dist', 'cli.mjs');

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Extra env to merge on top of the sanitized base. Wins on conflict. */
  env?: Record<string, string>;
  /** Override timeout. Default 20s. */
  timeoutMs?: number;
}

/**
 * Spawn `dist/cli.mjs` with a deterministic environment.
 *
 * `XDG_CONFIG_HOME` points at a caller-supplied scratch dir so the test
 * never touches the real session file. `NO_COLOR=1` strips ANSI from
 * any plain-text output (machine consumers shouldn't see it). `stdin`
 * is closed (execFile default) so commands that prompt would error
 * rather than hang the test.
 */
export async function runCli(
  args: readonly string[],
  xdgConfigHome: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const baseEnv: Record<string, string> = {};
  // Whitelist host env. Inheriting `process.env` wholesale would let
  // a developer's `AITCC_*` or `XDG_*` settings leak into the child
  // and make the test pass/fail based on machine state.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    const v = process.env[key];
    if (v !== undefined) baseEnv[key] = v;
  }
  baseEnv.NO_COLOR = '1';
  baseEnv.XDG_CONFIG_HOME = xdgConfigHome;

  try {
    const { stdout, stderr } = await execFileP(process.execPath, [DIST_CLI, ...args], {
      env: { ...baseEnv, ...opts.env },
      timeout: opts.timeoutMs ?? 20_000,
      // Cap captured output so a runaway command can't OOM the runner.
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    if (typeof e.code !== 'number') {
      // Spawn failed (ENOENT) or was killed by timeout — re-throw so the
      // test stops with a clear error rather than asserting on partial
      // output.
      throw err;
    }
    return {
      exitCode: e.code,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/**
 * Assert the `emitJson` invariant: exactly one JSON line followed by a
 * trailing `\n`. Returns the parsed payload for further inspection.
 *
 * `endsWith('\n')` alone isn't enough — multi-line output also satisfies
 * it. We require `split('\n').length === 2` with an empty trailer.
 */
export function assertSingleJsonLine(stdout: string): unknown {
  expect(stdout.endsWith('\n')).toBe(true);
  const parts = stdout.split('\n');
  expect(parts.length).toBe(2);
  expect(parts[1]).toBe('');
  const line = parts[0] as string;
  expect(line.length).toBeGreaterThan(0);
  return JSON.parse(line);
}

/**
 * Assert no line on stderr parses as JSON. Plain-text diagnostics are
 * fine; a JSON document on stderr is a contract violation that would
 * confuse agent-plugin if it ever fell back to scanning both streams.
 */
export function assertStderrHasNoJson(stderr: string): void {
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

/**
 * No printable byte in stdout should be an ANSI escape. `NO_COLOR=1` is
 * already set in the spawn env, but a regression that hard-codes color
 * would slip past until something downstream (e.g. a log aggregator)
 * flagged it.
 */
export function assertNoAnsi(s: string): void {
  // ESC = 0x1b. The full SGR pattern is ESC[ ... m, but any ESC byte
  // in a `--json` payload is a bug worth failing on.
  expect(s.includes('')).toBe(false);
}

/**
 * Tracks tmp dirs created during a test file run and exposes a single
 * cleanup hook. Avoids per-test `tmpDirs.push(...)` boilerplate.
 */
export function makeXdgFactory(): {
  fresh: () => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const dirs: string[] = [];
  return {
    async fresh() {
      const dir = await mkdtemp(join(tmpdir(), 'aitcc-cli-subproc-'));
      dirs.push(dir);
      return dir;
    },
    async cleanup() {
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Verify the build artifact exists. Run from a `beforeAll` so failures
 * surface as a clear error instead of a confusing ENOENT inside the
 * spawn. CI runs `pnpm build` before `pnpm test`; local devs need to
 * remember to do the same — the error message points there.
 */
export function ensureCliBuilt(): void {
  if (!existsSync(DIST_CLI)) {
    throw new Error(
      `dist/cli.mjs not found at ${DIST_CLI}. Run \`pnpm build\` before \`pnpm test\`.`,
    );
  }
}
