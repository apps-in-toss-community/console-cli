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
  schemaVersion: 1;
  user: SessionUser;
  // CDP-native cookie list from `Network.getAllCookies`. Treat as opaque
  // secret material outside the login/http code paths.
  cookies: readonly CdpCookie[];
  // Reserved for Playwright `storageState`-style `localStorage` snapshots;
  // empty until a feature needs it.
  origins: unknown[];
  capturedAt: string; // ISO-8601
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
  try {
    const raw = await readFile(sessionFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Session;
    if (parsed.schemaVersion !== 1) return null;
    if (!parsed.user || typeof parsed.user.id !== 'string') return null;
    if (typeof parsed.user.email !== 'string') return null;
    if (parsed.user.displayName !== undefined && typeof parsed.user.displayName !== 'string') {
      return null;
    }
    if (!Array.isArray(parsed.cookies)) return null;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // Malformed / unreadable file — treat as no session so commands emit a
    // clean "not logged in" error instead of a stack trace.
    return null;
  }
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
