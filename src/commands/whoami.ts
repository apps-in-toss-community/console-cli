import { defineCommand } from 'citty';
import { NetworkError, TossApiError } from '../api/http.js';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, sessionPathForDiagnostics } from '../session.js';

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

    if (!session) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ authenticated: false })}\n`);
      } else {
        process.stderr.write('Not logged in. Run `aitcc login` to start a session.\n');
        process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
      }
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    if (args.offline) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            authenticated: true,
            source: 'cache',
            user: session.user,
            capturedAt: session.capturedAt,
          })}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      const label = session.user.displayName
        ? `${session.user.displayName} <${session.user.email}>`
        : session.user.email;
      process.stdout.write(`Logged in as ${label} (cached)\n`);
      process.stdout.write(`Session captured: ${session.capturedAt}\n`);
      return exitAfterFlush(ExitCode.Ok);
    }

    try {
      const info = await fetchConsoleMemberUserInfo(session.cookies);
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
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
          })}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Logged in as ${info.name} <${info.email}> (${info.role})\n`);
      if (info.workspaces.length > 0) {
        process.stdout.write('Workspaces:\n');
        for (const w of info.workspaces) {
          process.stdout.write(`  - ${w.workspaceName} (id ${w.workspaceId}, ${w.role})\n`);
        }
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      if (err instanceof TossApiError && err.isAuthError) {
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              authenticated: false,
              reason: 'session-expired',
              errorCode: err.errorCode,
            })}\n`,
          );
        } else {
          process.stderr.write('Session is no longer valid. Run `aitcc login` again.\n');
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
