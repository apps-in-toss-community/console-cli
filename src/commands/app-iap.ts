import { defineCommand } from 'citty';
import {
  createIapProduct,
  fetchIapOrders,
  fetchIapProduct,
  fetchIapProducts,
  fetchIapRefunds,
  IAP_DISCOUNT_TYPES,
  IAP_FREE_TRIAL_PERIODS,
  IAP_PRODUCT_TYPES,
  IAP_RENEWAL_CYCLES,
  type IapDiscountPolicyInput,
  type IapDiscountType,
  type IapFreeTrialPeriod,
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
//                            --price P --icon U --min-deployment D
//                            [--renewal-cycle C] [--expose]
//                            [--discount SPEC[;SPEC...]]
//                            [--dry-run] [--confirm] [--workspace <id>]:
//     { ok: true, dryRun: true, workspaceId, appId, payload,
//       warnings?: string[] }                                           exit 0  (--dry-run)
//     { ok: true, workspaceId, appId, productId, result: {...} }         exit 0  (real submit)
//     { ok: false, reason: 'not-confirmed', message }                   exit 2  (missing --confirm, no --dry-run)
//     { ok: false, reason: 'invalid-args', field, message }              exit 2  (client-side validation — see
//                                                                                  validateCreateIapProductArgs)
//     (same 5001/5002/auth/network failure modes as the read commands —
//     5001 = IAP 위탁매매 약관 미동의, surfaced by a read-only `catalogs`
//     preflight probe BEFORE the mutating POST fires; see below)
//
//   create = 심사 제출(review submission) — a STRONGER mutation gate than
//   `app ads placement-groups create`: the single POST both registers the
//   product AND enqueues it for console review. Body shape ✅ confirmed via
//   console SPA serialization-logic measurement (issue #232, 2026-07-25,
//   high confidence) — per SECRET-HANDLING policy still never live-executed
//   against the real console in this repo (dry-run + read-only preflight
//   only in CI/dog-food); the real first call happens behind a
//   maintainer-approved `--confirm` invocation, and is likely to be blocked
//   until two server-side preconditions this CLI cannot fully verify
//   client-side yet are met: (1) `--min-deployment` must reference an
//   APPROVED-status deployment (dog-food app 31146 currently has zero),
//   (2) the workspace must have agreed the IAP 위탁매매 약관 (errorCode
//   5001). Unlike ads placement-group create, pre-approval create is
//   expected to be blocked, not just untested. See
//   docs/api/in-app-purchase.md "products create — confirmed body shape".
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
  readonly icon: string | undefined;
  readonly minDeployment: string | undefined;
  readonly expose: boolean;
  readonly renewalCycle: string | undefined;
  readonly discount: string | undefined;
}

export interface ValidatedCreateIapProductArgs {
  readonly type: IapProductType;
  readonly name: string;
  readonly description: string;
  /** Final price sent to the server, after snapping to the nearest 10 KRW. */
  readonly price: number;
  /** Raw --price value before snapping — used to build the "snapped" warning. */
  readonly requestedPrice: number;
  readonly iconImgUrl: string;
  readonly minDeploymentId: number;
  readonly postInspectionStatus: 'ACTIVE' | 'INACTIVE';
  readonly renewalCycle?: IapRenewalCycle;
  /** Always [] for non-SUBSCRIPTION types (server contract, see createIapProduct). */
  readonly discountPolicies: readonly IapDiscountPolicyInput[];
}

export type CreateIapProductValidation =
  | { readonly ok: true; readonly value: ValidatedCreateIapProductArgs }
  | { readonly ok: false; readonly field: string; readonly message: string };

// Parse a `--discount` spec into IapDiscountPolicyInput entries.
//
// citty (this repo's pinned 0.2.2) has no array/`multiple` arg type — it
// wraps node:util's `parseArgs` with `strict:false` and never sets
// `multiple: true` on any option, so repeating a string flag just makes the
// LAST occurrence win (verified directly against node:util.parseArgs — see
// PR discussion). A true repeatable `--discount X --discount Y` isn't
// achievable without hand-rolling argv parsing, which no command in this
// repo does. Since issue #232 explicitly marks SUBSCRIPTION discount-policy
// bounds as low-priority/server-unverified, this is a deliberately small
// substitute: a single `--discount` flag holding `;`-separated entries
// (mirroring the `splitCommaList` convention `products ls` already uses for
// `--type`/`--catalog-status`, just with `;` since each entry itself needs
// internal `,`-separated key=value pairs):
//   --discount "type=FREE_TRIAL,period=ONE_WEEK"
//   --discount "type=FREE_TRIAL,period=ONE_WEEK;type=RETURNING,durationMonths=1,discountedNetPrice=2000"
export function parseDiscountPoliciesSpec(
  raw: string,
):
  | { readonly ok: true; readonly value: IapDiscountPolicyInput[] }
  | { readonly ok: false; readonly message: string } {
  const entries = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) {
    return { ok: false, message: '--discount was given but contained no entries.' };
  }

  const policies: IapDiscountPolicyInput[] = [];
  const seenTypes = new Set<IapDiscountType>();

  for (const entry of entries) {
    const fields = new Map<string, string>();
    for (const pair of entry.split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        return {
          ok: false,
          message: `--discount entry ${JSON.stringify(entry)} must be comma-separated key=value pairs.`,
        };
      }
      fields.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    const discountType = fields.get('type');
    if (
      discountType === undefined ||
      !(IAP_DISCOUNT_TYPES as readonly string[]).includes(discountType)
    ) {
      return {
        ok: false,
        message: `--discount entry ${JSON.stringify(entry)}: type must be one of ${IAP_DISCOUNT_TYPES.join('|')}.`,
      };
    }
    if (seenTypes.has(discountType as IapDiscountType)) {
      return {
        ok: false,
        message: `--discount has more than one entry for type=${discountType} — the console only allows one policy per type.`,
      };
    }
    seenTypes.add(discountType as IapDiscountType);

    if (discountType === 'FREE_TRIAL') {
      const period = fields.get('period');
      if (period === undefined || !(IAP_FREE_TRIAL_PERIODS as readonly string[]).includes(period)) {
        return {
          ok: false,
          message: `--discount entry ${JSON.stringify(entry)}: FREE_TRIAL requires period=${IAP_FREE_TRIAL_PERIODS.join('|')}.`,
        };
      }
      const extraKeys = [...fields.keys()].filter((k) => k !== 'type' && k !== 'period');
      if (extraKeys.length > 0) {
        return {
          ok: false,
          message: `--discount entry ${JSON.stringify(entry)}: FREE_TRIAL only accepts type/period (got extra: ${extraKeys.join(',')}).`,
        };
      }
      policies.push({ discountType: 'FREE_TRIAL', period: period as IapFreeTrialPeriod });
      continue;
    }

    // NEW_SUBSCRIPTION / RETURNING share the same durationMonths+discountedNetPrice shape.
    const durationMonthsRaw = fields.get('durationMonths');
    const discountedNetPriceRaw = fields.get('discountedNetPrice');
    if (durationMonthsRaw === undefined || discountedNetPriceRaw === undefined) {
      return {
        ok: false,
        message: `--discount entry ${JSON.stringify(entry)}: ${discountType} requires durationMonths and discountedNetPrice.`,
      };
    }
    const durationMonths = Number(durationMonthsRaw);
    if (
      !Number.isFinite(durationMonths) ||
      !Number.isInteger(durationMonths) ||
      durationMonths <= 0 ||
      durationMonths > 12
    ) {
      return {
        ok: false,
        message: `--discount entry ${JSON.stringify(entry)}: durationMonths must be an integer between 1 and 12.`,
      };
    }
    const discountedNetPrice = Number(discountedNetPriceRaw);
    if (
      !Number.isFinite(discountedNetPrice) ||
      !Number.isInteger(discountedNetPrice) ||
      discountedNetPrice <= 0
    ) {
      return {
        ok: false,
        message: `--discount entry ${JSON.stringify(entry)}: discountedNetPrice must be a positive integer.`,
      };
    }
    const extraKeys = [...fields.keys()].filter(
      (k) => k !== 'type' && k !== 'durationMonths' && k !== 'discountedNetPrice',
    );
    if (extraKeys.length > 0) {
      return {
        ok: false,
        message: `--discount entry ${JSON.stringify(entry)}: ${discountType} only accepts type/durationMonths/discountedNetPrice (got extra: ${extraKeys.join(',')}).`,
      };
    }
    policies.push({
      discountType: discountType as IapDiscountType,
      durationMonths,
      discountedNetPrice,
    });
  }

  return { ok: true, value: policies };
}

// Field-level rules traced from IAPProductEditor.BQeOKeLb.js's react-hook-form
// `rules` (see docs/api/in-app-purchase.md "products create — confirmed body
// shape" for the exact source lines): name <=30 chars, description <=45
// chars, price 400..1_400_000 KRW snapped to the nearest 10 (console UI
// behavior — mirrored here client-side rather than rejecting non-10-KRW
// input outright), renewalCycle/discountPolicies required+meaningful iff
// type === 'SUBSCRIPTION' and REJECTED (not silently dropped) otherwise —
// issue #232 groups both under "type-conditional fields... fail fast".
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
  const isSubscription = type === 'SUBSCRIPTION';

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
  const requestedPrice = Number(input.price);
  if (!Number.isFinite(requestedPrice) || !Number.isInteger(requestedPrice)) {
    return { ok: false, field: 'price', message: '--price must be an integer.' };
  }
  const price = Math.round(requestedPrice / 10) * 10;
  if (price < 400 || price > 1_400_000) {
    return {
      ok: false,
      field: 'price',
      message:
        requestedPrice === price
          ? '--price must be between 400 and 1,400,000 (KRW).'
          : `--price must be between 400 and 1,400,000 (KRW) — ${requestedPrice} snaps to the nearest 10 (${price}), which is still out of range.`,
    };
  }

  const iconImgUrl = input.icon;
  if (iconImgUrl === undefined || iconImgUrl.length === 0) {
    return { ok: false, field: 'icon', message: '--icon is required.' };
  }

  // --min-deployment: the server requires this to reference an
  // APPROVED-status deployment (issue #232 hard precondition). Wiring an
  // automatic APPROVED-status lookup here would mean guessing at
  // `fetchBundles`'s opaque `deployStatus` filter values and response
  // field names against a deployment that's never actually been observed
  // populated (dog-food app 31146 currently has zero APPROVED deployments)
  // — left as a documented follow-up rather than shipping unverified
  // guesses. This validates presence/shape only; an unapproved
  // deploymentId will fail server-side, not here.
  if (input.minDeployment === undefined) {
    return { ok: false, field: 'min-deployment', message: '--min-deployment is required.' };
  }
  const minDeploymentId = Number(input.minDeployment);
  if (
    !Number.isFinite(minDeploymentId) ||
    !Number.isInteger(minDeploymentId) ||
    minDeploymentId <= 0
  ) {
    return {
      ok: false,
      field: 'min-deployment',
      message: '--min-deployment must be a positive integer deploymentId.',
    };
  }

  if (isSubscription && input.renewalCycle === undefined) {
    return {
      ok: false,
      field: 'renewal-cycle',
      message: '--renewal-cycle is required when --type is SUBSCRIPTION.',
    };
  }
  if (!isSubscription && input.renewalCycle !== undefined) {
    return {
      ok: false,
      field: 'renewal-cycle',
      message: '--renewal-cycle is only valid when --type is SUBSCRIPTION.',
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

  if (!isSubscription && input.discount !== undefined) {
    return {
      ok: false,
      field: 'discount',
      message: '--discount is only valid when --type is SUBSCRIPTION.',
    };
  }
  let discountPolicies: readonly IapDiscountPolicyInput[] = [];
  if (isSubscription && input.discount !== undefined) {
    const parsed = parseDiscountPoliciesSpec(input.discount);
    if (!parsed.ok) {
      return { ok: false, field: 'discount', message: parsed.message };
    }
    discountPolicies = parsed.value;
  }

  return {
    ok: true,
    value: {
      type: type as IapProductType,
      name,
      description,
      price,
      requestedPrice,
      iconImgUrl,
      minDeploymentId,
      postInspectionStatus: input.expose ? 'ACTIVE' : 'INACTIVE',
      ...(isSubscription && input.renewalCycle !== undefined
        ? { renewalCycle: input.renewalCycle as IapRenewalCycle }
        : {}),
      discountPolicies,
    },
  };
}

const productsCreateCommand = defineCommand({
  meta: {
    name: 'create',
    description:
      'Register a new in-app purchase product and submit it for review (심사 제출) in one step — a ' +
      'stronger mutation gate than `app ads placement-groups create` (see docs/api/in-app-purchase.md).',
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
    price: {
      type: 'string',
      description:
        'Supply price in KRW (400..1,400,000). Snapped to the nearest multiple of 10 with a warning if the ' +
        'given value is not already a multiple of 10.',
    },
    icon: {
      type: 'string',
      description:
        'Already-uploaded product icon image URL (source image is validated server-side at 1024x1024). ' +
        'File-path upload is out of scope here — the upload endpoint is unconfirmed (follow-up issue); pass ' +
        'a URL already uploaded through the console.',
    },
    'min-deployment': {
      type: 'string',
      description:
        'Minimum bundle deploymentId this product requires. Server-side hard precondition: must reference ' +
        'an APPROVED-status deployment. This CLI validates it is a positive integer but does NOT verify ' +
        'approval status client-side yet (follow-up — see the validateCreateIapProductArgs comment); an ' +
        'unapproved deploymentId will likely be rejected server-side.',
    },
    expose: {
      type: 'boolean',
      description:
        'Expose immediately once review passes (postInspectionStatus: ACTIVE). Default: INACTIVE — review ' +
        'approval alone does not make the product visible; it stays hidden until activated.',
      default: false,
    },
    'renewal-cycle': {
      type: 'string',
      description: `Required when --type is SUBSCRIPTION, rejected for any other type (${IAP_RENEWAL_CYCLES.join('|')}).`,
    },
    discount: {
      type: 'string',
      description:
        'SUBSCRIPTION-only discount policies (rejected for other types). `;`-separated entries, each a ' +
        `comma-separated key=value spec: FREE_TRIAL needs period=${IAP_FREE_TRIAL_PERIODS.join('|')}; ` +
        'NEW_SUBSCRIPTION/RETURNING need durationMonths (<=12) and discountedNetPrice. Example: ' +
        '"type=FREE_TRIAL,period=ONE_WEEK;type=RETURNING,durationMonths=1,discountedNetPrice=2000".',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'Validate and print the planned request body without calling the console API at all (no preflight ' +
        'probe, no POST).',
      default: false,
    },
    confirm: {
      type: 'boolean',
      description:
        'Required to actually submit (without --dry-run) — without it, the command refuses. This registers ' +
        'the product AND submits it for review in the same call.',
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
      icon: args.icon,
      minDeployment: args['min-deployment'],
      expose: args.expose,
      renewalCycle: args['renewal-cycle'],
      discount: args.discount,
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
        'this registers a real in-app purchase product AND submits it for review (심사 제출) in one call — ' +
        'a stronger gate than ad placement-group create. Pass --confirm to proceed, or --dry-run to preview ' +
        'the request body first.';
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

    const warnings: string[] = [];
    if (validation.value.price !== validation.value.requestedPrice) {
      warnings.push(
        `--price ${validation.value.requestedPrice} is not a multiple of 10 — snapped to ${validation.value.price}.`,
      );
    }
    if (!args.json) {
      for (const w of warnings) process.stderr.write(`[warn] ${w}\n`);
    }

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
      discountPolicies: validation.value.discountPolicies,
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
        discountPolicies: input.discountPolicies,
        currency: 'KRW',
        defaultLocale: 'KO_KR',
        ...(input.renewalCycle !== undefined ? { renewalCycle: input.renewalCycle } : {}),
      };
      if (args.json) {
        emitJson({
          ok: true,
          dryRun: true,
          workspaceId,
          appId,
          payload,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
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
    // (see SECRET-HANDLING policy in CLAUDE.md / issue #220 / #232).
    // Reachable only with an explicit --confirm from a maintainer-approved
    // invocation.
    //
    // Preflight (read-only): probe `catalogs` BEFORE the mutating POST so a
    // domain-level gate — most notably errorCode 5001 (IAP 위탁매매 약관
    // 미동의, see hintForErrorCode in _shared.ts) — surfaces as a clean
    // precondition failure instead of only showing up after the product has
    // already been submitted for review.
    try {
      await withReauthRetry(args.json, session, (s) =>
        fetchIapProducts({ workspaceId, miniAppId: appId, page: 0 }, s.cookies),
      );
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }

    // If the server returns a "review already in progress" lock (untested
    // for IAP — the mini-app register command's analog is errorCode 4046,
    // see docs/api/mini-apps.md "REVIEW lock"), the fix is to wait for the
    // operations team to resolve the existing review, NOT to mint a new
    // product to route around the lock (same anti-pattern CLAUDE.md §3
    // calls out for mini-app registration).
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
        `Created IAP product ${result.productId ?? '(unknown id)'} for app ${appId} (ws ${workspaceId}) — submitted for review.\n`,
      );
      process.stdout.write(
        '상태: 심사 제출됨 — 노출은 심사 APPROVED 후에만 가능해요 (--expose 여부와 무관하게 심사 통과가 먼저 필요).\n',
      );
      process.stdout.write(
        `SDK: IAP.getProductItemList() → createOneTimePurchaseOrder({ options: { sku: '${result.productId ?? '<productId>'}' } }) — ` +
          '샌드박스는 노출 ON(--expose로 설정한) 상품만 반환해요.\n',
      );
      process.stdout.write('진행 상태 재확인: `aitcc app iap products show <productId>`\n');
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
