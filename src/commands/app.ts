import { defineCommand } from 'citty';
import {
  fetchBundles,
  fetchCerts,
  fetchConversionMetrics,
  fetchDeployedBundle,
  fetchMiniAppRatings,
  fetchMiniApps,
  fetchMiniAppWithDraft,
  fetchReviewStatus,
  fetchUserReports,
  type MetricsTimeUnit,
  type RatingSortDirection,
  type RatingSortField,
} from '../api/mini-apps.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { emitFailureFromError, emitJson, resolveWorkspaceContext } from './_shared.js';
import { runRegister } from './register.js';

// --json contract (consumed by agent-plugin):
//
//   app ls [--workspace <id>]:
//     { ok: true, workspaceId, hasPolicyViolation, apps: [{id, name, reviewState?, extra}] } exit 0
//     { ok: false, reason: 'no-workspace-selected' }                                         exit 2
//     { ok: false, reason: 'invalid-id', message }                                           exit 2
//
//   Auth/network/api failures follow the shared contract from workspace/whoami
//   (ok: true authenticated: false exit 10, network-error exit 11, api-error exit 17).

// Best-effort match of review-status entries against mini-app summaries.
// The list endpoint and the review-status endpoint key off the same id,
// but we don't assume the field name is uniform — we compare by `.id` on
// each record, falling back to `miniAppId` / `appId` (same order as the
// list normaliser). Exported so the join semantics are unit-testable.
// Returns `null` if no plausible match; callers render that as "no review
// status" in the output rather than a failure.
export function findReviewEntry(
  reviewEntries: readonly Readonly<Record<string, unknown>>[],
  appId: string | number,
): Readonly<Record<string, unknown>> | null {
  const target = String(appId);
  for (const entry of reviewEntries) {
    const candidate = entry.id ?? entry.miniAppId ?? entry.appId;
    if (candidate !== undefined && String(candidate) === target) return entry;
  }
  return null;
}

export function reviewStateFor(
  entry: Readonly<Record<string, unknown>> | null,
): string | undefined {
  if (!entry) return undefined;
  const raw = entry.reviewState ?? entry.status;
  return typeof raw === 'string' ? raw : undefined;
}

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List mini-apps in the selected workspace.',
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
      // List + review-status are independent read endpoints. Fire in parallel
      // so a slow endpoint doesn't serialise the wait. Review-status failures
      // currently propagate (rather than being downgraded to "unknown
      // review") because they almost always indicate a shared auth/network
      // problem — if that ever stops being true we can degrade gracefully.
      const [apps, review] = await Promise.all([
        fetchMiniApps(workspaceId, session.cookies),
        fetchReviewStatus(workspaceId, session.cookies),
      ]);

      if (args.json) {
        const joined = apps.map((app) => {
          const entry = findReviewEntry(review.miniApps, app.id);
          const reviewState = reviewStateFor(entry);
          return {
            id: app.id,
            name: app.name ?? null,
            ...(reviewState !== undefined ? { reviewState } : {}),
            extra: app.extra,
          };
        });
        emitJson({
          ok: true,
          workspaceId,
          hasPolicyViolation: review.hasPolicyViolation,
          apps: joined,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      if (apps.length === 0) {
        process.stdout.write(`No apps in workspace ${workspaceId}.\n`);
        if (review.hasPolicyViolation) {
          process.stderr.write('Note: workspace-wide policy violation flag is set.\n');
        }
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const app of apps) {
        const entry = findReviewEntry(review.miniApps, app.id);
        const reviewState = reviewStateFor(entry) ?? '-';
        // Defensive: the upstream mini-app payload shape is not yet fully
        // observed (no registered apps in our workspaces). Tighten this
        // once sdk-example is registered and `name` is confirmed required.
        const name = app.name ?? '(unnamed)';
        process.stdout.write(`${app.id}\t${name}\t${reviewState}\n`);
      }
      if (review.hasPolicyViolation) {
        process.stderr.write('Note: workspace-wide policy violation flag is set.\n');
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app show <id> [--workspace <id>] [--view draft|current|merged]:
//     { ok: true, workspaceId, appId, view, miniApp: {...} }   exit 0
//     { ok: false, reason: 'no-workspace-selected' }            exit 2
//     { ok: false, reason: 'invalid-id', message }              exit 2
//     { ok: false, reason: 'app-not-found', appId }             exit 2
//
// `view` picks which part of the with-draft envelope to surface:
// - `draft` (default) — the editor's latest state, populated as soon as
//   the app is created. This is what `app register` just wrote; it's the
//   only reliable view until the app is approved and published.
// - `current` — the published/reviewed record end users see. Empty until
//   the app's first approval, so defaulting here would hide almost every
//   field we care about — hence the default is `draft`.
// - `merged` — current with draft overlaid on top (draft wins per field).
//   Useful once both exist and the user wants the "authoritative" snapshot.
//
// The `--view` flag intentionally never falls back on its own. If the
// caller asks for `current` on an unreviewed app they get `miniApp: null`
// with `view: 'current'` so agent-plugin can tell the two cases apart.
export function pickMiniAppView(
  envelope: { current: Record<string, unknown> | null; draft: Record<string, unknown> | null },
  view: 'draft' | 'current' | 'merged',
): Record<string, unknown> | null {
  const extract = (side: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (side === null) return null;
    const ma = side.miniApp;
    if (ma !== null && typeof ma === 'object' && !Array.isArray(ma)) {
      return ma as Record<string, unknown>;
    }
    return null;
  };
  const draft = extract(envelope.draft);
  const current = extract(envelope.current);
  if (view === 'draft') return draft;
  if (view === 'current') return current;
  if (current !== null && draft !== null) return { ...current, ...draft };
  return draft ?? current;
}

function parseAppId(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

const showCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      'Show full details of a mini-app, including fields only visible in the draft view.',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Mini-app ID (the numeric `appId` from `app ls` or `app register`).',
      required: true,
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    view: {
      type: 'string',
      description: 'Which view to render: `draft` (default), `current`, or `merged`.',
      default: 'draft',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app show: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const view = args.view;
    if (view !== 'draft' && view !== 'current' && view !== 'merged') {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'view',
          message: `--view must be one of draft|current|merged (got ${JSON.stringify(view)})`,
        });
      } else {
        process.stderr.write(`app show: invalid --view ${JSON.stringify(view)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const envelope = await fetchMiniAppWithDraft(workspaceId, appId, session.cookies);
      const miniApp = pickMiniAppView(envelope, view);

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          view,
          miniApp,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      if (miniApp === null) {
        if (view === 'current' && envelope.draft !== null) {
          process.stdout.write(
            `App ${appId} has no \`current\` view yet (not reviewed). Try --view draft.\n`,
          );
        } else {
          process.stdout.write(`App ${appId} has no data for view=${view}.\n`);
        }
        return exitAfterFlush(ExitCode.Ok);
      }

      const pick = (k: string): string => {
        const v = miniApp[k];
        return v === null || v === undefined ? '-' : String(v);
      };
      const images = Array.isArray(miniApp.images) ? miniApp.images : [];
      const impression =
        miniApp.impression !== null && typeof miniApp.impression === 'object'
          ? (miniApp.impression as Record<string, unknown>)
          : {};
      const keywords = Array.isArray(impression.keywordList) ? impression.keywordList : [];
      const categoryPaths = Array.isArray(impression.categoryPaths) ? impression.categoryPaths : [];

      process.stdout.write(`# App ${appId} (view=${view})\n\n`);
      process.stdout.write(`Name (ko)      ${pick('title')}\n`);
      process.stdout.write(`Name (en)      ${pick('titleEn')}\n`);
      process.stdout.write(`App slug       ${pick('appName')}\n`);
      process.stdout.write(`Status         ${pick('status')}\n`);
      process.stdout.write(`Home page      ${pick('homePageUri')}\n`);
      process.stdout.write(`CS email       ${pick('csEmail')}\n`);
      process.stdout.write(`Logo           ${pick('iconUri')}\n`);
      process.stdout.write(`Subtitle       ${pick('description')}\n`);
      const detail =
        typeof miniApp.detailDescription === 'string'
          ? `${[...miniApp.detailDescription].length} chars`
          : '-';
      process.stdout.write(`Detail desc    ${detail}\n`);
      process.stdout.write(`Images         ${images.length}\n`);
      process.stdout.write(`Keywords       ${keywords.length} (${keywords.join(', ')})\n`);
      const firstPath = categoryPaths[0];
      if (firstPath && typeof firstPath === 'object') {
        const fp = firstPath as Record<string, unknown>;
        const parts: string[] = [];
        for (const key of ['group', 'category', 'subCategory']) {
          const node = fp[key];
          if (node !== null && typeof node === 'object') {
            const nm = (node as Record<string, unknown>).name;
            if (typeof nm === 'string') parts.push(nm);
          }
        }
        process.stdout.write(`Category       ${parts.join(' > ') || '-'}\n`);
      } else {
        process.stdout.write(`Category       -\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// Derived review state. The console UI's "검토 중" banner is not a single
// API field — it's composed from the /with-draft envelope. We surface the
// derivation so `aitcc app status` is the one place the rule lives.
//
// Observed combinations (2026-04-23 on workspace 3095, apps 29349/29356/
// 29397/29405 all under review):
//
//   approvalType=REVIEW current=null  rejectedMessage=null   → under-review
//   approvalType=REVIEW current=null  rejectedMessage=STR    → rejected
//   approvalType=REVIEW current=ROW   (draft is edits-in-flight) → approved (with pending edits)
//   approvalType=REVIEW current=ROW   draft=null or equal    → approved
//   approvalType=null                                         → not-submitted (edit draft only)
//
// Unknown combinations fall through to `unknown` so callers can log and
// we can extend the ladder as new signals come in.
export type ReviewState =
  | 'not-submitted'
  | 'under-review'
  | 'rejected'
  | 'approved'
  | 'approved-with-edits'
  | 'unknown';

export interface DerivedStatus {
  readonly state: ReviewState;
  readonly approvalType: string | null;
  readonly rejectedMessage: string | null;
  readonly hasCurrent: boolean;
  readonly hasDraft: boolean;
}

export function deriveReviewState(env: {
  current: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  approvalType: string | null;
  rejectedMessage: string | null;
}): DerivedStatus {
  const hasCurrent = env.current !== null;
  const hasDraft = env.draft !== null;
  const approvalType = env.approvalType;
  const rejectedMessage = env.rejectedMessage;

  let state: ReviewState;
  if (approvalType === null) {
    state = 'not-submitted';
  } else if (rejectedMessage !== null) {
    state = 'rejected';
  } else if (!hasCurrent) {
    state = 'under-review';
  } else if (hasDraft) {
    state = 'approved-with-edits';
  } else {
    state = 'approved';
  }
  // approvalType values other than REVIEW (we haven't observed any yet)
  // or unexpected combinations get flagged as unknown rather than misreported.
  if (approvalType !== null && approvalType !== 'REVIEW' && state === 'under-review') {
    state = 'unknown';
  }
  return { state, approvalType, rejectedMessage, hasCurrent, hasDraft };
}

const POLL_MIN_INTERVAL_SEC = 30;
const POLL_MAX_INTERVAL_SEC = 3600;

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show the derived review state of a mini-app (under-review / rejected / approved).',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Mini-app ID.',
      required: true,
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    watch: {
      type: 'boolean',
      description:
        'Poll until the review state flips off `under-review` (rejected or approved). ' +
        'Combine with `--interval <seconds>`.',
      default: false,
    },
    interval: {
      type: 'string',
      description: 'Polling interval in seconds when --watch is set. Clamped to [30, 3600].',
      default: '60',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app status: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const intervalRaw = Number(args.interval);
    if (!Number.isFinite(intervalRaw) || intervalRaw <= 0) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'interval',
          message: `--interval must be a positive number (got ${JSON.stringify(args.interval)})`,
        });
      } else {
        process.stderr.write(`app status: invalid --interval ${JSON.stringify(args.interval)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const intervalSec = Math.max(
      POLL_MIN_INTERVAL_SEC,
      Math.min(POLL_MAX_INTERVAL_SEC, Math.floor(intervalRaw)),
    );

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    const emit = (status: DerivedStatus) => {
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, ...status });
      } else {
        process.stdout.write(
          `App ${appId} (ws ${workspaceId}): ${status.state}` +
            (status.rejectedMessage ? `\n  reason: ${status.rejectedMessage}` : '') +
            '\n',
        );
      }
    };

    try {
      const once = async (): Promise<DerivedStatus> => {
        const env = await fetchMiniAppWithDraft(workspaceId, appId, session.cookies);
        return deriveReviewState(env);
      };

      if (!args.watch) {
        emit(await once());
        return exitAfterFlush(ExitCode.Ok);
      }

      // --watch: poll with clear line-per-tick JSON emission. Each JSON line
      // is a self-contained object, NDJSON-style, so agents/shells can pipe
      // it into `jq -c` without waiting for a terminal. Stop when the state
      // is no longer `under-review` (reviewed) or when the process is
      // interrupted — we don't synthesise a "watch-ended" record.
      // Human mode prints a one-line update only when the state changes.
      let lastState: ReviewState | null = null;
      while (true) {
        const status = await once();
        if (args.json) {
          emit(status);
        } else if (status.state !== lastState) {
          emit(status);
        }
        lastState = status.state;
        if (status.state !== 'under-review') {
          return exitAfterFlush(ExitCode.Ok);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
      }
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app ratings <id> [--workspace <id>] [--page N] [--size N]
//                    [--sort-field CREATED_AT|SCORE] [--sort-direction ASC|DESC]:
//     { ok: true, workspaceId, appId, page, size, paging, averageRating,
//       totalReviewCount, ratings: [...] }                                 exit 0
//     { ok: false, reason: 'no-workspace-selected' }                       exit 2
//     { ok: false, reason: 'invalid-id', message }                         exit 2
//     { ok: false, reason: 'invalid-config', field, message }              exit 2
//
// The `sortField` values reflect what the console UI emits; the server
// accepts them exactly. We don't enumerate more values because no other
// orderings are observed — if the server supports them, add them once
// they appear in a real capture.

const VALID_SORT_FIELDS: readonly RatingSortField[] = ['CREATED_AT', 'SCORE'];
const VALID_SORT_DIRECTIONS: readonly RatingSortDirection[] = ['ASC', 'DESC'];

function parseNonNegativeInt(raw: string, field: string): { value: number } | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { error: `--${field} must be a non-negative integer (got ${JSON.stringify(raw)})` };
  }
  return { value: n };
}

const ratingsCommand = defineCommand({
  meta: {
    name: 'ratings',
    description: 'List user ratings and reviews left for a mini-app.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    size: { type: 'string', description: 'Page size.', default: '20' },
    'sort-field': {
      type: 'string',
      description: 'Sort field: CREATED_AT (default) or SCORE.',
      default: 'CREATED_AT',
    },
    'sort-direction': {
      type: 'string',
      description: 'Sort direction: ASC or DESC (default).',
      default: 'DESC',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app ratings: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const pageResult = parseNonNegativeInt(args.page, 'page');
    if ('error' in pageResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'page', message: pageResult.error });
      } else {
        process.stderr.write(`app ratings: ${pageResult.error}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const sizeResult = parseNonNegativeInt(args.size, 'size');
    if ('error' in sizeResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'size', message: sizeResult.error });
      } else {
        process.stderr.write(`app ratings: ${sizeResult.error}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    if (sizeResult.value === 0) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'size',
          message: '--size must be at least 1',
        });
      } else {
        process.stderr.write('app ratings: --size must be at least 1\n');
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const sortField = args['sort-field'];
    if (!VALID_SORT_FIELDS.includes(sortField as RatingSortField)) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'sort-field',
          message: `--sort-field must be one of ${VALID_SORT_FIELDS.join('|')} (got ${JSON.stringify(sortField)})`,
        });
      } else {
        process.stderr.write(`app ratings: invalid --sort-field ${JSON.stringify(sortField)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const sortDirection = args['sort-direction'];
    if (!VALID_SORT_DIRECTIONS.includes(sortDirection as RatingSortDirection)) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'sort-direction',
          message: `--sort-direction must be one of ${VALID_SORT_DIRECTIONS.join('|')} (got ${JSON.stringify(sortDirection)})`,
        });
      } else {
        process.stderr.write(
          `app ratings: invalid --sort-direction ${JSON.stringify(sortDirection)}\n`,
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchMiniAppRatings(
        {
          workspaceId,
          miniAppId: appId,
          page: pageResult.value,
          size: sizeResult.value,
          sortField: sortField as RatingSortField,
          sortDirection: sortDirection as RatingSortDirection,
        },
        session.cookies,
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          page: pageResult.value,
          size: sizeResult.value,
          sortField,
          sortDirection,
          averageRating: result.averageRating,
          totalReviewCount: result.totalReviewCount,
          paging: result.paging,
          ratings: result.ratings,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): ${result.totalReviewCount} review(s), avg ${result.averageRating.toFixed(2)}\n`,
      );
      if (result.ratings.length === 0) {
        process.stdout.write('No ratings on this page.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const r of result.ratings) {
        const score = typeof r.score === 'number' ? r.score : (r.rating ?? '-');
        const author =
          typeof r.nickname === 'string'
            ? r.nickname
            : typeof r.userName === 'string'
              ? r.userName
              : '(anon)';
        const text =
          typeof r.content === 'string'
            ? r.content
            : typeof r.reviewContent === 'string'
              ? r.reviewContent
              : '';
        const createdAt =
          typeof r.createdAt === 'string'
            ? r.createdAt
            : typeof r.reviewedAt === 'string'
              ? r.reviewedAt
              : '';
        process.stdout.write(`${score}\t${createdAt}\t${author}\t${text}\n`);
      }
      if (result.paging.hasNext) {
        process.stdout.write(
          `(more: --page ${pageResult.value + 1} for next ${sizeResult.value})\n`,
        );
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app reports <id> [--workspace <id>] [--page-size N] [--cursor <str>]:
//     { ok: true, workspaceId, appId, pageSize, cursor, nextCursor,
//       hasMore, reports: [...] }                              exit 0
//     { ok: false, reason: 'invalid-id' | 'invalid-config', ... } exit 2
//
// The endpoint is `/workspaces/:wid/mini-apps/:aid/user-reports` —
// note the **plural** `mini-apps` (same split-personality as review-status).
// Pagination is cursor-based: the server hands back `nextCursor` + `hasMore`,
// we pass `--cursor` as an opaque string next call.

const reportsCommand = defineCommand({
  meta: {
    name: 'reports',
    description: 'List user-submitted reports (신고 내역) for a mini-app.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    'page-size': { type: 'string', description: 'Page size (default 20).', default: '20' },
    cursor: {
      type: 'string',
      description: 'Opaque cursor from a previous response `nextCursor`.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app reports: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const pageSizeResult = parseNonNegativeInt(args['page-size'], 'page-size');
    if ('error' in pageSizeResult) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'page-size',
          message: pageSizeResult.error,
        });
      } else {
        process.stderr.write(`app reports: ${pageSizeResult.error}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    if (pageSizeResult.value === 0) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'page-size',
          message: '--page-size must be at least 1',
        });
      } else {
        process.stderr.write('app reports: --page-size must be at least 1\n');
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchUserReports(
        {
          workspaceId,
          miniAppId: appId,
          pageSize: pageSizeResult.value,
          ...(typeof args.cursor === 'string' && args.cursor.length > 0
            ? { cursor: args.cursor }
            : {}),
        },
        session.cookies,
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          pageSize: pageSizeResult.value,
          cursor: args.cursor ?? null,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          reports: result.reports,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): ${result.reports.length} report(s) on this page\n`,
      );
      if (result.reports.length === 0) {
        process.stdout.write('No reports.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const r of result.reports) {
        const id = typeof r.id === 'string' || typeof r.id === 'number' ? r.id : '-';
        const reason = typeof r.reason === 'string' ? r.reason : (r.reportType ?? '-');
        const text =
          typeof r.content === 'string' ? r.content : typeof r.detail === 'string' ? r.detail : '';
        const createdAt =
          typeof r.createdAt === 'string'
            ? r.createdAt
            : typeof r.reportedAt === 'string'
              ? r.reportedAt
              : '';
        process.stdout.write(`${id}\t${createdAt}\t${reason}\t${text}\n`);
      }
      if (result.hasMore && result.nextCursor) {
        process.stdout.write(`(more: --cursor ${result.nextCursor})\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app bundles ls <id> [--workspace <id>] [--page N]
//                       [--tested true|false] [--deploy-status STR]:
//     { ok: true, workspaceId, appId, page, totalPage, currentPage,
//       bundles: [...] }                                       exit 0
//     { ok: false, reason: 'invalid-id' | 'invalid-config' ... } exit 2
//
//   app bundles deployed <id> [--workspace <id>]:
//     { ok: true, workspaceId, appId, bundle: {...} | null }   exit 0
//     { ok: false, reason: 'invalid-id' ... }                  exit 2
//
// Bundles are the artefact that `aitcc deploy` will eventually upload
// (task #24). Listing them now lets agent-plugin and humans see the
// deploy surface even before we can write new ones.

const bundlesLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List upload bundles for a mini-app (page-based pagination).',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    tested: {
      type: 'string',
      description: 'Filter: `true` to show only tested bundles (or `false`).',
    },
    'deploy-status': {
      type: 'string',
      description: 'Filter by deploy status (e.g. DEPLOYED).',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app bundles ls: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const pageResult = parseNonNegativeInt(args.page, 'page');
    if ('error' in pageResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'page', message: pageResult.error });
      } else {
        process.stderr.write(`app bundles ls: ${pageResult.error}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    let tested: boolean | undefined;
    if (args.tested !== undefined) {
      if (args.tested === 'true') tested = true;
      else if (args.tested === 'false') tested = false;
      else {
        if (args.json) {
          emitJson({
            ok: false,
            reason: 'invalid-config',
            field: 'tested',
            message: `--tested must be "true" or "false" (got ${JSON.stringify(args.tested)})`,
          });
        } else {
          process.stderr.write(`app bundles ls: invalid --tested ${JSON.stringify(args.tested)}\n`);
        }
        return exitAfterFlush(ExitCode.Usage);
      }
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchBundles(
        {
          workspaceId,
          miniAppId: appId,
          page: pageResult.value,
          ...(tested !== undefined ? { tested } : {}),
          ...(typeof args['deploy-status'] === 'string' && args['deploy-status'].length > 0
            ? { deployStatus: args['deploy-status'] }
            : {}),
        },
        session.cookies,
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          page: pageResult.value,
          totalPage: result.totalPage,
          currentPage: result.currentPage,
          bundles: result.contents,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): page ${result.currentPage + 1}/${Math.max(result.totalPage, 1)}, ${result.contents.length} bundle(s)\n`,
      );
      if (result.contents.length === 0) {
        process.stdout.write('No bundles on this page.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const b of result.contents) {
        const id = typeof b.id === 'string' || typeof b.id === 'number' ? b.id : '-';
        const version = typeof b.version === 'string' ? b.version : '-';
        const status = typeof b.deployStatus === 'string' ? b.deployStatus : '-';
        const createdAt = typeof b.createdAt === 'string' ? b.createdAt : '';
        process.stdout.write(`${id}\t${version}\t${status}\t${createdAt}\n`);
      }
      if (result.currentPage + 1 < result.totalPage) {
        process.stdout.write(`(more: --page ${result.currentPage + 1})\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const bundlesDeployedCommand = defineCommand({
  meta: {
    name: 'deployed',
    description: 'Show the currently deployed bundle for a mini-app (or null if none).',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app bundles deployed: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const bundle = await fetchDeployedBundle(workspaceId, appId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, bundle });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (bundle === null) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no deployed bundle\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      const id = typeof bundle.id === 'string' || typeof bundle.id === 'number' ? bundle.id : '-';
      const version = typeof bundle.version === 'string' ? bundle.version : '-';
      const status = typeof bundle.deployStatus === 'string' ? bundle.deployStatus : '-';
      const deployedAt = typeof bundle.deployedAt === 'string' ? bundle.deployedAt : '';
      process.stdout.write(`App ${appId} deployed bundle:\n`);
      process.stdout.write(`  id          ${id}\n`);
      process.stdout.write(`  version     ${version}\n`);
      process.stdout.write(`  status      ${status}\n`);
      process.stdout.write(`  deployedAt  ${deployedAt}\n`);
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const bundlesCommand = defineCommand({
  meta: {
    name: 'bundles',
    description: 'Inspect upload bundles for a mini-app.',
  },
  subCommands: {
    ls: bundlesLsCommand,
    deployed: bundlesDeployedCommand,
  },
});

// --json contract (consumed by agent-plugin):
//
//   app certs ls <id> [--workspace <id>]:
//     { ok: true, workspaceId, appId, certs: [...] }   exit 0
//     { ok: false, reason: 'invalid-id' | ... }        exit 2
//
// mTLS certs for an app. Empty array is the common case (no certs
// generated yet). Per-record shape is passed through opaquely until
// we observe a populated response — agent-plugin consumers should
// treat each entry as `Record<string, unknown>`.

const certsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List mTLS certificates issued for a mini-app.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app certs ls: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const certs = await fetchCerts(workspaceId, appId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, certs });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (certs.length === 0) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no mTLS certs\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`App ${appId} (ws ${workspaceId}): ${certs.length} cert(s)\n`);
      for (const c of certs) {
        const id =
          typeof c.id === 'string' || typeof c.id === 'number'
            ? c.id
            : typeof c.certId === 'string' || typeof c.certId === 'number'
              ? c.certId
              : '-';
        const cn = typeof c.commonName === 'string' ? c.commonName : '-';
        const createdAt = typeof c.createdAt === 'string' ? c.createdAt : '';
        const expiresAt =
          typeof c.expiresAt === 'string'
            ? c.expiresAt
            : typeof c.validUntil === 'string'
              ? c.validUntil
              : '';
        process.stdout.write(`${id}\t${cn}\t${createdAt}\t${expiresAt}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const certsCommand = defineCommand({
  meta: {
    name: 'certs',
    description: 'Inspect mTLS certificates for a mini-app.',
  },
  subCommands: {
    ls: certsLsCommand,
  },
});

// --json contract (consumed by agent-plugin):
//
//   app metrics <id> [--workspace <id>] [--time-unit DAY|WEEK|MONTH]
//                    [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--refresh]:
//     { ok: true, workspaceId, appId, timeUnitType, startDate, endDate,
//       cacheTime?, metrics: [...] }                                exit 0
//     { ok: false, reason: 'invalid-id' | 'invalid-date'
//                        | 'invalid-time-unit' | ... }              exit 2
//
// Conversion metrics for an app over a date range. An empty `metrics`
// array is the common case for PREPARE-state apps (no live traffic);
// per-record shape is passed through opaquely. Default window: the last
// 30 days ending today (host local date). `--refresh` bypasses the
// server-side cache.

const VALID_TIME_UNITS: readonly MetricsTimeUnit[] = ['DAY', 'WEEK', 'MONTH'];

function parseIsoDate(raw: string, field: string): { value: string } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: `--${field} must be YYYY-MM-DD (got ${JSON.stringify(raw)})` };
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return { error: `--${field} is not a valid date (got ${JSON.stringify(raw)})` };
  }
  return { value: raw };
}

function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgoLocalIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const metricsCommand = defineCommand({
  meta: {
    name: 'metrics',
    description: 'Show conversion metrics for a mini-app over a date range.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    'time-unit': {
      type: 'string',
      description: 'Bucket size: DAY | WEEK | MONTH.',
      default: 'DAY',
    },
    start: {
      type: 'string',
      description: 'Start date (YYYY-MM-DD). Defaults to 30 days before --end.',
    },
    end: {
      type: 'string',
      description: 'End date (YYYY-MM-DD). Defaults to today (host local).',
    },
    refresh: {
      type: 'boolean',
      description: 'Bypass server-side cache.',
      default: false,
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const appId = parseAppId(args.id);
    if (appId === null) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `app id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`app metrics: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const timeUnit = String(args['time-unit']).toUpperCase();
    if (!VALID_TIME_UNITS.includes(timeUnit as MetricsTimeUnit)) {
      const message = `--time-unit must be one of ${VALID_TIME_UNITS.join('|')} (got ${JSON.stringify(args['time-unit'])})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-time-unit', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const endDate = args.end ? String(args.end) : todayLocalIso();
    const endResult = parseIsoDate(endDate, 'end');
    if ('error' in endResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-date', message: endResult.error });
      else process.stderr.write(`${endResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const startDate = args.start ? String(args.start) : daysAgoLocalIso(30);
    const startResult = parseIsoDate(startDate, 'start');
    if ('error' in startResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-date', message: startResult.error });
      else process.stderr.write(`${startResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    if (startResult.value > endResult.value) {
      const message = `--start (${startResult.value}) must be on or before --end (${endResult.value})`;
      if (args.json) emitJson({ ok: false, reason: 'invalid-date', message });
      else process.stderr.write(`${message}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchConversionMetrics(
        {
          workspaceId,
          miniAppId: appId,
          timeUnitType: timeUnit as MetricsTimeUnit,
          startDate: startResult.value,
          endDate: endResult.value,
          refresh: args.refresh,
        },
        session.cookies,
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          timeUnitType: timeUnit,
          startDate: startResult.value,
          endDate: endResult.value,
          ...(result.cacheTime !== undefined ? { cacheTime: result.cacheTime } : {}),
          metrics: result.metrics,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      const header = `App ${appId} (ws ${workspaceId}) · ${timeUnit} · ${startResult.value} → ${endResult.value}`;
      if (result.metrics.length === 0) {
        process.stdout.write(`${header}: no metrics\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`${header}: ${result.metrics.length} bucket(s)\n`);
      for (const m of result.metrics) {
        const date =
          typeof m.date === 'string'
            ? m.date
            : typeof m.bucketDate === 'string'
              ? m.bucketDate
              : '';
        const impressions =
          typeof m.impressions === 'number'
            ? m.impressions
            : typeof m.impressionCount === 'number'
              ? m.impressionCount
              : '';
        const clicks =
          typeof m.clicks === 'number'
            ? m.clicks
            : typeof m.clickCount === 'number'
              ? m.clickCount
              : '';
        process.stdout.write(`${date}\t${impressions}\t${clicks}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const registerCommand = defineCommand({
  meta: {
    name: 'register',
    description:
      'Register a mini-app in the selected workspace from a YAML/JSON manifest. ' +
      'Uploads logo/thumbnail/screenshots, then submits the create payload.',
  },
  args: {
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace (`aitcc workspace use`).',
    },
    config: {
      type: 'string',
      description:
        'Path to the app manifest. Defaults to `./aitcc.app.yaml`, then `./aitcc.app.json`.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate manifest + images and print the inferred submit payload; no uploads.',
      default: false,
    },
    'accept-terms': {
      type: 'boolean',
      description:
        'Attest to the required console legal-agreement checkboxes (see VALIDATION-RULES.md). Required for real submits.',
      default: false,
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    await runRegister({
      json: args.json,
      dryRun: args['dry-run'],
      acceptTerms: args['accept-terms'],
      ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
      ...(args.config !== undefined ? { config: args.config } : {}),
    });
  },
});

export const appCommand = defineCommand({
  meta: {
    name: 'app',
    description: 'Inspect mini-apps in a workspace.',
  },
  subCommands: {
    ls: lsCommand,
    show: showCommand,
    status: statusCommand,
    ratings: ratingsCommand,
    reports: reportsCommand,
    bundles: bundlesCommand,
    certs: certsCommand,
    metrics: metricsCommand,
    register: registerCommand,
  },
});
