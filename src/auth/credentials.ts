import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authStateFilePath } from '../paths.js';
import { type CredentialBackend, CredentialBackendUnsupportedError } from './backend.js';
import { LINUX_BACKEND } from './backends/linux.js';
import { MACOS_BACKEND } from './backends/macos.js';
import { WINDOWS_BACKEND } from './backends/windows.js';

// Toss Business email + password persisted across two layers so a future
// `aitcc login` can drive the sign-in form headlessly:
//   - the password lives in the OS keychain, keyed by `service=SERVICE,
//     account=<email>`. The keychain is the only place the secret ever
//     touches disk.
//   - the active email is mirrored to `auth-state.json` (0600) so we can
//     look up the keychain entry without the user re-typing the address
//     every time.
//
// `loadCredentials()` first checks env vars (`AITCC_EMAIL` +
// `AITCC_PASSWORD`) so CI runs can inject single-shot credentials without
// touching the keychain. The returned discriminated union tells callers
// which source they got.
//
// SECURITY MODEL
// - Single-user machine assumption. The native tools (`security`,
//   `secret-tool`, PowerShell + CredWrite) accept the password on argv on
//   macOS and Windows, briefly visible in `ps`/Task Manager to other
//   processes running as the same user. That's the OS tool's own limit;
//   we surface it in user-facing copy and don't pretend to defend
//   against an attacker already running as the user.
// - Linux uses `secret-tool` which streams the password on stdin; argv
//   stays clean.
// - This module never logs or prints passwords. Errors include backend
//   exit codes / stderr only — they must NOT include credential values.

export {
  CREDENTIAL_SERVICE,
  type CredentialBackend,
  CredentialBackendCommandError,
  CredentialBackendUnsupportedError,
} from './backend.js';

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export type CredentialsSource =
  | { readonly kind: 'env'; readonly email: string; readonly password: string }
  | { readonly kind: 'keychain'; readonly email: string; readonly password: string };
// 'file' fallback (~/.config/aitcc/credentials.json) — TODO follow-up; not
// implemented in PR α. Add a third variant when wired so callers can
// distinguish at the type level.

// --- Backend dispatch ---

export interface ResolveBackendOptions {
  readonly platform?: NodeJS.Platform;
  // Test seam — bypass platform detection.
  readonly override?: CredentialBackend;
}

export function resolveBackend(opts: ResolveBackendOptions = {}): CredentialBackend {
  if (opts.override) return opts.override;
  const platform = opts.platform ?? process.platform;
  switch (platform) {
    case 'darwin':
      return MACOS_BACKEND;
    case 'linux':
      return LINUX_BACKEND;
    case 'win32':
      return WINDOWS_BACKEND;
    default:
      throw new CredentialBackendUnsupportedError(
        platform,
        'Only macOS, Linux (libsecret), and Windows are supported.',
      );
  }
}

// --- Auth state (active email pointer) ---

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
 *   2. OS keychain entry whose email is recorded in `auth-state.json`.
 *
 * Returns `null` when no source is configured. The discriminated `kind`
 * lets callers (e.g. PR β's login flow) tell why a credential was found
 * without having to peek at process env themselves — useful for
 * "auto-login from CI" diagnostics.
 *
 * A future `'file'` source (~/.config/aitcc/credentials.json) is left as a
 * follow-up; once added, it slots between (1) and (2).
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
  const password = await resolveBackend(opts).get(state.activeEmail);
  if (password === null) {
    // The pointer exists but the keychain entry is gone — partial state.
    // Treat as "no credentials" rather than fatal; callers can re-save.
    return null;
  }
  return { kind: 'keychain', email: state.activeEmail, password };
}

export type SaveCredentialsStatus = 'created' | 'updated' | 'unchanged';

/**
 * Persist credentials to the OS keychain and update the active-email
 * pointer. Returns `'unchanged'` (no keychain write) when the same email
 * + password is already stored — avoids triggering OS keychain prompts on
 * every call when the user re-runs `auth set` with the same input.
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
  // If we are switching emails, the previous keychain entry would otherwise
  // dangle. Best-effort cleanup so the keychain reflects the active email.
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
 * Remove the keychain entry and the auth-state pointer. Returns
 * `existed: true` if either side previously held data.
 */
export async function deleteCredentials(
  opts: ResolveBackendOptions = {},
): Promise<{ existed: boolean }> {
  const state = await readAuthState();
  let backendExisted = false;
  if (state) {
    try {
      const result = await resolveBackend(opts).clear(state.activeEmail);
      backendExisted = result.existed;
    } catch (err) {
      if (err instanceof CredentialBackendUnsupportedError) {
        // No backend — auth-state alone is the only thing to clear.
      } else {
        throw err;
      }
    }
  }
  const stateResult = await clearAuthState();
  return { existed: backendExisted || stateResult.existed };
}
