import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoAnsi,
  assertSingleJsonLine,
  assertStderrHasNoJson,
  ensureCliBuilt,
  makeXdgFactory,
  runCli,
} from './_runCli.js';

// Subprocess harness: spawns the built `dist/cli.mjs` to lock down the
// `--json` contract that agent-plugin consumes. Each case picks a failure
// branch that does not require a live session or HTTP, so the test stays
// hermetic. The invariants we assert are command-agnostic:
//   1. stdout is exactly one line ending with `\n` (single JSON document).
//   2. stdout parses as JSON matching the documented shape.
//   3. exit code matches the contract in `commands/*.ts` and `src/exit.ts`.
//   4. stderr never contains JSON — it is plain-text diagnostics only,
//      and is empty for `--json` mode on these failure paths.
//
// Helpers live in `_runCli.ts`. Add a case here whenever a new command's
// `--json` shape would benefit from drift detection at the process boundary.

describe('aitcc --json subprocess contract', () => {
  const xdg = makeXdgFactory();

  beforeAll(() => {
    ensureCliBuilt();
  });

  afterEach(async () => {
    await xdg.cleanup();
  });

  describe('workspace', () => {
    it('workspace ls --json with no session emits not-authenticated and exits 10', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['workspace', 'ls', '--json'], dir);
      expect(exitCode).toBe(10);
      const payload = assertSingleJsonLine(stdout);
      expect(payload).toEqual({ ok: true, authenticated: false });
      assertStderrHasNoJson(stderr);
      expect(stderr).toBe('');
    }, 30_000);

    it('workspace use abc --json emits invalid-id and exits 2', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['workspace', 'use', 'abc', '--json'], dir);
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
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['workspace', 'use', '0', '--json'], dir);
      expect(exitCode).toBe(2);
      const payload = assertSingleJsonLine(stdout) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(payload.reason).toBe('invalid-id');
      // `message` is part of the documented `invalid-id` shape — agent-plugin
      // displays it to the user. Lock it down here too so a regression that
      // empties or drops the field on numeric-but-invalid ids is caught.
      expect(typeof payload.message).toBe('string');
      expect((payload.message as string).length).toBeGreaterThan(0);
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
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(
        ['workspace', 'show', '--workspace', 'abc', '--json'],
        dir,
      );
      expect(exitCode).toBe(10);
      const payload = assertSingleJsonLine(stdout);
      expect(payload).toEqual({ ok: true, authenticated: false });
      assertStderrHasNoJson(stderr);
      expect(stderr).toBe('');
    }, 30_000);
  });

  describe('whoami', () => {
    it('whoami --json with no session emits authenticated:false and exits 10', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['whoami', '--json'], dir);
      expect(exitCode).toBe(10);
      const payload = assertSingleJsonLine(stdout);
      expect(payload).toEqual({ ok: true, authenticated: false });
      assertStderrHasNoJson(stderr);
      expect(stderr).toBe('');
      // NO_COLOR=1 is set by the harness — guard against any future
      // hard-coded color codes leaking into the JSON line.
      assertNoAnsi(stdout);
    }, 30_000);
  });

  describe('app', () => {
    // `app status` resolves miniApp id (positional) before reading the
    // session, so an obviously-bad positional reaches the invalid-id
    // branch even with no session. Exercises the `_shared.ts` parser
    // path in addition to the auth gate covered by other cases.
    it('app status xyz --json emits invalid-id and exits 2', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['app', 'status', 'xyz', '--json'], dir);
      expect(exitCode).toBe(2);
      const payload = assertSingleJsonLine(stdout) as Record<string, unknown>;
      expect(payload.ok).toBe(false);
      expect(payload.reason).toBe('invalid-id');
      expect(typeof payload.message).toBe('string');
      assertStderrHasNoJson(stderr);
      expect(stderr).toBe('');
    }, 30_000);

    it('app ls --json with no session emits authenticated:false (exit 10)', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['app', 'ls', '--json'], dir);
      expect(exitCode).toBe(10);
      const payload = assertSingleJsonLine(stdout);
      expect(payload).toEqual({ ok: true, authenticated: false });
      assertStderrHasNoJson(stderr);
      expect(stderr).toBe('');
    }, 30_000);
  });

  describe('logout', () => {
    // logout is the one fail path that returns ok:0 — it's idempotent:
    // "no session to delete" is success, not an error. Locking down the
    // shape ensures agent-plugin can call `logout` blindly.
    it('logout --json with no session emits ok:true status:no-session (exit 0)', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['logout', '--json'], dir);
      expect(exitCode).toBe(0);
      const payload = assertSingleJsonLine(stdout) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.status).toBe('no-session');
      expect(typeof payload.path).toBe('string');
      assertStderrHasNoJson(stderr);
      expect(stderr).toBe('');
    }, 30_000);
  });

  describe('auth status', () => {
    // auth status exits 0 even on a clean machine — it reports presence,
    // not auth state. Useful as the only "stable across no-state" case.
    it('auth status --json on a clean machine emits ok:true with stored:false (exit 0)', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['auth', 'status', '--json'], dir);
      expect(exitCode).toBe(0);
      const payload = assertSingleJsonLine(stdout) as {
        ok: boolean;
        credentials: { stored: boolean };
        session: { active: boolean };
      };
      expect(payload.ok).toBe(true);
      expect(payload.credentials.stored).toBe(false);
      expect(payload.session.active).toBe(false);
      assertStderrHasNoJson(stderr);
    }, 30_000);
  });

  describe('--version', () => {
    // citty handles `--version` itself — it doesn't go through `emitJson`.
    // Lock that down so a future change adding `--json` parity here is
    // an intentional decision, not a silent regression. Today the
    // contract is: stdout is the bare version string + `\n`, stderr is
    // empty, exit 0. Agent-plugin reads it via `aitcc --version` (no
    // `--json`), so this is the consumer-visible shape.
    it('--version emits a bare semver-shaped line and exits 0', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['--version'], dir);
      expect(exitCode).toBe(0);
      expect(stdout.endsWith('\n')).toBe(true);
      const trimmed = stdout.trim();
      expect(trimmed).toMatch(/^\d+\.\d+\.\d+/);
      expect(stderr).toBe('');
      assertNoAnsi(stdout);
    }, 30_000);
  });

  describe('unknown command', () => {
    // citty rejects unknown subcommands with a help dump on stdout +
    // a diagnostic on stderr, exit non-zero. This is *not* `--json`-clean,
    // but agent-plugin would never send an unknown command; pinning the
    // structural shape (diagnostic on stderr, help on stdout, no ANSI in
    // either) protects against an upstream citty change that shifts the
    // help text to stderr — which would interleave with our diagnostic
    // stream and confuse log aggregators. We deliberately do NOT pin
    // citty's exact wording ("Unknown command X" vs "Unrecognized command")
    // since that's an internal detail that can change in a citty minor.
    it('aitcc nope --json exits non-zero, diagnostic on stderr, help on stdout', async () => {
      const dir = await xdg.fresh();
      const { exitCode, stdout, stderr } = await runCli(['nope', '--json'], dir);
      expect(exitCode).not.toBe(0);
      expect(stderr.length).toBeGreaterThan(0);
      expect(stdout.length).toBeGreaterThan(0);
      assertNoAnsi(stdout);
      assertNoAnsi(stderr);
    }, 30_000);
  });
});
