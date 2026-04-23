import { defineCommand } from 'citty';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import { fetchWorkspaceDetail, fetchWorkspacePartner } from '../api/workspaces.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, setCurrentWorkspaceId } from '../session.js';
import {
  emitFailureFromError,
  emitJson,
  emitNotAuthenticated,
  parsePositiveInt,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   workspace ls:
//     { ok: true, workspaces: [{workspaceId, workspaceName, role, current}] }
//                                                                     ^--- matches currentWorkspaceId
//   workspace use <id>:
//     { ok: true, workspaceId, workspaceName }                        exit 0
//     { ok: false, reason: 'not-found', workspaceId }                 exit 2
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//   workspace show [--workspace <id>]:
//     { ok: true, workspaceId, workspaceName, extra }                 exit 0
//     { ok: false, reason: 'no-workspace-selected' }                  exit 2
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//   workspace partner [--workspace <id>]:
//     { ok: true, workspaceId, registered, approvalType,
//       rejectMessage, partner }                                      exit 0
//     { ok: false, reason: 'no-workspace-selected' }                  exit 2
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//
// Every workspace subcommand inherits the standard auth failure modes from
// whoami: { ok: true, authenticated: false } exit 10, network-error exit 11,
// api-error exit 17. All JSON writes go through the shared `emitJson` so the
// single-line-with-trailing-newline invariant is enforced in one place.

// Formatting helper for the plain-text `show` output. `--json` is the
// structured consumption path; this is a crude fallback so a human can
// skim the response at a glance. Objects/arrays collapse to a single
// JSON line on purpose — nested structures are rare in the detail
// response and unreadable in any form without real tabular formatting.
function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
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
        const workspaces = info.workspaces.map((w) => ({
          workspaceId: w.workspaceId,
          workspaceName: w.workspaceName,
          role: w.role,
          current: w.workspaceId === current,
        }));
        emitJson({ ok: true, workspaces });
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
        process.stderr.write('No workspace selected. Run `aitcc workspace use <id>`.\n');
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
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
    const raw = String(args.id);
    const parsed = parsePositiveInt(raw);
    if (parsed === null) {
      const message = `workspace id must be a positive integer (got ${raw})`;
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-id', message });
      } else {
        process.stderr.write(`${message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    // Validate against the user's actual workspace list before writing the
    // selection. `members/me/user-info` is the live list, not the stored
    // one, so a workspace added after login is visible here. Only the
    // detail endpoint (not called here) could still 403 after this check.
    try {
      const info = await fetchConsoleMemberUserInfo(session.cookies);
      const match = info.workspaces.find((w) => w.workspaceId === parsed);
      if (!match) {
        if (args.json) {
          emitJson({ ok: false, reason: 'not-found', workspaceId: parsed });
        } else {
          process.stderr.write(
            `Workspace ${parsed} is not accessible from this account. Run \`aitcc workspace ls\` to see available workspaces.\n`,
          );
        }
        return exitAfterFlush(ExitCode.Usage);
      }
      // `setCurrentWorkspaceId` returns null only if the session disappeared
      // between our `readSession` above and here (e.g. concurrent logout).
      // Surface that as "not logged in" for consistency with other commands
      // instead of silently pretending the write landed. For v1 sessions
      // this is a double-read (readSession migrates, then this helper reads
      // again before writing) — benign, and preferable to threading the
      // already-loaded session through a new parameter just to save one IO.
      const updated = await setCurrentWorkspaceId(parsed);
      if (updated === null) {
        emitNotAuthenticated(args.json);
        return exitAfterFlush(ExitCode.NotAuthenticated);
      }
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId: match.workspaceId,
          workspaceName: match.workspaceName,
        });
      } else {
        process.stdout.write(`Using workspace ${match.workspaceId} (${match.workspaceName}).\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
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
      const raw = String(args.workspace);
      const parsed = parsePositiveInt(raw);
      if (parsed === null) {
        const message = `--workspace must be a positive integer (got ${raw})`;
        if (args.json) {
          emitJson({ ok: false, reason: 'invalid-id', message });
        } else {
          process.stderr.write(`${message}\n`);
        }
        return exitAfterFlush(ExitCode.Usage);
      }
      workspaceId = parsed;
    } else {
      workspaceId = session.currentWorkspaceId;
    }

    if (workspaceId === undefined) {
      if (args.json) {
        emitJson({ ok: false, reason: 'no-workspace-selected' });
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
        emitJson({
          ok: true,
          workspaceId: detail.workspaceId,
          workspaceName: detail.workspaceName,
          extra: detail.extra ?? {},
        });
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
      return emitFailureFromError(args.json, err);
    }
  },
});

// Shared helper for any workspace subcommand that takes an optional
// --workspace flag and falls back to the selected workspace. Returns
// either a numeric workspace id or emits the appropriate JSON/stderr
// failure and returns null — callers should exit(Usage) on null.
async function resolveWorkspaceArg(
  args: { workspace?: unknown; json: boolean },
  selected: number | undefined,
): Promise<number | null> {
  if (args.workspace) {
    const raw = String(args.workspace);
    const parsed = parsePositiveInt(raw);
    if (parsed === null) {
      const message = `--workspace must be a positive integer (got ${raw})`;
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-id', message });
      } else {
        process.stderr.write(`${message}\n`);
      }
      return null;
    }
    return parsed;
  }
  if (selected === undefined) {
    if (args.json) {
      emitJson({ ok: false, reason: 'no-workspace-selected' });
    } else {
      process.stderr.write(
        'No workspace selected. Pass `--workspace <id>` or run `aitcc workspace use <id>`.\n',
      );
    }
    return null;
  }
  return selected;
}

const partnerCommand = defineCommand({
  meta: {
    name: 'partner',
    description: 'Show the partner (billing/payout) registration state for the selected workspace.',
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
    const workspaceId = await resolveWorkspaceArg(args, session.currentWorkspaceId);
    if (workspaceId === null) return exitAfterFlush(ExitCode.Usage);

    try {
      const state = await fetchWorkspacePartner(workspaceId, session.cookies);
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          registered: state.registered,
          approvalType: state.approvalType,
          rejectMessage: state.rejectMessage,
          partner: state.partner,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Workspace ${workspaceId} partner:\n`);
      process.stdout.write(`  registered: ${state.registered}\n`);
      process.stdout.write(`  approvalType: ${state.approvalType ?? 'null'}\n`);
      if (state.rejectMessage) {
        process.stdout.write(`  rejectMessage: ${state.rejectMessage}\n`);
      }
      if (state.partner) {
        process.stdout.write('  partner:\n');
        for (const [k, v] of Object.entries(state.partner)) {
          process.stdout.write(`    ${k}: ${formatScalar(v)}\n`);
        }
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export const workspaceCommand = defineCommand({
  meta: {
    name: 'workspace',
    description: 'Inspect and switch between the workspaces this account can access.',
  },
  subCommands: {
    ls: lsCommand,
    use: useCommand,
    show: showCommand,
    partner: partnerCommand,
  },
});
