import { defineCommand } from 'citty';
import { NetworkError, TossApiError } from '../api/http.js';
import { type AiRiskTermsState, fetchConsoleMemberUserInfo, probeAiRiskTerms } from '../api/me.js';
import { getActiveCredentialEmail } from '../auth/credentials.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, sessionPathForDiagnostics } from '../session.js';
import { withReauthRetry } from './_shared.js';

// Resolve the credential source label without loading the password from disk.
// Returns `null` when nothing is configured so the JSON shape can stay compact.
async function describeCredentialSource(): Promise<{
  source: 'env' | 'file' | 'none';
  email: string | null;
}> {
  const active = await getActiveCredentialEmail().catch(() => null);
  if (!active) return { source: 'none', email: null };
  return { source: active.kind, email: active.email };
}

function formatCredentials(cred: {
  source: 'env' | 'file' | 'none';
  email: string | null;
}): string {
  if (cred.source === 'none') return 'none (run `aitcc login` to save)';
  if (cred.source === 'env') {
    return `env (AITCC_EMAIL${cred.email ? ` = ${cred.email}` : ''})`;
  }
  return `file (~/.config/aitcc/credentials.json)${cred.email ? ` (${cred.email})` : ''}`;
}

// --json contract (consumed by agent-plugin):
//
//   Success (session present + — for live mode — reachable):
//     { ok: true, authenticated: true, source: 'live'|'cache', user, capturedAt, ... }
//   Session missing:
//     { ok: true, authenticated: false }                                  exit 10
//   Session expired (console rejected our cookies):
//     { ok: true, authenticated: false, reason: 'session-expired' }       exit 10
//   Network failure talking to the console:
//     { ok: false, reason: 'network-error', message }                     exit 11
//   Any other API / unexpected error:
//     { ok: false, reason: 'api-error', message }                         exit 17
//
// The top-level `ok` is always present and indicates whether the command
// ran cleanly; `authenticated` is only meaningful when `ok: true`.

// The throttled "newer aitcc available?" probe used to live here and fire only
// on `whoami`. It now runs as the root command's `cleanup` hook
// (src/update-notice-hook.ts), so EVERY command surfaces the notice — and
// `whoami` no longer needs its own call (which would double-fire). The hook
// keeps the same guards: 500 ms cap, `--json` suppression, fully defensive.

export const whoamiCommand = defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the currently authenticated user (live from the console API by default).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON to stdout.',
      default: false,
    },
    offline: {
      type: 'boolean',
      description: 'Skip the live API call and read only the cached session summary.',
      default: false,
    },
  },
  async run({ args }) {
    const session = await readSession();
    const cred = await describeCredentialSource();

    if (!session) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            authenticated: false,
            credentialSource: cred.source,
            ...(cred.email ? { credentialEmail: cred.email } : {}),
          })}\n`,
        );
      } else {
        process.stderr.write('Not logged in. Run `aitcc login` to start a session.\n');
        process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
        process.stderr.write(`Credentials: ${formatCredentials(cred)}\n`);
      }
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    if (args.offline) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            authenticated: true,
            source: 'cache',
            user: session.user,
            capturedAt: session.capturedAt,
            credentialSource: cred.source,
            ...(cred.email ? { credentialEmail: cred.email } : {}),
          })}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      const label = session.user.displayName
        ? `${session.user.displayName} <${session.user.email}>`
        : session.user.email;
      process.stdout.write(`Logged in as ${label} (cached)\n`);
      process.stdout.write(`Credentials: ${formatCredentials(cred)}\n`);
      process.stdout.write(`Session captured: ${session.capturedAt}\n`);
      return exitAfterFlush(ExitCode.Ok);
    }

    try {
      const info = await withReauthRetry(args.json, session, (s) =>
        fetchConsoleMemberUserInfo(s.cookies),
      );
      const gate: AiRiskTermsState = await probeAiRiskTerms(session.cookies).catch(
        () => ({ status: 'unknown' }) as AiRiskTermsState,
      );

      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            authenticated: true,
            source: 'live',
            user: {
              id: String(info.id),
              bizUserNo: info.bizUserNo,
              name: info.name,
              email: info.email,
              role: info.role,
            },
            workspaces: info.workspaces.map((w) => ({
              workspaceId: w.workspaceId,
              workspaceName: w.workspaceName,
              role: w.role,
            })),
            capturedAt: session.capturedAt,
            credentialSource: cred.source,
            ...(cred.email ? { credentialEmail: cred.email } : {}),
            aiRiskTerms:
              gate.status === 'agreed'
                ? { status: 'agreed' }
                : gate.status === 'pending'
                  ? { status: 'pending', errorCode: 5010 }
                  : { status: 'unknown' },
          })}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Logged in as ${info.name} <${info.email}> (${info.role})\n`);
      process.stdout.write(`Credentials: ${formatCredentials(cred)}\n`);
      if (info.workspaces.length > 0) {
        process.stdout.write('Workspaces:\n');
        for (const w of info.workspaces) {
          process.stdout.write(`  - ${w.workspaceName} (id ${w.workspaceId}, ${w.role})\n`);
        }
      }
      if (gate.status === 'pending') {
        process.stdout.write(
          'AI risk terms: 미동의 (errorCode 5010 차단 중) — `aitcc me terms agree --scope AI_RISK_USE`로 동의\n',
        );
      } else if (gate.status === 'agreed') {
        process.stdout.write('AI risk terms: 동의 완료\n');
      }
      // status === 'unknown' (probe 실패): 줄 생략
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      if (err instanceof TossApiError && err.isAuthError) {
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: true,
              authenticated: false,
              reason: 'session-expired',
              errorCode: err.errorCode,
              credentialSource: cred.source,
              ...(cred.email ? { credentialEmail: cred.email } : {}),
            })}\n`,
          );
        } else {
          process.stderr.write('Session is no longer valid. Run `aitcc login` again.\n');
          process.stderr.write(`Credentials: ${formatCredentials(cred)}\n`);
        }
        return exitAfterFlush(ExitCode.NotAuthenticated);
      }
      if (err instanceof NetworkError) {
        // Network failures are surfaced as hard errors — we don't silently
        // fall back to the cache because agent-plugin callers branching on
        // exit code would miss the degradation. Users who explicitly want
        // the cached identity have `--offline` for that.
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, reason: 'network-error', message: err.message })}\n`,
          );
        } else {
          process.stderr.write(
            `Network error reaching the console API: ${err.message}. Use \`aitcc whoami --offline\` for the cached identity.\n`,
          );
        }
        return exitAfterFlush(ExitCode.NetworkError);
      }
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, reason: 'api-error', message: (err as Error).message })}\n`,
        );
      } else {
        process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
      }
      return exitAfterFlush(ExitCode.ApiError);
    }
  },
});
