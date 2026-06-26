import { defineCommand } from 'citty';
import { fetchWorkspaceMembers, inviteMember, removeMember } from '../api/members.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitFailureFromError,
  emitJson,
  parsePositiveInt,
  printContextHeader,
  resolveWorkspaceContext,
  withReauthRetry,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   members ls [--workspace <id>]:
//     { ok: true, workspaceId, members: [{bizUserNo, name, email, status, role, ...}] } exit 0
//     { ok: false, reason: 'no-workspace-selected' }                                    exit 2
//     { ok: false, reason: 'invalid-id', message }                                      exit 2
//
//   members invite <email> [--role <role>] [--workspace <id>]:
//     { ok: true, workspaceId, email }                                                  exit 0
//     { ok: false, reason: 'invalid-email', message }                                   exit 2
//     { ok: false, reason: 'no-workspace-selected' }                                    exit 2
//     { ok: false, reason: 'invalid-id', message }                                      exit 2
//
//   members remove <bizUserNo> [--workspace <id>]:
//     { ok: true, workspaceId, bizUserNo }                                              exit 0
//     { ok: false, reason: 'invalid-id', message }                                      exit 2
//     { ok: false, reason: 'no-workspace-selected' }                                    exit 2
//
//   Auth/network/api failures follow the shared contract (exit 10/11/17).
//
//   ⚠️ invite and remove use inferred endpoints (method/path confirmed;
//   payload/response/errorCodes not live-captured). See docs/api/members.md.

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
      const members = await withReauthRetry(args.json, session, (s) =>
        fetchWorkspaceMembers(workspaceId, s.cookies),
      );
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

// Simple email format check: must contain exactly one `@` with non-empty
// local and domain parts. We mirror what the console UI dialog would
// silently accept (any plausible email), not RFC 5322 strict — a server
// error on a malformed address is an acceptable fallback.
function isValidEmail(email: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0) return false;
  const domain = email.slice(at + 1);
  return domain.length > 0 && domain.includes('.');
}

const inviteCommand = defineCommand({
  meta: {
    name: 'invite',
    description: 'Invite a user to the workspace by email.',
  },
  args: {
    email: {
      type: 'positional',
      required: true,
      description: 'Email address of the user to invite.',
    },
    role: {
      type: 'string',
      description: 'Role to assign (default: server default). Example: MEMBER.',
    },
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

    const email = String(args.email).trim();
    if (!isValidEmail(email)) {
      const message = `<email> must be a valid email address (got ${JSON.stringify(email)})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-email', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const role = args.role ? String(args.role).trim() : undefined;

    try {
      await inviteMember(workspaceId, email, role, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, email });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Invited ${email} to workspace ${workspaceId}.\n`);
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a member from the workspace by their bizUserNo.',
  },
  args: {
    bizUserNo: {
      type: 'positional',
      required: true,
      description: 'bizUserNo of the member to remove (from `aitcc members ls`).',
    },
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

    const rawId = String(args.bizUserNo);
    const parsed = parsePositiveInt(rawId);
    if (parsed === null) {
      const message = `<bizUserNo> must be a positive integer (got ${JSON.stringify(rawId)})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-id', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    try {
      await removeMember(workspaceId, parsed, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, bizUserNo: parsed });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Removed member ${parsed} from workspace ${workspaceId}.\n`);
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export const membersCommand = defineCommand({
  meta: {
    name: 'members',
    description: 'Inspect and manage workspace members.',
  },
  subCommands: {
    ls: lsCommand,
    invite: inviteCommand,
    remove: removeCommand,
  },
});
