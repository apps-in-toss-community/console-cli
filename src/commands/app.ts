import { defineCommand } from 'citty';
import { fetchMiniApps, fetchMiniAppWithDraft, fetchReviewStatus } from '../api/mini-apps.js';
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
    register: registerCommand,
  },
});
