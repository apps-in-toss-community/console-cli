import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, type Session, sessionPathForDiagnostics } from '../session.js';

// Shared output helpers used by every session-scoped subcommand
// (`workspace`, `app`, `members`, `keys`, and the in-flight `deploy`/`logs`).
// Kept in one place so all commands agree on the `--json` contract — one
// line, trailing \n, stdout for structured output, stderr for diagnostics.
//
// Auth / network / API failure shapes are identical across every command:
// { ok: true, authenticated: false } (exit 10), { ok: false,
// reason: 'network-error', message } (exit 11), { ok: false,
// reason: 'api-error', message } (exit 17). See any per-command
// `--json contract` block (e.g. `commands/workspace.ts`) for the full
// exit-code legend plus the success-shape specific to that command —
// those per-command blocks are the source of truth for success payloads.

export interface NotAuthenticatedPayload {
  readonly ok: true;
  readonly authenticated: false;
  readonly reason?: 'session-expired';
}

export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function emitNotAuthenticated(json: boolean, reason?: 'session-expired'): void {
  if (json) {
    // `exactOptionalPropertyTypes` forbids `reason: undefined`, so we omit
    // the key entirely when we don't have a value — hence the branch
    // rather than a single object literal.
    const payload: NotAuthenticatedPayload = reason
      ? { ok: true, authenticated: false, reason }
      : { ok: true, authenticated: false };
    emitJson(payload);
  } else {
    process.stderr.write(
      reason === 'session-expired'
        ? 'Session is no longer valid. Run `aitcc login` again.\n'
        : 'Not logged in. Run `aitcc login` to start a session.\n',
    );
    process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
  }
}

export function emitNetworkError(json: boolean, message: string): void {
  if (json) {
    emitJson({ ok: false, reason: 'network-error', message });
  } else {
    process.stderr.write(`Network error reaching the console API: ${message}.\n`);
  }
}

export function emitApiError(json: boolean, message: string): void {
  if (json) {
    emitJson({ ok: false, reason: 'api-error', message });
  } else {
    process.stderr.write(`Unexpected error: ${message}\n`);
  }
}

// Parse a CLI-provided workspace id strictly: only the form `^[1-9]\d*$`
// is accepted. `Number.parseInt('36577x', 10)` returns 36577, so the CLI
// would otherwise silently accept `workspace use 36577x` and persist the
// wrong thing on a typo. Returning `null` triggers the caller's usage-error
// path. Exported so unit tests can guard against "just use parseInt"
// simplification regressions.
export function parsePositiveInt(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Boilerplate wrapper for any workspace-scoped command (`app ls`,
 * `members ls`, `keys ls`, ...). Loads the session, resolves the workspace
 * id from `--workspace <id>` or the persisted selection, and handles the
 * three common failure branches (`no session`, `invalid id`, `no workspace
 * selected`). On success, the caller gets the session + resolved id back.
 *
 * The return type is `Promise<... | null>` but the `null` branch is never
 * observed at runtime: every failure path `await`s `exitAfterFlush` which
 * calls `process.exit(...)` and doesn't return. The `| null` is a type-
 * level handshake that forces callers to add `if (!ctx) return;`, keeping
 * the bail-out readable.
 */
export async function resolveWorkspaceContext(args: {
  workspace?: string | undefined;
  json: boolean;
}): Promise<{ session: Session; workspaceId: number } | null> {
  const session = await readSession();
  if (!session) {
    emitNotAuthenticated(args.json);
    await exitAfterFlush(ExitCode.NotAuthenticated);
    return null;
  }

  let workspaceId: number | undefined;
  if (args.workspace) {
    const raw = String(args.workspace);
    const parsed = parsePositiveInt(raw);
    if (parsed === null) {
      const message = `--workspace must be a positive integer (got ${raw})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-id', message });
      else process.stderr.write(`${message}\n`);
      await exitAfterFlush(ExitCode.Usage);
      return null;
    }
    workspaceId = parsed;
  } else {
    workspaceId = session.currentWorkspaceId;
  }

  if (workspaceId === undefined) {
    if (args.json) emitJson({ ok: false, reason: 'no-workspace-selected' });
    else {
      process.stderr.write(
        'No workspace selected. Pass `--workspace <id>` or run `aitcc workspace use <id>`.\n',
      );
    }
    await exitAfterFlush(ExitCode.Usage);
    return null;
  }

  return { session, workspaceId };
}
