import { defineCommand } from 'citty';
import { NetworkError, TossApiError } from '../api/http.js';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import { fetchWorkspaceDetail } from '../api/workspaces.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, sessionPathForDiagnostics, setCurrentWorkspaceId } from '../session.js';

// --json contract (consumed by agent-plugin):
//
//   workspace ls:
//     { ok: true, workspaces: [{workspaceId, workspaceName, role, current}] }
//                                                                     ^--- matches currentWorkspaceId
//   workspace use <id>:
//     { ok: true, workspaceId, workspaceName }                        exit 0
//     { ok: false, reason: 'not-found', workspaceId }                 exit 2
//   workspace show [id]:
//     { ok: true, workspaceId, workspaceName, extra }                 exit 0
//     { ok: false, reason: 'no-workspace-selected' }                  exit 2
//
// Every workspace subcommand inherits the standard auth failure modes from
// whoami: { ok: true, authenticated: false } exit 10, network-error exit 11,
// api-error exit 17.

interface NotAuthenticatedPayload {
  readonly ok: true;
  readonly authenticated: false;
  readonly reason?: 'session-expired';
}

function emitNotAuthenticated(json: boolean, reason?: 'session-expired'): void {
  if (json) {
    const payload: NotAuthenticatedPayload = reason
      ? { ok: true, authenticated: false, reason }
      : { ok: true, authenticated: false };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(
      reason === 'session-expired'
        ? 'Session is no longer valid. Run `aitcc login` again.\n'
        : 'Not logged in. Run `aitcc login` to start a session.\n',
    );
    process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
  }
}

function emitNetworkError(json: boolean, message: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'network-error', message })}\n`);
  } else {
    process.stderr.write(`Network error reaching the console API: ${message}.\n`);
  }
}

function emitApiError(json: boolean, message: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'api-error', message })}\n`);
  } else {
    process.stderr.write(`Unexpected error: ${message}\n`);
  }
}

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List workspaces the current user has access to.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }
    try {
      const info = await fetchConsoleMemberUserInfo(session.cookies);
      const current = session.currentWorkspaceId;
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            workspaces: info.workspaces.map((w) => ({
              workspaceId: w.workspaceId,
              workspaceName: w.workspaceName,
              role: w.role,
              current: w.workspaceId === current,
            })),
          })}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      if (info.workspaces.length === 0) {
        process.stdout.write('No workspaces.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const w of info.workspaces) {
        const marker = w.workspaceId === current ? '* ' : '  ';
        process.stdout.write(`${marker}${w.workspaceId}  ${w.workspaceName}  (${w.role})\n`);
      }
      if (current === undefined) {
        process.stderr.write('\nNo workspace selected. Run `aitcc workspace use <id>`.\n');
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      if (err instanceof TossApiError && err.isAuthError) {
        emitNotAuthenticated(args.json, 'session-expired');
        return exitAfterFlush(ExitCode.NotAuthenticated);
      }
      if (err instanceof NetworkError) {
        emitNetworkError(args.json, err.message);
        return exitAfterFlush(ExitCode.NetworkError);
      }
      emitApiError(args.json, (err as Error).message);
      return exitAfterFlush(ExitCode.ApiError);
    }
  },
});

const useCommand = defineCommand({
  meta: {
    name: 'use',
    description: 'Select the current workspace by ID. Subsequent commands use this.',
  },
  args: {
    id: { type: 'positional', description: 'Workspace ID', required: true },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const parsed = Number.parseInt(String(args.id), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, reason: 'invalid-id', message: `workspace id must be a positive integer (got ${String(args.id)})` })}\n`,
        );
      } else {
        process.stderr.write(`workspace id must be a positive integer (got ${String(args.id)})\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    // Validate against the user's actual workspace list before writing the
    // selection. Silently accepting an id that the account can't access
    // produces confusing 403s from every subsequent command.
    try {
      const info = await fetchConsoleMemberUserInfo(session.cookies);
      const match = info.workspaces.find((w) => w.workspaceId === parsed);
      if (!match) {
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, reason: 'not-found', workspaceId: parsed })}\n`,
          );
        } else {
          process.stderr.write(
            `Workspace ${parsed} is not accessible from this account. Run \`aitcc workspace ls\` to see available workspaces.\n`,
          );
        }
        return exitAfterFlush(ExitCode.Usage);
      }
      await setCurrentWorkspaceId(parsed);
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, workspaceId: match.workspaceId, workspaceName: match.workspaceName })}\n`,
        );
      } else {
        process.stdout.write(`Using workspace ${match.workspaceId} (${match.workspaceName}).\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      if (err instanceof TossApiError && err.isAuthError) {
        emitNotAuthenticated(args.json, 'session-expired');
        return exitAfterFlush(ExitCode.NotAuthenticated);
      }
      if (err instanceof NetworkError) {
        emitNetworkError(args.json, err.message);
        return exitAfterFlush(ExitCode.NetworkError);
      }
      emitApiError(args.json, (err as Error).message);
      return exitAfterFlush(ExitCode.ApiError);
    }
  },
});

const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show details of the selected workspace (or the one passed with --workspace).',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID to inspect. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    let workspaceId: number | undefined;
    if (args.workspace) {
      const parsed = Number.parseInt(String(args.workspace), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, reason: 'invalid-id', message: `--workspace must be a positive integer (got ${String(args.workspace)})` })}\n`,
          );
        } else {
          process.stderr.write(
            `--workspace must be a positive integer (got ${String(args.workspace)})\n`,
          );
        }
        return exitAfterFlush(ExitCode.Usage);
      }
      workspaceId = parsed;
    } else {
      workspaceId = session.currentWorkspaceId;
    }

    if (workspaceId === undefined) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, reason: 'no-workspace-selected' })}\n`);
      } else {
        process.stderr.write(
          'No workspace selected. Pass `--workspace <id>` or run `aitcc workspace use <id>`.\n',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    try {
      const detail = await fetchWorkspaceDetail(workspaceId, session.cookies);
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            workspaceId: detail.workspaceId,
            workspaceName: detail.workspaceName,
            extra: detail.extra ?? {},
          })}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Workspace ${detail.workspaceId}: ${detail.workspaceName}\n`);
      if (detail.extra) {
        for (const [k, v] of Object.entries(detail.extra)) {
          process.stdout.write(`  ${k}: ${formatScalar(v)}\n`);
        }
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      if (err instanceof TossApiError && err.isAuthError) {
        emitNotAuthenticated(args.json, 'session-expired');
        return exitAfterFlush(ExitCode.NotAuthenticated);
      }
      if (err instanceof NetworkError) {
        emitNetworkError(args.json, err.message);
        return exitAfterFlush(ExitCode.NetworkError);
      }
      emitApiError(args.json, (err as Error).message);
      return exitAfterFlush(ExitCode.ApiError);
    }
  },
});

function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export const workspaceCommand = defineCommand({
  meta: {
    name: 'workspace',
    description: 'Inspect and switch between the workspaces this account can access.',
  },
  subCommands: {
    ls: lsCommand,
    use: useCommand,
    show: showCommand,
  },
});
