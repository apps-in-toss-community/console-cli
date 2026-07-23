import { defineCommand } from 'citty';
import { fetchBusinessVerificationLicense } from '../api/business-verification.js';
import { NetworkError, TossApiError } from '../api/http.js';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import {
  fetchPromotionMoneyBalance,
  fetchPromotionMoneyHistories,
} from '../api/promotion-money.js';
import {
  agreeWorkspaceTerms,
  fetchWorkspaceDetail,
  fetchWorkspacePartner,
  fetchWorkspacePartnerIsRegistered,
  fetchWorkspaceSegments,
  fetchWorkspaceTerms,
  WORKSPACE_TERM_TYPES,
  type WorkspacePartnerIsRegisteredState,
  type WorkspacePartnerState,
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
  withReauthRetry,
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
//   workspace terms [--type TYPE] [--workspace <id>]:
//     { ok: true, workspaceId, type, terms: (WorkspaceTerm & {blocks: string[]})[] }       exit 0  (single type)
//     { ok: true, workspaceId, byType: { TYPE: (WorkspaceTerm & {blocks: string[]})[] } }  exit 0  (default — every bucket)
//     { ok: false, reason: 'invalid-type', allowed: TYPES[] }                              exit 2
//     { ok: false, reason: 'no-workspace-selected' }                                       exit 2
//     { ok: false, reason: 'invalid-id', message }                                         exit 2
//
//   `blocks` is a per-type list of feature surfaces that become unavailable
//   while the bucket is un-agreed. The same list appears on every term in
//   the bucket — it's a property of the bucket, not the individual term.
//
//   workspace terms agree <type> [--workspace <id>]:
//   workspace terms agree --all   [--workspace <id>]:
//     { ok: true, partial: false, workspaceId, agreed: AgreedTerm[],
//       unchanged: AgreedTerm[], failed: [] }                            exit 0  (full success or all-already-agreed)
//     { ok: false, partial: true, workspaceId, agreed: AgreedTerm[],
//       unchanged: AgreedTerm[],
//       failed: { termsId, revisionId, type, message }[] }                exit 1  (some buckets succeeded, others failed)
//                                                                         exit 17 (full transport-level failure handled by emitFailureFromError)
//     { ok: false, reason: 'argument-required', message }                exit 2  (no <type> and no --all)
//     { ok: false, reason: 'mutually-exclusive', message }                exit 2  (<type> and --all both given)
//     { ok: false, reason: 'unknown-term-type', given, allowed: TYPES[] } exit 2  (positional <type> not in enum)
//     { ok: false, reason: 'no-workspace-selected' }                     exit 2
//     { ok: false, reason: 'invalid-id', message }                       exit 2
//
//   `AgreedTerm = { termsId, revisionId, type, title }`. `agreed` lists what
//   this run flipped from pending → agreed; `unchanged` lists terms that
//   were already agreed at fetch time and got skipped (idempotent path).
//   `failed` lists transport/server failures per term batch — populated only
//   when `partial === true`. `ok` is a single-bool decision flag for
//   agent-plugin (`ok && !failed.length`-style branching is unnecessary):
//   `ok: true` means every requested bucket either succeeded or was already
//   agreed; `ok: false, partial: true` means at least one bucket failed and
//   the caller should inspect `failed`.
//
//   workspace segments ls [--category <cat>] [--search <text>] [--page N] [--workspace <id>]:
//     { ok: true, workspaceId, category, segments: [...], totalPage, currentPage }  exit 0
//     { ok: false, reason: 'invalid-page', message }                                exit 2
//     { ok: false, reason: 'no-workspace-selected' }                                exit 2
//     { ok: false, reason: 'invalid-id', message }                                  exit 2
//
//   workspace promotion-money show [--page N] [--workspace <id>]:
//     { ok: true, workspaceId, balance, availableBalance,
//       page, totalPage, currentPage, histories: [...] }                            exit 0
//     { ok: false, reason: 'invalid-page', message }                                exit 2
//     { ok: false, reason: 'no-workspace-selected' }                                exit 2
//     { ok: false, reason: 'invalid-id', message }                                  exit 2
//
//   Promotion money is spend the workspace commits to promoting its OWN
//   apps — a different axis from IAA ad revenue (`aitcc app ads`). Do not
//   confuse the two when reading `balance`.
//
//   workspace business-verification show [--workspace <id>]:
//     { ok: true, workspaceId,
//       businessLicense: { registered, errorCode },
//       partner: { registered, approvalType, rejectMessage } }                       exit 0
//     { ok: false, reason: 'no-workspace-selected' }                                exit 2
//     { ok: false, reason: 'invalid-id', message }                                  exit 2
//
//   `businessLicense.errorCode: 500` means "license not registered yet" — a
//   business-level diagnostic embedded in a SUCCESS envelope, not a
//   transport failure (see src/api/business-verification.ts).
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
      const info = await withReauthRetry(args.json, session, (s) =>
        fetchConsoleMemberUserInfo(s.cookies),
      );
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
      const info = await withReauthRetry(args.json, session, (s) =>
        fetchConsoleMemberUserInfo(s.cookies),
      );
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
      const detail = await withReauthRetry(args.json, session, (s) =>
        fetchWorkspaceDetail(workspaceId, s.cookies),
      );
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

export interface CombinedPartnerState {
  readonly registered: boolean;
  readonly approvalType: string | null;
  readonly rejectMessage: string | null;
  readonly partner: Readonly<Record<string, unknown>> | null;
}

// `GET .../partner` (detail, carries the `partner` blob once approved) and
// `GET .../partner/is-registered` (a lighter dedicated status check) both
// answer the same registered/approvalType/rejectMessage question — issue
// #220 asks `workspace partner` to call both and merge them into one status
// view instead of only reading the detail endpoint. The only live
// observation we have (workspace 3095, unregistered) shows them agreeing
// exactly: {registered:false, approvalType:'DRAFT', rejectMessage:null}.
// We don't have a live example of them disagreeing, so the merge picks a
// conservative default: `registered` is true if EITHER endpoint reports it
// (fail toward "already registered" rather than masking a registration one
// endpoint hasn't caught up on yet), and approvalType/rejectMessage prefer
// the detail endpoint's value, falling back to the is-registered endpoint's
// when the detail endpoint's is null.
export function mergePartnerStates(
  partner: WorkspacePartnerState,
  isRegistered: WorkspacePartnerIsRegisteredState,
): CombinedPartnerState {
  return {
    registered: partner.registered || isRegistered.registered,
    approvalType: partner.approvalType ?? isRegistered.approvalType,
    rejectMessage: partner.rejectMessage ?? isRegistered.rejectMessage,
    partner: partner.partner,
  };
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
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    try {
      const [partnerState, isRegisteredState] = await withReauthRetry(args.json, session, (s) =>
        Promise.all([
          fetchWorkspacePartner(workspaceId, s.cookies),
          fetchWorkspacePartnerIsRegistered(workspaceId, s.cookies),
        ]),
      );
      const state = mergePartnerStates(partnerState, isRegisteredState);
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

// What each term-bucket gates if it is left un-agreed. The pairings come
// from docs/api/_error-codes.md "Auth / 약관 family" (4037/4039/4040/4099/5001
// rows) cross-referenced with docs/api/workspaces.md `<type>` descriptions
// — server is the source of truth for the term enum, this table only
// documents the consumer-side feature surface each enum value gates.
//
// Surfaced both in plain-text output (`blocks if missing: …`) and in the
// `--json` payload (`blocks: string[]`). Order within an entry mirrors the
// spec PR description so dog-food output stays diffable. Strings are
// human-readable feature names, not necessarily existing CLI command names
// (some gated features are still on the roadmap).
export const TERM_BLOCKS: Record<WorkspaceTermType, readonly string[]> = {
  TOSS_LOGIN: ['toss login scope for mini-apps', 'app register (login configured apps)'],
  BIZ_WORKSPACE: ['app register', 'app deploy', 'workspace-level admin'],
  TOSS_PROMOTION_MONEY: ['promotion money campaign management'],
  IAA: ['ad campaign management'],
  IAP: ['iap product register', 'iap config'],
};

export function blocksFor(type: WorkspaceTermType): readonly string[] {
  return TERM_BLOCKS[type] ?? [];
}

export function formatBlocksHint(type: WorkspaceTermType, agreed: boolean): string {
  // Skip the hint entirely when we have no mapping for this type — keeps
  // the output clean if the server adds a new bucket before we update
  // the table. The spec calls this the "simpler" path over emitting
  // `blocks if missing: -`.
  const blocks = blocksFor(type);
  if (blocks.length === 0) return '';
  // Only highlight when the term is pending — agreed terms still get the
  // line for context but in default styling. NO_COLOR + non-TTY both
  // disable the escape; isTTY gate keeps ANSI out of pipes.
  const useColor = !agreed && process.stdout.isTTY && !process.env.NO_COLOR;
  const yellow = useColor ? '\x1b[33m' : '';
  const reset = useColor ? '\x1b[0m' : '';
  return `    ${yellow}blocks if missing: ${blocks.join(', ')}${reset}\n`;
}

const termsShowCommand = defineCommand({
  meta: {
    name: 'show',
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
      const results = await withReauthRetry(args.json, session, (s) =>
        Promise.all(
          typesToQuery.map(
            async (t) => [t, await fetchWorkspaceTerms(workspaceId, t, s.cookies)] as const,
          ),
        ),
      );

      // Attach the static `blocks` feature-gate list to every term. Same
      // list per bucket since it's a property of the term-type, not the
      // individual term entry — duplicating it on each row keeps the
      // JSON contract uniform (consumers don't have to look up the
      // bucket key separately).
      const enrich = (
        type: WorkspaceTermType,
        terms: readonly WorkspaceTerm[],
      ): readonly (WorkspaceTerm & { readonly blocks: readonly string[] })[] => {
        const blocks = blocksFor(type);
        return terms.map((t) => ({ ...t, blocks }));
      };

      if (typesToQuery.length === 1) {
        const [type, terms] = results[0] as readonly [WorkspaceTermType, readonly WorkspaceTerm[]];
        if (args.json) {
          emitJson({ ok: true, workspaceId, type, terms: enrich(type, terms) });
          return exitAfterFlush(ExitCode.Ok);
        }
        process.stdout.write(`Workspace ${workspaceId} terms (${type}):\n`);
        if (terms.length === 0) {
          process.stdout.write('  (no terms required)\n');
        } else {
          for (const t of terms) {
            process.stdout.write(formatTermLines(t));
            process.stdout.write(formatBlocksHint(type, t.isAgreed));
          }
        }
        return exitAfterFlush(ExitCode.Ok);
      }

      // --all path
      const byType: Record<
        string,
        readonly (WorkspaceTerm & { readonly blocks: readonly string[] })[]
      > = {};
      for (const [t, terms] of results) byType[t] = enrich(t, terms);
      if (args.json) {
        emitJson({ ok: true, workspaceId, byType });
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const [type, terms] of results) {
        process.stdout.write(`\n[${type}]\n`);
        if (terms.length === 0) {
          process.stdout.write('  (no terms required)\n');
        } else {
          for (const t of terms) {
            process.stdout.write(formatTermLines(t));
            process.stdout.write(formatBlocksHint(type, t.isAgreed));
          }
        }
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// Per-term agreement record surfaced in the `agree` JSON payload. We carry
// `(termsId, revisionId)` so consumers can correlate with `terms show`
// output, plus `type` (bucket) + `title` so dog-food output and human
// messages don't have to look the title back up. The shape is the same
// for `agreed` and `unchanged` buckets — only the bucket says whether this
// run flipped the state.
export interface AgreedTerm {
  readonly termsId: number;
  readonly revisionId: number;
  readonly type: WorkspaceTermType;
  readonly title: string;
}

export interface FailedTerm {
  readonly termsId: number;
  readonly revisionId: number;
  readonly type: WorkspaceTermType;
  readonly message: string;
}

export function describeAgreeError(err: unknown): string {
  // `TossApiError.message` already embeds errorCode + reason + HTTP status
  // (`"Toss API error <code>: <reason> (HTTP <status>)"`), so we don't tack
  // on a redundant `(errorCode: ...)` suffix.
  if (err instanceof TossApiError) return err.message;
  if (err instanceof NetworkError) return `network error: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

// Pure validation of the (positional, --all) arg pair. Extracted so the
// command-level mutually-exclusive / argument-required / unknown-term-type
// branches can be unit-tested without invoking the full citty `run`.
// Case-insensitive on the positional so `iap` and `IAP` both work.
export type AgreeArgsValidation =
  | { readonly ok: true; readonly types: readonly WorkspaceTermType[] }
  | { readonly ok: false; readonly reason: 'argument-required'; readonly message: string }
  | { readonly ok: false; readonly reason: 'mutually-exclusive'; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: 'unknown-term-type';
      readonly given: string;
      readonly allowed: readonly WorkspaceTermType[];
      // `message` here is for stderr only — the `--json` emit path intentionally
      // omits it and surfaces `given` + `allowed` instead so the agent-plugin
      // can render its own message without parsing prose.
      readonly message: string;
    };

export function validateAgreeArgs(input: {
  positional: string;
  all: boolean;
}): AgreeArgsValidation {
  const hasPositional = input.positional.length > 0;
  if (!hasPositional && !input.all) {
    return {
      ok: false,
      reason: 'argument-required',
      message: 'Specify a term bucket (e.g. `aitcc workspace terms agree IAP`) or pass --all.',
    };
  }
  if (hasPositional && input.all) {
    return {
      ok: false,
      reason: 'mutually-exclusive',
      message: '<type> and --all are mutually exclusive — pass one or the other, not both.',
    };
  }
  if (input.all) {
    return { ok: true, types: WORKSPACE_TERM_TYPES };
  }
  const upper = input.positional.toUpperCase();
  if (!(WORKSPACE_TERM_TYPES as readonly string[]).includes(upper)) {
    return {
      ok: false,
      reason: 'unknown-term-type',
      given: input.positional,
      allowed: [...WORKSPACE_TERM_TYPES],
      message: `Unknown term bucket: ${input.positional}. Allowed: ${WORKSPACE_TERM_TYPES.join(', ')}.`,
    };
  }
  return { ok: true, types: [upper as WorkspaceTermType] };
}

// Pure orchestration: given the fetched buckets and an injectable agree
// function, partition terms into agreed/unchanged/failed. Server is NOT
// idempotent — already-agreed terms are dropped on the client side, and
// each bucket's agree call is independent (one bucket failing does not
// block the others).
export interface BucketSnapshot {
  readonly type: WorkspaceTermType;
  readonly terms: readonly WorkspaceTerm[];
}

export interface AgreeOutcome {
  readonly agreed: readonly AgreedTerm[];
  readonly unchanged: readonly AgreedTerm[];
  readonly failed: readonly FailedTerm[];
}

export async function processAgreeBuckets(
  buckets: readonly BucketSnapshot[],
  submit: (
    type: WorkspaceTermType,
    pending: readonly { termsId: number; revisionId: number }[],
  ) => Promise<void>,
): Promise<AgreeOutcome> {
  const agreed: AgreedTerm[] = [];
  const unchanged: AgreedTerm[] = [];
  const failed: FailedTerm[] = [];

  for (const { type, terms } of buckets) {
    for (const t of terms) {
      if (t.isAgreed) {
        unchanged.push({ termsId: t.termsId, revisionId: t.revisionId, type, title: t.title });
      }
    }
    const pending = terms.filter((t) => !t.isAgreed);
    if (pending.length === 0) continue;
    try {
      await submit(
        type,
        pending.map((t) => ({ termsId: t.termsId, revisionId: t.revisionId })),
      );
      for (const t of pending) {
        agreed.push({ termsId: t.termsId, revisionId: t.revisionId, type, title: t.title });
      }
    } catch (err) {
      const message = describeAgreeError(err);
      for (const t of pending) {
        failed.push({ termsId: t.termsId, revisionId: t.revisionId, type, message });
      }
    }
  }
  return { agreed, unchanged, failed };
}

const termsAgreeCommand = defineCommand({
  meta: {
    name: 'agree',
    description:
      'Agree to workspace-level terms. Pass a single bucket as positional argument, or --all to agree to every pending bucket. Already-agreed terms are skipped (idempotent).',
  },
  args: {
    type: {
      type: 'positional',
      description: `Term bucket to agree to (positional, NOT --type): ${WORKSPACE_TERM_TYPES.join(' | ')}. Asymmetric with \`terms show --type ...\` because agree is a one-shot intent — pass the bucket name directly or --all.`,
      required: false,
    },
    all: {
      type: 'boolean',
      description:
        'Agree to every pending bucket. Mutually exclusive with the positional argument.',
      default: false,
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID to inspect. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const validation = validateAgreeArgs({
      positional: args.type !== undefined ? String(args.type) : '',
      all: Boolean(args.all),
    });
    if (!validation.ok) {
      if (args.json) {
        if (validation.reason === 'unknown-term-type') {
          emitJson({
            ok: false,
            reason: 'unknown-term-type',
            given: validation.given,
            allowed: validation.allowed,
          });
        } else {
          emitJson({ ok: false, reason: validation.reason, message: validation.message });
        }
      } else {
        process.stderr.write(`${validation.message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    try {
      // Fetch every requested bucket in parallel — same pattern as `show`.
      // The agree endpoint is per-bucket but the GET isn't, and we need
      // the (termsId, revisionId) + isAgreed snapshot before deciding
      // what to submit (server is NOT idempotent — re-submitting an
      // already-agreed term returns 500).
      const buckets: readonly BucketSnapshot[] = await Promise.all(
        validation.types.map(async (type) => ({
          type,
          terms: await fetchWorkspaceTerms(workspaceId, type, session.cookies),
        })),
      );

      const { agreed, unchanged, failed } = await processAgreeBuckets(
        buckets,
        async (_type, pending) => {
          await agreeWorkspaceTerms(workspaceId, pending, session.cookies);
        },
      );

      const partial = failed.length > 0;
      if (args.json) {
        emitJson({
          ok: !partial,
          partial,
          workspaceId,
          agreed,
          unchanged,
          failed,
        });
      } else if (agreed.length === 0 && failed.length === 0) {
        process.stdout.write(
          unchanged.length === 0
            ? '(no terms to agree to)\n'
            : `Already agreed: ${unchanged.length} term(s) — nothing to do.\n`,
        );
      } else {
        if (agreed.length > 0) {
          // Group by type for a tighter rendering.
          const byType = new Map<WorkspaceTermType, AgreedTerm[]>();
          for (const a of agreed) {
            const arr = byType.get(a.type) ?? [];
            arr.push(a);
            byType.set(a.type, arr);
          }
          for (const [type, items] of byType) {
            const blocks = blocksFor(type);
            const blocksHint = blocks.length > 0 ? ` (unblocks: ${blocks.join(', ')})` : '';
            process.stdout.write(`✓ Agreed to ${items.length} term(s) in ${type}${blocksHint}\n`);
            for (const a of items) {
              process.stdout.write(`    - ${a.title}\n`);
            }
          }
        }
        if (unchanged.length > 0) {
          process.stdout.write(`(skipped ${unchanged.length} already-agreed term(s))\n`);
        }
        if (failed.length > 0) {
          process.stderr.write(`✗ ${failed.length} term(s) failed:\n`);
          for (const f of failed) {
            process.stderr.write(`    - [${f.type}] termsId=${f.termsId}: ${f.message}\n`);
          }
        }
      }
      return exitAfterFlush(partial ? ExitCode.Generic : ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const termsCommand = defineCommand({
  meta: {
    name: 'terms',
    description:
      'Show or agree to console terms-of-agreement that gate workspace-level features (Toss login, IAP, IAA, biz workspace, promotion money).',
  },
  // citty's `findSubCommandIndex` walks the parent's argsDef to decide
  // whether `--flag VALUE` consumes one or two raw args. If the parent
  // doesn't declare a string-typed flag, the VALUE half gets read as a
  // positional and citty treats it as the subcommand name → "Unknown
  // command 36577". Mirror the `show` subcommand's value-flags here so
  // `aitcc workspace terms --workspace 36577 --type IAP` still routes
  // bare → show via `default` (the previous, no-subtree behaviour). These
  // declarations are PURE ROUTING SCAFFOLDING — the parent never reads
  // them; `runCommand` re-parses raw args inside the resolved subcommand.
  // Importantly, `--type` here does NOT mean `terms agree --type IAP` is
  // valid: agree takes the bucket as a positional. The flag name overlap
  // is incidental — see `termsAgreeCommand.args.type` for the real shape.
  args: {
    type: {
      type: 'string',
      description: 'Forwarded to `show` (routing only — see `agree --help`).',
    },
    workspace: { type: 'string', description: 'Forwarded to the resolved subcommand.' },
    json: { type: 'boolean', description: 'Forwarded to the resolved subcommand.', default: false },
  },
  subCommands: {
    show: termsShowCommand,
    agree: termsAgreeCommand,
  },
  // Bare `aitcc workspace terms` (no subcommand) routes to `show` so the
  // existing read-only behaviour is preserved.
  default: 'show',
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
      const page = await withReauthRetry(args.json, session, (s) =>
        fetchWorkspaceSegments(
          {
            workspaceId,
            ...(args.category !== undefined ? { category: String(args.category) } : {}),
            ...(args.search !== undefined ? { search: String(args.search) } : {}),
            page: pageNum,
          },
          s.cookies,
        ),
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

// --- promotion-money ---
//
// "프로모션 머니" — the budget a workspace spends promoting its OWN apps
// inside Toss. This is a DIFFERENT axis from `aitcc app ads` (IAA, revenue
// earned by serving ads inside a mini-app) — the command description below
// says so explicitly so the two are never conflated at the CLI surface.

const promotionMoneyShowCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      '워크스페이스의 프로모션 머니(자사 앱 홍보 지출 예산) 잔액과 사용 내역을 조회한다. ' +
      'IAA 광고수익(`aitcc app ads`, 인앱 광고 노출로 벌어들이는 수익)과는 다른 축이니 혼동 주의.',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID to inspect. Defaults to the selected workspace.',
    },
    page: {
      type: 'string',
      description: 'History page number (0-indexed).',
      default: '0',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const pageRaw = String(args.page);
    const pageNum = Number(pageRaw);
    if (!Number.isFinite(pageNum) || !Number.isInteger(pageNum) || pageNum < 0) {
      const message = `--page must be a non-negative integer (got ${JSON.stringify(pageRaw)})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-page', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    printContextHeader(ctx, { json: args.json });

    try {
      const [balance, historyPage] = await withReauthRetry(args.json, session, (s) =>
        Promise.all([
          fetchPromotionMoneyBalance(workspaceId, s.cookies),
          fetchPromotionMoneyHistories({ workspaceId, page: pageNum }, s.cookies),
        ]),
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          balance: balance.balance,
          availableBalance: balance.availableBalance,
          page: pageNum,
          totalPage: historyPage.totalPage,
          currentPage: historyPage.currentPage,
          histories: historyPage.contents,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `Workspace ${workspaceId} promotion money (자사 앱 홍보 지출 축 — IAA 광고수익과는 다름):\n`,
      );
      process.stdout.write(`  balance: ${balance.balance}\n`);
      process.stdout.write(`  availableBalance: ${balance.availableBalance}\n`);
      if (historyPage.contents.length === 0) {
        process.stdout.write('  histories: (none)\n');
      } else {
        process.stdout.write(
          `  histories: ${historyPage.contents.length} entr${historyPage.contents.length === 1 ? 'y' : 'ies'} (page ${historyPage.currentPage + 1}/${Math.max(historyPage.totalPage, 1)})\n`,
        );
        for (const h of historyPage.contents) {
          process.stdout.write(`    ${JSON.stringify(h)}\n`);
        }
      }
      if (balance.availableBalance === 0) {
        process.stdout.write(
          '자사 앱 홍보 캠페인을 운영하려면 콘솔에서 프로모션 머니를 충전하세요.\n',
        );
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const promotionMoneyCommand = defineCommand({
  meta: {
    name: 'promotion-money',
    description:
      '워크스페이스의 프로모션 머니(자사 앱 홍보 지출 축 — IAA 광고수익과는 다름) 상태를 조회한다.',
  },
  subCommands: {
    show: promotionMoneyShowCommand,
  },
});

// --- business-verification ---

const businessVerificationShowCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      '워크스페이스의 사업자 라이선스 인증 상태를 조회하고, 파트너(빌링/정산 주체) 등록 상태와 묶어 하나의 리포트로 보여준다.',
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
      const [license, isRegistered] = await withReauthRetry(args.json, session, (s) =>
        Promise.all([
          fetchBusinessVerificationLicense(workspaceId, s.cookies),
          fetchWorkspacePartnerIsRegistered(workspaceId, s.cookies),
        ]),
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          businessLicense: { registered: license.registered, errorCode: license.errorCode },
          partner: {
            registered: isRegistered.registered,
            approvalType: isRegistered.approvalType,
            rejectMessage: isRegistered.rejectMessage,
          },
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(`Workspace ${workspaceId} business verification:\n`);
      if (license.registered) {
        process.stdout.write('  business license: 등록됨\n');
      } else {
        process.stdout.write(
          `  business license: 미등록 (errorCode ${license.errorCode ?? 'unknown'} — 사업자 라이선스 미등록)\n`,
        );
      }
      process.stdout.write(
        `  partner: registered=${isRegistered.registered}, approvalType=${isRegistered.approvalType ?? 'null'}\n`,
      );
      if (!license.registered) {
        process.stdout.write('콘솔에서 사업자 라이선스 인증 절차를 먼저 진행하세요.\n');
      }
      if (!isRegistered.registered) {
        process.stdout.write('`aitcc workspace partner`로 파트너 등록 상태를 자세히 확인하세요.\n');
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const businessVerificationCommand = defineCommand({
  meta: {
    name: 'business-verification',
    description: '워크스페이스의 사업자 라이선스 인증 + 파트너 등록 상태를 조회한다.',
  },
  subCommands: {
    show: businessVerificationShowCommand,
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
    'promotion-money': promotionMoneyCommand,
    'business-verification': businessVerificationCommand,
  },
});
