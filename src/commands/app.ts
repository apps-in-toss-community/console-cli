import { defineCommand } from 'citty';
import { NetworkError, TossApiError } from '../api/http.js';
import { fetchMiniApps, fetchReviewStatus } from '../api/mini-apps.js';
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

export const appCommand = defineCommand({
  meta: {
    name: 'app',
    description: 'Inspect mini-apps in a workspace.',
  },
  subCommands: {
    ls: lsCommand,
  },
});
