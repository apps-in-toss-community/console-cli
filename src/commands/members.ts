import { defineCommand } from 'citty';
import { NetworkError, TossApiError } from '../api/http.js';
import { fetchWorkspaceMembers } from '../api/members.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitApiError,
  emitJson,
  emitNetworkError,
  emitNotAuthenticated,
  resolveWorkspaceContext,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   members ls [--workspace <id>]:
//     { ok: true, workspaceId, members: [{bizUserNo, name, email, status, role, ...}] } exit 0
//     { ok: false, reason: 'no-workspace-selected' }                                    exit 2
//     { ok: false, reason: 'invalid-id', message }                                      exit 2
//
//   Auth/network/api failures follow the shared contract (exit 10/11/17).

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List members of the selected workspace.',
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

    try {
      const members = await fetchWorkspaceMembers(workspaceId, session.cookies);
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          members: members.map((m) => ({
            bizUserNo: m.bizUserNo,
            name: m.name,
            email: m.email,
            status: m.status,
            role: m.role,
            isOwnerDelegationRequested: m.isOwnerDelegationRequested,
          })),
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (members.length === 0) {
        process.stdout.write(`No members in workspace ${workspaceId}.\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const m of members) {
        process.stdout.write(`${m.bizUserNo}\t${m.name}\t${m.email}\t${m.role}\t${m.status}\n`);
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

export const membersCommand = defineCommand({
  meta: {
    name: 'members',
    description: 'Inspect workspace members.',
  },
  subCommands: {
    ls: lsCommand,
  },
});
