import { defineCommand } from 'citty';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import {
  fetchWorkspaceDetail,
  fetchWorkspacePartner,
  fetchWorkspaceSegments,
  fetchWorkspaceTerms,
  WORKSPACE_TERM_TYPES,
  type WorkspaceTerm,
  type WorkspaceTermType,
} from '../api/workspaces.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, setCurrentWorkspaceId } from '../session.js';
import {
  emitFailureFromError,
  emitJson,
  emitNotAuthenticated,
  parsePositiveInt,
  printContextHeader,
  resolveWorkspaceContext,
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
//   workspace terms [--type TYPE | --all] [--workspace <id>]:
//     { ok: true, workspaceId, type, terms: WorkspaceTerm[] }         exit 0  (single type)
//     { ok: true, workspaceId, byType: { TYPE: WorkspaceTerm[] } }    exit 0  (--all)
//     { ok: false, reason: 'invalid-type', allowed: TYPES[] }         exit 2
//     { ok: false, reason: 'no-workspace-selected' }                  exit 2
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//   workspace segments ls [--category <cat>] [--search <text>] [--page N] [--workspace <id>]:
//     { ok: true, workspaceId, category, segments: [...], totalPage, currentPage }  exit 0
//     { ok: false, reason: 'invalid-page', message }                                exit 2
//     { ok: false, reason: 'no-workspace-selected' }                                exit 2
//     { ok: false, reason: 'invalid-id', message }                                  exit 2
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
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

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
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

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

function formatTermLines(term: WorkspaceTerm): string {
  // One agreement per line in the plain-text rendering; the title + a
  // [agreed]/[pending] tag is the useful signal for a human operator.
  // Keep the contentsUrl on a second indented line so ops can Ctrl-click
  // to review it directly without switching to --json.
  const tag = term.isAgreed ? '[agreed]' : '[pending]';
  const req = term.required ? ' required' : '';
  return `  ${tag}${req}  ${term.title}\n    ${term.contentsUrl}\n`;
}

const termsCommand = defineCommand({
  meta: {
    name: 'terms',
    description:
      'Show the console terms-of-agreement state that gate workspace-level features (Toss login, IAP, IAA, biz workspace, promotion money).',
  },
  args: {
    type: {
      type: 'string',
      description: `Term bucket to inspect: ${WORKSPACE_TERM_TYPES.join(' | ')}. Omit to query every bucket.`,
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID to inspect. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    const typesToQuery: readonly WorkspaceTermType[] = (() => {
      if (!args.type) return WORKSPACE_TERM_TYPES;
      const raw = String(args.type).toUpperCase();
      if ((WORKSPACE_TERM_TYPES as readonly string[]).includes(raw)) {
        return [raw as WorkspaceTermType];
      }
      return [];
    })();
    if (typesToQuery.length === 0) {
      const message = `--type must be one of: ${WORKSPACE_TERM_TYPES.join(', ')}`;
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-type', allowed: [...WORKSPACE_TERM_TYPES] });
      } else {
        process.stderr.write(`${message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    printContextHeader(ctx, { json: args.json });

    try {
      // Single-type path keeps the JSON payload flat; --all (or the
      // default) groups results by type so consumers don't have to call
      // five times. Fire them in parallel — each is an independent GET
      // and the server has no cross-bucket rate-limit we've observed.
      const results = await Promise.all(
        typesToQuery.map(
          async (t) => [t, await fetchWorkspaceTerms(workspaceId, t, session.cookies)] as const,
        ),
      );

      if (typesToQuery.length === 1) {
        const [type, terms] = results[0] as readonly [WorkspaceTermType, readonly WorkspaceTerm[]];
        if (args.json) {
          emitJson({ ok: true, workspaceId, type, terms });
          return exitAfterFlush(ExitCode.Ok);
        }
        process.stdout.write(`Workspace ${workspaceId} terms (${type}):\n`);
        if (terms.length === 0) {
          process.stdout.write('  (no terms required)\n');
        } else {
          for (const t of terms) process.stdout.write(formatTermLines(t));
        }
        return exitAfterFlush(ExitCode.Ok);
      }

      // --all path
      const byType: Record<string, readonly WorkspaceTerm[]> = {};
      for (const [t, terms] of results) byType[t] = terms;
      if (args.json) {
        emitJson({ ok: true, workspaceId, byType });
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const [type, terms] of results) {
        process.stdout.write(`\n[${type}]\n`);
        if (terms.length === 0) {
          process.stdout.write('  (no terms required)\n');
        } else {
          for (const t of terms) process.stdout.write(formatTermLines(t));
        }
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const segmentsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List user segments in the selected workspace (the 세그먼트 menu).',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    category: {
      type: 'string',
      description: 'Category bucket (tab). Defaults to "생성된 세그먼트" — the UI\'s initial tab.',
    },
    search: { type: 'string', description: 'Name-contains filter. Empty matches everything.' },
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    const pageRaw = String(args.page);
    const pageNum = Number(pageRaw);
    if (!Number.isFinite(pageNum) || !Number.isInteger(pageNum) || pageNum < 0) {
      const message = `--page must be a non-negative integer (got ${JSON.stringify(pageRaw)})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-page', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }
    printContextHeader(ctx, { json: args.json });

    try {
      const page = await fetchWorkspaceSegments(
        {
          workspaceId,
          ...(args.category !== undefined ? { category: String(args.category) } : {}),
          ...(args.search !== undefined ? { search: String(args.search) } : {}),
          page: pageNum,
        },
        session.cookies,
      );
      const category = args.category !== undefined ? String(args.category) : '생성된 세그먼트';
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          category,
          segments: page.contents,
          totalPage: page.totalPage,
          currentPage: page.currentPage,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (page.contents.length === 0) {
        process.stdout.write(
          `Workspace ${workspaceId} (${category}): no segments on page ${page.currentPage}\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `Workspace ${workspaceId} (${category}): ${page.contents.length} segment(s), page ${page.currentPage} of ${page.totalPage}\n`,
      );
      for (const s of page.contents) {
        const id =
          typeof s.id === 'string' || typeof s.id === 'number'
            ? s.id
            : typeof s.segmentId === 'string' || typeof s.segmentId === 'number'
              ? s.segmentId
              : '-';
        const name =
          typeof s.name === 'string' ? s.name : typeof s.title === 'string' ? s.title : '-';
        const userCount =
          typeof s.userCount === 'number'
            ? String(s.userCount)
            : typeof s.count === 'number'
              ? String(s.count)
              : '-';
        process.stdout.write(`${id}\t${name}\t${userCount}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const segmentsCommand = defineCommand({
  meta: {
    name: 'segments',
    description: 'Inspect user segments defined in a workspace.',
  },
  subCommands: {
    ls: segmentsLsCommand,
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
    terms: termsCommand,
    segments: segmentsCommand,
  },
});
