import { defineCommand } from 'citty';
import { fetchWorkspaceMembers } from '../api/members.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitFailureFromError,
  emitJson,
  printContextHeader,
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
    printContextHeader(ctx, { json: args.json });

    try {
      const members = await fetchWorkspaceMembers(workspaceId, session.cookies);
      if (args.json) {
        // `workspaceId` is omitted per-member (redundant with top level)
        // and `isAdult` is intentionally dropped — it is a Korean-specific
        // age-verification flag (성인 인증) classed as PII under local
        // compliance. Owners see *all* co-members, not just themselves, so
        // default-emitting it would leak every member's adult-verification
        // bit through `--json`. No CLI automation use case justifies
        // exposing it; if one ever arises, an opt-in flag is safer.
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
      return emitFailureFromError(args.json, err);
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
