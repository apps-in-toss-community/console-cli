import { defineCommand } from 'citty';
import {
  KR_ONLY_WARNING_KEY,
  KR_ONLY_WARNING_LONG,
  KR_ONLY_WARNING_SHORT,
} from '../auth/kr-only-warning.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  decodeSessionBlob,
  normalizeValidatedSession,
  readSession,
  type Session,
  sessionPathForDiagnostics,
  validateSessionBlob,
  type WriteSessionOptions,
  writeSession,
} from '../session.js';
import { emitJson } from './_shared.js';

// `aitcc auth import` — validate a portable session blob and write it
// (mode 0600) to the local session file. Symmetric with `auth export`.
//
// Use cases (in order of frequency):
//   - Restore a session on a new desktop without redoing OAuth flow.
//   - Recover from a hand-edited session.json with `--dry-run` for shape
//     validation feedback before writing.
// CI almost never needs this: in CI the recommended path is to set the
// `AITCC_SESSION` env var directly (no file write, no 0600 negotiation
// with shared runners).
//
// --json contract (consumed by agent-plugin):
//
//   { ok: true, replaced: boolean, user: { id, email, displayName? },
//     dryRun?: true,
//     warning: 'kr-only-cookies', warningMessage: <string> }              exit 0
//   { ok: false, reason: 'no-input', message }                            exit 2
//   { ok: false, reason: 'env-not-set', message }                         exit 2
//   { ok: false, reason: 'invalid-blob', detail }                         exit 2
//   { ok: false, reason: 'write-failed', message }                        exit 1

export interface AuthImportArgs {
  readonly json: boolean;
  readonly fromEnv: boolean;
  readonly dryRun: boolean;
}

export interface AuthImportDeps {
  // Test seams.
  readonly readStdin?: () => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinIsTTY?: boolean;
  readonly readExistingSession?: () => Promise<Session | null>;
  readonly writeSession?: (s: Session, opts?: WriteSessionOptions) => Promise<void>;
}

export async function runAuthImport(
  args: AuthImportArgs,
  deps: AuthImportDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;

  // Sourcing: explicit --from-env wins; otherwise stdin. We refuse to
  // prompt or block on a TTY-attached stdin — the import flow is meant
  // for piped use (`aitcc auth import < session.json`) or `--from-env`,
  // and a hung blocking read on a developer terminal would look broken.
  let raw: string;
  if (args.fromEnv) {
    const envValue = env.AITCC_SESSION;
    if (!envValue) {
      emitFailure(args.json, 'env-not-set', 'AITCC_SESSION is not set; export it first.');
      return exitAfterFlush(ExitCode.Usage);
    }
    raw = envValue;
  } else {
    const stdinIsTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    if (stdinIsTTY) {
      emitFailure(
        args.json,
        'no-input',
        'No stdin pipe detected. Pipe a session JSON in or pass --from-env.',
      );
      return exitAfterFlush(ExitCode.Usage);
    }
    raw = await (deps.readStdin ?? readStdinToString)();
    if (raw.trim().length === 0) {
      emitFailure(args.json, 'no-input', 'stdin was empty.');
      return exitAfterFlush(ExitCode.Usage);
    }
  }

  // Auto-detect base64 vs raw JSON. `decodeSessionBlob` peeks at the
  // body for a leading `{` so users can paste either shape without a
  // flag. Symmetric with the env-precedence path in session.ts.
  const decoded = decodeSessionBlob(raw);
  if (decoded === null) {
    emitFailure(args.json, 'invalid-blob', 'could not parse blob as JSON or base64-encoded JSON');
    return exitAfterFlush(ExitCode.Usage);
  }
  const reason = validateSessionBlob(decoded);
  if (reason) {
    emitFailure(args.json, 'invalid-blob', reason);
    return exitAfterFlush(ExitCode.Usage);
  }

  const session = normalizeValidatedSession(decoded);

  // `replaced` is informational — no overwrite confirm. CI use of
  // `auth import` is rare (env path is preferred); local restore is the
  // primary case and the user is the one running the command.
  const existing = await (deps.readExistingSession ?? readSession)().catch(() => null);
  const replaced = existing !== null;

  if (args.dryRun) {
    if (args.json) {
      emitJson({
        ok: true,
        dryRun: true,
        replaced,
        user: session.user,
        warning: KR_ONLY_WARNING_KEY,
        warningMessage: KR_ONLY_WARNING_LONG,
      });
    } else {
      const cookies = session.cookies.length;
      process.stdout.write(
        `dry-run: blob is valid (${session.user.email}, ${cookies} cookies). Skipping write.\n`,
      );
      process.stderr.write(`warning: ${KR_ONLY_WARNING_SHORT}\n`);
    }
    return exitAfterFlush(ExitCode.Ok);
  }

  // Write path. We deliberately call `writeSession` even when reading
  // from --from-env; the user explicitly invoked import to persist, and
  // the env-write no-op in session.ts would otherwise swallow the write
  // silently. The `forceWrite` option opts into the write path without
  // touching `process.env` — the env no-op exists to protect commands
  // that *might* accidentally write (like `workspace use` on a CI host),
  // not the command whose entire job is to write.
  try {
    await (deps.writeSession ?? writeSession)(session, { forceWrite: true });
  } catch (err) {
    const message = (err as Error).message;
    if (args.json) {
      emitJson({ ok: false, reason: 'write-failed', message });
    } else {
      process.stderr.write(`Failed to write session file: ${message}\n`);
    }
    return exitAfterFlush(ExitCode.Generic);
  }

  if (args.json) {
    emitJson({
      ok: true,
      replaced,
      user: session.user,
      warning: KR_ONLY_WARNING_KEY,
      warningMessage: KR_ONLY_WARNING_LONG,
    });
  } else {
    const path = sessionPathForDiagnostics();
    const cookies = session.cookies.length;
    const verb = replaced ? 'replaced' : 'wrote';
    process.stdout.write(
      `ok — ${verb} session at ${path} (${session.user.email}, ${cookies} cookies)\n`,
    );
    process.stderr.write(`warning: ${KR_ONLY_WARNING_SHORT}\n`);
  }
  return exitAfterFlush(ExitCode.Ok);
}

function emitFailure(json: boolean, reason: string, detail: string): void {
  if (json) {
    emitJson({
      ok: false,
      reason,
      ...(reason === 'invalid-blob' ? { detail } : { message: detail }),
    });
  } else {
    process.stderr.write(`${reason}: ${detail}\n`);
  }
}

async function readStdinToString(): Promise<string> {
  // process.stdin is a Readable stream; collect to one buffer.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const authImportCommand = defineCommand({
  meta: {
    name: 'import',
    description:
      'Validate a portable session blob and write it to the local session file. KR-only.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    'from-env': {
      type: 'boolean',
      description: 'Read the blob from the AITCC_SESSION env var instead of stdin.',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate the blob without writing the session file.',
      default: false,
    },
  },
  async run({ args }) {
    return runAuthImport({
      json: args.json,
      fromEnv: Boolean(args['from-env']),
      dryRun: Boolean(args['dry-run']),
    });
  },
});
