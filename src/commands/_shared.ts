import { describeApiError } from '../api/error-messages.js';
import { NetworkError, TossApiError } from '../api/http.js';
import type { UserTerm } from '../api/me.js';
import type { CredentialsSource } from '../auth/credentials.js';
import { loadCredentials } from '../auth/credentials.js';
import { type HeadlessLoginResult, headlessLoginFromCredentials } from '../auth/headless-login.js';
import { findProjectContext, type ProjectContext } from '../config/project-context.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  isEnvSessionActive,
  readSession,
  type Session,
  sessionPathForDiagnostics,
} from '../session.js';

// Shared output helpers used by every session-scoped subcommand
// (`workspace`, `app`, `members`, `keys`, and the in-flight `deploy`/`logs`).
// Kept in one place so all commands agree on the `--json` contract — one
// line, trailing \n, stdout for structured output, stderr for diagnostics.
//
// Cross-cutting failure shapes (emitted from every session/app/workspace-
// scoped command — per-command `--json contract` blocks may add their own
// reasons on top, but these are universal):
//
//   Auth/network/API:
//     { ok: true, authenticated: false }                              exit 10
//     { ok: false, reason: 'network-error', message }                 exit 11
//     { ok: false, reason: 'api-error', status?, errorCode?, message } exit 17
//
//   Context resolution (any command that goes through
//   `resolveWorkspaceContext` / `resolveAppOrFail`):
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//       (--workspace value, positional <appId>, or --app value malformed)
//     { ok: false, reason: 'invalid-env', message }                   exit 2
//       (AITCC_WORKSPACE or AITCC_APP env var contains a non-positive-int)
//     { ok: false, reason: 'no-workspace-selected' }                  exit 2
//       (no flag/env/yaml/session source supplied a workspace id)
//
//   App-scoped commands additionally:
//     { ok: false, reason: 'missing-app-id', message }                exit 2
//       (workspace resolved but no source supplied a miniApp id)
//
// See any per-command `--json contract` block (e.g. `commands/workspace.ts`)
// for the success-shape specific to that command and any command-specific
// reasons stacked on top of these.

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
  details?: { status?: number; errorCode?: string; hint?: string },
): void {
  if (json) {
    emitJson({
      ok: false,
      reason: 'api-error',
      ...(details?.status !== undefined ? { status: details.status } : {}),
      ...(details?.errorCode !== undefined ? { errorCode: details.errorCode } : {}),
      ...(details?.hint !== undefined ? { hint: details.hint } : {}),
      message,
    });
  } else {
    process.stderr.write(`Unexpected error: ${message}\n`);
    if (details?.hint !== undefined) process.stderr.write(`${details.hint}\n`);
  }
}

// Some error codes have a concrete CLI remedy. When we recognise one, we
// attach a one-line `hint` so the seam to the fixing command is printed
// instead of leaving the user to discover it. `5010` (혁신금융서비스 약관
// 미동의 — AI-risk disclosure/usage terms) gates Deploy Key issuance and
// almost every other workspace read/write at the *account* level; the fix
// is `aitcc me terms agree --scope AI_RISK_USE`. Returns `undefined` for
// codes with no known CLI remedy (most numeric codes pass through verbatim
// — see docs/api/_error-codes.md).
export function hintForErrorCode(errorCode: string | undefined): string | undefined {
  if (errorCode === '5010') {
    return (
      'AI 위험 고지·이용약관(AI_RISK_USE) 동의가 필요해요. ' +
      '`aitcc me terms --scope AI_RISK_USE`로 약관을 확인하고, ' +
      '`aitcc me terms agree --scope AI_RISK_USE`로 동의하세요 ' +
      '(법적 동의 — 계정 소유자가 직접 링크를 검토한 뒤 동의해야 하며, ' +
      '비대화형/--json 환경에서는 --yes로 확인).'
    );
  }
  return undefined;
}

// Terse, stderr-only preflight warning for the AI_RISK_USE (5010) gate.
// Reuses hintForErrorCode('5010') for the actionable line so the preflight
// and the post-failure hint never drift. Renders ONLY public title/
// contentsUrl (SECRET-HANDLING: never cookies / Cookie header / GET URL).
export function formatAiRiskPreflightWarning(pending: readonly UserTerm[]): string {
  const lines: string[] = [];
  lines.push(
    '[warn] AI 위험 고지·이용약관(AI_RISK_USE) 미동의 상태예요 — 이 명령이 errorCode 5010으로 막힐 수 있어요.\n',
  );
  for (const t of pending) {
    lines.push(`  - ${t.title}\n      ${t.contentsUrl}\n`);
  }
  // Single-sourced remedy line (= post-failure hint). hintForErrorCode never
  // returns undefined for '5010', but fall back defensively.
  lines.push(`  ${hintForErrorCode('5010') ?? ''}\n`);
  lines.push('  법적 동의라 계정 소유자가 직접 위 링크를 확인하고 동의해야 해요.\n');
  return lines.join('');
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
    const message = describeApiError({
      errorCode: err.errorCode,
      reason: err.reason,
      fallback: err.message,
    });
    const hint = hintForErrorCode(err.errorCode);
    emitApiError(json, message, {
      status: err.status,
      errorCode: err.errorCode,
      ...(hint !== undefined ? { hint } : {}),
    });
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
 * id through the full priority chain (`--workspace` flag → `AITCC_WORKSPACE`
 * env → `aitcc.yaml` → persisted selection), and handles the common failure
 * branches (`no session`, `invalid id`, `invalid env`, `no workspace
 * selected`). On success, the caller gets the session + resolved id +
 * source bookkeeping back so it can `printContextHeader` consistently.
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
}): Promise<
  | (AppContext & {
      session: Session;
    })
  | null
> {
  const session = await acquireSessionOrReauth(args.json);
  if (!session) return null;

  let flagWorkspaceId: number | undefined;
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
    flagWorkspaceId = parsed;
  }

  let app: AppContext;
  try {
    app = await resolveAppContext({
      ...(flagWorkspaceId !== undefined ? { flagWorkspaceId } : {}),
      ...(session.currentWorkspaceId !== undefined
        ? { sessionWorkspaceId: session.currentWorkspaceId }
        : {}),
    });
  } catch (err) {
    await emitAppContextErrorAndExit(args.json, err);
    return null;
  }

  return { session, ...app };
}

/**
 * Session-only sibling of `resolveWorkspaceContext` for commands that
 * don't need a workspace id (notices come from a shared Toss workspace,
 * whoami is self-scoped). Same "exits on miss, returns null to force
 * `if (!session) return`" pattern.
 */
export async function requireSession(json: boolean): Promise<Session | null> {
  return acquireSessionOrReauth(json);
}

// --- Dependency injection seams (for testing) ---

// Single source of truth for the reauth breadcrumb text. Both
// `acquireSessionOrReauth` (session-absent path) and `withReauthRetry`
// (mid-flight 401 path) emit the same line so the operator sees a
// consistent signal regardless of which path fired.
// SECRET-HANDLING: this string must never contain cookies / credentials /
// full URLs with query strings.
const REAUTH_BREADCRUMB = 'Session expired — re-authenticating with saved credentials…\n';

export interface AcquireSessionDeps {
  /** Override for readSession — defaults to the real fs-backed reader. */
  readonly readSession?: () => Promise<Session | null>;
  /** Override for loadCredentials — defaults to the real credential loader. */
  readonly loadCredentials?: () => Promise<CredentialsSource | null>;
  /**
   * Override for the headless-login call — defaults to
   * `headlessLoginFromCredentials`.  Receives only email + password so
   * tests never need real Chrome.
   */
  readonly headlessLogin?: (input: {
    email: string;
    password: string;
  }) => Promise<HeadlessLoginResult>;
}

/**
 * Acquire a live session, transparently re-authenticating with saved file
 * credentials when the session is absent and the conditions allow it.
 *
 * Priority / carve-out matrix:
 *   1. Session present → return it immediately (happy path, zero I/O).
 *   2. `AITCC_SESSION` env active (CI mode) → `emitNotAuthenticated` + exit 10.
 *      Never auto-spawn in CI — the operator controls the session blob.
 *   3. No file credentials (`loadCredentials` → null) → same exit.
 *   4. Credentials from env (`kind: 'env'`) → same exit.
 *      `AITCC_EMAIL`+`AITCC_PASSWORD` are single-shot CI injections;
 *      a missing session there means the session has truly expired for
 *      this run and the operator should rotate the secret, not headlessly
 *      re-login on every invocation.
 *   5. Credentials from file (`kind: 'file'`) → attempt ONE headless login.
 *      - `ok`          → return the newly-written session.
 *      - `step-up-needed` → print step-up message + exit 10.
 *      - `failed`      → print generic reauth-failed message + exit 10.
 *
 * The `deps` parameter is an injection seam for unit tests — production
 * callers leave it undefined and get the real implementations.
 *
 * Returns `null` only after `exitAfterFlush` is called (which terminates
 * the process), so `null` is a type-level "force `if (!session) return`"
 * handshake that mirrors the pattern used by `requireSession`,
 * `resolveWorkspaceContext`, and `resolveAppOrFail`.
 */
export async function acquireSessionOrReauth(
  json: boolean,
  deps?: AcquireSessionDeps,
): Promise<Session | null> {
  const doReadSession = deps?.readSession ?? readSession;
  const doLoadCredentials = deps?.loadCredentials ?? loadCredentials;
  const doHeadlessLogin =
    deps?.headlessLogin ??
    ((input: { email: string; password: string }) =>
      headlessLoginFromCredentials({ email: input.email, password: input.password }));

  // 1. Session already present — nothing to do.
  const existing = await doReadSession();
  if (existing) return existing;

  // 2. AITCC_SESSION env is active (CI mode) — never auto-spawn.
  if (isEnvSessionActive()) {
    emitNotAuthenticated(json);
    await exitAfterFlush(ExitCode.NotAuthenticated);
    return null;
  }

  // 3 & 4. Load credentials; bail out when none found or env-sourced.
  const cred = await doLoadCredentials();
  if (!cred || cred.kind === 'env') {
    emitNotAuthenticated(json);
    await exitAfterFlush(ExitCode.NotAuthenticated);
    return null;
  }

  // 5. File-sourced credentials — attempt ONE headless login.
  process.stderr.write(REAUTH_BREADCRUMB);

  const result = await doHeadlessLogin({ email: cred.email, password: cred.password });

  if (result.kind === 'ok') {
    // Return the freshly-written session (already in result.session).
    return result.session;
  }

  if (result.kind === 'step-up-needed') {
    process.stderr.write(
      'Re-authentication requires a step-up (Toss app push). ' +
        'Run `aitcc login` to complete the sign-in interactively.\n',
    );
    emitNotAuthenticated(json);
    await exitAfterFlush(ExitCode.NotAuthenticated);
    return null;
  }

  // result.kind === 'failed'
  process.stderr.write(
    'Automatic re-authentication failed. Run `aitcc login` to start a new session.\n',
  );
  emitNotAuthenticated(json);
  await exitAfterFlush(ExitCode.NotAuthenticated);
  return null;
}

/**
 * Run a read-only API thunk and, on a genuine expired-session 401 (not a
 * geo-block), attempt exactly ONE transparent re-authentication with saved
 * file credentials and replay the thunk once with the fresh session.
 *
 * Carve-outs (same as `acquireSessionOrReauth`):
 *   - 4010 (geo-block)    → rethrow; reauth is a guaranteed no-op.
 *   - AITCC_SESSION active → rethrow; CI controls the session blob.
 *   - No file credentials → rethrow; nothing to reauth with.
 *   - Env credentials     → rethrow; single-shot CI injection.
 *
 * On terminal reauth failure the original TossApiError is rethrown so the
 * caller's existing `catch → emitFailureFromError` handler prints "Session
 * is no longer valid. Run `aitcc login` again." without any change.
 *
 * This function is generic over `T` and CANNOT return null on failure — it
 * either returns `T` or throws. That keeps it a pure enhancement: wrap the
 * live API call, leave the `catch` block alone.
 *
 * MUTATIONS must NOT be wrapped — a replayed mutation could double-submit.
 * Only read operations (fetch*, list*) belong here.
 *
 * The `deps` parameter is an injection seam for unit tests — production
 * callers leave it undefined and get the real implementations.
 */
export async function withReauthRetry<T>(
  json: boolean,
  session: Session,
  run: (session: Session) => Promise<T>,
  deps?: AcquireSessionDeps,
): Promise<T> {
  void json; // intentionally unused — see comment above
  try {
    return await run(session);
  } catch (err) {
    // Only intercept a genuine expired-session 401, not geo-blocks or other
    // API / network errors — let those propagate to the caller's catch block.
    if (!(err instanceof TossApiError) || !err.isExpiredSession) {
      throw err;
    }

    // Carve-outs: CI / no-file-creds paths must never auto-spawn reauth.
    const doLoadCredentials = deps?.loadCredentials ?? loadCredentials;

    if (isEnvSessionActive()) {
      throw err;
    }
    const cred = await doLoadCredentials();
    if (!cred || cred.kind === 'env') {
      throw err;
    }

    // File credentials present — attempt ONE headless login.
    // SECRET-HANDLING: breadcrumb contains no cookie/credential/URL values.
    process.stderr.write(REAUTH_BREADCRUMB);

    const doHeadlessLogin =
      deps?.headlessLogin ??
      ((input: { email: string; password: string }) =>
        headlessLoginFromCredentials({ email: input.email, password: input.password }));

    const result = await doHeadlessLogin({ email: cred.email, password: cred.password });

    if (result.kind === 'ok') {
      // Replay the read exactly once with the fresh session. If the replay
      // itself throws, propagate without a second reauth attempt.
      return await run(result.session);
    }

    if (result.kind === 'step-up-needed') {
      process.stderr.write(
        'Re-authentication requires a step-up (Toss app push). ' +
          'Run `aitcc login` to complete the sign-in interactively.\n',
      );
      // Rethrow the original 401 so the caller's emitFailureFromError prints
      // "Session is no longer valid" and exits with the standard exit code.
      throw err;
    }

    // result.kind === 'failed' — rethrow original error.
    throw err;
  }
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

  let miniApp: { miniAppId: number; miniAppIdSource: ContextSource } | undefined;
  if (input.flagMiniAppId !== undefined) {
    miniApp = { miniAppId: input.flagMiniAppId, miniAppIdSource: 'flag' };
  } else if (envMiniApp !== undefined) {
    miniApp = { miniAppId: envMiniApp, miniAppIdSource: 'env' };
  } else if (project?.miniAppId !== undefined && workspaceSource !== 'flag') {
    miniApp = { miniAppId: project.miniAppId, miniAppIdSource: 'yaml' };
  }

  return {
    workspaceId,
    workspaceSource,
    ...(miniApp !== undefined ? miniApp : {}),
    ...(project !== null ? { projectFile: project.source } : {}),
  };
}

/**
 * Common failure-emitter for `AppContextError` produced by the priority
 * chain. Workspace-scoped (`resolveWorkspaceContext`) and app-scoped
 * (`resolveAppOrFail`) callers both feed any thrown `AppContextError`
 * through here so the `--json` shape and exit code stay aligned across
 * the two entry points.
 */
async function emitAppContextErrorAndExit(json: boolean, err: unknown): Promise<void> {
  if (err instanceof AppContextError && err.reason === 'invalid-env') {
    if (json) emitJson({ ok: false, reason: 'invalid-env', message: err.message });
    else process.stderr.write(`${err.message}\n`);
    await exitAfterFlush(ExitCode.Usage);
    return;
  }
  if (err instanceof AppContextError && err.reason === 'no-workspace-selected') {
    if (json) emitJson({ ok: false, reason: 'no-workspace-selected' });
    else process.stderr.write(`${err.message}\n`);
    await exitAfterFlush(ExitCode.Usage);
    return;
  }
  throw err;
}

/**
 * Boilerplate wrapper for app-scoped commands (`app show`, `app status`,
 * `app bundles ls`, ...). Builds on `resolveWorkspaceContext` — every
 * app-scoped command also loads the session and resolves the workspace
 * — and additionally accepts a positional `<appId>` value (or per-command
 * `--app` flag value) that feeds into the miniApp priority chain.
 *
 * `args.id` is the raw positional value as citty surfaces it. We accept
 * `unknown` because citty hands back `string | undefined`, but tests
 * sometimes pass `number` literals; guarding with `String(...)` matches
 * the parsing the per-command early-validation used to do.
 *
 * On a malformed positional we emit the same `invalid-id` shape that the
 * pre-PR-1b commands used so agent-plugin's parsing is unchanged.
 *
 * Returns `null` after exiting on every failure branch, mirroring
 * `resolveWorkspaceContext`. Callers must `if (!ctx) return;`.
 */
export async function resolveAppOrFail(args: {
  workspace?: string | undefined;
  /** Raw positional/flag value for the mini-app id. */
  appIdRaw?: unknown;
  /** Field name to surface in error messages (`id` or `app`). */
  appIdField?: 'id' | 'app';
  json: boolean;
}): Promise<
  | (AppContext & {
      session: Session;
    })
  | null
> {
  // Parse the explicit positional/flag first so a typo is rejected before
  // we let yaml/env quietly take over — `aitcc app status 42x` should not
  // silently fall through to the yaml miniAppId.
  let flagMiniAppId: number | undefined;
  const raw = args.appIdRaw;
  if (raw !== undefined && raw !== null && raw !== '') {
    const str = typeof raw === 'string' ? raw : String(raw);
    const parsed = parsePositiveInt(str);
    if (parsed === null) {
      const field = args.appIdField === 'app' ? '--app' : 'app id';
      const message = `${field} must be a positive integer (got ${JSON.stringify(str)})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-id', message });
      else process.stderr.write(`${message}\n`);
      await exitAfterFlush(ExitCode.Usage);
      return null;
    }
    flagMiniAppId = parsed;
  }

  const session = await acquireSessionOrReauth(args.json);
  if (!session) return null;

  let flagWorkspaceId: number | undefined;
  if (args.workspace) {
    const wsRaw = String(args.workspace);
    const parsed = parsePositiveInt(wsRaw);
    if (parsed === null) {
      const message = `--workspace must be a positive integer (got ${wsRaw})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-id', message });
      else process.stderr.write(`${message}\n`);
      await exitAfterFlush(ExitCode.Usage);
      return null;
    }
    flagWorkspaceId = parsed;
  }

  let app: AppContext;
  try {
    app = await resolveAppContext({
      ...(flagWorkspaceId !== undefined ? { flagWorkspaceId } : {}),
      ...(flagMiniAppId !== undefined ? { flagMiniAppId } : {}),
      ...(session.currentWorkspaceId !== undefined
        ? { sessionWorkspaceId: session.currentWorkspaceId }
        : {}),
    });
  } catch (err) {
    await emitAppContextErrorAndExit(args.json, err);
    return null;
  }

  return { session, ...app };
}

/**
 * Emit the standard "miniApp id required" failure for app-scoped commands
 * whose context resolved a workspace but no miniApp. Returns `null` after
 * exiting so the caller can `if (!miniAppId) return;` without an extra
 * branch. Lifted into `_shared.ts` so every Group A command emits the
 * same JSON shape.
 */
export async function requireMiniAppId(ctx: AppContext, json: boolean): Promise<number | null> {
  if (ctx.miniAppId !== undefined) return ctx.miniAppId;
  const message =
    'app id required (provide as argument, --app flag, AITCC_APP env, or `miniAppId` in aitcc.yaml)';
  if (json) emitJson({ ok: false, reason: 'missing-app-id', message });
  else process.stderr.write(`${message}\n`);
  await exitAfterFlush(ExitCode.Usage);
  return null;
}

function describeSource(
  source: ContextSource,
  kind: 'workspace' | 'app',
  projectFile: string | undefined,
): string {
  if (source === 'flag') return kind === 'workspace' ? '(from --workspace)' : '(from --app)';
  if (source === 'env')
    return kind === 'workspace' ? '(from $AITCC_WORKSPACE)' : '(from $AITCC_APP)';
  if (source === 'yaml') {
    // Use the simple file label (`aitcc.yaml` / `aitcc.json`) rather than
    // the absolute path so the header stays short on deep checkouts. The
    // exact path is in `ctx.projectFile` for callers that want it.
    if (projectFile !== undefined) {
      const slash = Math.max(projectFile.lastIndexOf('/'), projectFile.lastIndexOf('\\'));
      const base = slash >= 0 ? projectFile.slice(slash + 1) : projectFile;
      return `(from ${base})`;
    }
    return '(from aitcc.yaml)';
  }
  return '(from session)';
}

/**
 * Print the one-line `[workspace: … · app: …]` context header to stderr
 * before a command emits its real output. Suppressed under `--json` so
 * machine-readable callers see only the structured stdout. Stays on
 * stderr (not stdout) so it never lands in pipes that grep stdout, and
 * stays out of TTY-only branches so CI logs still record what context
 * was used.
 */
export function printContextHeader(ctx: AppContext, opts: { json: boolean }): void {
  if (opts.json) return;
  const wsTag = describeSource(ctx.workspaceSource, 'workspace', ctx.projectFile);
  let line = `[workspace: ${ctx.workspaceId} ${wsTag}`;
  if (ctx.miniAppId !== undefined && ctx.miniAppIdSource !== undefined) {
    const appTag = describeSource(ctx.miniAppIdSource, 'app', ctx.projectFile);
    line += ` · app: ${ctx.miniAppId} ${appTag}`;
  }
  line += ']\n';
  process.stderr.write(line);
}
