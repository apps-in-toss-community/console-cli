# @ait-co/console-cli

## 0.1.16

### Patch Changes

- 2ea3e26: fix(app deploy): accept both AIT header format and legacy zip bundles

  `@apps-in-toss/web-framework`'s build toolchain switched to an `AIT`
  wrapper format (`AITBUNDL` magic + big-endian header + protobuf
  `AITBundle` + inner zip blob); legacy toolchains still emit plain zips.
  The console's uploader branches on the first 8 bytes and handles both,
  but `aitcc app deploy` was parsing the file as a zip unconditionally
  and would reject modern bundles with `invalid-zip`.

  `src/config/ait-bundle.ts` now:

  - detects the format via magic bytes (`AITBUNDL` → AIT, `PK\x03\x04` → zip),
  - reads `deploymentId` directly from the AIT protobuf header for AIT
    files (via a minimal inline wire-format decoder — no `protobufjs` /
    `long` runtime dependency), and
  - keeps the existing `fflate` `app.json` extraction path for legacy zips.

  New `AitBundleErrorReason` values: `unrecognized-format` (neither magic
  matches) and `invalid-ait` (truncated or malformed AIT header).
  `readAitBundle` / `deploymentIdFromBundleBytes` now also surface the
  detected `format: 'ait' | 'zip'`, and `aitcc app deploy --json`
  includes `bundleFormat` in both dry-run and success output so
  `agent-plugin` can tell which toolchain produced the bundle without
  re-reading the file.

## 0.1.15

### Patch Changes

- b61a117: docs: record that the console exposes no runtime-log endpoint

  Full static analysis of `bootstrap.N0Zaulo0.js` (184 endpoints, 55 async
  chunks, complete mini-app route table) finds zero runtime-log surface —
  the three `/log/*` endpoints in the bundle are all about the **custom
  analytics event catalog** (keyed on `logName`), same thing `aitcc app
events` already wraps. `aitcc app logs` is deferred until a backend log
  endpoint actually exists; see `.playwright-mcp/LOGS-NOT-FOUND.md` for
  the full procedure so the next attempt can pick up where this one left
  off.

- 12a6036: docs: close out root-level `aitcc status` from TODO

  TODO.md originally had `aitcc status [appId]` as a planned root-level
  command alongside `app status`. Now that `aitcc app status <id>` is
  implemented with `--watch` / `--json` / `--workspace` and fuses the
  client-derived review state with the server's `serviceStatus`, the
  root-level alias isn't worth the surface area: it would either
  duplicate `app status` (saving 4 characters) or require a
  "selected-app" mode-state the session deliberately doesn't keep.

  Marks the item complete in TODO and adds a "왜 top-level `aitcc
status`가 없는가" rationale note in CLAUDE.md so future sweeps don't
  re-open this question. No code changes.

- 019a5fc: feat(app): bundle upload/review/release/test-push commands

  Adds the full write-path for shipping bundles to mini-apps:

  - `aitcc app bundles upload <id> <path> --deployment-id <uuid> [--memo]` —
    3-step deploy dance observed in the console UI:
    `POST /deployments/initialize {deploymentId}` →
    `PUT <uploadUrl>` (S3 presigned, Content-Type `application/zip`) →
    `POST /deployments/complete {deploymentId}` →
    optional `POST /bundles/memos {deploymentId, memo}`.
    Refuses if initialize returns `reviewStatus !== PREPARE` (matches the
    console's "이미 존재하는 버전이에요." guard). `--dry-run` shows what
    would be sent without touching the server.
  - `aitcc app bundles review <id> --deployment-id <uuid> --release-notes <text>` —
    `POST /bundles/reviews`. `--withdraw` sends
    `POST /bundles/reviews/withdrawal` instead.
  - `aitcc app bundles release <id> --deployment-id <uuid> --confirm` —
    `POST /bundles/release`. Guarded behind `--confirm` because the bundle
    goes live to end users.
  - `aitcc app bundles test-push <id> --deployment-id <uuid>` —
    `POST /bundles/test-push`.
  - `aitcc app bundles test-links <id>` — `GET /bundles/test-links`.

  `deploymentId` is the `_metadata.deploymentId` written into the `.ait`
  bundle's `app.json` by the build toolchain; for now the CLI takes it as
  an explicit flag. Zip cracking is a follow-up.

- cd34b41: feat(app): deploy one-shot wrapper (upload + review + release)

  Adds `aitcc app deploy <path> --app <id>` — a convenience wrapper that
  chains the bundle pipeline. Before this, shipping a bundle meant
  running three separate commands (`bundles upload` → `bundles review` →
  `bundles release`) while carrying the same `--deployment-id` by hand.

  The wrapper:

  - Auto-detects `_metadata.deploymentId` from the `.ait` by cracking the
    zip (via `fflate`) when `--deployment-id` is omitted — users no
    longer need to open the bundle themselves.
  - Always performs the 3-step upload (initialize → PUT → complete, +
    optional memo).
  - `--request-review --release-notes <text>` additionally submits the
    bundle for review.
  - `--release --confirm` additionally publishes an APPROVED bundle.
    (Typically a second `app deploy` run, since a freshly uploaded
    bundle is not yet APPROVED.)
  - `--dry-run` prints the planned pipeline without touching the server.
  - Partial-success `--json` reports `uploaded`/`reviewed`/`released`
    flags so `agent-plugin` can resume at the failing step on retry
    without re-uploading.

  Internal additions:

  - New runtime dependency: `fflate` (~8 KB, zero deps) for zip reads.
  - New module: `src/config/ait-bundle.ts` — pure bundle reader, unit-
    tested with synthesized zips (`src/config/ait-bundle.test.ts`).
  - New command module: `src/commands/app-deploy.ts`, exporting
    `runDeploy` as the testable seam (same pattern as `runRegister`).

## 0.1.14

### Patch Changes

- a4960f8: Add `aitcc completion <bash|zsh|fish>` to emit shell completion scripts.

  Static, shallow design: top-level commands and one level of subcommands (e.g. `aitcc workspace <TAB>` → `ls partner segments show terms use`). Deeper (3rd+ word) completions fall through to the shell's default filename completion, which is fine for positional app/workspace IDs.

  Install one-liners per shell:

  - bash: `source <(aitcc completion bash)` in `~/.bashrc`
  - zsh: `aitcc completion zsh > "${fpath[1]}/_aitcc"`
  - fish: `aitcc completion fish > ~/.config/fish/completions/aitcc.fish`

  `install.sh` now detects `$SHELL` and prints the appropriate one-liner after install. User rc files are not modified automatically.

  `--json` emits `{ok: false, reason: 'invalid-shell', allowed: [...], message}` on bad input so agent-plugin can capability-probe.

## 0.1.13

### Patch Changes

- 6a3fa2c: `app show --view current` now prints a stderr hint when the current view is empty but a draft exists — the most common "why is this empty?" case for unreviewed apps. The JSON contract is unchanged (`miniApp: null` is still returned); only stderr diagnostics improve.
- 89489e7: `app status` now surfaces the server's `serviceStatus` (PREPARE / RUNNING / …) alongside the client-derived review state, in both JSON and plain text. Also exposes `shutdownCandidateStatus` and `scheduledShutdownAt` from the same `/review-status` endpoint, so operators can see whether an approved app is actually live — or scheduled for shutdown — without making a second `app service-status` call.

  `--watch` mode re-prints on either review-state OR service-status changes; the service-status call is best-effort, so a transient failure still lets the derived review state through.

- 8113b7b: `app register` now prints a hint pointing at `aitcc app categories --selectable` whenever the manifest validator rejects `categoryIds`. The hint is plain-text only (stderr); the `--json` payload is unchanged so agent-plugin's parser stays stable.

## 0.1.12

### Patch Changes

- 2769f76: Add `aitcc app categories` to list the impression category tree used by `app register`'s `categoryIds` field.

  Endpoint: `GET /impression/category-list` — workspace-independent lookup. Returns three groups (금융 / 게임 / 생활), each with a category list and optional sub-categories. `--selectable` collapses the output to only the entries callers may actually reference (`isSelectable: true`). Useful when authoring or validating an `aitcc.app.yaml` manifest.

- c663d07: Add `aitcc app events ls <id>` to list the custom event catalogs (log search) for a mini-app — the 이벤트 menu in the console.

  Endpoint: `POST /mini-app/:id/log/catalogs/search` with body `{isRefresh, pageNumber, pageSize, search}`. Response: `{results, cacheTime, paging: {pageNumber, pageSize, hasNext, totalCount, totalPages}}`. PREPARE-state apps return an empty `results` with a server-cache timestamp — same pattern as `conversion-metrics`.

  Flags: `--page <n>`, `--size <n>`, `--search <text>`, `--refresh` (bypass server cache). Per-event record shape is passed through opaquely until a populated response is observed.

- de2bafc: Add `aitcc app messages ls <id>` to list smart-message campaigns (the successor to the legacy 푸시알림 menu, now surfaced as 스마트 발송).

  Endpoint: `POST /mini-app/:id/smart-message/campaigns?page=&size=` with a JSON body `{sort, search, filters}`. The unusual POST-for-list shape is what the console UI sends; the CLI mirrors it so the request is indistinguishable from XHR. Response: `{items, paging: {pageNumber, pageSize, hasNext, totalCount}}`.

  Flags: `--page <n>`, `--size <n>`, `--search <text>`. Per-campaign record shape is passed through opaquely until a populated response is observed.

- df8d355: Add `aitcc app service-status <id>` to show the server-authoritative runtime state of a mini-app.

  Endpoint: `GET /mini-app/:id/review-status` (singular `mini-app` — distinct from the workspace-level `mini-apps/review-status` plural endpoint that `app ls` uses). Response: `{serviceStatus, shutdownCandidateStatus, scheduledShutdownAt}`.

  This complements `app status` (which derives state client-side from `/with-draft`) by surfacing the server's canonical `serviceStatus` string — useful for detecting shutdown schedules or when the /with-draft envelope is ambiguous.

- 0a55a3e: Add `aitcc app templates ls <id>` to list the smart-message composer templates for a mini-app (the template picker inside 스마트 발송).

  Endpoint: `GET /mini-app/:id/templates/search?page&size&contentReachType&isSmartMessage`. Response: `{page: {totalPageCount}, groupSendContextSimpleView}` — the internal `groupSendContextSimpleView` key is renamed to `templates` at the CLI layer so the output stays readable.

  Flags: `--page`, `--size`, `--content-reach-type FUNCTIONAL|MARKETING`, `--smart-message true|false`. Per-template record shape is passed through opaquely until a populated response is observed.

- c9c9143: Add `aitcc me terms` to show the console-level terms of agreement for the signed-in account.

  Endpoint: `GET /console-user-terms/me`. This is user-scoped (sibling of `workspace terms`, which is workspace-scoped). On a fresh account the result is a single `앱인토스 콘솔 이용약관` entry with `isAgreed: true` — anyone who has logged in at all has accepted it.

  Introduces a new top-level `me` command group for future account-level settings (profile, notification preferences, etc.).

- e10c47c: Add `aitcc workspace partner` to show the partner (billing/payout) registration state of the selected workspace.

  Endpoint: `GET /workspaces/:wid/partner` — returns `{registered, approvalType, rejectMessage, partner}`. A fresh workspace reports `registered: false, approvalType: 'DRAFT', partner: null`; once the owner registers the billing entity the `partner` record is populated (passed through opaquely until a live example is observed).

  Flag: `--workspace <id>` to inspect a workspace other than the current selection.

- 952d89a: Add `aitcc workspace segments ls [--category <cat>] [--search <text>] [--page N] [--workspace <id>]` to list user segments defined in the workspace (the 세그먼트 menu).

  Endpoint: `GET /workspaces/:wid/segments/list?category&search&page` — workspace-scoped (not per mini-app). Response: `{contents, totalPage, currentPage}`. `--category` defaults to "생성된 세그먼트" (the UI's initial tab). Per-segment record shape is passed through opaquely until a populated response is observed.

- c51816a: Add `aitcc workspace terms [--type TYPE] [--workspace <id>]` to show the console terms-of-agreement buckets that gate workspace-level features.

  Endpoint: `GET /workspaces/:wid/console-workspace-terms/:type/skip-permission` — one call per bucket. Five types: `TOSS_LOGIN`, `BIZ_WORKSPACE`, `TOSS_PROMOTION_MONEY`, `IAA`, `IAP`. Default is to query every bucket in parallel; `--type <TYPE>` limits to a single one. Each entry is `{required, termsId, revisionId, title, contentsUrl, actionType, isAgreed, isOneTimeConsent}` — useful for checking which features are blocked by pending agreements before running commands that depend on them (e.g. `app share-rewards` needs `TOSS_PROMOTION_MONEY`, `app promotions` creation needs partner+promotion-money, etc.).

## 0.1.11

### Patch Changes

- 1196c3e: Add `aitcc app bundles ls <id>` and `aitcc app bundles deployed <id>` to inspect upload bundles.

  Endpoints:

  - `GET /workspaces/:wid/mini-app/:aid/bundles[?page=&tested=&deployStatus=]` — page-based pagination, `{contents, totalPage, currentPage}`
  - `GET /workspaces/:wid/mini-app/:aid/bundles/deployed` — returns the single currently-deployed bundle (or `null`)

  `bundles ls` flags: `--page N`, `--tested true|false`, `--deploy-status STR` (e.g. `DEPLOYED`), plus `--workspace`, `--json`. `bundles deployed` only takes `--workspace` and `--json`.

  These are the read half of the deploy surface; `aitcc deploy` (task #24) will write new bundles through a separate upload endpoint once observed. For now `app bundles ls` lets the CLI and agent-plugin see what's already there, and `app bundles deployed` answers "what version is live?" for a given app — the quickest way to confirm a deploy from the terminal.

- 265dfb0: Add `aitcc app certs ls <id>` to list mTLS certificates issued for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-app/:aid/certs` — a simple array. Empty `[]` is the common case (no certs provisioned); per-record shape is passed through opaquely until a populated response is observed.

  Scaffolded under a `certs` group so follow-ups (`certs create`, `certs revoke`) land as sibling subcommands without reshuffling the command tree.

- 2ed6f7a: Add `aitcc app metrics <id>` to read conversion metrics for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-app/:aid/conversion-metrics?refresh=&timeUnitType=DAY|WEEK|MONTH&startDate=&endDate=`. Defaults to the last 30 days (host local) at DAY granularity.

  Flags: `--time-unit DAY|WEEK|MONTH`, `--start YYYY-MM-DD`, `--end YYYY-MM-DD`, `--refresh` (bypass server cache). Validates the date range locally (exit 2 with `invalid-date` if `start > end`).

  PREPARE-state apps return `metrics: []` with a `cacheTime` ISO timestamp; per-record shape is passed through opaquely until a live-traffic response is observed.

- a54cf8b: Add `aitcc app ratings <id>` to list user ratings and reviews for a submitted mini-app.

  The console UI's "평점 및 리뷰" tab is powered by `GET /mini-app/:id/app-ratings?page&size&sortField&sortDirection`. The response envelope carries `{ratings, paging, averageRating, totalReviewCount}`, so the CLI surfaces all four directly: the rollup numbers in both human and JSON output, and the per-review records (score, nickname, content, timestamp) as a tab-separated table in human mode / opaque records in JSON.

  Flags:

  - `--page N` (0-indexed, default 0) and `--size N` (default 20) for pagination
  - `--sort-field CREATED_AT|SCORE` (default `CREATED_AT`) and `--sort-direction ASC|DESC` (default `DESC`) to match the fields the console UI emits
  - `--workspace <id>` falls through to the selected workspace

  JSON exit codes match the other `app` subcommands: `invalid-id` / `invalid-config` → exit 2, live API/network/auth failures follow the shared `api-error` / `network-error` / `authenticated: false` contract.

- 9b07f49: Add `aitcc app reports <id>` to list user-submitted reports (신고 내역) for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-apps/:aid/user-reports?pageSize=N[&cursor=...]`. Note the **plural** `mini-apps` in the path — same split-personality as `mini-apps/review-status`. Cursor-based pagination (unlike ratings, which is page-based): the server hands back `{reports, nextCursor, hasMore}` and the caller passes `--cursor` opaquely on the next call.

  Flags:

  - `--page-size N` (default 20)
  - `--cursor <str>` — opaque token from a previous response's `nextCursor`
  - `--workspace <id>` falls through to the selected workspace
  - `--json`

  JSON exit codes follow the shared `app` subcommand contract (invalid-id / invalid-config → exit 2, api-error / network-error / `authenticated: false` for live failures).

- a8dbf98: Add `aitcc app share-rewards ls <id>` to list share-reward promotions for a mini-app.

  Endpoint: `GET /workspaces/:wid/mini-app/:aid/share-rewards?search=` — a simple array. The console UI always sends `search=` (empty matches everything); the CLI mirrors that shape so the request is indistinguishable from the UI's XHR.

  Flag: `--search <text>` for a title-contains filter. Per-record shape is passed through opaquely until a populated response is observed.

- fa17ba7: Add `aitcc notices` — read Apps in Toss notices (공지사항) from the terminal.

  Subcommands:

  - `aitcc notices ls [--page N] [--size N] [--search STR]` — list notices with page-based pagination and optional title substring filter
  - `aitcc notices show <id>` — print a single notice (title, subtitle, category, publish time, full body) or JSON-dump it with `--json`
  - `aitcc notices categories` — list the 7 category buckets with their post counts

  Lives on a separate Toss service (`api-public.toss.im/api-public/v3/ipd-thor`) with a hard-coded `workspaceId=129` that's shared across every console user — there's no per-user notice bucket. Session cookies captured at login are domain-matched against `.toss.im` so they're sent automatically without any extra handshake.

  New API client module at `src/api/ipd-thor.ts` so later ipd-thor surfaces (post feedback, likes, series) have a place to live. Commands/`requireSession` helper factored out of `resolveWorkspaceContext` since notices don't need a workspace id.

## 0.1.10

### Patch Changes

- f8ca390: Add `aitcc app status <id>` to check the review state of a submitted mini-app, with `--watch` to poll until it flips.

  The console UI shows a "검토 중이에요" banner on every submitted app's meta page. That banner isn't a single API field — it's derived from four things on the `/mini-app/:id/with-draft` envelope: `approvalType`, `current`, `rejectedMessage`, and whether a `draft` exists. `aitcc app status` encodes that derivation once so callers get a stable state string instead of reimplementing the logic.

  States emitted:

  - `not-submitted` — app exists but has no `approvalType` (register never called in review mode)
  - `under-review` — submitted, not yet reviewed (this is the "검토 중" banner case)
  - `rejected` — `rejectedMessage` is set; the CLI surfaces the reason in human output
  - `approved` — the published `current` row exists, no in-flight draft
  - `approved-with-edits` — approved + the editor has unpublished changes
  - `unknown` — any `approvalType` we haven't observed yet (guards forward-compat)

  `--watch` polls (default 60s, clamped [30, 3600]) until the state leaves `under-review`. `--json` emits NDJSON one record per tick; human mode only prints on state changes.

## 0.1.9

### Patch Changes

- 13c4a8b: Add `aitcc app show <id>` to surface the full mini-app detail, including fields that only live in the draft view.

  `aitcc app ls` and `GET /mini-app/:id` (detail) both return the app's **current** view — the published record end users see. Until a mini-app has been reviewed and approved, `current` is empty for almost every field: no `detailDescription`, no `csEmail`, no `homePageUri`, no `images`, no `keywordList`. This is what made `aitcc app register` look buggy during dog-food (fields appeared lost). They were in the draft view all along — readable from `GET /mini-app/:id/with-draft`, which is what this new subcommand reads.

  Flags:

  - `--view draft` (default) — what the editor / `app register` just wrote. This is the useful view until the app is approved.
  - `--view current` — the published record. Returns `miniApp: null` in `--json` when the app isn't reviewed yet, so agent-plugin can tell "unreviewed" from "reviewed and empty" apart.
  - `--view merged` — current with draft overlaid on top (draft wins per field). Useful once both exist.

  Human output summarises title/slug/status/home/cs/logo/subtitle + image count + keywords + category path. `--json` returns the raw `miniApp` record.

  No server-mutating calls.

## 0.1.8

### Patch Changes

- 379b2db: Revert the 0.1.7 "flat payload + `categoryList: [{id}]`" change for `aitcc app register`; keep the new manifest validators.

  Further dog-food against workspace 3095 showed the 0.1.7 shape was a regression, not a fix. The original 0.1.6 shape (`{miniApp, impression}` wrapper + `impression.categoryIds: [number]` + `images[]` rows with `displayOrder`) is what the server actually accepts. The earlier "missing fields" signal was a read-side issue — `GET /mini-app/:id` returns only the published `current` view, so the fields we sent looked lost. `GET /mini-app/:id/with-draft` shows them all correctly persisted.

  The 0.1.7 payload (flat + `categoryList`) triggers HTTP 400 on the server, so 0.1.7 is effectively broken. 0.1.8 restores working submits.

  What is kept from 0.1.7: the two pre-flight manifest validators (`titleEn` may only contain English letters, digits, spaces, and colons; `description` ≤ 500 code points). Both mirror server rules surfaced during dog-food.

  `/mini-app/review` is genuinely a one-shot register+submit-for-review endpoint when the payload is complete — no separate update or review-trigger endpoint exists. See `apps-in-toss-community/.playwright-mcp/FORM-SCHEMA-CAPTURED.md` ("FINAL" section) and the `xhr-captures/` directory in the umbrella for the full evidence trail.

## 0.1.7

### Patch Changes

- 729ae69: Fix `aitcc app register` submit payload shape based on dog-food #23 findings.

  The inferred `{miniApp, impression}` wrapper silently dropped every nested
  field on the server side (confirmed by round-tripping through
  `GET /workspaces/:wid/mini-app`). Submit now sends a flat top-level
  document matching the persisted row shape, and the `impression` block
  uses `categoryList: [{id}]` instead of `categoryIds: [number]`.

  Also adds two manifest validations that mirror server rules surfaced by
  the dog-food: `titleEn` may contain only English letters, digits, spaces,
  and colons; `description` must be at most 500 code points.

  Follow-up (out of scope for this patch): the `/mini-app/review` endpoint
  returns `reviewState: null`, strongly suggesting it creates a skeleton
  app without triggering review. A separate `aitcc app review-request`
  command will drive the trigger endpoint once captured.

## 0.1.6

### Patch Changes

- 5bd67ed: Add `aitcc app register` for one-shot mini-app registration from a YAML/JSON manifest.

  The command reads a manifest (default `./aitcc.app.yaml` → `./aitcc.app.json`), validates each referenced PNG against the console's dimension rules, uploads the images to `/resource/:wid/upload`, and submits the combined create + review payload to `/workspaces/:wid/mini-app/review`. See CLAUDE.md → "App registration" for the manifest schema and the full `--json` contract.

  The submit payload shape is inferred from static bundle analysis and has **not** been observed on the wire yet — the first real submission (dog-food task #23) is expected to either confirm or minor-correct the transform in `src/commands/register-payload.ts` + `src/api/mini-apps.ts`. The manifest shape is stable regardless.

## 0.1.5

### Patch Changes

- 543ba37: Add `aitcc app ls` to list mini-apps in the selected workspace.

  - Fetches `/workspaces/:id/mini-app` and `/workspaces/:id/mini-apps/review-status` in parallel and joins them by app id, so each row surfaces both the app identity and its review state in one call.
  - Honours the workspace selection from `aitcc workspace use`; `--workspace <id>` overrides for one-off inspection.
  - `--json` emits `{ ok: true, workspaceId, hasPolicyViolation, apps: [...] }`. `hasPolicyViolation` is surfaced because it is the console's workspace-wide policy flag, not a per-app attribute.
  - Plain output is `appId<TAB>name<TAB>reviewState` — easy to pipe through `column -t` or `awk`. Unknown review states render as `-`; unnamed apps as `(unnamed)`.
  - Mini-app payload shape is not yet fully documented (our test workspaces have zero apps); the API client normalises `id`/`name` across a few spellings and stashes the rest under `extra`. Follow-up exploration will tighten this once `sdk-example` is registered as a real mini-app.

- 087cb53: Add `aitcc members ls` and `aitcc keys ls` for workspace member and API-key listing.

  - `aitcc members ls [--workspace <id>]` — list workspace members, with `bizUserNo`, `name`, `email`, `status`, `role`. The `bizUserNo` is the stable per-person identifier; future member-management commands will key off it.
  - `aitcc keys ls [--workspace <id>]` — list console API keys used for deploy automation. Empty lists include a stderr hint pointing users at the console UI's "발급받기" flow (issuing keys programmatically is a follow-up once we can observe the creation endpoint).
  - Both commands reuse the shared workspace-context resolver added to `_shared.ts`, so `--workspace` parsing, "no workspace selected", and auth/network/api error triage are identical across `app ls` / `members ls` / `keys ls`.
  - `parsePositiveInt` moved from `workspace.ts` to `_shared.ts` so every command can depend on it without importing through `workspace.ts`.
  - Internal: `app ls` migrates to the shared resolver (behaviour-neutral). `keys ls --json` surfaces `needsKey: true` when the key list is empty, so agent-plugin skills can bail early with a friendly message before attempting a deploy that would 401.
  - Internal: `resolveWorkspaceContext` now has unit tests covering the three failure branches (exit 10 on no session, exit 2 on invalid id, exit 2 on no selected workspace), pinning the agent-plugin JSON contract.

- 58dc6a7: Add a throttled update-check notice that tells users when a newer `aitcc` is available, without hammering GitHub's anonymous 60/hr rate-limit bucket.

  - At most one network call every 24 hours, cached at `$XDG_CACHE_HOME/aitcc/upgrade-check.json` (or `~/.cache/aitcc/upgrade-check.json`).
  - Failed checks still update the throttle window to prevent aggressive retries.
  - Conditional GET with the previous ETag — a 304 response consumes no rate-limit slot.
  - Fully opt-out via `AITCC_NO_UPDATE_CHECK=1`.
  - The notice is skipped when stdout is not a TTY or when `--json` is passed, so agent-plugin consumers never see a stray line.
  - Only runs during successful `aitcc whoami` invocations. `aitcc login` / `aitcc logout` / `aitcc upgrade` never trigger the background check.

- ca2e799: Add `aitcc workspace ls / use / show` for multi-tenant workspace management.

  The Apps in Toss console scopes almost every resource (mini-apps, members, API keys, configs) under a workspace; an account can belong to multiple workspaces, so CLI operations need an explicit workspace context. Session schema bumps from v1 to v2 to persist `currentWorkspaceId` — v1 files are still read transparently and upgraded in-memory, then rewritten on the next explicit write.

  - `aitcc workspace ls` — list workspaces the current account can access. Marks the selected one with `*`.
  - `aitcc workspace use <id>` — select a workspace. Validates the id against the account's actual workspace list before persisting, so a typo fails fast instead of producing confusing 403s from every downstream command.
  - `aitcc workspace show [--workspace <id>]` — dump the workspace detail (business registration / verification / review state). Pass `--workspace <id>` on `show` (and on future workspace-scoped commands) to override the persisted selection for one call without clobbering it.
  - `--json` is supported on every subcommand and follows the existing exit-code contract (`ok`, `authenticated`, `reason`). Invalid id input produces `{ ok: false, reason: 'invalid-id', message }` with exit `2`; a missing workspace selection on `show` produces `{ ok: false, reason: 'no-workspace-selected' }`.

## 0.1.4

### Patch Changes

- 01912f4: Rename the CLI to `aitcc`, replace the OAuth-callback login scaffold with a Chrome DevTools Protocol flow, and wire `whoami` to the live console API.

  ## Breaking: CLI renamed

  The executable is now `aitcc` (Apps in Toss Community Console). Shorter than the previous `ait-console`, matches the organization's short name, and leaves `ait-console` free in case the Toss team ever ships their own tool. The npm package name (`@ait-co/console-cli`) is unchanged.

  - Binary: `ait-console-<os>-<arch>[.exe]` → `aitcc-<os>-<arch>[.exe]`.
  - Session directory: `$XDG_CONFIG_HOME/ait-console/` → `$XDG_CONFIG_HOME/aitcc/`. Existing sessions read as "no session" — re-run `aitcc login` once.
  - Env vars: `AIT_CONSOLE_*` → `AITCC_*` (`AITCC_BROWSER`, `AITCC_OAUTH_URL`, `AITCC_VERSION` build-time define, `AITCC_INSTALL_DIR`, `AITCC_QUIET`).

  Binary users: re-run `install.sh` to pick up the renamed asset. The installer does not touch the old `ait-console` binary — delete `$HOME/.local/bin/ait-console` (or wherever you installed it) manually once you've confirmed `aitcc` works. npm users: reinstall the package so the new `bin` entry lands in your `$PATH`.

  ## `aitcc login` now captures cookies via CDP

  The old flow waited for an OAuth callback on `127.0.0.1` — which never worked because the registered redirect on the public client_id is the production domain, not localhost. The new flow launches the user's system Chrome/Edge/Chromium in an isolated temporary profile, navigates to the Apps in Toss sign-in URL, and captures the session cookies (including `HttpOnly`) over CDP once the browser reaches the post-login workspace page. No OAuth redirect URI configuration is required.

  ## `aitcc whoami` is live by default

  `whoami` now calls the console's `members/me/user-info` endpoint, printing your name, email, role, and workspace list. Pass `--offline` to read only the cached identity. Exit codes: 0 on success, 10 when the session is missing or expired, 11 on network failure, 17 on other API errors.

  ## Removed

  The `oauth.ts` callback server, `--no-browser` flag, and `AIT_CONSOLE_OAUTH_CLIENT_ID` / `AIT_CONSOLE_OAUTH_SCOPE` env overrides are gone. Override the authorize URL with `AITCC_OAUTH_URL` and the browser executable with `AITCC_BROWSER` if needed.

## 0.1.3

### Patch Changes

- 92f3b51: Update README's pre-release banner to reflect that 0.1.x is now published to
  npm + GitHub Releases. The previous "Work in Progress — not yet published"
  note was inaccurate after the 0.1.0 ship; replace with a note that names the
  currently-shipped commands and points to TODO.md for what's next.

## 0.1.2

### Patch Changes

- 055c94b: Use `rcodesign` (apple-platform-rs) instead of Apple's stock `codesign` to
  ad-hoc sign macOS binaries during the release build. Bun-compiled binaries
  have a malformed `LC_CODE_SIGNATURE` stub that stock `codesign` rejects
  (`invalid or unsupported format for signature`); rcodesign handles them after
  a `codesign --remove-signature` pass strips the broken stub. The
  release-binaries workflow downloads the rcodesign 0.29.0 prebuilt for the
  macOS runner, so no Cargo/Rust toolchain is needed at CI time. Once Bun
  1.3.13+ stable lands (the upstream fix is merged in canary), this whole path
  can be replaced with the stock `codesign` invocation again.

## 0.1.1

### Patch Changes

- 4264e0c: Apply ad-hoc code signature to macOS binaries during the release build so users
  can run `ait-console` on Sonoma+ without hitting Gatekeeper SIGKILL on first
  launch. Adds `scripts/macos-entitlements.plist` (JIT / unsigned-executable-memory
  / disable-library-validation, required by Bun's compiled binary at runtime) and
  makes `scripts/build-bin.ts` invoke `codesign --force --sign -` for any
  `bun-darwin-*` target when running on a macOS host. `install.sh` now also strips
  `com.apple.quarantine` and re-applies an ad-hoc signature on Darwin as a safety
  net. Proper notarization is still deferred to 1.0.

## 0.1.0

### Minor Changes

- 4eb4e9f: Initial 0.1.0 release of `ait-console`.

  **CLI surface** (MVP):

  - `ait-console whoami` — reads local session, reports logged-in user. `--json` for machine output.
  - `ait-console login` — localhost callback OAuth scaffold (random `state`, 5-min timeout, XDG `session.json` with `0600` perms). Actual Toss OAuth endpoint pending discovery; override via `AIT_CONSOLE_OAUTH_URL` env var.
  - `ait-console logout` — idempotent session file removal.
  - `ait-console upgrade` — downloads matching platform binary from the latest GitHub Release and atomically replaces itself.
  - `--json` supported on every command; stderr for diagnostics, stdout for structured result.

  **Build pipeline**:

  - Node dist via `tsdown` for npm install.
  - Platform-specific binaries via `bun build --compile` for Linux/macOS × x64/arm64, Windows × x64. Attached to each GitHub Release with `SHA256SUMS`.
  - `install.sh` at repo root detects OS/arch, verifies checksum, installs to `$HOME/.local/bin`.

  **Session storage**: XDG `session.json` with `0600` perms (keychain deferred per CLAUDE.md rationale).
