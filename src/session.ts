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

export async function readSession(): Promise<Session | null> {
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
  let parsed: Session;
  try {
    parsed = JSON.parse(raw) as Session;
  } catch {
    // Malformed JSON — warn once, then fall back to "not logged in". The
    // user can re-run `aitcc login` to replace the broken file.
    process.stderr.write(`warning: session file at ${path} is corrupt and will be ignored\n`);
    return null;
  }
  const schemaReason = validateSessionShape(parsed);
  if (schemaReason) {
    process.stderr.write(
      `warning: session file at ${path} ignored (${schemaReason}); re-run \`aitcc login\`\n`,
    );
    return null;
  }
  // In-memory migration from v1 to v2: we accept v1 files but upgrade the
  // version tag so downstream code sees a uniform shape. The file itself is
  // only rewritten on the next explicit write (login, workspace use, etc).
  if ((parsed.schemaVersion as number) === 1) {
    parsed = { ...parsed, schemaVersion: 2 };
  }
  return parsed;
}

// v1 → v2 migration: v1 files are still valid, we just treat the absent
// `currentWorkspaceId` as "no workspace selected yet". The next write (e.g.
// from `workspace use`) bumps the stored schemaVersion. The validator input
// is deliberately loose (`unknown`-ish) so we can inspect old-schema files
// without the TS type narrowing away the v1 branch.
function validateSessionShape(parsed: {
  schemaVersion?: unknown;
  user?: { id?: unknown; email?: unknown; displayName?: unknown };
  cookies?: unknown;
  currentWorkspaceId?: unknown;
}): string | null {
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    return `unknown schemaVersion ${String(parsed.schemaVersion)}`;
  }
  if (!parsed.user || typeof parsed.user.id !== 'string') return 'missing user.id';
  if (typeof parsed.user.email !== 'string') return 'missing user.email';
  if (parsed.user.displayName !== undefined && typeof parsed.user.displayName !== 'string') {
    return 'user.displayName has wrong type';
  }
  if (!Array.isArray(parsed.cookies)) return 'cookies is not an array';
  if (
    parsed.currentWorkspaceId !== undefined &&
    (typeof parsed.currentWorkspaceId !== 'number' || !Number.isInteger(parsed.currentWorkspaceId))
  ) {
    return 'currentWorkspaceId has wrong type';
  }
  return null;
}

export async function readSessionSummary(): Promise<SessionSummary | null> {
  const s = await readSession();
  return s ? summarize(s) : null;
}

export async function writeSession(session: Session): Promise<void> {
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
