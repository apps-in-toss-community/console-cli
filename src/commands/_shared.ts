import { NetworkError, TossApiError } from '../api/http.js';
import { findProjectContext, type ProjectContext } from '../config/project-context.js';
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

export function emitApiError(
  json: boolean,
  message: string,
  details?: { status?: number; errorCode?: string },
): void {
  if (json) {
    emitJson({
      ok: false,
      reason: 'api-error',
      ...(details?.status !== undefined ? { status: details.status } : {}),
      ...(details?.errorCode !== undefined ? { errorCode: details.errorCode } : {}),
      message,
    });
  } else {
    process.stderr.write(`Unexpected error: ${message}\n`);
  }
}

/**
 * Shared auth/network/api dispatch. Every session-scoped command's
 * `catch (err)` block boils down to the same sequence: TossApiError
 * (auth → exit 10, otherwise → exit 17 with status + errorCode),
 * NetworkError (exit 11), fallback (exit 17 with just a message).
 * Exists so we get a single source of truth for the api-error JSON
 * shape — previously each command duplicated the if/else ladder and
 * `register` diverged (it exposed `status`/`errorCode` that the others
 * didn't) until this extraction lined them up.
 *
 * Returns `Promise<void>` but never returns at runtime: every branch
 * awaits `exitAfterFlush` which calls `process.exit`.
 */
export async function emitFailureFromError(json: boolean, err: unknown): Promise<void> {
  if (err instanceof TossApiError && err.isAuthError) {
    emitNotAuthenticated(json, 'session-expired');
    return exitAfterFlush(ExitCode.NotAuthenticated);
  }
  if (err instanceof TossApiError) {
    emitApiError(json, err.message, { status: err.status, errorCode: err.errorCode });
    return exitAfterFlush(ExitCode.ApiError);
  }
  if (err instanceof NetworkError) {
    emitNetworkError(json, err.message);
    return exitAfterFlush(ExitCode.NetworkError);
  }
  emitApiError(json, (err as Error).message);
  return exitAfterFlush(ExitCode.ApiError);
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

/**
 * Session-only sibling of `resolveWorkspaceContext` for commands that
 * don't need a workspace id (notices come from a shared Toss workspace,
 * whoami is self-scoped). Same "exits on miss, returns null to force
 * `if (!session) return`" pattern.
 */
export async function requireSession(json: boolean): Promise<Session | null> {
  const session = await readSession();
  if (!session) {
    emitNotAuthenticated(json);
    await exitAfterFlush(ExitCode.NotAuthenticated);
    return null;
  }
  return session;
}

export type ContextSource = 'flag' | 'env' | 'yaml' | 'session';

export interface AppContext {
  readonly workspaceId: number;
  readonly miniAppId?: number;
  readonly workspaceSource: ContextSource;
  readonly miniAppIdSource?: ContextSource;
  /** Path of the yaml that contributed to the resolution, if any. */
  readonly projectFile?: string;
}

export interface ResolveAppContextInput {
  /** Value from `--workspace <id>` (already parsed by the command). */
  readonly flagWorkspaceId?: number;
  /** Value from a positional `<appId>` (or equivalent flag). */
  readonly flagMiniAppId?: number;
  /** Persisted `currentWorkspaceId`, if a session is loaded. */
  readonly sessionWorkspaceId?: number;
  /** Override for tests; defaults to `process.cwd()`. */
  readonly cwd?: string;
}

export class AppContextError extends Error {
  readonly reason: 'invalid-env' | 'no-workspace-selected';
  constructor(reason: 'invalid-env' | 'no-workspace-selected', message: string) {
    super(message);
    this.name = 'AppContextError';
    this.reason = reason;
  }
}

function readEnvPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = parsePositiveInt(raw);
  if (parsed === null) {
    throw new AppContextError('invalid-env', `${name} must be a positive integer (got ${raw})`);
  }
  return parsed;
}

/**
 * Resolve the app/workspace context for a command invocation by combining
 * flags, env vars, an optional `aitcc.yaml`, and the persisted session.
 *
 * Priority chains (highest first):
 *   workspace: flag > env(AITCC_WORKSPACE) > yaml(workspaceId) > session.currentWorkspaceId
 *   miniApp:   flag > env(AITCC_APP)       > yaml(miniAppId)
 *
 * When the workspace comes from `flag`, any `miniAppId` sourced from
 * `yaml` is dropped — the flag explicitly redirects the workspace, so a
 * yaml `miniAppId` may belong to a different workspace and is unsafe to
 * carry forward. We never fetch the API to verify; that is the caller's
 * job if it matters.
 *
 * Throws `AppContextError('no-workspace-selected', ...)` when no source
 * provides a `workspaceId`. The caller decides how to surface it (most
 * commands map it to `{ ok: false, reason: 'no-workspace-selected' }`
 * with exit code 2 — see `resolveWorkspaceContext`).
 */
export async function resolveAppContext(input: ResolveAppContextInput): Promise<AppContext> {
  const cwd = input.cwd ?? process.cwd();

  let project: ProjectContext | null = null;
  try {
    project = await findProjectContext(cwd);
  } catch {
    // A broken yaml shouldn't take down commands that don't actually need
    // it (the user may have flag-provided everything). Treat as "no
    // project context"; the dedicated manifest loader surfaces a precise
    // error from the commands that do need to read it.
    project = null;
  }

  const envWorkspace = readEnvPositiveInt('AITCC_WORKSPACE');
  const envMiniApp = readEnvPositiveInt('AITCC_APP');

  let workspaceId: number | undefined;
  let workspaceSource: ContextSource | undefined;
  if (input.flagWorkspaceId !== undefined) {
    workspaceId = input.flagWorkspaceId;
    workspaceSource = 'flag';
  } else if (envWorkspace !== undefined) {
    workspaceId = envWorkspace;
    workspaceSource = 'env';
  } else if (project?.workspaceId !== undefined) {
    workspaceId = project.workspaceId;
    workspaceSource = 'yaml';
  } else if (input.sessionWorkspaceId !== undefined) {
    workspaceId = input.sessionWorkspaceId;
    workspaceSource = 'session';
  }

  if (workspaceId === undefined || workspaceSource === undefined) {
    throw new AppContextError(
      'no-workspace-selected',
      'No workspace selected. Pass `--workspace <id>`, set AITCC_WORKSPACE, add `workspaceId` to aitcc.yaml, or run `aitcc workspace use <id>`.',
    );
  }

  let miniAppId: number | undefined;
  let miniAppIdSource: ContextSource | undefined;
  if (input.flagMiniAppId !== undefined) {
    miniAppId = input.flagMiniAppId;
    miniAppIdSource = 'flag';
  } else if (envMiniApp !== undefined) {
    miniAppId = envMiniApp;
    miniAppIdSource = 'env';
  } else if (project?.miniAppId !== undefined && workspaceSource !== 'flag') {
    miniAppId = project.miniAppId;
    miniAppIdSource = 'yaml';
  }

  return {
    workspaceId,
    workspaceSource,
    ...(miniAppId !== undefined ? { miniAppId } : {}),
    ...(miniAppIdSource !== undefined ? { miniAppIdSource } : {}),
    ...(project?.source !== undefined ? { projectFile: project.source } : {}),
  };
}
