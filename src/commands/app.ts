import { defineCommand } from 'citty';
import {
  fetchAppEventCatalogs,
  fetchAppServiceStatus,
  fetchAppTemplates,
  fetchBundles,
  fetchBundleTestLinks,
  fetchCerts,
  fetchConversionMetrics,
  fetchDeployedBundle,
  fetchImpressionCategoryList,
  fetchMiniAppRatings,
  fetchMiniApps,
  fetchMiniAppWithDraft,
  fetchReviewStatus,
  fetchShareRewards,
  fetchSmartMessageCampaigns,
  fetchUserReports,
  type MetricsTimeUnit,
  postBundleMemo,
  postBundleRelease,
  postBundleReview,
  postBundleReviewWithdrawal,
  postBundleTestPush,
  postDeploymentsComplete,
  postDeploymentsInitialize,
  putBundleToUploadUrl,
  type RatingSortDirection,
  type RatingSortField,
  TEMPLATE_CONTENT_REACH_TYPES,
  type TemplateContentReachType,
} from '../api/mini-apps.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession } from '../session.js';
import {
  emitFailureFromError,
  emitJson,
  emitNotAuthenticated,
  resolveWorkspaceContext,
} from './_shared.js';
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

      // Emit a one-line stderr hint when `--view current` comes back
      // empty but a draft exists — this is the most common confusion
      // (unreviewed apps have a populated draft and an empty current).
      // stderr so both JSON and plain callers see it without the JSON
      // shape changing.
      if (miniApp === null && view === 'current' && envelope.draft !== null) {
        process.stderr.write(
          `App ${appId} has no \`current\` view yet (not reviewed). Re-run with \`--view draft\` to see the pending record.\n`,
        );
      }

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
        // Plain-text path keeps the stdout summary (the stderr hint is
        // already out of the way). Avoid duplicating it here.
        if (view === 'current' && envelope.draft !== null) {
          process.stdout.write(`App ${appId} has no \`current\` view yet.\n`);
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

    // `serviceStatus` is a server-side string (PREPARE / RUNNING / …) that
    // is orthogonal to the client-derived review `state`. We surface both
    // so operators see the review stage and the runtime stage at once —
    // important because an app can be `approved` (review done) yet still
    // `PREPARE` (not live), and we never want the --json consumer to have
    // to make a second call to tell them apart.
    const emit = (
      status: DerivedStatus,
      service: {
        serviceStatus: string;
        shutdownCandidateStatus: string | null;
        scheduledShutdownAt: string | null;
      } | null,
    ) => {
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          ...status,
          // `null` only in the unlikely case the service-status endpoint
          // failed but with-draft succeeded — we fall through rather than
          // hard-failing, because the derived review state is still useful.
          serviceStatus: service?.serviceStatus ?? null,
          shutdownCandidateStatus: service?.shutdownCandidateStatus ?? null,
          scheduledShutdownAt: service?.scheduledShutdownAt ?? null,
        });
      } else {
        const svc = service ? ` [${service.serviceStatus}]` : '';
        process.stdout.write(
          `App ${appId} (ws ${workspaceId}): ${status.state}${svc}` +
            (status.rejectedMessage ? `\n  reason: ${status.rejectedMessage}` : '') +
            (service?.scheduledShutdownAt
              ? `\n  scheduled shutdown: ${service.scheduledShutdownAt}`
              : '') +
            '\n',
        );
      }
    };

    try {
      const once = async (): Promise<
        [
          DerivedStatus,
          {
            serviceStatus: string;
            shutdownCandidateStatus: string | null;
            scheduledShutdownAt: string | null;
          } | null,
        ]
      > => {
        // Fire both requests in parallel — they share the same session
        // cookie and the console backend has no cross-rate-limit we've
        // observed. `service-status` is best-effort: if it fails we still
        // want the review state through.
        const [env, service] = await Promise.all([
          fetchMiniAppWithDraft(workspaceId, appId, session.cookies),
          fetchAppServiceStatus(workspaceId, appId, session.cookies).catch(() => null),
        ]);
        return [deriveReviewState(env), service];
      };

      if (!args.watch) {
        const [status, service] = await once();
        emit(status, service);
        return exitAfterFlush(ExitCode.Ok);
      }

      // --watch: poll with clear line-per-tick JSON emission. Each JSON line
      // is a self-contained object, NDJSON-style, so agents/shells can pipe
      // it into `jq -c` without waiting for a terminal. Stop when the state
      // is no longer `under-review` (reviewed) or when the process is
      // interrupted — we don't synthesise a "watch-ended" record.
      // Human mode prints a one-line update only when the state changes.
      let lastState: ReviewState | null = null;
      let lastServiceStatus: string | null = null;
      while (true) {
        const [status, service] = await once();
        const svc = service?.serviceStatus ?? null;
        if (args.json) {
          emit(status, service);
        } else if (status.state !== lastState || svc !== lastServiceStatus) {
          emit(status, service);
        }
        lastState = status.state;
        lastServiceStatus = svc;
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

// --json contract (consumed by agent-plugin):
//
//   app bundles upload <id> <path> [--deployment-id <uuid>] [--memo <text>]
//                       [--workspace <id>] [--dry-run]:
//     { ok: true, workspaceId, appId, deploymentId, reviewStatus,
//       bundle: { ... }, memoApplied: boolean }                   exit 0
//     { ok: true, dryRun: true, workspaceId, appId, deploymentId,
//       bytes, memo }                                             exit 0
//     { ok: false, reason: 'invalid-id' | 'file-unreadable'
//                         | 'missing-deployment-id'
//                         | 'bundle-not-prepare', ... }           exit 2
//
// 3-step upload: initialize → PUT to S3 presigned URL → complete,
// optionally followed by POST /bundles/memos. deployment-id is the
// `_metadata.deploymentId` inside the .ait's app.json — for now we ask
// the caller to supply it explicitly (zip-cracking is a follow-up).
// On mismatched reviewStatus ("이미 존재하는 버전이에요.") we bail
// before touching S3 with exit 2 / reason `bundle-not-prepare`, matching
// the console's own client-side guard.

const bundlesUploadCommand = defineCommand({
  meta: {
    name: 'upload',
    description: 'Upload an .ait bundle (initialize → PUT → complete [+ memo]).',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    path: { type: 'positional', description: 'Path to the .ait bundle file.', required: true },
    'deployment-id': {
      type: 'string',
      description: 'deploymentId embedded in the bundle (from app.json._metadata.deploymentId).',
    },
    memo: { type: 'string', description: 'Optional memo attached to this bundle version.' },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate inputs and show what would be sent, without touching the server.',
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
        process.stderr.write(`app bundles upload: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const deploymentId = typeof args['deployment-id'] === 'string' ? args['deployment-id'] : '';
    if (deploymentId === '') {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'missing-deployment-id',
          message:
            '--deployment-id is required; read app.json._metadata.deploymentId from inside the .ait',
        });
      } else {
        process.stderr.write(
          'app bundles upload: --deployment-id <uuid> is required.\n' +
            '  The .ait bundle is a zip; read app.json inside and copy _metadata.deploymentId.\n',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const filePath = typeof args.path === 'string' ? args.path : '';
    let bytes: Uint8Array;
    try {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(filePath);
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.json) {
        emitJson({ ok: false, reason: 'file-unreadable', path: filePath, message });
      } else {
        process.stderr.write(`app bundles upload: cannot read ${filePath}: ${message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    const memo = typeof args.memo === 'string' && args.memo.length > 0 ? args.memo : undefined;

    if (args['dry-run']) {
      if (args.json) {
        emitJson({
          ok: true,
          dryRun: true,
          workspaceId,
          appId,
          deploymentId,
          bytes: bytes.byteLength,
          memo: memo ?? null,
        });
      } else {
        process.stdout.write(
          `DRY RUN\n` +
            `  workspace    ${workspaceId}\n` +
            `  appId        ${appId}\n` +
            `  deploymentId ${deploymentId}\n` +
            `  bytes        ${bytes.byteLength}\n` +
            `  memo         ${memo ?? '(none)'}\n`,
        );
      }
      return exitAfterFlush(ExitCode.Ok);
    }

    try {
      const init = await postDeploymentsInitialize(
        workspaceId,
        appId,
        deploymentId,
        session.cookies,
      );
      if (init.reviewStatus !== 'PREPARE') {
        if (args.json) {
          emitJson({
            ok: false,
            reason: 'bundle-not-prepare',
            workspaceId,
            appId,
            deploymentId,
            reviewStatus: init.reviewStatus,
            message: '이미 존재하는 버전이에요.',
          });
        } else {
          process.stderr.write(
            `app bundles upload: deployment ${deploymentId} is already in state ${init.reviewStatus}; bundle upload refused.\n`,
          );
        }
        return exitAfterFlush(ExitCode.Usage);
      }
      await putBundleToUploadUrl(init.uploadUrl, bytes);
      const bundle = await postDeploymentsComplete(
        workspaceId,
        appId,
        deploymentId,
        session.cookies,
      );
      let memoApplied = false;
      if (memo !== undefined) {
        await postBundleMemo(workspaceId, appId, deploymentId, memo, session.cookies);
        memoApplied = true;
      }
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          deploymentId,
          reviewStatus: init.reviewStatus,
          bundle,
          memoApplied,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `Uploaded bundle for app ${appId} (ws ${workspaceId})\n` +
          `  deploymentId ${deploymentId}\n` +
          `  bytes        ${bytes.byteLength}\n` +
          `  memo         ${memoApplied ? 'applied' : '(none)'}\n`,
      );
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app bundles review <id> --deployment-id <uuid> --release-notes <text>
//                      [--withdraw] [--workspace <id>]:
//     { ok: true, workspaceId, appId, deploymentId, action: 'submit'|'withdraw',
//       result: { ... } }                                        exit 0
//     { ok: false, reason: 'invalid-id' | 'missing-deployment-id'
//                         | 'missing-release-notes' }            exit 2
//
// Submits (default) or withdraws a review request on an uploaded bundle.
// Server validates the deploymentId belongs to the app — we don't
// double-check here. `--withdraw` is the opposite action and takes no
// release-notes. Submitting requires release-notes even if empty on the
// wire (the UI sends "") — we forward whatever the caller supplies.

const bundlesReviewCommand = defineCommand({
  meta: {
    name: 'review',
    description: 'Submit (or withdraw) an uploaded bundle for review.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    'deployment-id': {
      type: 'string',
      description: 'deploymentId of the uploaded bundle.',
    },
    'release-notes': {
      type: 'string',
      description: 'Release notes shown to the reviewer. Ignored with --withdraw.',
    },
    withdraw: {
      type: 'boolean',
      description: 'Withdraw the existing review request instead of submitting a new one.',
      default: false,
    },
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
        process.stderr.write(`app bundles review: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const deploymentId = typeof args['deployment-id'] === 'string' ? args['deployment-id'] : '';
    if (deploymentId === '') {
      if (args.json) {
        emitJson({ ok: false, reason: 'missing-deployment-id' });
      } else {
        process.stderr.write('app bundles review: --deployment-id <uuid> is required.\n');
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const withdraw = Boolean(args.withdraw);
    const releaseNotes =
      typeof args['release-notes'] === 'string' ? args['release-notes'] : undefined;
    if (!withdraw && releaseNotes === undefined) {
      if (args.json) {
        emitJson({ ok: false, reason: 'missing-release-notes' });
      } else {
        process.stderr.write(
          'app bundles review: --release-notes <text> is required to submit for review.\n',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      if (withdraw) {
        const result = await postBundleReviewWithdrawal(
          workspaceId,
          appId,
          deploymentId,
          session.cookies,
        );
        if (args.json) {
          emitJson({
            ok: true,
            workspaceId,
            appId,
            deploymentId,
            action: 'withdraw',
            result,
          });
          return exitAfterFlush(ExitCode.Ok);
        }
        process.stdout.write(
          `Withdrew review for bundle ${deploymentId} (app ${appId}, ws ${workspaceId})\n`,
        );
        return exitAfterFlush(ExitCode.Ok);
      }
      const result = await postBundleReview(
        {
          workspaceId,
          miniAppId: appId,
          deploymentId,
          releaseNotes: releaseNotes ?? '',
        },
        session.cookies,
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          deploymentId,
          action: 'submit',
          result,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      const versionName = typeof result.versionName === 'string' ? result.versionName : '';
      process.stdout.write(
        `Submitted bundle ${deploymentId} for review (app ${appId}, ws ${workspaceId})` +
          (versionName ? ` — version ${versionName}` : '') +
          '\n',
      );
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app bundles release <id> --deployment-id <uuid> [--workspace <id>]:
//     { ok: true, workspaceId, appId, deploymentId, result: { ... } } exit 0
//     { ok: false, reason: 'invalid-id' | 'missing-deployment-id'
//                         | 'not-confirmed' }                         exit 2
//
// Flips an APPROVED bundle live. This is the destructive write path —
// end users will see the new version. Guarded behind `--confirm` to
// prevent accidental invocation from a loose shell history. No `--json`
// bypass: the confirmation flag is mandatory.

const bundlesReleaseCommand = defineCommand({
  meta: {
    name: 'release',
    description: 'Release (publish) an APPROVED bundle to end users.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    'deployment-id': {
      type: 'string',
      description: 'deploymentId of the APPROVED bundle to publish.',
    },
    confirm: {
      type: 'boolean',
      description: 'Required to actually release — without it, the command refuses.',
      default: false,
    },
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
        process.stderr.write(`app bundles release: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const deploymentId = typeof args['deployment-id'] === 'string' ? args['deployment-id'] : '';
    if (deploymentId === '') {
      if (args.json) {
        emitJson({ ok: false, reason: 'missing-deployment-id' });
      } else {
        process.stderr.write('app bundles release: --deployment-id <uuid> is required.\n');
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    if (!args.confirm) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'not-confirmed',
          message: 'release is destructive; pass --confirm to proceed',
        });
      } else {
        process.stderr.write(
          'app bundles release: this publishes the bundle to end users.\n' +
            '  Re-run with --confirm to proceed.\n',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await postBundleRelease(
        { workspaceId, miniAppId: appId, deploymentId },
        session.cookies,
      );
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, deploymentId, result });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `Released bundle ${deploymentId} for app ${appId} (ws ${workspaceId})\n`,
      );
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --json contract (consumed by agent-plugin):
//
//   app bundles test-push <id> --deployment-id <uuid> [--workspace <id>]:
//     { ok: true, workspaceId, appId, deploymentId, result: { ... } } exit 0
//
//   app bundles test-links <id> [--workspace <id>]:
//     { ok: true, workspaceId, appId, links: { ... } }                exit 0

const bundlesTestPushCommand = defineCommand({
  meta: {
    name: 'test-push',
    description: 'Send a test push so the uploader can open this bundle on their device.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    'deployment-id': {
      type: 'string',
      description: 'deploymentId of the bundle to test.',
    },
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
        process.stderr.write(`app bundles test-push: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const deploymentId = typeof args['deployment-id'] === 'string' ? args['deployment-id'] : '';
    if (deploymentId === '') {
      if (args.json) {
        emitJson({ ok: false, reason: 'missing-deployment-id' });
      } else {
        process.stderr.write('app bundles test-push: --deployment-id <uuid> is required.\n');
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    try {
      const result = await postBundleTestPush(workspaceId, appId, deploymentId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, deploymentId, result });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`Sent test push for bundle ${deploymentId} (app ${appId})\n`);
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const bundlesTestLinksCommand = defineCommand({
  meta: {
    name: 'test-links',
    description: 'Show per-device test URLs for the mini-app.',
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
        process.stderr.write(`app bundles test-links: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;
    try {
      const links = await fetchBundleTestLinks(workspaceId, appId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, links });
        return exitAfterFlush(ExitCode.Ok);
      }
      const keys = Object.keys(links);
      if (keys.length === 0) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no test links available\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`App ${appId} (ws ${workspaceId}):\n`);
      for (const k of keys) {
        const v = links[k];
        process.stdout.write(`  ${k}\t${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const bundlesCommand = defineCommand({
  meta: {
    name: 'bundles',
    description: 'Inspect and manage upload bundles for a mini-app.',
  },
  subCommands: {
    ls: bundlesLsCommand,
    deployed: bundlesDeployedCommand,
    upload: bundlesUploadCommand,
    review: bundlesReviewCommand,
    release: bundlesReleaseCommand,
    'test-push': bundlesTestPushCommand,
    'test-links': bundlesTestLinksCommand,
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

// --json contract (consumed by agent-plugin):
//
//   app share-rewards ls <id> [--workspace <id>] [--search <text>]:
//     { ok: true, workspaceId, appId, rewards: [...] }       exit 0
//     { ok: false, reason: 'invalid-id' | ... }              exit 2
//
//   app messages ls <id> [--workspace <id>] [--page N] [--size N] [--search <text>]:
//     { ok: true, workspaceId, appId, campaigns: [...], paging: {...} }   exit 0
//     { ok: false, reason: 'invalid-id' | 'invalid-page' | 'invalid-size' | ... } exit 2
//
//   app events ls <id> [--workspace <id>] [--page N] [--size N] [--search <text>] [--refresh]:
//     { ok: true, workspaceId, appId, events: [...], cacheTime, paging: {...} }   exit 0
//     { ok: false, reason: 'invalid-id' | 'invalid-page' | 'invalid-size' | ... } exit 2
//
//   app templates ls <id> [--workspace <id>] [--page N] [--size N] [--content-reach-type FUNCTIONAL|MARKETING] [--smart-message true|false]:
//     { ok: true, workspaceId, appId, templates: [...], totalPageCount }          exit 0
//     { ok: false, reason: 'invalid-id' | 'invalid-page' | 'invalid-size' |
//                            'invalid-content-reach-type' | 'invalid-smart-message' } exit 2
//
//   app categories [--selectable]:
//     { ok: true, categories: CategoryTreeEntry[] }                               exit 0
//     { ok: true, authenticated: false }                                          exit 10
//
//   app service-status <id> [--workspace <id>]:
//     { ok: true, workspaceId, appId, serviceStatus, shutdownCandidateStatus,
//       scheduledShutdownAt }                                                     exit 0
//     { ok: false, reason: 'invalid-id' | ... }                                   exit 2
//
// Share-reward promotions for an app. Empty array is the common case
// (no promotions set up). Per-record shape is passed through opaquely
// until a populated response is observed.

const shareRewardsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List share-reward promotions configured for a mini-app.',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    search: {
      type: 'string',
      description: 'Filter by title (server-side title-contains match). Empty matches everything.',
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
        process.stderr.write(`app share-rewards ls: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const rewards = await fetchShareRewards(
        {
          workspaceId,
          miniAppId: appId,
          ...(args.search !== undefined ? { search: String(args.search) } : {}),
        },
        session.cookies,
      );
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, rewards });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (rewards.length === 0) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no share-reward promotions\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`App ${appId} (ws ${workspaceId}): ${rewards.length} share-reward(s)\n`);
      for (const r of rewards) {
        const id =
          typeof r.id === 'string' || typeof r.id === 'number'
            ? r.id
            : typeof r.rewardId === 'string' || typeof r.rewardId === 'number'
              ? r.rewardId
              : '-';
        const title =
          typeof r.title === 'string' ? r.title : typeof r.name === 'string' ? r.name : '-';
        const status = typeof r.status === 'string' ? r.status : '-';
        process.stdout.write(`${id}\t${title}\t${status}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const shareRewardsCommand = defineCommand({
  meta: {
    name: 'share-rewards',
    description: 'Inspect share-reward promotions for a mini-app.',
  },
  subCommands: {
    ls: shareRewardsLsCommand,
  },
});

const messagesLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List smart-message campaigns (formerly "push" — the 스마트 발송 menu).',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    size: { type: 'string', description: 'Page size.', default: '20' },
    search: { type: 'string', description: 'Title-contains filter. Empty matches everything.' },
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
        process.stderr.write(`app messages ls: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const pageResult = parseNonNegativeInt(String(args.page), 'page');
    if ('error' in pageResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-page', message: pageResult.error });
      else process.stderr.write(`${pageResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }
    const sizeResult = parseNonNegativeInt(String(args.size), 'size');
    if ('error' in sizeResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-size', message: sizeResult.error });
      else process.stderr.write(`${sizeResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchSmartMessageCampaigns(
        {
          workspaceId,
          miniAppId: appId,
          page: pageResult.value,
          size: sizeResult.value,
          ...(args.search !== undefined ? { search: String(args.search) } : {}),
        },
        session.cookies,
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          campaigns: result.items,
          paging: result.paging,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (result.items.length === 0) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no smart-message campaigns\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): ${result.items.length} campaign(s) on page ${result.paging.pageNumber} of ${result.paging.totalCount}\n`,
      );
      for (const c of result.items) {
        const id =
          typeof c.id === 'string' || typeof c.id === 'number'
            ? c.id
            : typeof c.campaignId === 'string' || typeof c.campaignId === 'number'
              ? c.campaignId
              : '-';
        const title =
          typeof c.title === 'string' ? c.title : typeof c.name === 'string' ? c.name : '-';
        const status = typeof c.status === 'string' ? c.status : '-';
        process.stdout.write(`${id}\t${title}\t${status}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const messagesCommand = defineCommand({
  meta: {
    name: 'messages',
    description: 'Inspect smart-message (formerly push) campaigns for a mini-app.',
  },
  subCommands: {
    ls: messagesLsCommand,
  },
});

const eventsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List custom event catalogs recorded for a mini-app (the 이벤트 menu).',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    size: { type: 'string', description: 'Page size.', default: '20' },
    search: { type: 'string', description: 'Event-name filter. Empty matches everything.' },
    refresh: {
      type: 'boolean',
      description: 'Bypass the server cache and rebuild the catalog list.',
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
        process.stderr.write(`app events ls: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const pageResult = parseNonNegativeInt(String(args.page), 'page');
    if ('error' in pageResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-page', message: pageResult.error });
      else process.stderr.write(`${pageResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }
    const sizeResult = parseNonNegativeInt(String(args.size), 'size');
    if ('error' in sizeResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-size', message: sizeResult.error });
      else process.stderr.write(`${sizeResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchAppEventCatalogs(
        {
          workspaceId,
          miniAppId: appId,
          pageNumber: pageResult.value,
          pageSize: sizeResult.value,
          ...(args.search !== undefined ? { search: String(args.search) } : {}),
          ...(args.refresh ? { refresh: true } : {}),
        },
        session.cookies,
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          events: result.results,
          cacheTime: result.cacheTime ?? null,
          paging: result.paging,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (result.results.length === 0) {
        const ct = result.cacheTime ? ` (cached ${result.cacheTime})` : '';
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no event catalogs${ct}\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): ${result.results.length} event(s) on page ${result.paging.pageNumber} of ${result.paging.totalPages}\n`,
      );
      for (const e of result.results) {
        const name =
          typeof e.name === 'string' ? e.name : typeof e.eventName === 'string' ? e.eventName : '-';
        const count =
          typeof e.count === 'number'
            ? String(e.count)
            : typeof e.totalCount === 'number'
              ? String(e.totalCount)
              : '-';
        process.stdout.write(`${name}\t${count}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const eventsCommand = defineCommand({
  meta: {
    name: 'events',
    description: 'Inspect custom event catalogs (log search) for a mini-app.',
  },
  subCommands: {
    ls: eventsLsCommand,
  },
});

const templatesLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description:
      'List the smart-message composer templates available for a mini-app (the 템플릿 picker in 스마트 발송).',
  },
  args: {
    id: { type: 'positional', description: 'Mini-app ID.', required: true },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    size: { type: 'string', description: 'Page size.', default: '20' },
    'content-reach-type': {
      type: 'string',
      description: `Template reach bucket: ${TEMPLATE_CONTENT_REACH_TYPES.join(' | ')}. Omit for all.`,
    },
    'smart-message': {
      type: 'string',
      description:
        'Filter to templates compatible with smart-message ("true") or legacy push ("false"). Omit for all.',
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
        process.stderr.write(`app templates ls: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const pageResult = parseNonNegativeInt(String(args.page), 'page');
    if ('error' in pageResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-page', message: pageResult.error });
      else process.stderr.write(`${pageResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }
    const sizeResult = parseNonNegativeInt(String(args.size), 'size');
    if ('error' in sizeResult) {
      if (args.json) emitJson({ ok: false, reason: 'invalid-size', message: sizeResult.error });
      else process.stderr.write(`${sizeResult.error}\n`);
      return exitAfterFlush(ExitCode.Usage);
    }

    let contentReachType: TemplateContentReachType | undefined;
    if (args['content-reach-type'] !== undefined) {
      const upper = String(args['content-reach-type']).toUpperCase();
      if ((TEMPLATE_CONTENT_REACH_TYPES as readonly string[]).includes(upper)) {
        contentReachType = upper as TemplateContentReachType;
      } else {
        const message = `--content-reach-type must be one of: ${TEMPLATE_CONTENT_REACH_TYPES.join(', ')}`;
        if (args.json) {
          emitJson({
            ok: false,
            reason: 'invalid-content-reach-type',
            allowed: [...TEMPLATE_CONTENT_REACH_TYPES],
          });
        } else {
          process.stderr.write(`${message}\n`);
        }
        return exitAfterFlush(ExitCode.Usage);
      }
    }

    let isSmartMessage: boolean | undefined;
    if (args['smart-message'] !== undefined) {
      const raw = String(args['smart-message']).toLowerCase();
      if (raw === 'true') isSmartMessage = true;
      else if (raw === 'false') isSmartMessage = false;
      else {
        const message = '--smart-message must be "true" or "false"';
        if (args.json) emitJson({ ok: false, reason: 'invalid-smart-message', message });
        else process.stderr.write(`${message}\n`);
        return exitAfterFlush(ExitCode.Usage);
      }
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const result = await fetchAppTemplates(
        {
          workspaceId,
          miniAppId: appId,
          page: pageResult.value,
          size: sizeResult.value,
          ...(contentReachType !== undefined ? { contentReachType } : {}),
          ...(isSmartMessage !== undefined ? { isSmartMessage } : {}),
        },
        session.cookies,
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          templates: result.templates,
          totalPageCount: result.totalPageCount,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      if (result.templates.length === 0) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): no templates\n`);
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): ${result.templates.length} template(s) of ${result.totalPageCount} page(s)\n`,
      );
      for (const t of result.templates) {
        const id =
          typeof t.id === 'string' || typeof t.id === 'number'
            ? t.id
            : typeof t.templateId === 'string' || typeof t.templateId === 'number'
              ? t.templateId
              : '-';
        const title =
          typeof t.title === 'string' ? t.title : typeof t.name === 'string' ? t.name : '-';
        const type = typeof t.templateType === 'string' ? t.templateType : '-';
        process.stdout.write(`${id}\t${title}\t${type}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const templatesCommand = defineCommand({
  meta: {
    name: 'templates',
    description: 'Inspect smart-message composer templates available for a mini-app.',
  },
  subCommands: {
    ls: templatesLsCommand,
  },
});

const categoriesCommand = defineCommand({
  meta: {
    name: 'categories',
    description: "List the impression category tree used by `app register`'s `categoryIds` field.",
  },
  args: {
    selectable: {
      type: 'boolean',
      description: 'Only show categories flagged `isSelectable: true` — the ones you can pick.',
      default: false,
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON to stdout.', default: false },
  },
  async run({ args }) {
    const session = await readSession();
    if (!session) {
      emitNotAuthenticated(args.json);
      return exitAfterFlush(ExitCode.NotAuthenticated);
    }

    try {
      const tree = await fetchImpressionCategoryList(session.cookies);

      // Optional filter collapses non-selectable groups and categories. Kept
      // off by default because the flag `isSelectable: false` entries still
      // show up in live app payloads (eg. `금융` group) and are useful for
      // agents debugging a rejected registration.
      const filtered = args.selectable
        ? tree
            .filter((g) => g.categoryGroup.isSelectable)
            .map((g) => ({
              ...g,
              categoryList: g.categoryList
                .filter((c) => c.isSelectable)
                .map((c) => ({
                  ...c,
                  subCategoryList: c.subCategoryList.filter((s) => s.isSelectable),
                })),
            }))
        : tree;

      if (args.json) {
        emitJson({ ok: true, categories: filtered });
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const g of filtered) {
        const mark = g.categoryGroup.isSelectable ? '' : ' (not selectable)';
        process.stdout.write(`[${g.categoryGroup.id}] ${g.categoryGroup.name}${mark}\n`);
        for (const c of g.categoryList) {
          const cmark = c.isSelectable ? '' : ' (not selectable)';
          process.stdout.write(`  ${c.id}\t${c.name}${cmark}\n`);
          for (const s of c.subCategoryList) {
            const smark = s.isSelectable ? '' : ' (not selectable)';
            process.stdout.write(`    ${s.id}\t${s.name}${smark}\n`);
          }
        }
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const serviceStatusCommand = defineCommand({
  meta: {
    name: 'service-status',
    description:
      'Show the server-authoritative runtime status of a mini-app (serviceStatus, shutdown schedule).',
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
        process.stderr.write(`app service-status: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    const ctx = await resolveWorkspaceContext(args);
    if (!ctx) return;
    const { session, workspaceId } = ctx;

    try {
      const st = await fetchAppServiceStatus(workspaceId, appId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, ...st });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`App ${appId} (ws ${workspaceId}):\n`);
      process.stdout.write(`  serviceStatus: ${st.serviceStatus}\n`);
      process.stdout.write(`  shutdownCandidateStatus: ${st.shutdownCandidateStatus ?? 'null'}\n`);
      process.stdout.write(`  scheduledShutdownAt: ${st.scheduledShutdownAt ?? 'null'}\n`);
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
    'share-rewards': shareRewardsCommand,
    messages: messagesCommand,
    events: eventsCommand,
    templates: templatesCommand,
    categories: categoriesCommand,
    'service-status': serviceStatusCommand,
    register: registerCommand,
  },
});
