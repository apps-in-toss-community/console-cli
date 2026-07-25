import { defineCommand } from 'citty';
import {
  AD_BANNER_STYLES,
  AD_FORMATS,
  type AdBannerStyle,
  type AdFormat,
  createAdsPlacementGroup,
  fetchAdsAbuseStatus,
  fetchAdsPlacementGroups,
  resolveAdCategoryId,
} from '../api/in-app-ads.js';
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
//   app ads placement-groups create --name N --format F [--category ID]
//                                    [--reward-unit T --reward-amount N]
//                                    [--banner-style S] [--app <id>]
//                                    [--workspace <id>] [--dry-run] [--confirm]:
//     { ok: true, dryRun: true, workspaceId, appId, payload,
//       categorySource?: 'override'|'auto' }                             exit 0  (--dry-run)
//     { ok: true, workspaceId, appId, adGroupId, result: {...},
//       categorySource?: 'override'|'auto' }                             exit 0  (real submit)
//     { ok: false, reason: 'not-confirmed', message }                    exit 2  (missing --confirm, no --dry-run)
//     { ok: false, reason: 'invalid-args', field, message }               exit 2  (client-side validation — see
//                                                                                  validateCreateAdsPlacementGroupArgs)
//     { ok: false, reason: 'category-not-resolved', field: 'category', message } exit 2
//       (--category omitted, non-BANNER, and the app's own impression category couldn't be read — see
//        resolveAdCategoryId in src/api/in-app-ads.ts)
//     { ok: false, reason: 'category-invalid', field: 'category', categoryId, message } exit 2
//       (auto-resolved categoryId rejected by ad-mob-ad-info for this --format)
//     (same context-resolution + 5002/auth/network failure modes as the read commands)
//
//   `--category` is required for BANNER-less formats (INTERSTITIAL/
//   REWARDED) only when it can't be auto-resolved (issue #231, 2026-07-24
//   live measurement): omitted → the app's own impression category id is
//   read via fetchMiniAppDetail and best-effort validated via
//   fetchAdMobAdInfo (categorySource: 'auto'); provided → used as an
//   explicit override with no extra live lookups (categorySource:
//   'override'). BANNER never takes a category (adStyles instead).
//
//   ⚠️ `placement-groups create`'s request body is inferred from static
//   analysis of the console SPA's placement-group creation wizard
//   serialization logic, cross-checked against the public developer docs.
//   Never live-confirmed. Per SECRET-HANDLING policy this command's POST
//   call is never exercised against the live console in this repo (dry-run
//   only in CI/dog-food); the real first call happens behind a
//   maintainer-approved `--confirm` invocation. See docs/api/in-app-ads.md
//   "placement-group create — inferred body shape".
//
// Every subcommand inherits the standard auth/network/api failure modes
// (see `emitFailureFromError` in _shared.ts): session-expired exit 10,
// network-error exit 11, api-error exit 17.
//
// `placement-groups ls` / `abuse-status` are read-only, confirmed live
// 2026-07-24 (workspace 3095 / app 31146): both endpoints return 200 with
// empty/neutral state (no placement groups registered yet, abuse level
// NONE). See docs/api/in-app-ads.md. `placement-groups create` is the one
// mutation in this command group — gated behind --confirm (see below).

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

// --- placement-groups create ---
//
// Client-side validation mirrors the console SPA's placement-group creation
// wizard form rules (see src/api/in-app-ads.ts module comment for the
// source trace). Exported as a pure function so it's testable without a
// citty invocation, matching `validateCreateIapProductArgs` in app-iap.ts.

export interface CreateAdsPlacementGroupArgsInput {
  readonly name: string | undefined;
  readonly format: string | undefined;
  readonly category: string | undefined;
  readonly rewardUnit: string | undefined;
  readonly rewardAmount: string | undefined;
  readonly bannerStyle: string | undefined;
}

export interface ValidatedCreateAdsPlacementGroupArgs {
  readonly displayName: string;
  readonly adFormat: AdFormat;
  readonly categoryId?: number;
  readonly rewardSettings?: { readonly unitType: string; readonly unitAmount: number };
  readonly adStyles?: readonly [AdBannerStyle];
}

export type CreateAdsPlacementGroupValidation =
  | { readonly ok: true; readonly value: ValidatedCreateAdsPlacementGroupArgs }
  | { readonly ok: false; readonly field: string; readonly message: string };

// Field-level rules from the create contract (issue #229, confirmed via
// console SPA serialization logic + public developer docs, 2026-07-24):
//   displayName <=40 chars, adFormat required, rewardSettings required iff
//   adFormat === REWARDED, adStyles (1-entry array) only when
//   adFormat === BANNER (default NORMAL).
//
// `--category` is OPTIONAL here even when adFormat !== BANNER (issue #231,
// 2026-07-24 live measurement) — when omitted, the command layer
// auto-resolves it from the app's own impression category after the app
// context is known (this pure function has no session/live-call access, so
// it can only validate a *provided* value's shape; the "is a category
// actually available" question is answered later by
// `resolveAdCategoryId` in src/api/in-app-ads.ts). When provided it's
// always taken as an explicit override — validated as a positive integer
// exactly as before.
export function validateCreateAdsPlacementGroupArgs(
  input: CreateAdsPlacementGroupArgsInput,
): CreateAdsPlacementGroupValidation {
  const name = input.name;
  if (name === undefined || name.length === 0) {
    return { ok: false, field: 'name', message: '--name is required.' };
  }
  if (name.length > 40) {
    return { ok: false, field: 'name', message: '--name must be 40 characters or fewer.' };
  }

  const format = input.format;
  if (format === undefined || !(AD_FORMATS as readonly string[]).includes(format)) {
    return {
      ok: false,
      field: 'format',
      message: `--format must be one of ${AD_FORMATS.join('|')} (got ${JSON.stringify(format)}).`,
    };
  }
  const adFormat = format as AdFormat;

  let categoryId: number | undefined;
  if (adFormat !== 'BANNER' && input.category !== undefined) {
    const parsed = Number(input.category);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      return {
        ok: false,
        field: 'category',
        message: '--category must be a positive integer category id.',
      };
    }
    categoryId = parsed;
  }

  let rewardSettings: { unitType: string; unitAmount: number } | undefined;
  if (adFormat === 'REWARDED') {
    if (input.rewardUnit === undefined || input.rewardUnit.length === 0) {
      return {
        ok: false,
        field: 'reward-unit',
        message: '--reward-unit is required when --format is REWARDED.',
      };
    }
    if (input.rewardAmount === undefined) {
      return {
        ok: false,
        field: 'reward-amount',
        message: '--reward-amount is required when --format is REWARDED.',
      };
    }
    const unitAmount = Number(input.rewardAmount);
    if (!Number.isFinite(unitAmount) || !Number.isInteger(unitAmount) || unitAmount <= 0) {
      return {
        ok: false,
        field: 'reward-amount',
        message: '--reward-amount must be a positive integer.',
      };
    }
    rewardSettings = { unitType: input.rewardUnit, unitAmount };
  }

  let adStyles: readonly [AdBannerStyle] | undefined;
  if (adFormat === 'BANNER') {
    const bannerStyleRaw = input.bannerStyle ?? 'NORMAL';
    if (!(AD_BANNER_STYLES as readonly string[]).includes(bannerStyleRaw)) {
      return {
        ok: false,
        field: 'banner-style',
        message: `--banner-style must be one of ${AD_BANNER_STYLES.join('|')}.`,
      };
    }
    adStyles = [bannerStyleRaw as AdBannerStyle];
  }

  return {
    ok: true,
    value: {
      displayName: name,
      adFormat,
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(rewardSettings !== undefined ? { rewardSettings } : {}),
      ...(adStyles !== undefined ? { adStyles } : {}),
    },
  };
}

const placementGroupsCreateCommand = defineCommand({
  meta: {
    name: 'create',
    description:
      'Create a new in-app ad placement group (⚠️ inferred body shape — see docs/api/in-app-ads.md).',
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
    name: { type: 'string', description: 'Placement group display name (<=40 chars).' },
    format: {
      type: 'string',
      description: `Ad format (${AD_FORMATS.join('|')}).`,
    },
    category: {
      type: 'string',
      description:
        'Ad category id override — only used when --format is INTERSTITIAL or REWARDED. ' +
        "Optional: when omitted, the app's own category id is auto-resolved (fetched from " +
        'app details and validated for the given --format); pass this to override it.',
    },
    'reward-unit': {
      type: 'string',
      description: 'Reward unit type — required when --format is REWARDED (e.g. "coin").',
    },
    'reward-amount': {
      type: 'string',
      description: 'Reward unit amount — required when --format is REWARDED.',
    },
    'banner-style': {
      type: 'string',
      description: `Banner style, only used when --format is BANNER (${AD_BANNER_STYLES.join('|')}).`,
      default: 'NORMAL',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate and print the planned request body without calling the console API.',
      default: false,
    },
    confirm: {
      type: 'boolean',
      description:
        'Required to actually submit (without --dry-run) — without it, the command refuses.',
      default: false,
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const validation = validateCreateAdsPlacementGroupArgs({
      name: args.name,
      format: args.format,
      category: args.category,
      rewardUnit: args['reward-unit'],
      rewardAmount: args['reward-amount'],
      bannerStyle: args['banner-style'],
    });
    if (!validation.ok) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-args',
          field: validation.field,
          message: validation.message,
        });
      } else {
        process.stderr.write(`app ads placement-groups create: ${validation.message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    if (!args['dry-run'] && !args.confirm) {
      const message =
        'this creates a real in-app ad placement group; pass --confirm to proceed, ' +
        'or --dry-run to preview the request body first.';
      if (args.json) {
        emitJson({ ok: false, reason: 'not-confirmed', message });
      } else {
        process.stderr.write(`app ads placement-groups create: ${message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

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

    // --- categoryId resolution (non-BANNER only, issue #231) ---
    //
    // An explicit --category is always an override — no live lookups, same
    // as before. Omitted --category on a non-BANNER format now auto-resolves
    // from the app's own impression category (fetchMiniAppDetail) and
    // best-effort validates it against --format (fetchAdMobAdInfo). Both
    // calls are read-only GETs, so this runs ahead of --dry-run too — the
    // preview should show the categoryId that a real submit would actually
    // use.
    let categoryId = validation.value.categoryId;
    let categorySource: 'override' | 'auto' | undefined;
    if (validation.value.adFormat !== 'BANNER') {
      if (categoryId !== undefined) {
        categorySource = 'override';
      } else {
        const resolved = await withReauthRetry(args.json, session, (s) =>
          resolveAdCategoryId(
            { workspaceId, miniAppId: appId, adFormat: validation.value.adFormat },
            s.cookies,
          ),
        );
        if (!resolved.ok) {
          if (args.json) {
            emitJson({
              ok: false,
              reason: resolved.reason,
              field: 'category',
              message: resolved.message,
              ...(resolved.reason === 'category-invalid'
                ? { categoryId: resolved.categoryId }
                : {}),
            });
          } else {
            process.stderr.write(`app ads placement-groups create: ${resolved.message}\n`);
          }
          return exitAfterFlush(ExitCode.Usage);
        }
        categoryId = resolved.categoryId;
        categorySource = 'auto';
        if (!resolved.validated && !args.json) {
          process.stderr.write(
            `[warn] Could not confirm category ${categoryId} via ad-mob-ad-info (best-effort check unavailable) — proceeding with the app's own category id anyway.\n`,
          );
        }
      }
    }

    const input = {
      workspaceId,
      miniAppId: appId,
      displayName: validation.value.displayName,
      adFormat: validation.value.adFormat,
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(validation.value.rewardSettings !== undefined
        ? { rewardSettings: validation.value.rewardSettings }
        : {}),
      ...(validation.value.adStyles !== undefined ? { adStyles: validation.value.adStyles } : {}),
    };

    const categoryLine = (): string =>
      `Category ID: ${categoryId} (${
        categorySource === 'auto'
          ? "auto-resolved from the app's own category"
          : 'override via --category'
      })\n`;

    if (args['dry-run']) {
      const payload = {
        displayName: input.displayName,
        adFormat: input.adFormat,
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.rewardSettings !== undefined ? { rewardSettings: input.rewardSettings } : {}),
        ...(input.adStyles !== undefined ? { adStyles: input.adStyles } : {}),
      };
      if (args.json) {
        emitJson({
          ok: true,
          dryRun: true,
          workspaceId,
          appId,
          payload,
          ...(categorySource !== undefined ? { categorySource } : {}),
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write('[dry-run] Would POST to ');
      process.stdout.write(
        `.../workspaces/${workspaceId}/mini-app/${appId}/in-app-ads-v2/placement-group\n`,
      );
      if (categorySource !== undefined) process.stdout.write(categoryLine());
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return exitAfterFlush(ExitCode.Ok);
    }

    // Real submit — never exercised against the live console in this repo
    // (see SECRET-HANDLING policy in CLAUDE.md). Reachable only with an
    // explicit --confirm from a maintainer-approved invocation.
    try {
      const result = await withReauthRetry(args.json, session, (s) =>
        createAdsPlacementGroup(input, s.cookies),
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          adGroupId: result.groupId,
          result: result.extra,
          ...(categorySource !== undefined ? { categorySource } : {}),
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `Created placement group ${result.groupId ?? '(unknown id)'} for app ${appId} (ws ${workspaceId})\n`,
      );
      if (categorySource !== undefined) process.stdout.write(categoryLine());
      process.stdout.write(
        '상태: REGISTERING — 구글 광고 시스템 반영까지 최대 2시간 걸릴 수 있어요.\n',
      );
      process.stdout.write(
        '실서빙은 사업자 등록·정산 승인 후 시작돼요 (인앱광고 선행조건 — `aitcc workspace business-verification show`로 확인).\n',
      );
      process.stdout.write(
        `SDK: GoogleAdMob.loadAppsInTossAdMob({ options: { adGroupId: '${result.groupId ?? '<adGroupId>'}' } }) — 개발 중 테스트는 ait-ad-test-* ID를 쓰세요.\n`,
      );
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const placementGroupsCommand = defineCommand({
  meta: {
    name: 'placement-groups',
    description: 'Inspect and create in-app ad placement groups for a mini-app.',
  },
  subCommands: {
    ls: placementGroupsLsCommand,
    create: placementGroupsCreateCommand,
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
