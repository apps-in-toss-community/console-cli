import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CdpCookie } from './cdp.js';
import { configDir, sessionFilePath } from './paths.js';

// Minimal, forward-compatible session shape. `cookies` mirrors the CDP
// `Network.getAllCookies` payload so the login command can drop it in
// directly and the http layer can replay it against the console API.
//
// SECURITY: this module is the only place that touches the secret material.
// - Never log raw cookies / origins.
// - Treat file IO errors as "no session" in user-facing commands.

export interface SessionUser {
  id: string;
  email: string;
  displayName?: string;
}

export interface Session {
  schemaVersion: 2;
  user: SessionUser;
  // CDP-native cookie list from `Network.getAllCookies`. Treat as opaque
  // secret material outside the login/http code paths.
  cookies: readonly CdpCookie[];
  // Reserved for Playwright `storageState`-style `localStorage` snapshots;
  // empty until a feature needs it.
  origins: unknown[];
  capturedAt: string; // ISO-8601
  // Workspace context. Unset until the user runs `aitcc workspace use <id>`
  // or provides `--workspace` on first use. Writes are explicit — we never
  // guess a default (e.g. "first workspace the user has access to") because
  // a silent guess is exactly the class of bug that causes a deploy to land
  // in the wrong account.
  currentWorkspaceId?: number;
}

// Public-safe projection for `whoami` and other diagnostics.
export interface SessionSummary {
  user: SessionUser;
  capturedAt: string;
}

function summarize(session: Session): SessionSummary {
  return { user: session.user, capturedAt: session.capturedAt };
}

/**
 * Read the persisted session. Returns `null` when no session exists, when
 * the file is corrupt, or when the shape fails validation — each of those
 * emits a one-line warning on stderr for diagnostics.
 *
 * **`AITCC_SESSION` env precedence**: when the env var is set with a valid
 * blob (raw JSON or base64-encoded JSON), this function returns it directly
 * and never touches the session file. This is the read path for the CI
 * single-shot flow seeded by `aitcc auth export`. Invalid env content
 * falls back to the file with a one-shot warning so a typo doesn't
 * silently strand a CI run.
 *
 * **Side effect**: a v1 session file is transparently rewritten to v2 on
 * the first successful read of this process. This keeps read-only callers
 * (`whoami`, `workspace ls`) from stranding users on an old schema. If the
 * rewrite fails, we warn once per process and continue with the in-memory
 * v2 value so the calling command still succeeds. The env path performs
 * the same v1 → v2 upgrade in memory only — env mode never writes.
 */
export async function readSession(): Promise<Session | null> {
  const fromEnv = readSessionFromEnv();
  if (fromEnv !== undefined) return fromEnv;
  const path = sessionFilePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // Some other IO error — surface one-line diagnostic on stderr so the
    // user can tell "permission denied" from "no session". The command
    // still falls back to "not logged in" behaviour.
    process.stderr.write(`warning: could not read session file at ${path}: ${code ?? 'unknown'}\n`);
    return null;
  }
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — warn once, then fall back to "not logged in". The
    // user can re-run `aitcc login` to replace the broken file.
    process.stderr.write(`warning: session file at ${path} is corrupt and will be ignored\n`);
    return null;
  }
  const schemaReason = validateSessionShape(rawParsed);
  if (schemaReason) {
    process.stderr.write(
      `warning: session file at ${path} ignored (${schemaReason}); re-run \`aitcc login\`\n`,
    );
    return null;
  }
  // Post-validation: the shape is trusted. `schemaVersion` is now 1 or 2;
  // v1 files are transparently upgraded to v2 in memory. We best-effort
  // rewrite the file so long-lived v1-on-disk sessions eventually migrate
  // without requiring the user to run a write-shaped command. A failed
  // rewrite is non-fatal (the in-memory shape is correct) but we still
  // emit a one-line stderr warning once per process so a read-only mount
  // or permission issue does not silently persist. We await rather than
  // fire-and-forget so concurrent callers observe consistent on-disk state.
  const validated = rawParsed as { schemaVersion: 1 | 2 } & Omit<Session, 'schemaVersion'>;
  if (validated.schemaVersion === 1) {
    const upgraded: Session = { ...validated, schemaVersion: 2 };
    try {
      await writeSession(upgraded);
    } catch (err) {
      warnMigrationOnce(path, (err as NodeJS.ErrnoException).code);
    }
    return upgraded;
  }
  return validated as Session;
}

// One-shot latch so a failing migration doesn't spam stderr on every call
// inside the same process. Users still get the diagnostic the first time.
let migrationWarned = false;
function warnMigrationOnce(path: string, code: string | undefined): void {
  if (migrationWarned) return;
  migrationWarned = true;
  process.stderr.write(
    `warning: could not migrate session file at ${path} to schemaVersion 2: ${code ?? 'unknown'}\n`,
  );
}

// One-shot latches so we don't spam stderr when many commands read the
// session in a single process (e.g. ctx resolver + http call + diagnostics).
let envFallbackWarned = false;
let envWriteWarned = false;

/**
 * Test-only: reset the one-shot stderr warning latches. Production
 * code should never call this — the latches exist precisely so a
 * single CLI invocation that reads the session many times only warns
 * once. The shared vitest process keeps modules alive across tests so
 * a latch tripped by an earlier case would suppress the warning the
 * later case asserts on.
 */
export function __resetSessionWarningsForTests(): void {
  envFallbackWarned = false;
  envWriteWarned = false;
  migrationWarned = false;
}

/**
 * Decode `AITCC_SESSION` env var into a `Session`. Returns:
 *   - `undefined` when the env var is unset (caller falls through to file).
 *   - `Session` when set + valid (caller uses it, ignores file).
 *   - `null` when set but malformed/invalid; emits a one-shot stderr warning
 *     and the caller falls through to the file path. We use `null` here as
 *     "tried env, gave up" so the file path still runs — the goal is to
 *     never strand a developer who accidentally exported garbage but has a
 *     working session file underneath.
 *
 * The blob may be either raw JSON or base64-encoded JSON; we autodetect by
 * peeking at the decoded body for a leading `{`. This matches the symmetry
 * `auth export` ↔ `auth import` even when a user hand-edits a secret.
 */
function readSessionFromEnv(): Session | null | undefined {
  const raw = process.env.AITCC_SESSION;
  if (!raw || raw.length === 0) return undefined;
  const decoded = decodeSessionBlob(raw);
  if (decoded === null) {
    warnEnvFallbackOnce('AITCC_SESSION env is set but not valid JSON');
    return undefined;
  }
  const reason = validateSessionShape(decoded);
  if (reason) {
    warnEnvFallbackOnce(`AITCC_SESSION env ignored (${reason})`);
    return undefined;
  }
  const validated = decoded as { schemaVersion: 1 | 2 } & Omit<Session, 'schemaVersion'>;
  // v1 → v2 upgrade in memory only — env mode is read-only by contract.
  return validated.schemaVersion === 1
    ? { ...validated, schemaVersion: 2 }
    : (validated as Session);
}

function warnEnvFallbackOnce(message: string): void {
  if (envFallbackWarned) return;
  envFallbackWarned = true;
  process.stderr.write(`warning: ${message}; falling back to session file\n`);
}

function warnEnvWriteOnce(): void {
  if (envWriteWarned) return;
  envWriteWarned = true;
  process.stderr.write('warning: AITCC_SESSION env active — session updates not persisted\n');
}

/**
 * Best-effort blob decoder shared by `readSessionFromEnv` and the
 * `auth import` command. Tries base64 first; if the result doesn't look
 * like JSON, falls back to treating the input as raw JSON. Returns the
 * parsed value on success, `null` on parse failure.
 */
export function decodeSessionBlob(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Direct JSON: cheap path, no base64 round-trip.
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // Try base64 → JSON.
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const decodedTrim = decoded.trim();
  if (decodedTrim.startsWith('{')) {
    try {
      return JSON.parse(decodedTrim);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Validate a candidate session blob. Returns `null` on success or a
 * short reason string on failure. Exported so `auth import` can run the
 * exact same validation `readSession` uses, eliminating drift between
 * the two write paths.
 */
export function validateSessionBlob(input: unknown): string | null {
  return validateSessionShape(input);
}

/**
 * Normalise a validated blob to a `Session` (auto-upgrading v1 → v2).
 * Caller must have already passed the value through `validateSessionBlob`.
 */
export function normalizeValidatedSession(input: unknown): Session {
  const validated = input as { schemaVersion: 1 | 2 } & Omit<Session, 'schemaVersion'>;
  return validated.schemaVersion === 1
    ? { ...validated, schemaVersion: 2 }
    : (validated as Session);
}

// v1 → v2 migration: v1 files are still valid, we just treat the absent
// `currentWorkspaceId` as "no workspace selected yet". The next write (e.g.
// from `workspace use`) bumps the stored schemaVersion. The validator input
// is `unknown` so we can inspect raw JSON without the TS type narrowing
// away the v1 branch.
function validateSessionShape(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return 'root is not an object';
  const parsed = input as {
    schemaVersion?: unknown;
    user?: { id?: unknown; email?: unknown; displayName?: unknown };
    cookies?: unknown;
    origins?: unknown;
    capturedAt?: unknown;
    currentWorkspaceId?: unknown;
  };
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    return `unknown schemaVersion ${String(parsed.schemaVersion)}`;
  }
  if (!parsed.user || typeof parsed.user.id !== 'string') return 'missing user.id';
  if (typeof parsed.user.email !== 'string') return 'missing user.email';
  if (parsed.user.displayName !== undefined && typeof parsed.user.displayName !== 'string') {
    return 'user.displayName has wrong type';
  }
  if (!Array.isArray(parsed.cookies)) return 'cookies is not an array';
  if (parsed.origins !== undefined && !Array.isArray(parsed.origins)) {
    return 'origins is not an array';
  }
  if (parsed.capturedAt !== undefined && typeof parsed.capturedAt !== 'string') {
    return 'capturedAt has wrong type';
  }
  if (parsed.currentWorkspaceId !== undefined) {
    const wid = parsed.currentWorkspaceId;
    if (typeof wid !== 'number' || !Number.isInteger(wid) || wid <= 0) {
      return 'currentWorkspaceId has wrong type';
    }
  }
  return null;
}

export async function readSessionSummary(): Promise<SessionSummary | null> {
  const s = await readSession();
  return s ? summarize(s) : null;
}

export async function writeSession(session: Session): Promise<void> {
  // CI single-shot mode (`AITCC_SESSION` env active) is read-only by
  // contract — silently creating or overwriting a file would defeat the
  // 0600 guarantee on hosts that don't expect a persistent session and
  // leave a stale blob behind on shared runners. One-shot warn so a
  // misuse (`workspace use` on a CI box) is visible without spamming.
  if (process.env.AITCC_SESSION) {
    warnEnvWriteOnce();
    return;
  }
  const dir = dirname(sessionFilePath());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(sessionFilePath(), JSON.stringify(session, null, 2), {
    mode: 0o600,
  });
  // writeFile's mode only applies on creation; tighten existing files too.
  try {
    await chmod(sessionFilePath(), 0o600);
  } catch {
    // Windows / exotic FS: best-effort only.
  }
}

/**
 * Persist a new `currentWorkspaceId` on an existing session. Returns the
 * updated session, or `null` if there is no session to update (callers
 * should surface "not logged in" in that case).
 */
export async function setCurrentWorkspaceId(workspaceId: number): Promise<Session | null> {
  const session = await readSession();
  if (!session) return null;
  const updated: Session = { ...session, currentWorkspaceId: workspaceId };
  await writeSession(updated);
  return updated;
}

export async function clearSession(): Promise<{ existed: boolean }> {
  // Env mode is read-only — pretend we cleared, but warn so the operator
  // knows the AITCC_SESSION secret in their pipeline still authenticates
  // the next command. (Symmetric with `writeSession` above.)
  if (process.env.AITCC_SESSION) {
    warnEnvWriteOnce();
    return { existed: false };
  }
  try {
    await unlink(sessionFilePath());
    return { existed: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { existed: false };
    throw err;
  }
}

export function sessionPathForDiagnostics(): string {
  return sessionFilePath();
}

export function configDirForDiagnostics(): string {
  return configDir();
}
