import { input, password as passwordPrompt, select } from '@inquirer/prompts';
import { defineCommand } from 'citty';
import { type FetchLike, TossApiError } from '../api/http.js';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import {
  type CredentialsSource,
  loadCredentials,
  type SaveCredentialsStatus,
  saveCredentials,
} from '../auth/credentials.js';
import {
  attachToFirstPage,
  CdpClient,
  type CdpCookie,
  getAllCookies,
  watchMainFrameNavigations,
} from '../cdp.js';
import {
  ChromeEndpointTimeoutError,
  ChromeLaunchError,
  ChromeNotFoundError,
  launchChrome,
} from '../chrome.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { type HeadlessLoginOutcome, runHeadlessLogin } from '../login-headless.js';
import { type Session, writeSession } from '../session.js';

// Login flow (replaces the prior OAuth-callback-server scaffold):
//
//   1. Resolve credentials in priority order — explicit --email/--password*
//      flags > AITCC_EMAIL/AITCC_PASSWORD env > OS keychain > interactive
//      prompt (TTY) > error (non-TTY). Optionally persist to the keychain
//      via the unified --save flag (or by selecting "keychain" in the
//      interactive prompt) so the next login runs without prompting.
//   2. Launch a Chrome-family browser with an isolated user-data-dir.
//      Headless when we have credentials and the user didn't request the
//      visible flow; visible (`--interactive`) when they did or when no
//      credentials were available.
//   3. Watch main-frame navigations over CDP. Once the URL lands on the
//      console's post-login workspace page, the auth cookies have been set
//      (HttpOnly, so JS can't see them — CDP can).
//   4. Dump all cookies via `Network.getAllCookies`, resolve the member
//      user-info from the console API, and persist `{ user, cookies,
//      capturedAt }` at `$XDG_CONFIG_HOME/aitcc/session.json` (0600).
//   5. Dispose the Chrome process and wipe the ephemeral user-data-dir.

const DEFAULT_AUTHORIZE_URL =
  'https://business.toss.im/account/sign-in' +
  '?client_id=4uktpjgqd0cp9txybqzuxc2y6w0cuupb' +
  '&redirect_uri=https%3A%2F%2Fapps-in-toss.toss.im%2Fsign-up' +
  '&state=%2Fworkspace';

// The CDP login is complete once the main frame lands on the workspace URL.
const LOGIN_LANDING_HOST = 'apps-in-toss.toss.im';
const LOGIN_LANDING_PATH_PREFIX = '/workspace';

// Hosts we'll drive a login flow to. `AITCC_OAUTH_URL` is meant as a
// staging-environment escape hatch, not a way to redirect the CLI to an
// attacker-controlled URL via a tampered shell rc. A `.toss.im` suffix
// match is the tightest allowlist that still permits internal hosts.
const ALLOWED_AUTHORIZE_HOST_SUFFIXES = ['.toss.im'] as const;

// Minimum time we hand to the interactive-fallback path even if the
// headless attempt already consumed most of `--timeout`. Without a floor
// the user could see "Login timed out after 0s" right after the visible
// Chrome appears — comfortably long enough to actually type the form.
export const INTERACTIVE_FALLBACK_FLOOR_MS = 30_000;

/**
 * Compute the timeout budget for the interactive fallback attempt after a
 * headless attempt has already burned `elapsedMs`. Caps the result at the
 * user's overall `--timeout` and floors it at `INTERACTIVE_FALLBACK_FLOOR_MS`
 * so a near-exhausted budget still gives the user enough time to type.
 *
 * Pure decision function — extracted so the policy can be exercised
 * without standing up the Chrome/CDP machinery.
 */
export function computeFallbackTimeoutMs(totalTimeoutMs: number, elapsedMs: number): number {
  return Math.max(INTERACTIVE_FALLBACK_FLOOR_MS, totalTimeoutMs - elapsedMs);
}

export function isAllowedAuthorizeHost(host: string): boolean {
  const lower = host.toLowerCase();
  return ALLOWED_AUTHORIZE_HOST_SUFFIXES.some(
    (suffix) => lower === suffix.slice(1) || lower.endsWith(suffix),
  );
}

export function isLoginLanding(url: string): boolean {
  try {
    const u = new URL(url);
    // Use hostname (no port) so a same-host landing on a non-default port
    // still matches — the console hasn't shipped a custom port in the
    // wild but we shouldn't trip on one if it appears.
    if (u.hostname !== LOGIN_LANDING_HOST) return false;
    if (
      u.pathname !== LOGIN_LANDING_PATH_PREFIX &&
      !u.pathname.startsWith(`${LOGIN_LANDING_PATH_PREFIX}/`)
    ) {
      return false;
    }
    // Reject things like `/workspacely`: require the prefix to be followed
    // by end-of-path or a '/'.
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide which login mode to enter on first attempt. Pure so the
 * branching policy is testable without standing up Chrome.
 *
 * Rules: `--interactive` always wins. Otherwise headless if and only if
 * we have credentials. The caller is responsible for falling back to
 * interactive on a mid-flight headless failure.
 */
export function chooseLoginMode(input: {
  readonly interactiveFlag: boolean;
  readonly hasCredentials: boolean;
}): LoginMode {
  if (input.interactiveFlag) return 'interactive';
  return input.hasCredentials ? 'headless' : 'interactive';
}

// Two top-level paths into the login flow:
//   - `interactive`: launch a visible Chrome and let the user type
//     credentials themselves. This is the historical path and the
//     fallback whenever headless can't proceed.
//   - `headless`: launch Chrome with --headless=new, fill the form via
//     CDP using credentials from the OS keychain (or env vars), and
//     wait for the same workspace landing URL.
// Cookie capture / session write / output is shared after the browser
// has reached the workspace page — both paths converge there.
export type LoginMode = 'interactive' | 'headless';

export type SaveTarget = 'keychain' | 'file' | 'none';

export interface LoginDeps {
  // DI seam for tests and for keeping the CLI entrypoint as the only
  // module that imports `loadCredentials` directly. `null` means "no
  // credentials configured, take the interactive path".
  readonly getCredentials?: () => Promise<CredentialsSource | null>;
  // DI seam for the credential write. Tests can substitute an in-memory
  // backend; production wires `saveCredentials`.
  readonly saveCredentials?: (
    email: string,
    password: string,
    useFile?: boolean,
  ) => Promise<{ status: SaveCredentialsStatus }>;
  // DI seam for stdin reads (`--password-stdin`). Tests inject the
  // expected password without having to feed a real stream.
  readonly readStdin?: () => Promise<string>;
  // DI seam for prompts so tests don't have to run the inquirer renderer.
  readonly prompts?: PromptDeps;
}

export interface PromptDeps {
  readonly email: (defaultValue?: string) => Promise<string>;
  readonly password: () => Promise<string>;
  readonly saveTarget: () => Promise<SaveTarget>;
}

const defaultPromptDeps: PromptDeps = {
  email: (defaultValue) =>
    input({
      message: 'Email:',
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      validate: (raw) => {
        const trimmed = raw.trim();
        if (trimmed.length === 0) return 'email is required';
        if (!trimmed.includes('@')) return 'must contain "@"';
        return true;
      },
    }).then((s) => s.trim()),
  password: () =>
    passwordPrompt({
      message: 'Password:',
      mask: true,
      validate: (raw) => (raw.length > 0 ? true : 'password is required'),
    }),
  saveTarget: () =>
    select<SaveTarget>({
      message: 'Where would you like to save the credentials?',
      default: 'keychain',
      choices: [
        {
          name: 'OS keychain (recommended) — next login runs headlessly',
          value: 'keychain',
        },
        {
          name: 'File (~/.config/aitcc/credentials.json, perm 0600) — use for SSH/headless sessions',
          value: 'file',
        },
        {
          name: 'Do not save — one-shot. (Tip: AITCC_EMAIL/AITCC_PASSWORD env for CI.)',
          value: 'none',
        },
      ],
    }),
};

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Sign in to the Apps in Toss console and capture the session cookies.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    timeout: {
      type: 'string',
      description: 'Abort if login does not complete within N seconds (default 300).',
      default: '300',
    },
    interactive: {
      type: 'boolean',
      description: 'Force the visible-browser flow even if credentials are configured.',
      default: false,
    },
    email: {
      type: 'string',
      description: 'Email (skip prompt; required for non-interactive use).',
    },
    password: {
      type: 'string',
      description:
        'Password (skip prompt; visible in `ps`/Task Manager — prefer --password-stdin or AITCC_PASSWORD env).',
    },
    'password-stdin': {
      type: 'boolean',
      description: 'Read the password from stdin (recommended for non-interactive use).',
      default: false,
    },
    save: {
      type: 'string',
      description:
        'Where to persist credentials when --email/--password* are passed: "keychain", "file", or "none" (default). Use "file" for SSH/headless sessions where the OS keychain is unavailable.',
    },
    'skip-onboarding': {
      type: 'boolean',
      description: 'Deprecated no-op; kept so existing scripts do not break.',
      default: false,
    },
  },
  async run({ args }) {
    return runLoginCommand(
      {
        json: args.json,
        timeout: args.timeout,
        interactive: args.interactive,
        email: typeof args.email === 'string' ? args.email : undefined,
        password: typeof args.password === 'string' ? args.password : undefined,
        passwordStdin: args['password-stdin'],
        save: typeof args.save === 'string' ? args.save : undefined,
      },
      {
        getCredentials: loadCredentials,
        saveCredentials: (email, password, useFile) =>
          saveCredentials(email, password, { useFile: useFile === true }),
      },
    );
  },
});

export interface LoginCommandArgs {
  readonly json: boolean;
  readonly timeout: string;
  readonly interactive: boolean;
  readonly email?: string | undefined;
  readonly password?: string | undefined;
  readonly passwordStdin: boolean;
  readonly save?: string | undefined;
}

interface ResolvedCredentials {
  readonly source: 'argv' | 'env' | 'keychain' | 'file' | 'prompt';
  readonly email: string;
  readonly password: string;
}

interface ResolveCredentialsOk {
  readonly kind: 'ok';
  readonly credentials: ResolvedCredentials | null;
  // 'request' means the user (via --save keychain or interactive prompt)
  // asked us to persist credentials before login. 'none' means do not save.
  readonly saveTarget: SaveTarget;
}

interface ResolveCredentialsError {
  readonly kind: 'error';
  readonly reason: string;
  readonly message: string;
  readonly exitCode: number;
}

type ResolveCredentialsResult = ResolveCredentialsOk | ResolveCredentialsError;

export async function runLoginCommand(args: LoginCommandArgs, deps: LoginDeps): Promise<never> {
  const emitError = (payload: Record<string, unknown>, human: string) => {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
    }
    process.stderr.write(`${human}\n`);
  };

  const timeoutSec = Number(args.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
    emitError(
      { reason: 'invalid-timeout', given: args.timeout },
      `Invalid --timeout value: ${args.timeout}`,
    );
    return exitAfterFlush(ExitCode.Usage);
  }
  const timeoutMs = timeoutSec * 1000;

  const rawAuthorizeUrl = process.env.AITCC_OAUTH_URL;
  const authorizeUrl = rawAuthorizeUrl ?? DEFAULT_AUTHORIZE_URL;
  if (rawAuthorizeUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawAuthorizeUrl);
    } catch {
      // fall through
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      emitError(
        { reason: 'invalid-authorize-url' },
        `AITCC_OAUTH_URL is not a valid http(s) URL: ${rawAuthorizeUrl}`,
      );
      return exitAfterFlush(ExitCode.Usage);
    }
    if (!isAllowedAuthorizeHost(parsed.hostname)) {
      emitError(
        { reason: 'authorize-host-not-allowed', host: parsed.hostname },
        `Refusing to open ${parsed.hostname}: only *.toss.im hosts are allowed for sign-in.`,
      );
      return exitAfterFlush(ExitCode.Usage);
    }
    process.stderr.write(`Using custom authorize URL from AITCC_OAUTH_URL: ${authorizeUrl}\n`);
  }

  // Resolve credentials before launching anything. The unified surface:
  // argv flags > env > keychain > interactive prompt > error (non-TTY).
  const resolved = await resolveCredentialsForLogin(args, deps);
  if (resolved.kind === 'error') {
    emitError({ reason: resolved.reason, message: resolved.message }, resolved.message);
    return exitAfterFlush(resolved.exitCode);
  }

  // Persist credentials BEFORE attempting login when the user asked us to.
  // Saving up-front means a successful save followed by a failed login still
  // leaves the backend in the user-intended state (so they can re-run
  // `aitcc login` without re-prompting). Save failure with an explicit
  // `--save keychain` or `--save file` is fatal — silently downgrading to
  // "session-only" would be the opposite of the user's request.
  let saved: SaveCredentialsStatus | 'skipped' = 'skipped';
  if (
    (resolved.saveTarget === 'keychain' || resolved.saveTarget === 'file') &&
    resolved.credentials !== null
  ) {
    const useFile = resolved.saveTarget === 'file';
    const save = deps.saveCredentials;
    if (!save) {
      emitError(
        { reason: 'save-unavailable', message: 'no save backend configured' },
        'Cannot save credentials: no backend configured.',
      );
      return exitAfterFlush(ExitCode.Generic);
    }
    try {
      const result = await save(resolved.credentials.email, resolved.credentials.password, useFile);
      saved = result.status;
      if (!args.json) {
        if (result.status === 'unchanged') {
          process.stderr.write('Credentials already saved (no change).\n');
        } else if (useFile) {
          process.stderr.write(
            `Credentials saved to file backend (${resolved.credentials.email}).\n`,
          );
        } else {
          process.stderr.write(
            `Credentials saved to OS keychain (${resolved.credentials.email}).\n`,
          );
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!useFile && process.platform === 'darwin') {
        emitError(
          { reason: 'keychain-save-failed', message },
          `keychain 접근에 실패했습니다.\n` +
            `SSH/headless 세션이면 다음 중 하나를 시도하세요:\n` +
            `  1) 데스크톱 GUI Mac에서: aitcc auth export --format=env (KR IP 필요)\n` +
            `     SSH에서: AITCC_SESSION='...' aitcc auth import --from-env\n` +
            `  2) 같은 SSH 세션에서 keychain unlock:\n` +
            `     security unlock-keychain ~/Library/Keychains/login.keychain-db\n` +
            `     (login 비밀번호 입력 후 재시도)\n` +
            `  3) keychain 대신 파일 저장:\n` +
            `     aitcc login --save=file (~/.config/aitcc/credentials.json, perm 0600)\n` +
            `참고: https://github.com/apps-in-toss-community/console-cli/issues/176`,
        );
      } else if (!useFile) {
        emitError(
          { reason: 'keychain-save-failed', message },
          `Failed to save credentials to the OS keychain: ${message}\n` +
            'On Linux, install libsecret (`secret-tool`) and retry. ' +
            'Re-run with `--save none` to skip persistence.',
        );
      } else {
        emitError(
          { reason: 'file-save-failed', message },
          `Failed to save credentials to file backend: ${message}\n` +
            'Check that ~/.config/aitcc/ is writable, or use AITCC_CREDENTIAL_FILE to specify a custom path.',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }
  }

  const initialMode: LoginMode = chooseLoginMode({
    interactiveFlag: args.interactive,
    hasCredentials: resolved.credentials !== null,
  });

  // Cap Chrome's own startup window at half the overall --timeout, with
  // a 30-second floor and 60-second ceiling. Corporate anti-virus can
  // easily push a cold Chrome launch past the default 15s; short
  // `--timeout` values shouldn't starve the launch itself.
  const endpointTimeoutMs = Math.min(60_000, Math.max(30_000, Math.floor(timeoutMs / 2)));

  // First attempt: in the chosen mode. If headless declines, we recurse
  // once into interactive — never the other way around.
  const firstAttemptStart = Date.now();
  const result = await attemptLogin({
    args,
    timeoutMs,
    endpointTimeoutMs,
    authorizeUrl,
    mode: initialMode,
    credentials: resolved.credentials,
    saved,
    emitError,
  });

  if (result.status === 'fallback-to-interactive') {
    process.stderr.write(`${result.message}\n`);
    // Subtract the time the headless attempt already burned so the user's
    // overall `--timeout` budget is honoured. A small floor protects the
    // human-typing window — if headless ate most of the budget we still
    // give the user a usable interactive session, with the cost showing
    // up as the command running slightly past the requested timeout.
    const fallbackTimeoutMs = computeFallbackTimeoutMs(timeoutMs, Date.now() - firstAttemptStart);
    const second = await attemptLogin({
      args,
      timeoutMs: fallbackTimeoutMs,
      endpointTimeoutMs,
      authorizeUrl,
      mode: 'interactive',
      credentials: null,
      saved,
      emitError,
    });
    if (second.status === 'exit') return exitAfterFlush(second.code);
    // A fallback returning fallback again is a programmer error — we
    // never request fallback while already interactive. Narrow on the
    // discriminant so a future variant can't silently land here.
    const _: 'fallback-to-interactive' = second.status;
    void _;
    return exitAfterFlush(ExitCode.Generic);
  }

  return exitAfterFlush(result.code);
}

/**
 * Resolve credentials and the requested save target for `aitcc login`.
 * Pure-ish: only side-effect is reading stdin via `deps.readStdin` (when
 * `--password-stdin` is set) and prompting via `deps.prompts` (when TTY).
 */
export async function resolveCredentialsForLogin(
  args: LoginCommandArgs,
  deps: LoginDeps,
  opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdoutIsTTY?: boolean;
    readonly stdinIsTTY?: boolean;
  } = {},
): Promise<ResolveCredentialsResult> {
  const env = opts.env ?? process.env;
  const stdoutIsTTY = opts.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stdinIsTTY = opts.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const interactiveTty = stdoutIsTTY && stdinIsTTY && !args.json;

  // --password and --password-stdin are mutually exclusive: both ask us to
  // pick a different source for the same field.
  if (args.password !== undefined && args.passwordStdin) {
    return {
      kind: 'error',
      reason: 'conflicting-password-source',
      message: '--password and --password-stdin cannot be used together.',
      exitCode: ExitCode.Usage,
    };
  }

  // --interactive forces the visible-browser flow where the human types
  // credentials directly into the page. Combining it with any credential
  // source (--email/--password/--password-stdin) or with --save would
  // silently drop the user's stated intent — the credentials would never
  // be used to drive form-fill, and the save block (which guards on
  // `credentials !== null`) would never run. Reject the combination up
  // front so the user notices instead of seeing a no-op.
  if (
    args.interactive &&
    (args.email !== undefined ||
      args.password !== undefined ||
      args.passwordStdin ||
      args.save !== undefined)
  ) {
    return {
      kind: 'error',
      reason: 'conflicting-interactive-flags',
      message:
        '--interactive cannot be combined with --email/--password/--password-stdin/--save. ' +
        'Drop --interactive to use credentials, or drop the credential flags to type in the browser.',
      exitCode: ExitCode.Usage,
    };
  }

  // Validate --save value early — it has to be defined here so we can
  // emit a clean error before we touch the network or any prompt.
  let saveTarget: SaveTarget | undefined;
  if (args.save !== undefined) {
    if (args.save !== 'keychain' && args.save !== 'file' && args.save !== 'none') {
      return {
        kind: 'error',
        reason: 'invalid-save',
        message: `--save must be "keychain", "file", or "none" (got "${args.save}").`,
        exitCode: ExitCode.Usage,
      };
    }
    saveTarget = args.save;
  }

  // 1) Explicit --email + (--password | --password-stdin): full argv mode.
  if (args.email !== undefined || args.password !== undefined || args.passwordStdin) {
    if (args.email === undefined || args.email.trim().length === 0) {
      return {
        kind: 'error',
        reason: 'missing-email',
        message: '--email is required when --password / --password-stdin is passed.',
        exitCode: ExitCode.Usage,
      };
    }
    if (!args.email.includes('@')) {
      return {
        kind: 'error',
        reason: 'invalid-email',
        message: `Invalid email: ${args.email}`,
        exitCode: ExitCode.Usage,
      };
    }

    let password: string;
    if (args.passwordStdin) {
      const reader = deps.readStdin ?? readStdinAll;
      const raw = await reader();
      password = stripTrailingNewline(raw);
      if (password.length === 0) {
        return {
          kind: 'error',
          reason: 'invalid-password',
          message: '--password-stdin received an empty password on stdin.',
          exitCode: ExitCode.Usage,
        };
      }
    } else if (args.password !== undefined) {
      // Loud, single warning: argv passwords leak into `ps`/Task Manager.
      // Mirrors the warning `auth set` used to emit so existing users see
      // the same message.
      process.stderr.write(
        'Warning: --password on argv is visible in `ps`/Task Manager. ' +
          'Prefer --password-stdin or the AITCC_PASSWORD environment variable.\n',
      );
      password = args.password;
      if (password.length === 0) {
        return {
          kind: 'error',
          reason: 'invalid-password',
          message: '--password value is empty.',
          exitCode: ExitCode.Usage,
        };
      }
    } else {
      // --email passed but no password source. We could prompt in TTY,
      // but a half-specified non-interactive call is more often a CI
      // typo than a feature; refuse to cover the failure mode.
      return {
        kind: 'error',
        reason: 'missing-password',
        message:
          '--email passed without a password. Add --password-stdin (recommended) or --password.',
        exitCode: ExitCode.Usage,
      };
    }

    return {
      kind: 'ok',
      credentials: { source: 'argv', email: args.email.trim(), password },
      saveTarget: saveTarget ?? 'none',
    };
  }

  // --interactive forces the visible-browser flow regardless of whether
  // credentials are configured. We still surface --save as user intent
  // for any subsequent re-run, but we don't drive form-fill ourselves.
  if (args.interactive) {
    return { kind: 'ok', credentials: null, saveTarget: saveTarget ?? 'none' };
  }

  // 2) AITCC_EMAIL + AITCC_PASSWORD env (CI single-shot).
  if (env.AITCC_EMAIL && env.AITCC_PASSWORD) {
    return {
      kind: 'ok',
      credentials: { source: 'env', email: env.AITCC_EMAIL, password: env.AITCC_PASSWORD },
      // Env credentials are intentionally ephemeral; --save has to be
      // explicit to persist them.
      saveTarget: saveTarget ?? 'none',
    };
  }

  // 3) OS keychain — auth-state pointer + keychain entry.
  const getCredentials = deps.getCredentials;
  if (getCredentials) {
    const fromStore = await getCredentials().catch((err: Error) => {
      // A credential backend hiccup shouldn't kill `aitcc login` — log a
      // one-line diagnostic and fall through to the interactive prompt.
      process.stderr.write(`Credential lookup failed (${err.message}); ignoring.\n`);
      return null;
    });
    if (fromStore) {
      // `loadCredentials` already prefers env over keychain, so reaching
      // this branch means the env path above didn't fire — this is the
      // keychain entry. Emit a one-line stderr breadcrumb so the user
      // knows where the headless attempt is getting its credentials from.
      if (!args.json) {
        process.stderr.write(
          `Using credentials from OS keychain for ${fromStore.email}. ` +
            'Pass --interactive to type a different account.\n',
        );
      }
      return {
        kind: 'ok',
        credentials: {
          source: fromStore.kind,
          email: fromStore.email,
          password: fromStore.password,
        },
        // Already stored — no need to re-save unless the user explicitly
        // asked.
        saveTarget: saveTarget ?? 'none',
      };
    }
  }

  // 4) Interactive prompt (TTY only). This is the new "first-run" path:
  // ask for email/password and the save target in one sequence, then run
  // the headless flow with the captured credentials.
  if (interactiveTty) {
    const prompts = deps.prompts ?? defaultPromptDeps;
    let email: string;
    let password: string;
    try {
      email = await prompts.email();
      password = await prompts.password();
    } catch (err) {
      if (isPromptCancelled(err)) {
        return {
          kind: 'error',
          reason: 'aborted',
          message: 'Aborted.',
          exitCode: ExitCode.Usage,
        };
      }
      throw err;
    }

    let promptedSave: SaveTarget;
    if (saveTarget !== undefined) {
      // CLI flag pre-empts the prompt — useful when the user knows the
      // answer in advance and doesn't want a third question.
      promptedSave = saveTarget;
    } else {
      try {
        promptedSave = await prompts.saveTarget();
      } catch (err) {
        if (isPromptCancelled(err)) {
          return {
            kind: 'error',
            reason: 'aborted',
            message: 'Aborted.',
            exitCode: ExitCode.Usage,
          };
        }
        throw err;
      }
    }

    return {
      kind: 'ok',
      credentials: { source: 'prompt', email, password },
      saveTarget: promptedSave,
    };
  }

  // 5) Non-TTY with no credentials: refuse and tell the operator how to
  // make the call non-interactive.
  return {
    kind: 'error',
    reason: 'interactive-required',
    message:
      'No credentials configured and stdin is not a TTY. ' +
      'Pass --email + --password-stdin (or set AITCC_EMAIL + AITCC_PASSWORD).',
    exitCode: ExitCode.Usage,
  };
}

interface AttemptOptions {
  readonly args: LoginCommandArgs;
  readonly timeoutMs: number;
  readonly endpointTimeoutMs: number;
  readonly authorizeUrl: string;
  readonly mode: LoginMode;
  readonly credentials: ResolvedCredentials | null;
  readonly saved: SaveCredentialsStatus | 'skipped';
  readonly emitError: (payload: Record<string, unknown>, human: string) => void;
}

type AttemptResult =
  | { readonly status: 'exit'; readonly code: number }
  | { readonly status: 'fallback-to-interactive'; readonly message: string };

async function attemptLogin(opts: AttemptOptions): Promise<AttemptResult> {
  const { args, timeoutMs, endpointTimeoutMs, authorizeUrl, mode, credentials, saved, emitError } =
    opts;
  const headless = mode === 'headless';

  const launched = await launchChrome({
    initialUrl: authorizeUrl,
    endpointTimeoutMs,
    headless,
  }).catch((err: Error) => err);
  if (launched instanceof ChromeNotFoundError) {
    emitError({ reason: 'chrome-not-found', candidates: launched.candidates }, launched.message);
    return { status: 'exit', code: ExitCode.LoginBrowserNotFound };
  }
  if (launched instanceof ChromeLaunchError || launched instanceof ChromeEndpointTimeoutError) {
    emitError(
      { reason: 'chrome-launch-failed', message: launched.message },
      `Failed to launch browser: ${launched.message}`,
    );
    return { status: 'exit', code: ExitCode.LoginBrowserFailed };
  }
  if (launched instanceof Error) {
    emitError(
      { reason: 'chrome-launch-failed', errorName: launched.name, message: launched.message },
      `Failed to launch browser (${launched.name}): ${launched.message}`,
    );
    return { status: 'exit', code: ExitCode.LoginBrowserFailed };
  }

  if (mode === 'interactive') {
    process.stderr.write(
      'Opened a browser window — complete the sign-in there. The CLI will capture the session automatically.\n',
    );
  } else {
    const sourceLabel = credentials?.source ?? 'configured store';
    process.stderr.write(`Signing in headlessly with credentials from ${sourceLabel}…\n`);
  }

  // Resource disposal must happen BEFORE `exitAfterFlush` is called:
  // exitAfterFlush terminates the process, and Chrome children on POSIX
  // are not killed automatically when the parent exits.
  let client: CdpClient | null = null;
  const disposeAll = async (): Promise<void> => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    await launched.dispose().catch(() => {});
  };

  try {
    client = await CdpClient.connect({ url: launched.webSocketDebuggerUrl });
  } catch (err) {
    emitError(
      { reason: 'cdp-connect-failed', message: (err as Error).message },
      `Could not connect to the browser over CDP: ${(err as Error).message}`,
    );
    await disposeAll();
    return { status: 'exit', code: ExitCode.LoginBrowserFailed };
  }

  let attached: Awaited<ReturnType<typeof attachToFirstPage>>;
  try {
    attached = await attachToFirstPage(client);
  } catch (err) {
    emitError(
      { reason: 'cdp-attach-failed', message: (err as Error).message },
      `Could not attach to the browser tab: ${(err as Error).message}`,
    );
    await disposeAll();
    return { status: 'exit', code: ExitCode.LoginBrowserFailed };
  }

  let stepUp = false;
  if (mode === 'headless') {
    if (!credentials) {
      // Defensive — caller should never put us here without credentials.
      await disposeAll();
      return {
        status: 'fallback-to-interactive',
        message: 'No credentials available; switching to interactive login.',
      };
    }
    let outcome: HeadlessLoginOutcome;
    try {
      outcome = await runHeadlessLogin({
        client,
        sessionId: attached.sessionId,
        credentials: { email: credentials.email, password: credentials.password },
        stepUpTimeoutMs: timeoutMs,
        onStepUp: () =>
          process.stderr.write(
            'Step-up auth requested — complete the prompt in the Toss app to continue…\n',
          ),
      });
    } catch (err) {
      // Real I/O failure inside the headless flow. Don't fall back —
      // surface it so the user can see what went wrong.
      emitError(
        { reason: 'headless-login-failed', message: (err as Error).message },
        `Headless login failed: ${(err as Error).message}`,
      );
      await disposeAll();
      return { status: 'exit', code: ExitCode.LoginBrowserFailed };
    }

    if (outcome.kind === 'fallback') {
      await disposeAll();
      return {
        status: 'fallback-to-interactive',
        message: `headless login failed: ${outcome.reason}, falling back to interactive`,
      };
    }
    if (outcome.kind === 'timeout') {
      emitError(
        { reason: 'login-timeout', timeoutSec: Math.floor(timeoutMs / 1000), stage: outcome.stage },
        `Login timed out after ${Math.floor(timeoutMs / 1000)}s (${outcome.stage}).`,
      );
      await disposeAll();
      return { status: 'exit', code: ExitCode.LoginTimeout };
    }
    stepUp = outcome.stepUp;
  } else {
    const landing = await waitForLanding(client, attached.sessionId, timeoutMs);
    if (landing === 'timeout') {
      emitError(
        { reason: 'login-timeout', timeoutSec: Math.floor(timeoutMs / 1000) },
        `Login timed out after ${Math.floor(timeoutMs / 1000)}s.`,
      );
      await disposeAll();
      return { status: 'exit', code: ExitCode.LoginTimeout };
    }
    if (landing === 'aborted') {
      emitError(
        { reason: 'login-aborted' },
        'Login was aborted (browser closed before reaching the console).',
      );
      await disposeAll();
      return { status: 'exit', code: ExitCode.LoginBrowserFailed };
    }
  }

  // Both paths converge here: pull cookies, resolve identity, write
  // session, emit human/JSON output.
  const cookies = await getAllCookies(client, attached.sessionId).catch((err: Error) => err);
  if (cookies instanceof Error) {
    emitError(
      { reason: 'cookie-capture-failed', message: cookies.message },
      `Failed to capture cookies: ${cookies.message}`,
    );
    await disposeAll();
    return { status: 'exit', code: ExitCode.LoginCookieCaptureFailed };
  }

  const user = await resolveUserWithRetry(cookies, {
    onRetry: (ms) =>
      process.stderr.write(
        `Cookies not yet accepted by the console API — retrying in ${ms}ms...\n`,
      ),
  }).catch((err: Error) => err);
  if (user instanceof Error) {
    const authFailed = user instanceof TossApiError && user.isAuthError;
    emitError(
      {
        reason: authFailed ? 'login-auth-not-active' : 'member-info-failed',
        message: user.message,
      },
      authFailed
        ? 'Browser session did not produce valid console cookies. Try again and wait for the workspace page to load.'
        : `Failed to read member info: ${user.message}`,
    );
    await disposeAll();
    return {
      status: 'exit',
      code: authFailed ? ExitCode.LoginCookieCaptureFailed : ExitCode.ApiError,
    };
  }

  const session: Session = {
    schemaVersion: 2,
    user: {
      id: String(user.id),
      email: user.email,
      displayName: user.name,
    },
    cookies,
    origins: [],
    capturedAt: new Date().toISOString(),
  };
  try {
    await writeSession(session);
  } catch (err) {
    emitError(
      { reason: 'session-write-failed', message: (err as Error).message },
      `Failed to write session file: ${(err as Error).message}`,
    );
    await disposeAll();
    return { status: 'exit', code: ExitCode.Generic };
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        status: 'logged-in',
        user: session.user,
        capturedAt: session.capturedAt,
        cookieCount: cookies.length,
        mode,
        credentialSource: credentials?.source ?? 'browser',
        saved,
        stepUp,
      })}\n`,
    );
  } else {
    process.stdout.write(`Logged in as ${user.name} <${user.email}>\n`);
  }

  await disposeAll();
  return { status: 'exit', code: ExitCode.Ok };
}

async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) {
    // Reading from a TTY would block waiting for the user to type EOF —
    // a CI typo (`--password-stdin` without a pipe) shouldn't hang.
    throw new Error('--password-stdin requires stdin to be a pipe, not a TTY.');
  }
  process.stdin.setEncoding('utf8');
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
  }
  return buf;
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}

// Mirrors the helper in app-init.ts / auth.ts — `@inquirer/prompts` throws an
// `ExitPromptError` (name only, the class isn't exported from the top-level
// package) when the user hits Ctrl-C. We don't want to surface that as a
// stack trace.
function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

export async function waitForLanding(
  client: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<'ok' | 'timeout' | 'aborted'> {
  // Two signals, run together, first wins:
  //   (a) Page.frameNavigated events — responsive, catches the final redirect.
  //   (b) Polling Page.getFrameTree — a safety net for the race where Chrome
  //       finishes the auth redirects before we finish attaching and
  //       subscribing. The navigation event won't re-fire for pages that
  //       already landed, so we have to poll the current URL at least once
  //       (and continue polling in case CDP events are dropped on slow links).
  return await new Promise<'ok' | 'timeout' | 'aborted'>((resolve) => {
    let settled = false;
    const stops: Array<() => void | Promise<void>> = [];
    const settle = (outcome: 'ok' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      for (const s of stops) {
        try {
          void s();
        } catch {
          // best effort
        }
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // Target-destroyed → the user closed the tab before landing.
    stops.push(
      client.on((event) => {
        if (event.method === 'Target.targetDestroyed') settle('aborted');
      }),
    );

    // (a) Live event subscription. Fires on fresh navigations after we
    //     Page.enable — may not trigger if Chrome already finished all
    //     redirects before we attached (handled by (b)).
    watchMainFrameNavigations(client, sessionId, (ev) => {
      if (!ev.isMainFrame) return;
      if (isLoginLanding(ev.url)) settle('ok');
    })
      .then((off) => {
        // Polling may have already settled by the time subscribe returns;
        // in that case unregister the listener immediately rather than
        // leaving it dangling on the client.
        if (settled) off();
        else stops.push(off);
      })
      .catch((err: Error) => {
        if (settled) return;
        process.stderr.write(`Could not watch for navigation: ${err.message}\n`);
      });

    // (b) Poll the current main-frame URL every second. Cheap, robust.
    const checkCurrent = async () => {
      if (settled) return;
      const tree = await client
        .send<{ frameTree: { frame: { url?: string; parentId?: string } } }>(
          'Page.getFrameTree',
          {},
          sessionId,
        )
        .catch(() => null);
      const url = tree?.frameTree.frame?.url;
      if (url && isLoginLanding(url)) settle('ok');
    };
    // Kick off an immediate check — covers the "already landed" case.
    void checkCurrent();
    const pollTimer = setInterval(() => {
      void checkCurrent();
    }, 1000);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  });
}

// The console issues auth cookies a beat after the landing navigation
// fires — if the first /me call 401s, we wait this long and retry once.
// Larger than the fastest observed exchange (~200 ms), small enough to
// keep the user from wondering whether the CLI hung.
export const AUTH_SETTLE_DELAY_MS = 750;

export async function resolveUserWithRetry(
  cookies: readonly CdpCookie[],
  opts: {
    onRetry?: (delayMs: number) => void;
    fetchImpl?: FetchLike;
  } = {},
): Promise<Awaited<ReturnType<typeof fetchConsoleMemberUserInfo>>> {
  const callArgs = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
  try {
    return await fetchConsoleMemberUserInfo(cookies, callArgs);
  } catch (err) {
    if (err instanceof TossApiError && err.isAuthError) {
      opts.onRetry?.(AUTH_SETTLE_DELAY_MS);
      await new Promise((r) => {
        const t = setTimeout(r, AUTH_SETTLE_DELAY_MS);
        if (typeof t.unref === 'function') t.unref();
      });
      return await fetchConsoleMemberUserInfo(cookies, callArgs);
    }
    throw err;
  }
}
