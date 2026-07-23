import { defineCommand } from 'citty';
import { fetchAdsAbuseStatus, fetchAdsPlacementGroups } from '../api/in-app-ads.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  emitFailureFromError,
  emitJson,
  printContextHeader,
  requireMiniAppId,
  resolveAppOrFail,
  withReauthRetry,
} from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   app ads placement-groups ls [--app <id>] [--workspace <id>]:
//     { ok: true, workspaceId, appId, placementGroups: [...] }            exit 0
//     { ok: false, reason: 'missing-app-id' | 'invalid-id'
//                        | 'no-workspace-selected' | 'invalid-config' }    exit 2
//
//   app ads abuse-status [--app <id>] [--workspace <id>]:
//     { ok: true, workspaceId, appId, abuseLevel, isServingBlocked,
//       blockedPlacementGroups: [...] }                                   exit 0
//     (same context-resolution failure modes as `placement-groups ls`)
//
// Every subcommand inherits the standard auth/network/api failure modes
// (see `emitFailureFromError` in _shared.ts): session-expired exit 10,
// network-error exit 11, api-error exit 17.
//
// Read-only — this command group never mutates ad configuration. Confirmed
// live 2026-07-24 (workspace 3095 / app 31146): both endpoints return 200
// with empty/neutral state (no placement groups registered yet, abuse
// level NONE). See docs/api/in-app-ads.md.

const placementGroupsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List in-app ad placement groups registered for a mini-app.',
  },
  args: {
    app: {
      type: 'string',
      description: 'Mini-app ID. Optional when `aitcc.yaml` provides `miniAppId`.',
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveAppOrFail({
      json: args.json,
      appIdRaw: args.app,
      appIdField: 'app',
      ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    });
    if (!ctx) return;
    const appId = await requireMiniAppId(ctx, args.json);
    if (appId === null) return;
    printContextHeader(ctx, { json: args.json });
    const { session, workspaceId } = ctx;

    try {
      const placementGroups = await withReauthRetry(args.json, session, (s) =>
        fetchAdsPlacementGroups({ workspaceId, miniAppId: appId }, s.cookies),
      );

      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, placementGroups });
        return exitAfterFlush(ExitCode.Ok);
      }

      if (placementGroups.length === 0) {
        process.stdout.write(`App ${appId} (ws ${workspaceId}): 등록된 광고 지면 없음\n`);
        process.stdout.write(
          '콘솔의 광고 관리 메뉴에서 광고 지면을 먼저 생성하면 여기서 조회할 수 있어요.\n',
        );
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): ${placementGroups.length} placement group(s)\n`,
      );
      for (const g of placementGroups) {
        const id = typeof g.id === 'string' || typeof g.id === 'number' ? g.id : '-';
        const name = typeof g.name === 'string' ? g.name : '-';
        const status = typeof g.status === 'string' ? g.status : '-';
        process.stdout.write(`${id}\t${name}\t${status}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const placementGroupsCommand = defineCommand({
  meta: {
    name: 'placement-groups',
    description: 'Inspect in-app ad placement groups for a mini-app.',
  },
  subCommands: {
    ls: placementGroupsLsCommand,
  },
});

const abuseStatusCommand = defineCommand({
  meta: {
    name: 'abuse-status',
    description:
      'Show whether a mini-app is currently flagged for ad abuse (and blocked from serving).',
  },
  args: {
    app: {
      type: 'string',
      description: 'Mini-app ID. Optional when `aitcc.yaml` provides `miniAppId`.',
    },
    workspace: {
      type: 'string',
      description: 'Workspace ID. Defaults to the selected workspace.',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const ctx = await resolveAppOrFail({
      json: args.json,
      appIdRaw: args.app,
      appIdField: 'app',
      ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    });
    if (!ctx) return;
    const appId = await requireMiniAppId(ctx, args.json);
    if (appId === null) return;
    printContextHeader(ctx, { json: args.json });
    const { session, workspaceId } = ctx;

    try {
      const status = await withReauthRetry(args.json, session, (s) =>
        fetchAdsAbuseStatus({ workspaceId, miniAppId: appId }, s.cookies),
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          abuseLevel: status.abuseLevel,
          isServingBlocked: status.isServingBlocked,
          blockedPlacementGroups: status.blockedPlacementGroups,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(`App ${appId} (ws ${workspaceId}) ad abuse status:\n`);
      process.stdout.write(`  abuseLevel: ${status.abuseLevel}\n`);
      process.stdout.write(`  isServingBlocked: ${status.isServingBlocked}\n`);
      if (status.isServingBlocked) {
        process.stdout.write(
          `  blocked placement groups: ${status.blockedPlacementGroups.length}\n`,
        );
        process.stdout.write(
          '  광고 노출이 차단된 상태예요 — 콘솔의 광고 정책 위반 안내를 확인하고 소명 절차를 진행하세요.\n',
        );
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export const adsCommand = defineCommand({
  meta: {
    name: 'ads',
    description: 'Inspect in-app ad placement groups and abuse/serving status for a mini-app.',
  },
  subCommands: {
    'placement-groups': placementGroupsCommand,
    'abuse-status': abuseStatusCommand,
  },
});
