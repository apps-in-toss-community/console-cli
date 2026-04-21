import { defineCommand } from 'citty';
import { NetworkError, TossApiError } from '../api/http.js';
import { fetchMiniApps, fetchReviewStatus } from '../api/mini-apps.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession, sessionPathForDiagnostics } from '../session.js';
import { parsePositiveInt } from './workspace.js';

// --json contract (consumed by agent-plugin):
//
//   app ls [--workspace <id>]:
//     { ok: true, workspaceId, hasPolicyViolation, apps: [{id, name, reviewState?, extra}] } exit 0
//     { ok: false, reason: 'no-workspace-selected' }                                         exit 2
//     { ok: false, reason: 'invalid-id', message }                                           exit 2
//
//   Auth/network/api failures follow the shared contract from workspace/whoami
//   (ok: true authenticated: false exit 10, network-error exit 11, api-error exit 17).

function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitNotAuthenticated(json: boolean, reason?: 'session-expired'): void {
  if (json) {
    // exactOptionalPropertyTypes forbids `reason: undefined`, so omit the
    // key entirely when we don't have a value.
    const payload = reason
      ? { ok: true as const, authenticated: false as const, reason }
      : { ok: true as const, authenticated: false as const };
    emitJson(payload);
  } else {
    process.stderr.write(
      reason === 'session-expired'
        ? 'Session is no longer valid. Run `aitcc login` again.\n'
        : 'Not logged in. Run `aitcc login` to start a session.\n',
    );
    process.stderr.write(`Session file checked: ${sessionPathForDiagnostics()}\n`);
  }
}

function emitNetworkError(json: boolean, message: string): void {
  if (json) {
    emitJson({ ok: false, reason: 'network-error', message });
  } else {
    process.stderr.write(`Network error reaching the console API: ${message}.\n`);
  }
}

function emitApiError(json: boolean, message: string): void {
  if (json) {
    emitJson({ ok: false, reason: 'api-error', message });
  } else {
    process.stderr.write(`Unexpected error: ${message}\n`);
  }
}

// Best-effort match of review-status entries against mini-app summaries.
// The list endpoint and the review-status endpoint key off the same id,
// but we don't assume the field name is uniform — we compare by `.id` on
// each record, falling back to string equality. Returns `null` if no
// plausible match; callers render that as "no review status" in the
// output rather than a failure.
function findReviewEntry(
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

function reviewStateFor(entry: Readonly<Record<string, unknown>> | null): string | undefined {
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
        if (args.json) emitJson({ ok: false, reason: 'invalid-id', message });
        else process.stderr.write(`${message}\n`);
        return exitAfterFlush(ExitCode.Usage);
      }
      workspaceId = parsed;
    } else {
      workspaceId = session.currentWorkspaceId;
    }

    if (workspaceId === undefined) {
      if (args.json) emitJson({ ok: false, reason: 'no-workspace-selected' });
      else {
        process.stderr.write(
          'No workspace selected. Pass `--workspace <id>` or run `aitcc workspace use <id>`.\n',
        );
      }
      return exitAfterFlush(ExitCode.Usage);
    }

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
          process.stderr.write('Note: workspace has a policy violation flag set.\n');
        }
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const app of apps) {
        const entry = findReviewEntry(review.miniApps, app.id);
        const reviewState = reviewStateFor(entry) ?? '-';
        const name = app.name ?? '(unnamed)';
        process.stdout.write(`${app.id}\t${name}\t${reviewState}\n`);
      }
      if (review.hasPolicyViolation) {
        process.stderr.write('Note: workspace has a policy violation flag set.\n');
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
