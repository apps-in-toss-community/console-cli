import { defineCommand } from 'citty';
import { saveAitTokenProfile } from '../ait-token-profile.js';
import {
  type CreateApiKeyTarget,
  createApiKey,
  disableApiKey,
  fetchApiKeys,
} from '../api/api-keys.js';
import { probeAiRiskTerms } from '../api/me.js';
import { APP_NAME_REGEX } from '../config/app-manifest.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitFailureFromError,
  emitJson,
  formatAiRiskPreflightWarning,
  printContextHeader,
  resolveWorkspaceContext,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   keys ls [--workspace <id>]:
//     { ok: true, workspaceId, keys: [{id, name, expireTs, extra}], needsKey? } exit 0
//     { ok: false, reason: 'no-workspace-selected' }                            exit 2
//     { ok: false, reason: 'invalid-id', message }                              exit 2
//
//   `needsKey: true` is emitted when the key list is empty. The flag is
//   there so `/ait deploy` (and similar agent-plugin skills) can bail
//   with a friendly "issue a key first" message instead of attempting a
//   deploy that will 401 server-side. We keep the UI-specific Korean
//   wording out of JSON (it lives on stderr plain output only).
//
//   keys create --name <label> [--apps <slug,slug>] [--workspace <id>]
//               [--save-profile <name>] [--no-save-profile]:
//     { ok: true, workspaceId, apiKey, name, target: {isAll, appNames},
//       savedProfile?: string, saveProfileWarning?: string, extra }             exit 0
//     { ok: false, reason: 'invalid-name', message }                            exit 2
//     { ok: false, reason: 'invalid-apps', message }                            exit 2
//     { ok: false, reason: 'no-workspace-selected' }                            exit 2
//     { ok: false, reason: 'invalid-id', message }                              exit 2
//
//   The `apiKey` field carries the plaintext token and is surfaced **only
//   here** — the list endpoint does not echo it back. Agent-plugin skills
//   should pipe it straight into a secret manager and never log the raw
//   value. The CLI itself prints it to stdout once.
//
//   By default the key is automatically saved to `~/.ait/credentials` under
//   the same name as --name so `ait deploy --profile <name>` works
//   immediately. Pass `--no-save-profile` to skip this (stdout-only, for CI
//   pipes that store the key elsewhere).
//
//   When `--save-profile <name>` is given it overrides the auto-save
//   profile name; `--no-save-profile` disables saving entirely.
//
//   On auto/explicit save:
//     - On success: `savedProfile` is set to the profile name. The key is
//       saved to `~/.ait/credentials` so `ait deploy --profile <name>` works
//       immediately without a manual `ait token add` step.
//     - On failure (write error + ait not on PATH): `saveProfileWarning`
//       explains what went wrong; `apiKey` is still emitted and `exit 0`
//       so the caller can save it elsewhere.
//   The secret key value is NEVER included in `saveProfileWarning` or stderr.
//
//   keys revoke <id> [--workspace <id>]:
//     { ok: true, workspaceId, apiKeyId }                                       exit 0
//     { ok: false, reason: 'invalid-id', message }                              exit 2
//     { ok: false, reason: 'no-workspace-selected' }                            exit 2
//
//   Auth/network/api failures follow the shared contract (exit 10/11/17).
//
// Deploy Key (the console UI labels it "API key") — used to authenticate
// automated deploys. Endpoints + payload shapes confirmed from the console
// management-page chunk; full capture in docs/api/api-keys.md.

// `name` validation mirrors the UI dialog (`he` in static/index.ZsA5htf8.js):
//   - max 16 codepoints (UI shows length/16 counter, disables submit > 16)
//   - "공백, 한글, 특수문자 제외" placeholder = ASCII letters/digits/-/_ only
// We mirror the UI rule rather than rely on the server because the server
// returns a generic FAIL on rejection and a local check gives a better hint.
export const NAME_MAX = 16;
const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

// `appName` slugs are kebab-case ASCII per the mini-app registration regex.
// Reuse the canonical regex so a future tightening (length cap, allowed
// chars) flows here automatically instead of drifting.

export type NameValidationError = 'too-short' | 'too-long' | 'bad-chars';
export function validateKeyName(raw: string): NameValidationError | null {
  if (raw.length === 0) return 'too-short';
  if (raw.length > NAME_MAX) return 'too-long';
  if (!NAME_REGEX.test(raw)) return 'bad-chars';
  return null;
}

/**
 * Resolve the ait profile name to save the Deploy Key under.
 *
 * - `noSaveProfile: true` → undefined (skip saving)
 * - `saveProfileOverride` present → use that name
 * - default → use `name` (the --name value)
 *
 * Exported for unit testing.
 */
export function resolveProfileName(
  name: string,
  opts: { noSaveProfile?: boolean; saveProfileOverride?: string },
): string | undefined {
  if (opts.noSaveProfile) return undefined;
  if (opts.saveProfileOverride) return opts.saveProfileOverride;
  return name;
}

export type AppsParseResult =
  | { ok: true; slugs: string[] }
  | { ok: false; reason: 'empty' | 'invalid'; bad?: string[] };

export function parseAppsFlag(raw: string): AppsParseResult {
  const slugs = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (slugs.length === 0) return { ok: false, reason: 'empty' };
  const bad = slugs.filter((s) => !APP_NAME_REGEX.test(s));
  if (bad.length > 0) return { ok: false, reason: 'invalid', bad };
  return { ok: true, slugs };
}

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List Deploy Keys in the selected workspace.',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace (`aitcc workspace use`).',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    try {
      const keys = await fetchApiKeys(workspaceId, session.cookies);
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          keys: keys.map((k) => ({
            id: k.id,
            name: k.name ?? null,
            expireTs: k.expireTs ?? null,
            extra: k.extra,
          })),
          ...(keys.length === 0 ? { needsKey: true } : {}),
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (keys.length === 0) {
        process.stdout.write(`No Deploy Keys in workspace ${workspaceId}.\n`);
        process.stderr.write(
          'Hint: `aitcc keys create --name <label>` to issue one (deploy automation requires a Deploy Key).\n',
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`${keys.length} Deploy Key(s) in workspace ${workspaceId}:\n`);
      const now = Date.now();
      for (const k of keys) {
        const name = k.name ?? '(unnamed)';
        const expiry = formatExpiry(k.expireTs, now);
        process.stdout.write(`${k.id}\t${name}\t${expiry}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const createCommand = defineCommand({
  meta: {
    name: 'create',
    description: 'Issue a new Deploy Key. Plaintext is shown once.',
  },
  args: {
    name: {
      type: 'string',
      description:
        'Label for the key (≤16 ASCII chars: letters/digits/-/_). Required, mirrors the UI dialog.',
      required: true,
    },
    apps: {
      type: 'string',
      description:
        'Comma-separated mini-app `appName` slugs to scope the key to. Omit for an all-apps key (default).',
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    'save-profile': {
      type: 'string',
      description:
        'Profile name for the ait token (defaults to --name). The key is written to ' +
        '`~/.ait/credentials` so `ait deploy --profile <name>` works immediately. ' +
        'Use --no-save-profile to skip.',
    },
    'no-save-profile': {
      type: 'boolean',
      default: false,
      description:
        'Do not save the issued key to an ait token profile — print to stdout only ' +
        '(for CI pipes that store it elsewhere).',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    const name = String(args.name);
    const nameErr = validateKeyName(name);
    if (nameErr !== null) {
      const message =
        nameErr === 'too-short'
          ? '--name is required (1..16 chars)'
          : nameErr === 'too-long'
            ? `--name must be ≤${NAME_MAX} chars (got ${name.length})`
            : '--name may contain only ASCII letters, digits, hyphen, and underscore (no spaces, Korean, or special chars)';
      if (args.json) emitJson({ ok: false, reason: 'invalid-name', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    let target: CreateApiKeyTarget;
    if (args.apps) {
      const parsed = parseAppsFlag(String(args.apps));
      if (!parsed.ok) {
        const message =
          parsed.reason === 'empty'
            ? '--apps was empty (drop the flag for an all-apps key)'
            : `--apps contains invalid slug(s): ${(parsed.bad ?? []).join(', ')} (expected kebab-case: [a-z][a-z0-9-]*)`;
        if (args.json) emitJson({ ok: false, reason: 'invalid-apps', message });
        else process.stderr.write(`${message}\n`);
        return exitAfterFlush(ExitCode.Usage);
      }
      target = { isAll: false, appNames: parsed.slugs };
    } else {
      target = { isAll: true, appNames: [] };
    }

    // Preflight: best-effort AI_RISK_USE (5010) gate check before the real
    // createApiKey call. Diagnostic-only — never blocks; the server is the
    // authoritative gate (emitFailureFromError prints hintForErrorCode('5010')
    // if we proceed and still get 5010). Under --json we skip the human warning
    // entirely (printContextHeader precedent) so stdout stays one JSON line.
    // SECRET-HANDLING: only title/contentsUrl (public) are rendered — never
    // session.cookies, the Cookie header, or the GET URL.
    if (!args.json) {
      const gate = await probeAiRiskTerms(session.cookies);
      if (gate.status === 'pending') {
        process.stderr.write(formatAiRiskPreflightWarning(gate.pending));
      }
    }

    try {
      const result = await createApiKey(workspaceId, { name, target }, session.cookies);

      // Auto-save the key to ~/.ait/credentials so `ait deploy --profile <name>`
      // works immediately without a manual `ait token add` step.
      // --no-save-profile disables this; --save-profile <other> overrides the name.
      // Failure is non-fatal: we still surface the key and exit 0 so the caller
      // can save it elsewhere.
      // SECRET-HANDLING: apiKey is never included in warning messages.
      const saveProfileName = resolveProfileName(name, {
        noSaveProfile: args['no-save-profile'],
        ...(args['save-profile'] ? { saveProfileOverride: String(args['save-profile']) } : {}),
      });
      let savedProfile: string | undefined;
      let saveProfileWarning: string | undefined;

      if (saveProfileName !== undefined) {
        const saveResult = saveAitTokenProfile(saveProfileName, result.apiKey);
        if (saveResult.ok) {
          savedProfile = saveResult.profile;
        } else {
          saveProfileWarning =
            `Could not save to ait profile "${saveProfileName}": ${saveResult.detail}. ` +
            'Save the key manually with `ait token add --api-key <key> ' +
            saveProfileName +
            '`.';
        }
      }

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          apiKey: result.apiKey,
          name,
          target: { isAll: target.isAll, appNames: [...target.appNames] },
          ...(savedProfile !== undefined ? { savedProfile } : {}),
          ...(saveProfileWarning !== undefined ? { saveProfileWarning } : {}),
          extra: result.extra,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      // Plaintext is shown exactly once on stdout so the line is pipe-friendly
      // (`aitcc keys create ... | secret-tool store ...`).
      // On the default/auto-save path stderr confirms where the profile landed
      // so the user can immediately run `ait deploy --profile <name>`.
      // The "shown only once" warning is only emitted when saving was skipped
      // (--no-save-profile) or failed, so the user knows to save it manually.
      // SECRET-HANDLING: apiKey never appears in stderr or warning text.
      process.stdout.write(`${result.apiKey}\n`);
      if (savedProfile !== undefined) {
        process.stderr.write(
          `Saved as ait profile "${savedProfile}". Run: ait deploy --profile ${savedProfile}\n`,
        );
      } else {
        process.stderr.write(
          '⚠️  This key is shown only once. Save it to a secret manager now — it cannot be retrieved later.\n',
        );
      }
      if (saveProfileWarning !== undefined) {
        process.stderr.write(`Warning: ${saveProfileWarning}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const revokeCommand = defineCommand({
  meta: {
    name: 'revoke',
    description: 'Disable a Deploy Key by id.',
  },
  args: {
    id: {
      type: 'positional',
      required: true,
      description: 'Deploy Key id (from `aitcc keys ls`).',
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    // citty enforces `required: true` on the positional, so `args.id` is
    // always present when `run` is called.
    const rawId = String(args.id);

    try {
      await disableApiKey(workspaceId, rawId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, apiKeyId: rawId });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Revoked Deploy Key ${rawId} in workspace ${workspaceId}.\n`);
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export function formatExpiry(expireTs: number | undefined, now: number): string {
  if (expireTs === undefined) return '';
  const diffMs = expireTs - now;
  const days = Math.floor(diffMs / 86_400_000);
  if (diffMs < 0) return 'expired';
  return `D-${days}`;
}

export const keysCommand = defineCommand({
  meta: {
    name: 'keys',
    description: 'Manage Deploy Keys used for deploy automation.',
  },
  subCommands: {
    ls: lsCommand,
    create: createCommand,
    revoke: revokeCommand,
  },
});
