import { defineCommand } from 'citty';
import {
  KR_ONLY_WARNING_KEY,
  KR_ONLY_WARNING_LONG,
  KR_ONLY_WARNING_SHORT,
} from '../auth/kr-only-warning.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, type Session } from '../session.js';
import { emitJson } from './_shared.js';

// `aitcc auth export` — dump the live session into a portable blob so it
// can be moved to a KR-resident CI runner via secret manager. Symmetric
// with `auth import`. Read path is `AITCC_SESSION` env var, handled in
// `src/session.ts:readSessionFromEnv` (see CLAUDE.md "Session storage").
//
// --json contract (consumed by agent-plugin):
//
//   { ok: true,
//     format: 'env'|'json',
//     payload: <string for env, object for json>,
//     warning: 'kr-only-cookies',
//     warningMessage: <string> }                                          exit 0
//   { ok: true, authenticated: false }                                    exit 10
//
// SECURITY: this is the ONE command that is allowed to emit cookie
// material on stdout (it's the user's explicit intent). All other
// surfaces redact. The shell-friendly `--format env` line is exactly
// `AITCC_SESSION=<base64>\n` so `eval $(...)` and `>> $GITHUB_ENV`
// both work without quoting gymnastics.

export type AuthExportFormat = 'env' | 'json';

export interface AuthExportArgs {
  readonly json: boolean;
  readonly format: AuthExportFormat;
  readonly quiet: boolean;
}

export interface AuthExportDeps {
  // Test seam: override session source. Production reads `readSession()`
  // which honours `AITCC_SESSION` precedence (re-exporting an env-loaded
  // session is an idempotent no-op by design).
  readonly readSession?: () => Promise<Session | null>;
  readonly stdoutIsTTY?: boolean;
}

export async function runAuthExport(
  args: AuthExportArgs,
  deps: AuthExportDeps = {},
): Promise<void> {
  const session = await (deps.readSession ?? readSession)();

  if (!session) {
    if (args.json) {
      emitJson({ ok: true, authenticated: false });
    } else {
      process.stderr.write('Not logged in. Run `aitcc login` to start a session.\n');
    }
    return exitAfterFlush(ExitCode.NotAuthenticated);
  }

  const blobJson = JSON.stringify(session);

  // --json envelope is independent from --format. The agent-plugin always
  // shells out with --json; --format then picks how the inner `payload`
  // is shaped (one-line env string vs. raw object the user can stuff into
  // a secret manager).
  if (args.json) {
    const payload =
      args.format === 'env'
        ? `AITCC_SESSION=${Buffer.from(blobJson, 'utf8').toString('base64')}`
        : session;
    emitJson({
      ok: true,
      format: args.format,
      payload,
      warning: KR_ONLY_WARNING_KEY,
      warningMessage: KR_ONLY_WARNING_LONG,
    });
    return exitAfterFlush(ExitCode.Ok);
  }

  // Human + shell paths.
  const stdoutIsTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY);

  if (args.format === 'env') {
    const base64 = Buffer.from(blobJson, 'utf8').toString('base64');
    // Exactly one line, single trailing newline — `eval` and `>> $GITHUB_ENV`
    // both depend on this. Resist the urge to add a header/comment.
    process.stdout.write(`AITCC_SESSION=${base64}\n`);
  } else {
    // Raw shape pretty-printed so a human pasting into a secret manager
    // can sanity-check the email / capturedAt before storing.
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  }

  if (!args.quiet) {
    if (stdoutIsTTY) {
      process.stderr.write(
        'Hint: stdout looks like a TTY — redirect to a file or pipe to your secret manager (e.g. `>> $GITHUB_ENV`).\n',
      );
    }
    process.stderr.write(`warning: ${KR_ONLY_WARNING_SHORT}\n`);
    process.stderr.write('See docs/api/auth-session.md for the full constraint.\n');
  }

  return exitAfterFlush(ExitCode.Ok);
}

export const authExportCommand = defineCommand({
  meta: {
    name: 'export',
    description:
      'Dump the active session as a portable blob for CI. Note: KR-only — fails from non-KR IPs.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON envelope to stdout.',
      default: false,
    },
    format: {
      type: 'string',
      description: 'Output shape: `env` (one-line AITCC_SESSION=...) or `json` (raw blob).',
      default: 'env',
    },
    quiet: {
      type: 'boolean',
      description: 'Silence the KR-only warning on stderr (the warning is non-fatal).',
      default: false,
    },
  },
  async run({ args }) {
    const format = parseFormat(args.format);
    if (format === null) {
      // Citty already coerces unknown strings; we still validate to give a
      // crisp `--json` error rather than emitting an env blob with a
      // garbage format label.
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-format',
          message: `unknown --format: ${String(args.format)} (expected 'env' or 'json')`,
        });
      } else {
        process.stderr.write(
          `Unknown --format: ${String(args.format)} (expected 'env' or 'json').\n`,
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    return runAuthExport({ json: args.json, format, quiet: args.quiet });
  },
});

function parseFormat(raw: unknown): AuthExportFormat | null {
  if (raw === 'env' || raw === 'json') return raw;
  return null;
}
