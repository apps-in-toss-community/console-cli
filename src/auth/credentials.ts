import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authStateFilePath } from '../paths.js';
import type { CredentialBackend } from './backend.js';
import { FILE_BACKEND } from './backends/file.js';
import { migrateKeychainToFileIfNeeded } from './keychain-migration.js';

// Toss Business email + password persisted to a single-layer file store:
//   - the password lives in `~/.config/aitcc/credentials.json` (mode 0600),
//     keyed by `<service>:<email>`. Plain-file storage matches the model
//     used by gh/aws/gcloud and avoids native OS keychain dependencies that
//     complicate `bun build --compile` on all three platforms.
//   - the active email is mirrored to `auth-state.json` (0600) so we can
//     look up the credential entry without the user re-typing the address
//     every time.
//
// `loadCredentials()` first checks env vars (`AITCC_EMAIL` +
// `AITCC_PASSWORD`) so CI runs can inject single-shot credentials without
// touching the file. The returned discriminated union tells callers which
// source they got.
//
// SECURITY MODEL
// - Single-user machine assumption with disk encryption (FileVault / LUKS)
//   recommended. Credentials are stored as plain text in a 0600 file — the
//   same trade-off gh, aws-cli, and gcloud accept.
// - This module never logs or prints passwords. Errors must NOT include
//   credential values.

export { CREDENTIAL_SERVICE, type CredentialBackend } from './backend.js';

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export type CredentialsSource =
  | { readonly kind: 'env'; readonly email: string; readonly password: string }
  | { readonly kind: 'file'; readonly email: string; readonly password: string };

// --- Backend accessor ---

export interface ResolveBackendOptions {
  // Test seam — bypass the real file system.
  readonly override?: CredentialBackend;
}

export function resolveBackend(opts: ResolveBackendOptions = {}): CredentialBackend {
  if (opts.override) return opts.override;
  return FILE_BACKEND;
}

// --- Auth state (active-email pointer) ---

interface AuthState {
  readonly schemaVersion: 1;
  readonly activeEmail: string;
}

async function readAuthState(): Promise<AuthState | null> {
  let raw: string;
  try {
    raw = await readFile(authStateFilePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.activeEmail !== 'string' || parsed.activeEmail.length === 0) return null;
    return { schemaVersion: 1, activeEmail: parsed.activeEmail };
  } catch {
    return null;
  }
}

async function writeAuthState(state: AuthState): Promise<void> {
  const path = authStateFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows / exotic FS — best-effort.
  }
}

async function clearAuthState(): Promise<{ existed: boolean }> {
  try {
    await unlink(authStateFilePath());
    return { existed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw err;
  }
}

// --- Public API ---

export interface LoadCredentialsOptions extends ResolveBackendOptions {
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve credentials from the highest-priority source available:
 *   1. `AITCC_EMAIL` + `AITCC_PASSWORD` env vars (CI single-shot use).
 *   2. File backend (`~/.config/aitcc/credentials.json`) — the only
 *      persistent store; email pointer lives in `auth-state.json`.
 *
 * Returns `null` when no source is configured. The discriminated `kind`
 * lets callers (e.g. the login flow) tell why a credential was found
 * without having to peek at process env themselves — useful for
 * "auto-login from CI" diagnostics.
 */
export async function loadCredentials(
  opts: LoadCredentialsOptions = {},
): Promise<CredentialsSource | null> {
  const env = opts.env ?? process.env;
  const envEmail = env.AITCC_EMAIL;
  const envPassword = env.AITCC_PASSWORD;
  if (envEmail && envPassword) {
    return { kind: 'env', email: envEmail, password: envPassword };
  }
  const state = await readAuthState();
  if (!state) return null;
  const backend = resolveBackend(opts);
  let password = await backend.get(state.activeEmail);
  if (password === null) {
    // File entry is absent — try a one-time migration from the OS keychain
    // for users who previously used `--save=keychain`. Silent on failure.
    await migrateKeychainToFileIfNeeded(state.activeEmail).catch(() => null);
    password = await backend.get(state.activeEmail);
  }
  if (password === null) {
    // The pointer exists but no credential found — partial state.
    // Treat as "no credentials" rather than fatal; callers can re-save.
    return null;
  }
  return { kind: 'file', email: state.activeEmail, password };
}

export type SaveCredentialsStatus = 'created' | 'updated' | 'unchanged';

/**
 * Persist credentials to the file backend and update the active-email
 * pointer. Returns `'unchanged'` (no file write) when the same email
 * + password is already stored — avoids unnecessary disk writes on every
 * call when the user re-runs `login` with the same input.
 */
export async function saveCredentials(
  email: string,
  password: string,
  opts: ResolveBackendOptions = {},
): Promise<{ status: SaveCredentialsStatus }> {
  if (!email) throw new Error('email is required');
  if (!password) throw new Error('password is required');

  const backend = resolveBackend(opts);
  const previousState = await readAuthState();

  let status: SaveCredentialsStatus;
  if (previousState && previousState.activeEmail === email) {
    const existing = await backend.get(email);
    if (existing === password) {
      // Same email + same password already stored. No-op.
      return { status: 'unchanged' };
    }
    status = 'updated';
  } else {
    status = previousState ? 'updated' : 'created';
  }

  await backend.set(email, password);
  // If we are switching emails, the previous file entry would otherwise
  // dangle. Best-effort cleanup so the store reflects only the active email.
  if (previousState && previousState.activeEmail !== email) {
    try {
      await backend.clear(previousState.activeEmail);
    } catch {
      // Old entry might already be gone or backend may flake — non-fatal.
    }
  }
  await writeAuthState({ schemaVersion: 1, activeEmail: email });
  return { status };
}

/**
 * Read just the active-email pointer without loading the password from disk.
 * Useful for surfaces like `whoami` that want to report whether credentials
 * are configured without performing a full credential read.
 *
 * Returns the email and where it was found (`'env'` when
 * `AITCC_EMAIL` + `AITCC_PASSWORD` are present, `'file'` when the
 * `auth-state.json` pointer exists), or `null` when nothing is configured.
 */
export async function getActiveCredentialEmail(
  opts: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ kind: 'env' | 'file'; email: string } | null> {
  const env = opts.env ?? process.env;
  if (env.AITCC_EMAIL && env.AITCC_PASSWORD) {
    return { kind: 'env', email: env.AITCC_EMAIL };
  }
  const state = await readAuthState();
  if (!state) return null;
  return { kind: 'file', email: state.activeEmail };
}

/**
 * Remove the file credential entry and the auth-state pointer. Returns
 * `existed: true` if either side previously held data.
 */
export async function deleteCredentials(
  opts: ResolveBackendOptions = {},
): Promise<{ existed: boolean }> {
  const state = await readAuthState();
  let backendExisted = false;
  if (state) {
    const result = await resolveBackend(opts).clear(state.activeEmail);
    backendExisted = result.existed;
  }
  const stateResult = await clearAuthState();
  return { existed: backendExisted || stateResult.existed };
}
