import { defineCommand } from 'citty';
import {
  createIapProduct,
  fetchIapOrders,
  fetchIapProduct,
  fetchIapProducts,
  fetchIapRefunds,
  IAP_PRODUCT_TYPES,
  IAP_RENEWAL_CYCLES,
  type IapProductType,
  type IapRenewalCycle,
} from '../api/in-app-purchase.js';
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
//   app iap products ls [--app <id>] [--workspace <id>] [--page N]
//                       [--search <text>] [--type T1,T2] [--catalog-status S1,S2]:
//     { ok: true, workspaceId, appId, page, totalPage, currentPage,
//       products: [...] }                                              exit 0
//     { ok: false, reason: 'api-error', errorCode: '5002',
//       hint: '거래처 등록이 필요합니다 — `aitcc workspace partner`로 상태를 확인하세요.',
//       ... }                                                          exit 17
//       (5002 = partner/거래처 not registered yet — the CLI's standard
//       hintForErrorCode('5002') attaches this hint automatically, see
//       src/commands/_shared.ts. Confirmed live 2026-07-23, workspace 3095 /
//       app 31146.)
//     { ok: false, reason: 'missing-app-id' | 'invalid-id'
//                        | 'no-workspace-selected' | 'invalid-config' }  exit 2
//
//   app iap products show <productId> [--app <id>] [--workspace <id>]:
//     { ok: true, workspaceId, appId, productId, product: {...} }        exit 0
//     (same 5002/auth/network failure modes as `products ls`)
//
//   app iap products create --app <id> --type T --name N --description D
//                            --price P --icon-img-url U --min-deployment-id D
//                            [--renewal-cycle C] [--post-inspection-status S]
//                            [--dry-run] [--confirm] [--workspace <id>]:
//     { ok: true, dryRun: true, workspaceId, appId, payload }            exit 0  (--dry-run)
//     { ok: true, workspaceId, appId, productId, result: {...} }         exit 0  (real submit)
//     { ok: false, reason: 'not-confirmed', message }                   exit 2  (missing --confirm, no --dry-run)
//     { ok: false, reason: 'invalid-args', field, message }              exit 2  (client-side validation — see
//                                                                                  validateCreateIapProductArgs)
//     (same 5002/auth/network failure modes as the read commands)
//
//   ⚠️ `products create`'s request body is inferred from static analysis of
//   the console SPA's shared IAPProductEditor form component — never live-
//   confirmed. Per SECRET-HANDLING policy this command's POST call is never
//   exercised against the live console in this repo (dry-run only in CI/
//   dog-food); the real first call happens behind a maintainer-approved
//   `--confirm` invocation. See docs/api/in-app-purchase.md
//   "products create — inferred body shape".
//
//   app iap orders ls [--app <id>] [--workspace <id>] [--page N]:
//     { ok: true, workspaceId, appId, page, totalPage, currentPage,
//       orders: [...] }                                                 exit 0
//
//   app iap refunds ls [--app <id>] [--workspace <id>] [--page N]:
//     { ok: true, workspaceId, appId, page, totalPage, currentPage,
//       refunds: [...] }                                                exit 0
//
// Every subcommand inherits the standard auth/network/api failure modes
// (see `emitFailureFromError` in _shared.ts): session-expired exit 10,
// network-error exit 11, api-error exit 17.

function parseNonNegativeInt(raw: string, field: string): { value: number } | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { error: `--${field} must be a non-negative integer (got ${JSON.stringify(raw)})` };
  }
  return { value: n };
}

function splitCommaList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

// --- products ls ---

const productsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List in-app purchase products (catalog) for a mini-app.',
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
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    search: { type: 'string', description: 'Filter by product name/description search text.' },
    type: {
      type: 'string',
      description: `Filter by product type(s), comma-separated (${IAP_PRODUCT_TYPES.join('|')}).`,
    },
    'catalog-status': {
      type: 'string',
      description: 'Filter by catalog status(es), comma-separated (e.g. ACTIVE,INACTIVE).',
    },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const pageResult = parseNonNegativeInt(args.page, 'page');
    if ('error' in pageResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'page', message: pageResult.error });
      } else {
        process.stderr.write(`app iap products ls: ${pageResult.error}\n`);
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

    const types = splitCommaList(args.type);
    const catalogStatuses = splitCommaList(args['catalog-status']);

    try {
      const result = await withReauthRetry(args.json, session, (s) =>
        fetchIapProducts(
          {
            workspaceId,
            miniAppId: appId,
            page: pageResult.value,
            ...(args.search !== undefined ? { search: args.search } : {}),
            ...(types !== undefined ? { type: types as IapProductType[] } : {}),
            ...(catalogStatuses !== undefined ? { catalogStatus: catalogStatuses } : {}),
          },
          s.cookies,
        ),
      );

      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          page: pageResult.value,
          totalPage: result.totalPage,
          currentPage: result.currentPage,
          products: result.contents,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): page ${result.currentPage + 1}/${Math.max(result.totalPage, 1)}, ${result.contents.length} product(s)\n`,
      );
      if (result.contents.length === 0) {
        process.stdout.write('No products on this page.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const p of result.contents) {
        const id =
          typeof p.productId === 'string' || typeof p.productId === 'number' ? p.productId : '-';
        const name = typeof p.productName === 'string' ? p.productName : '-';
        const type = typeof p.productType === 'string' ? p.productType : '-';
        const status = typeof p.catalogStatus === 'string' ? p.catalogStatus : '-';
        process.stdout.write(`${id}\t${name}\t${type}\t${status}\n`);
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

// --- products show ---

const productsShowCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show a single in-app purchase product by productId.',
  },
  args: {
    productId: {
      type: 'positional',
      description: 'Product ID (from `app iap products ls`).',
      required: true,
    },
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
    const productId = typeof args.productId === 'string' ? args.productId.trim() : '';
    if (productId.length === 0) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'missing-product-id',
          message: 'productId positional is required',
        });
      } else {
        process.stderr.write('app iap products show: productId is required\n');
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

    try {
      const product = await withReauthRetry(args.json, session, (s) =>
        fetchIapProduct({ workspaceId, miniAppId: appId, productId }, s.cookies),
      );
      if (args.json) {
        emitJson({ ok: true, workspaceId, appId, productId, product });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(`App ${appId} (ws ${workspaceId}): product ${productId}\n`);
      for (const [k, v] of Object.entries(product)) {
        const rendered =
          v === null
            ? 'null'
            : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
              ? String(v)
              : JSON.stringify(v);
        process.stdout.write(`  ${k}: ${rendered}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

// --- products create ---
//
// Client-side validation mirrors the console SPA's IAPProductEditor form
// rules verbatim (see src/api/in-app-purchase.ts module comment for the
// source trace). Exported as a pure function so it's testable without a
// citty invocation, matching `validateAgreeArgs` in workspace.ts.

export interface CreateIapProductArgsInput {
  readonly type: string | undefined;
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly price: string | undefined;
  readonly iconImgUrl: string | undefined;
  readonly minDeploymentId: string | undefined;
  readonly postInspectionStatus: string | undefined;
  readonly renewalCycle: string | undefined;
}

export interface ValidatedCreateIapProductArgs {
  readonly type: IapProductType;
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly iconImgUrl: string;
  readonly minDeploymentId: number;
  readonly postInspectionStatus: 'ACTIVE' | 'INACTIVE';
  readonly renewalCycle?: IapRenewalCycle;
}

export type CreateIapProductValidation =
  | { readonly ok: true; readonly value: ValidatedCreateIapProductArgs }
  | { readonly ok: false; readonly field: string; readonly message: string };

const IAP_POST_INSPECTION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

// Field-level rules traced from IAPProductEditor.BQeOKeLb.js's react-hook-form
// `rules` (see docs/api/in-app-purchase.md for the exact source lines):
//   name <=30 chars, description <=45 chars, price 400..1_400_000 KRW,
//   renewalCycle required iff type === 'SUBSCRIPTION'.
export function validateCreateIapProductArgs(
  input: CreateIapProductArgsInput,
): CreateIapProductValidation {
  const type = input.type;
  if (type === undefined || !(IAP_PRODUCT_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      field: 'type',
      message: `--type must be one of ${IAP_PRODUCT_TYPES.join('|')} (got ${JSON.stringify(type)})`,
    };
  }

  const name = input.name;
  if (name === undefined || name.length === 0) {
    return { ok: false, field: 'name', message: '--name is required.' };
  }
  if (name.length > 30) {
    return { ok: false, field: 'name', message: '--name must be 30 characters or fewer.' };
  }

  const description = input.description;
  if (description === undefined || description.length === 0) {
    return { ok: false, field: 'description', message: '--description is required.' };
  }
  if (description.length > 45) {
    return {
      ok: false,
      field: 'description',
      message: '--description must be 45 characters or fewer.',
    };
  }

  if (input.price === undefined) {
    return { ok: false, field: 'price', message: '--price is required.' };
  }
  const price = Number(input.price);
  if (!Number.isFinite(price) || !Number.isInteger(price)) {
    return { ok: false, field: 'price', message: '--price must be an integer.' };
  }
  if (price < 400 || price > 1_400_000) {
    return {
      ok: false,
      field: 'price',
      message: '--price must be between 400 and 1,400,000 (KRW).',
    };
  }

  const iconImgUrl = input.iconImgUrl;
  if (iconImgUrl === undefined || iconImgUrl.length === 0) {
    return { ok: false, field: 'icon-img-url', message: '--icon-img-url is required.' };
  }

  if (input.minDeploymentId === undefined) {
    return { ok: false, field: 'min-deployment-id', message: '--min-deployment-id is required.' };
  }
  const minDeploymentId = Number(input.minDeploymentId);
  if (
    !Number.isFinite(minDeploymentId) ||
    !Number.isInteger(minDeploymentId) ||
    minDeploymentId <= 0
  ) {
    return {
      ok: false,
      field: 'min-deployment-id',
      message: '--min-deployment-id must be a positive integer.',
    };
  }

  const postInspectionStatusRaw = input.postInspectionStatus ?? 'INACTIVE';
  if (!(IAP_POST_INSPECTION_STATUSES as readonly string[]).includes(postInspectionStatusRaw)) {
    return {
      ok: false,
      field: 'post-inspection-status',
      message: `--post-inspection-status must be one of ${IAP_POST_INSPECTION_STATUSES.join('|')}.`,
    };
  }

  const isSubscription = type === 'SUBSCRIPTION';
  if (isSubscription && input.renewalCycle === undefined) {
    return {
      ok: false,
      field: 'renewal-cycle',
      message: '--renewal-cycle is required when --type is SUBSCRIPTION.',
    };
  }
  if (
    input.renewalCycle !== undefined &&
    !(IAP_RENEWAL_CYCLES as readonly string[]).includes(input.renewalCycle)
  ) {
    return {
      ok: false,
      field: 'renewal-cycle',
      message: `--renewal-cycle must be one of ${IAP_RENEWAL_CYCLES.join('|')}.`,
    };
  }

  return {
    ok: true,
    value: {
      type: type as IapProductType,
      name,
      description,
      price,
      iconImgUrl,
      minDeploymentId,
      postInspectionStatus: postInspectionStatusRaw as 'ACTIVE' | 'INACTIVE',
      ...(isSubscription && input.renewalCycle !== undefined
        ? { renewalCycle: input.renewalCycle as IapRenewalCycle }
        : {}),
    },
  };
}

const productsCreateCommand = defineCommand({
  meta: {
    name: 'create',
    description:
      'Register a new in-app purchase product and submit it for inspection (⚠️ inferred body shape — see docs/api/in-app-purchase.md).',
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
    type: {
      type: 'string',
      description: `Product type (${IAP_PRODUCT_TYPES.join('|')}).`,
    },
    name: { type: 'string', description: 'Product name (<=30 chars).' },
    description: { type: 'string', description: 'Product description (<=45 chars).' },
    price: { type: 'string', description: 'Supply price in KRW (400..1,400,000).' },
    'icon-img-url': { type: 'string', description: 'Already-uploaded product icon image URL.' },
    'min-deployment-id': {
      type: 'string',
      description: 'Minimum bundle deploymentId this product requires.',
    },
    'post-inspection-status': {
      type: 'string',
      description: 'ACTIVE (expose immediately) or INACTIVE (default) once inspection passes.',
      default: 'INACTIVE',
    },
    'renewal-cycle': {
      type: 'string',
      description: `Required when --type SUBSCRIPTION (${IAP_RENEWAL_CYCLES.join('|')}).`,
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
    const validation = validateCreateIapProductArgs({
      type: args.type,
      name: args.name,
      description: args.description,
      price: args.price,
      iconImgUrl: args['icon-img-url'],
      minDeploymentId: args['min-deployment-id'],
      postInspectionStatus: args['post-inspection-status'],
      renewalCycle: args['renewal-cycle'],
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
        process.stderr.write(`app iap products create: ${validation.message}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    if (!args['dry-run'] && !args.confirm) {
      const message =
        'this registers a real in-app purchase product and submits it for inspection; ' +
        'pass --confirm to proceed, or --dry-run to preview the request body first.';
      if (args.json) {
        emitJson({ ok: false, reason: 'not-confirmed', message });
      } else {
        process.stderr.write(`app iap products create: ${message}\n`);
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

    const input = {
      workspaceId,
      miniAppId: appId,
      type: validation.value.type,
      name: validation.value.name,
      description: validation.value.description,
      price: validation.value.price,
      iconImgUrl: validation.value.iconImgUrl,
      minDeploymentId: validation.value.minDeploymentId,
      postInspectionStatus: validation.value.postInspectionStatus,
      ...(validation.value.renewalCycle !== undefined
        ? { renewalCycle: validation.value.renewalCycle }
        : {}),
    };

    if (args['dry-run']) {
      const payload = {
        type: input.type,
        name: input.name,
        description: input.description,
        price: input.price,
        iconImgUrl: input.iconImgUrl,
        minDeploymentId: input.minDeploymentId,
        postInspectionStatus: input.postInspectionStatus,
        discountPolicies: [] as const,
        currency: 'KRW',
        defaultLocale: 'KO_KR',
        ...(input.renewalCycle !== undefined ? { renewalCycle: input.renewalCycle } : {}),
      };
      if (args.json) {
        emitJson({ ok: true, dryRun: true, workspaceId, appId, payload });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write('[dry-run] Would POST to ');
      process.stdout.write(
        `.../workspaces/${workspaceId}/mini-app/${appId}/in-app-purchase/product/inspection\n`,
      );
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return exitAfterFlush(ExitCode.Ok);
    }

    // Real submit — never exercised against the live console in this repo
    // (see SECRET-HANDLING policy in CLAUDE.md / issue #220). Reachable only
    // with an explicit --confirm from a maintainer-approved invocation.
    try {
      const result = await withReauthRetry(args.json, session, (s) =>
        createIapProduct(input, s.cookies),
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          productId: result.productId,
          result: result.extra,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `Created product ${result.productId ?? '(unknown id)'} for app ${appId} (ws ${workspaceId})\n`,
      );
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const productsCommand = defineCommand({
  meta: {
    name: 'products',
    description: 'Inspect and register in-app purchase products for a mini-app.',
  },
  subCommands: {
    ls: productsLsCommand,
    show: productsShowCommand,
    create: productsCreateCommand,
  },
});

// --- orders ---

const ordersLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List in-app purchase orders for a mini-app.',
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
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const pageResult = parseNonNegativeInt(args.page, 'page');
    if ('error' in pageResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'page', message: pageResult.error });
      } else {
        process.stderr.write(`app iap orders ls: ${pageResult.error}\n`);
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

    try {
      const result = await withReauthRetry(args.json, session, (s) =>
        fetchIapOrders({ workspaceId, miniAppId: appId, page: pageResult.value }, s.cookies),
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          page: pageResult.value,
          totalPage: result.totalPage,
          currentPage: result.currentPage,
          orders: result.contents,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): page ${result.currentPage + 1}/${Math.max(result.totalPage, 1)}, ${result.contents.length} order(s)\n`,
      );
      for (const o of result.contents) {
        process.stdout.write(`${JSON.stringify(o)}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const ordersCommand = defineCommand({
  meta: {
    name: 'orders',
    description: 'Inspect in-app purchase orders for a mini-app.',
  },
  subCommands: {
    ls: ordersLsCommand,
  },
});

// --- refunds ---

const refundsLsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List in-app purchase refunds for a mini-app.',
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
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const pageResult = parseNonNegativeInt(args.page, 'page');
    if ('error' in pageResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'page', message: pageResult.error });
      } else {
        process.stderr.write(`app iap refunds ls: ${pageResult.error}\n`);
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

    try {
      const result = await withReauthRetry(args.json, session, (s) =>
        fetchIapRefunds({ workspaceId, miniAppId: appId, page: pageResult.value }, s.cookies),
      );
      if (args.json) {
        emitJson({
          ok: true,
          workspaceId,
          appId,
          page: pageResult.value,
          totalPage: result.totalPage,
          currentPage: result.currentPage,
          refunds: result.contents,
        });
        return exitAfterFlush(ExitCode.Ok);
      }
      process.stdout.write(
        `App ${appId} (ws ${workspaceId}): page ${result.currentPage + 1}/${Math.max(result.totalPage, 1)}, ${result.contents.length} refund(s)\n`,
      );
      for (const r of result.contents) {
        process.stdout.write(`${JSON.stringify(r)}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const refundsCommand = defineCommand({
  meta: {
    name: 'refunds',
    description: 'Inspect in-app purchase refunds for a mini-app.',
  },
  subCommands: {
    ls: refundsLsCommand,
  },
});

export const iapCommand = defineCommand({
  meta: {
    name: 'iap',
    description: 'Inspect in-app purchase products, orders, and refunds for a mini-app.',
  },
  subCommands: {
    products: productsCommand,
    orders: ordersCommand,
    refunds: refundsCommand,
  },
});
