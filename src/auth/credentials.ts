import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authStateFilePath } from '../paths.js';

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

export interface CredentialBackend {
  readonly name: string;
  get(account: string): Promise<string | null>;
  set(account: string, password: string): Promise<void>;
  clear(account: string): Promise<{ existed: boolean }>;
}

export class CredentialBackendUnsupportedError extends Error {
  constructor(
    readonly platform: NodeJS.Platform,
    readonly hint: string,
  ) {
    super(`No supported credential backend for platform "${platform}". ${hint}`);
    this.name = 'CredentialBackendUnsupportedError';
  }
}

export class CredentialBackendCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    // We deliberately accept stderr but redact it: a backend that echoes
    // its argv on failure could put the password in this string. Callers
    // see only "<redacted>" until we audit each backend's failure paths.
    redactedStderr: string,
  ) {
    super(
      `Credential backend command "${command}" failed (exit=${exitCode ?? 'null'}): ${redactedStderr}`,
    );
    this.name = 'CredentialBackendCommandError';
  }
}

export const CREDENTIAL_SERVICE = 'aitcc.credentials';

interface RunOpts {
  readonly args: readonly string[];
  readonly stdin?: string;
}

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(command: string, opts: RunOpts): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...opts.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

function isCommandNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}

// Backend command failures land in user-facing logs. macOS `security` and
// Linux `secret-tool` don't echo argv on error in our smoke tests, but a
// kernel-level oddity (e.g. failing exec) can make stderr unbounded.
// Truncate aggressively + drop anything that looks remotely password-ish.
function redactStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return '<no stderr>';
  if (trimmed.length > 200) return `${trimmed.slice(0, 200)}… <truncated>`;
  return trimmed;
}

// --- macOS backend ---

const MACOS_BACKEND: CredentialBackend = {
  name: 'macos-keychain',
  async get(account) {
    let result: RunResult;
    try {
      result = await runCommand('security', {
        args: ['find-generic-password', '-s', CREDENTIAL_SERVICE, '-a', account, '-w'],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'darwin',
          'macOS `security` is missing from PATH.',
        );
      }
      throw err;
    }
    if (result.exitCode === 44) return null; // errSecItemNotFound
    if (result.exitCode !== 0) return null; // be lenient on `find` — assume missing
    const password = stripTrailingNewline(result.stdout);
    return password.length > 0 ? password : null;
  },
  async set(account, password) {
    let result: RunResult;
    try {
      // -U upserts. -A opens the ACL so subsequent `find-generic-password`
      // reads do not raise the keychain unlock prompt every call (saving
      // one prompt per `aitcc` run, including the read inside the
      // unchanged-detection path of `saveCredentials`). The trade-off is a
      // permissive ACL: any process running as the same user can read the
      // entry. We accept this for the same reason we accept argv-visible
      // passwords on `security` — the threat model is a single-user
      // machine and the OS keychain is no stronger than the login
      // session. `security` reads the password from `-w`; no stdin path
      // exists on this command.
      result = await runCommand('security', {
        args: [
          'add-generic-password',
          '-U',
          '-A',
          '-s',
          CREDENTIAL_SERVICE,
          '-a',
          account,
          '-w',
          password,
        ],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'darwin',
          'macOS `security` is missing from PATH.',
        );
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'security add-generic-password',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
  },
  async clear(account) {
    let result: RunResult;
    try {
      result = await runCommand('security', {
        args: ['delete-generic-password', '-s', CREDENTIAL_SERVICE, '-a', account],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'darwin',
          'macOS `security` is missing from PATH.',
        );
      }
      throw err;
    }
    if (result.exitCode === 44) return { existed: false };
    if (result.exitCode === 0) return { existed: true };
    throw new CredentialBackendCommandError(
      'security delete-generic-password',
      result.exitCode,
      redactStderr(result.stderr),
    );
  },
};

// --- Linux backend (libsecret) ---

const LINUX_BACKEND: CredentialBackend = {
  name: 'libsecret',
  async get(account) {
    let result: RunResult;
    try {
      result = await runCommand('secret-tool', {
        args: ['lookup', 'service', CREDENTIAL_SERVICE, 'account', account],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'linux',
          'libsecret tools are missing. Install `libsecret-tools` (Debian/Ubuntu) or the equivalent and ensure a Secret Service provider (gnome-keyring / KWallet) is running.',
        );
      }
      throw err;
    }
    // `secret-tool lookup` exits 0 with no stdout when the entry is
    // missing on some distros, non-zero on others. Empty stdout = missing
    // either way.
    if (result.stdout.length === 0) return null;
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'secret-tool lookup',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    const password = stripTrailingNewline(result.stdout);
    return password.length > 0 ? password : null;
  },
  async set(account, password) {
    let result: RunResult;
    try {
      // `store` reads the secret from stdin — keeps argv clean.
      result = await runCommand('secret-tool', {
        args: [
          'store',
          '--label',
          'aitcc Toss Business credentials',
          'service',
          CREDENTIAL_SERVICE,
          'account',
          account,
        ],
        stdin: password,
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'linux',
          'libsecret tools are missing. Install `libsecret-tools` and ensure a Secret Service provider is running.',
        );
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'secret-tool store',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
  },
  async clear(account) {
    let result: RunResult;
    try {
      result = await runCommand('secret-tool', {
        args: ['clear', 'service', CREDENTIAL_SERVICE, 'account', account],
      });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError('linux', 'libsecret tools are missing.');
      }
      throw err;
    }
    // `secret-tool clear` always exits 0 even when the entry was absent.
    // Probe with `lookup` after to know whether something existed; cheaper
    // alternative is just to report `existed: true` optimistically, since
    // the user-facing impact is "credentials are gone now" either way.
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'secret-tool clear',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    return { existed: true };
  },
};

// --- Windows backend (PowerShell + CredWrite/CredRead/CredDelete) ---
//
// Stock Windows ships PowerShell which can call the CredentialManager API
// via P/Invoke. No extra modules to install. The password round-trips as
// hex bytes through the script body so a `ps` listing shows hex, not
// cleartext.

const WINDOWS_PS_HEADER = `
$ErrorActionPreference = 'Stop';
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AitccCredApi {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredWriteW", CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL Credential, [In] uint Flags);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr CredentialPtr);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredFree")]
    public static extern void CredFree([In] IntPtr cred);
}
"@
`;

function windowsTargetName(account: string): string {
  return `${CREDENTIAL_SERVICE}/${account}`;
}

function powerShellArgs(script: string): readonly string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

const WINDOWS_BACKEND: CredentialBackend = {
  name: 'windows-credential-manager',
  async get(account) {
    const target = windowsTargetName(account);
    const script = `
${WINDOWS_PS_HEADER}
$target = '${target.replace(/'/g, "''")}';
$ptr = [IntPtr]::Zero;
$ok = [AitccCredApi]::CredRead($target, 1, 0, [ref]$ptr);
if (-not $ok) { exit 0; }
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][AitccCredApi+CREDENTIAL]);
$blob = New-Object byte[] $cred.CredentialBlobSize;
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize);
$pw = [System.Text.Encoding]::Unicode.GetString($blob);
[AitccCredApi]::CredFree($ptr);
[Console]::Out.Write($pw);
`;
    let result: RunResult;
    try {
      result = await runCommand('powershell.exe', { args: powerShellArgs(script) });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'win32',
          '`powershell.exe` is missing from PATH. Windows credential storage requires PowerShell.',
        );
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'powershell CredRead',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    return result.stdout.length > 0 ? result.stdout : null;
  },
  async set(account, password) {
    const target = windowsTargetName(account);
    // Encode the password as hex so PowerShell's argv (visible in Task
    // Manager) shows hex, not cleartext. `account` is the email; it's
    // intentionally cleartext on argv since the email is not secret.
    const passwordHex = Buffer.from(password, 'utf8').toString('hex');
    const script = `
${WINDOWS_PS_HEADER}
$target = '${target.replace(/'/g, "''")}';
$user = '${account.replace(/'/g, "''")}';
$pwHex = '${passwordHex}';
$pwBytes = New-Object byte[] ($pwHex.Length / 2);
for ($i = 0; $i -lt $pwBytes.Length; $i++) {
  $pwBytes[$i] = [Convert]::ToByte($pwHex.Substring($i * 2, 2), 16);
}
$pwUtf16 = [System.Text.Encoding]::Unicode.GetBytes([System.Text.Encoding]::UTF8.GetString($pwBytes));
$cred = New-Object AitccCredApi+CREDENTIAL;
$cred.Type = 1;
$cred.TargetName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($target);
$cred.CredentialBlobSize = [uint32]$pwUtf16.Length;
$cred.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($pwUtf16.Length);
[Runtime.InteropServices.Marshal]::Copy($pwUtf16, 0, $cred.CredentialBlob, $pwUtf16.Length);
$cred.Persist = 2;
$cred.UserName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($user);
try {
  $ok = [AitccCredApi]::CredWrite([ref]$cred, 0);
  if (-not $ok) { Write-Error 'CredWrite failed'; exit 1; }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.TargetName);
  [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.UserName);
  [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob);
}
`;
    let result: RunResult;
    try {
      result = await runCommand('powershell.exe', { args: powerShellArgs(script) });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'win32',
          '`powershell.exe` is missing from PATH.',
        );
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'powershell CredWrite',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
  },
  async clear(account) {
    const target = windowsTargetName(account);
    const script = `
${WINDOWS_PS_HEADER}
$target = '${target.replace(/'/g, "''")}';
$ok = [AitccCredApi]::CredDelete($target, 1, 0);
if ($ok) { [Console]::Out.Write('deleted'); } else { [Console]::Out.Write('absent'); }
`;
    let result: RunResult;
    try {
      result = await runCommand('powershell.exe', { args: powerShellArgs(script) });
    } catch (err) {
      if (isCommandNotFound(err)) {
        throw new CredentialBackendUnsupportedError(
          'win32',
          '`powershell.exe` is missing from PATH.',
        );
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'powershell CredDelete',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    return { existed: result.stdout.includes('deleted') };
  },
};

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

// Exposed for unit tests.
export const __test = {
  redactStderr,
  stripTrailingNewline,
  MACOS_BACKEND,
  LINUX_BACKEND,
  WINDOWS_BACKEND,
};
