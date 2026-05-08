import { confirm, input, password as passwordPrompt } from '@inquirer/prompts';
import { defineCommand } from 'citty';
import {
  type CredentialBackend,
  deleteCredentials,
  getActiveCredentialEmail,
  saveCredentials,
} from '../auth/credentials.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession } from '../session.js';
import { emitJson } from './_shared.js';
import { authExportCommand } from './auth-export.js';
import { authImportCommand } from './auth-import.js';

// `aitcc auth` — user-facing surface over the credentials library
// introduced in PR α. The library handles env precedence, OS keychain
// dispatch, and idempotent writes; this file is the thin CLI shell that
// turns those primitives into `set` / `clear` / `status` subcommands.
//
// --json contract (consumed by agent-plugin):
//
//   auth set:
//     { ok: true, status: 'created'|'updated'|'unchanged', email }       exit 0
//     { ok: false, reason: 'interactive-required'|'invalid-email'|... }  exit 2/...
//
//   auth clear:
//     { ok: true, status: 'deleted'|'absent'|'cancelled' }                exit 0
//     { ok: false, reason: 'confirmation-required', ... }                 exit 2
//
//   auth status:
//     { ok: true, credentials: { stored, email?, source? },
//                 session:     { active, user?, capturedAt? } }           exit 0
//
// Passwords NEVER appear in any output (stdout/stderr/JSON). The auth
// state pointer file (`auth-state.json`) only carries the email, and
// the keychain backend never echoes the password to its own logs.

// --- auth set ---

export interface AuthSetArgs {
  readonly json: boolean;
  readonly email?: string | undefined;
  readonly password?: string | undefined;
}

export interface AuthDeps {
  readonly backend?: CredentialBackend;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runAuthSet(args: AuthSetArgs, deps: AuthDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;

  // Resolve email + password from (in order): explicit flags, env vars,
  // interactive prompts. argv passwords are visible in `ps` so we warn;
  // env vars are the recommended scripted path.
  let email = args.email?.trim();
  let password = args.password;
  const argvPasswordUsed = password !== undefined;

  if (!email && env.AITCC_EMAIL) email = env.AITCC_EMAIL;
  if (password === undefined && env.AITCC_PASSWORD) password = env.AITCC_PASSWORD;

  // Argv password is a footgun. Surface it loud and only once, regardless
  // of whether we end up prompting for the email afterwards.
  if (argvPasswordUsed) {
    process.stderr.write(
      'Warning: --password on argv is visible in `ps`/Task Manager. ' +
        'Prefer the AITCC_PASSWORD environment variable for scripted use.\n',
    );
  }

  const interactive = process.stdout.isTTY && process.stdin.isTTY && !args.json;

  if (!email) {
    if (!interactive) {
      emitInteractiveRequired(args.json, 'email');
      return exitAfterFlush(ExitCode.Usage);
    }
    try {
      email = (
        await input({
          message: 'Email:',
          validate: (raw) => (raw.trim().length > 0 ? true : 'email is required'),
        })
      ).trim();
    } catch (err) {
      if (isPromptCancelled(err)) {
        process.stderr.write('Aborted.\n');
        return exitAfterFlush(ExitCode.Usage);
      }
      throw err;
    }
  }

  if (!email.includes('@')) {
    // Cheap sanity check — keychain backends accept any string but storing
    // a non-email pointer would silently desync from the login form.
    if (args.json) emitJson({ ok: false, reason: 'invalid-email', message: 'invalid email' });
    else process.stderr.write(`Invalid email: ${email}\n`);
    return exitAfterFlush(ExitCode.Usage);
  }

  if (password === undefined) {
    if (!interactive) {
      emitInteractiveRequired(args.json, 'password');
      return exitAfterFlush(ExitCode.Usage);
    }
    try {
      password = await passwordPrompt({
        message: 'Password:',
        mask: true,
        validate: (raw) => (raw.length > 0 ? true : 'password is required'),
      });
    } catch (err) {
      if (isPromptCancelled(err)) {
        process.stderr.write('Aborted.\n');
        return exitAfterFlush(ExitCode.Usage);
      }
      throw err;
    }
  }

  if (password.length === 0) {
    if (args.json)
      emitJson({ ok: false, reason: 'invalid-password', message: 'password is empty' });
    else process.stderr.write('Password is empty.\n');
    return exitAfterFlush(ExitCode.Usage);
  }

  let result: { status: 'created' | 'updated' | 'unchanged' };
  try {
    result = await saveCredentials(email, password, deps.backend ? { override: deps.backend } : {});
  } catch (err) {
    const message = (err as Error).message;
    if (args.json) emitJson({ ok: false, reason: 'keychain-error', message });
    else process.stderr.write(`Failed to save credentials: ${message}\n`);
    return exitAfterFlush(ExitCode.Generic);
  }

  if (args.json) {
    emitJson({ ok: true, status: result.status, email });
  } else if (result.status === 'unchanged') {
    process.stdout.write('Credentials already saved (no change).\n');
  } else {
    process.stdout.write(`Credentials saved for ${email} (keychain).\n`);
  }
  return exitAfterFlush(ExitCode.Ok);
}

// --- auth clear ---

export interface AuthClearArgs {
  readonly json: boolean;
  readonly yes: boolean;
}

export async function runAuthClear(args: AuthClearArgs, deps: AuthDeps = {}): Promise<void> {
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !args.json;

  // Look up the active email up front so we can show it in the confirm
  // prompt and the human success line. Failing here is non-fatal — the
  // clear path below will still try to wipe whatever it finds.
  const active = await getActiveCredentialEmail(deps.env ? { env: deps.env } : {}).catch(
    () => null,
  );

  if (!args.yes) {
    if (!interactive) {
      // Non-TTY (script, pipe, --json) without --yes is treated as a
      // mistake — silently wiping credentials from a piped invocation
      // would surprise the operator. Refuse and ask for the explicit
      // opt-in. The TTY branch below covers the human-confirm path.
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'confirmation-required',
          message: 'pass --yes to clear credentials in non-interactive mode',
        });
      } else {
        process.stderr.write(
          'Refusing to clear credentials without confirmation. Pass --yes to proceed.\n',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const label = active?.email ?? '(unknown)';
    let confirmed: boolean;
    try {
      confirmed = await confirm({
        message: `Delete saved credentials for ${label}?`,
        default: false,
      });
    } catch (err) {
      if (isPromptCancelled(err)) {
        process.stderr.write('Aborted.\n');
        return exitAfterFlush(ExitCode.Usage);
      }
      throw err;
    }
    if (!confirmed) {
      // Distinct status from `'absent'`: the user actively said no even
      // though credentials may exist, vs. nothing was there to begin with.
      if (args.json) emitJson({ ok: true, status: 'cancelled' });
      else process.stdout.write('Aborted.\n');
      return exitAfterFlush(ExitCode.Ok);
    }
  }

  let result: { existed: boolean };
  try {
    result = await deleteCredentials(deps.backend ? { override: deps.backend } : {});
  } catch (err) {
    const message = (err as Error).message;
    if (args.json) emitJson({ ok: false, reason: 'keychain-error', message });
    else process.stderr.write(`Failed to clear credentials: ${message}\n`);
    return exitAfterFlush(ExitCode.Generic);
  }

  const status = result.existed ? 'deleted' : 'absent';
  if (args.json) {
    emitJson({ ok: true, status });
  } else if (result.existed) {
    process.stdout.write('Credentials cleared.\n');
  } else {
    process.stdout.write('No saved credentials.\n');
  }
  return exitAfterFlush(ExitCode.Ok);
}

// --- auth status ---

export interface AuthStatusArgs {
  readonly json: boolean;
}

export async function runAuthStatus(args: AuthStatusArgs, deps: AuthDeps = {}): Promise<void> {
  // Read the email pointer without touching the keychain — `auth status`
  // shouldn't trigger a Touch ID / libsecret prompt just to answer "do I
  // have credentials configured?". Password retrieval lives in the login
  // path, which already needs it.
  const active = await getActiveCredentialEmail(deps.env ? { env: deps.env } : {}).catch(
    () => null,
  );
  const session = await readSession();

  if (args.json) {
    const credentials = active
      ? { stored: true as const, email: active.email, source: active.kind }
      : { stored: false as const };
    const sessionShape = session
      ? {
          active: true as const,
          user: session.user,
          capturedAt: session.capturedAt,
        }
      : { active: false as const };
    emitJson({ ok: true, credentials, session: sessionShape });
    return exitAfterFlush(ExitCode.Ok);
  }

  if (active) {
    const sourceLabel = active.kind === 'env' ? 'environment (AITCC_EMAIL/PASSWORD)' : 'keychain';
    process.stdout.write(`Email: ${active.email}\n`);
    process.stdout.write(`Source: ${sourceLabel}\n`);
  } else {
    process.stdout.write('Email: (not configured)\n');
  }
  if (session) {
    const label = session.user.displayName
      ? `${session.user.displayName} <${session.user.email}>`
      : session.user.email;
    process.stdout.write(`Session: active — ${label}\n`);
    process.stdout.write(`Captured: ${session.capturedAt}\n`);
  } else {
    process.stdout.write('Session: none (run `aitcc login`)\n');
  }
  return exitAfterFlush(ExitCode.Ok);
}

// --- helpers ---

function emitInteractiveRequired(json: boolean, missing: 'email' | 'password'): void {
  if (json) {
    emitJson({
      ok: false,
      reason: 'interactive-required',
      message: `${missing} prompt requires a TTY; use --${missing} or AITCC_${missing.toUpperCase()}`,
    });
  } else {
    process.stderr.write(
      `Cannot prompt for ${missing} in non-interactive mode. ` +
        `Use --${missing} or set AITCC_${missing.toUpperCase()}.\n`,
    );
  }
}

// Mirrors the helper in app-init.ts — `@inquirer/prompts` throws an
// `ExitPromptError` (name only, the class isn't exported from the
// top-level package) when the user hits Ctrl-C. We don't want to surface
// that as a stack trace.
function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

// --- citty wrappers ---

const setCommand = defineCommand({
  meta: {
    name: 'set',
    description: 'Save email + password to the OS keychain for future headless logins.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
    email: { type: 'string', description: 'Email (skip prompt).' },
    password: {
      type: 'string',
      description: 'Password (skip prompt; visible in `ps` — prefer AITCC_PASSWORD env var).',
    },
  },
  async run({ args }) {
    return runAuthSet({
      json: args.json,
      email: typeof args.email === 'string' ? args.email : undefined,
      password: typeof args.password === 'string' ? args.password : undefined,
    });
  },
});

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Delete the saved credentials and the auth-state pointer.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip the confirmation prompt.',
      default: false,
    },
  },
  async run({ args }) {
    return runAuthClear({ json: args.json, yes: args.yes });
  },
});

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Report whether credentials and a session are configured.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    return runAuthStatus({ json: args.json });
  },
});

export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Manage saved login credentials and export/import portable session blobs for CI.',
  },
  subCommands: {
    set: setCommand,
    clear: clearCommand,
    status: statusCommand,
    export: authExportCommand,
    import: authImportCommand,
  },
});
