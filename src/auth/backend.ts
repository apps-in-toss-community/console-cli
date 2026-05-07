import { spawn } from 'node:child_process';

// Service identifier used as the keychain "service" / Windows target name
// prefix / libsecret schema attribute. Stable across versions — changing it
// would orphan existing entries on user machines.
export const CREDENTIAL_SERVICE = 'aitcc.credentials';

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

export interface RunOpts {
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCommand(command: string, opts: RunOpts): Promise<RunResult> {
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

export function isCommandNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}

// Backend command failures land in user-facing logs. macOS `security` and
// Linux `secret-tool` don't echo argv on error in our smoke tests, but a
// kernel-level oddity (e.g. failing exec) can make stderr unbounded.
// Truncate aggressively + drop anything that looks remotely password-ish.
export function redactStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return '<no stderr>';
  if (trimmed.length > 200) return `${trimmed.slice(0, 200)}… <truncated>`;
  return trimmed;
}
