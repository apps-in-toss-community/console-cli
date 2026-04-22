# @ait-co/console-cli

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
