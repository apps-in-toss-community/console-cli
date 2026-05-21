# console-cli

[한국어](./README.md) · **English**

[![npm](https://img.shields.io/npm/v/@ait-co/console-cli)](https://www.npmjs.com/package/@ait-co/console-cli)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](https://github.com/apps-in-toss-community/console-cli/blob/main/LICENSE)

> Pre-1.0 (`0.1.x`) — published to npm. Auth, workspace, and mini-app commands (including bundle deploy and cert management) work end-to-end today; `app logs` is deferred until the backend endpoint is available. See [Status](#status) for the full command surface.

`aitcc` is a community-maintained CLI for automating Apps in Toss developer console operations — log in once in a browser, then drive subsequent operations from your shell or from an AI coding agent via headless browser automation.

## Install

### Platform binary (primary)

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | sh
```

The installer detects OS (`uname -s`) and arch (`uname -m`), downloads the matching binary from the latest GitHub Release, verifies it against `SHA256SUMS`, and installs it to `$HOME/.local/bin/aitcc`. Node is **not** required.

Pin a specific version:

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | AITCC_VERSION=v0.1.34 sh
```

Override the install directory with `AITCC_INSTALL_DIR=/custom/path` (default `$HOME/.local/bin`).

### npm (fallback)

If you already have Node 24+ on your PATH:

```sh
npm i -g @ait-co/console-cli
# or: pnpm add -g @ait-co/console-cli
```

This is the path that `agent-plugin` uses when a project already has Node installed.

## Quick usage

```sh
aitcc --version          # print the embedded version
aitcc login              # interactive: prompts email/password/save target, then signs in
aitcc login --interactive   # force the visible-browser flow (skip headless)
aitcc logout             # delete the local session file
aitcc logout --purge     # also delete saved keychain credentials (replaces `auth clear`)
aitcc whoami             # show the currently logged-in user + credential source
aitcc whoami --offline   # use the cached identity without hitting the API
aitcc whoami --json      # machine-readable output for scripts and agents
aitcc upgrade            # self-update to the latest GitHub Release (binary installs only)
aitcc upgrade --dry-run  # check for an update without downloading or replacing
aitcc upgrade --force    # reinstall the latest release even if versions match
```

For non-interactive use (CI, scripts), pipe the password instead of typing it:

```sh
printf '%s' "$AITCC_PASSWORD" | aitcc login --email you@example.com --password-stdin --json
# or simply export both env vars and let the CLI pick them up:
AITCC_EMAIL=you@example.com AITCC_PASSWORD=… aitcc login --json
```

Add `--save keychain` to persist the credentials so the next `aitcc login` runs without prompting.

`aitcc upgrade` respects `GITHUB_TOKEN` to avoid anonymous GitHub API rate limits.

Planned: `app logs` (pending backend endpoint availability).

### Project context (`aitcc.yaml`)

App- and workspace-scoped commands (`app status`, `app deploy`, `app certs ls`, `keys ls`, …) accept an explicit `--workspace <id>` and positional `<appId>`, but you can also drop an `aitcc.yaml` (or `aitcc.json`) at the root of your project and let the CLI find it by walking up from the current directory:

```yaml
# aitcc.yaml
workspaceId: 12345
miniAppId: 67890
```

Resolution priority (highest first):

- **workspace**: `--workspace` flag → `AITCC_WORKSPACE` env → yaml `workspaceId` → session selection (`aitcc workspace use`)
- **mini-app**: positional/flag `<appId>` → `AITCC_APP` env → yaml `miniAppId`

Each command prints a one-line context header to stderr so you always see what was resolved (suppressed under `--json` so machine-readable output is unaffected):

```
[workspace: 12345 (from aitcc.yaml) · app: 67890 (from aitcc.yaml)]
```

The walk stops at the nearest `.git` directory and never crosses `$HOME`. Passing `--workspace` overrides any yaml `miniAppId` (it may belong to a different workspace), but `AITCC_WORKSPACE` keeps it.

When `aitcc app register` succeeds, the returned `miniAppId` is written back into the resolved `aitcc.yaml`/`aitcc.json` (comments and key order in YAML are preserved). Subsequent commands can then run without `--app`. The write-back is skipped under `--dry-run` and silently no-ops when the file already pins the same id; if no project file exists in the tree, the CLI prints a one-line stderr hint instead of creating one.

To bootstrap an `aitcc.yaml` from scratch, run `aitcc app init`. The command asks for the required manifest fields interactively (workspace is picked from the live API list), validates each value against the same constraints that `register` enforces, and lays the optional fields (`homePageUri`, `logoDarkMode`, `keywords`, `horizontalScreenshots`) as commented-out lines for later edits. Image paths (`./assets/logo.png`, `./assets/thumbnail.png`, `./assets/screenshot-{1,2,3}.png`) are written as placeholders — drop the actual files into `./assets/` before running `aitcc app register`. `init` requires an interactive TTY and refuses `--json` / non-TTY runs with `interactive-required` (exit 2).

```sh
mkdir my-app && cd my-app
aitcc app init           # interactive prompt → ./aitcc.yaml
# (drop logo/thumbnail/screenshots into ./assets/)
aitcc app register       # creates the mini-app and writes miniAppId back
aitcc app status         # works with no flags — context comes from aitcc.yaml
```

### Login details

`aitcc login` resolves credentials from (in order) explicit `--email` + `--password` / `--password-stdin` flags, the `AITCC_EMAIL` + `AITCC_PASSWORD` environment, the OS keychain (saved by a prior `--save keychain`), or — on a TTY — an interactive prompt that asks for both fields plus where to save them. It then launches a Chrome-family browser via the Chrome DevTools Protocol, drives the sign-in headlessly when credentials are available, and waits for the main frame to reach the post-login workspace page. Once it does, the CLI dumps all cookies over CDP (including `HttpOnly` auth cookies that JavaScript can't see) and persists them to the local session file. The browser runs against a temporary, isolated `--user-data-dir` that is wiped on exit, so your everyday browser profile is never touched.

Pass `--interactive` to force the visible-browser flow even when credentials are configured (useful for switching accounts or working around step-up auth). The legacy `aitcc auth set` / `auth clear` / `auth status` commands still work but emit a deprecation warning — prefer `aitcc login` (interactive prompt offers a save option), `aitcc logout --purge`, and `aitcc whoami` instead. They will be removed in 1.0.

The CLI looks for Chrome in the standard OS install locations (Google Chrome, Chromium, Microsoft Edge). Override the executable with `AITCC_BROWSER=/path/to/chrome` if your install is elsewhere; override the sign-in URL with `AITCC_OAUTH_URL` if you need to point at a staging environment. `--timeout <seconds>` controls how long the CLI will wait for sign-in to finish (default 300s).

## Session storage

The local session lives at an XDG-compliant path with file mode `0600`:

- Linux/macOS: `$XDG_CONFIG_HOME/aitcc/session.json` (fallback `~/.config/aitcc/session.json`)
- Windows: `%APPDATA%\aitcc\session.json`

The containing directory is created with mode `0700`. Cookies captured during login are **never** printed, logged, or attached to `--verbose` output — only `user.email`, `name`, and workspace summary surface through `whoami`.

See [CLAUDE.md](./CLAUDE.md) for the rationale behind using a plain `0600` file instead of an OS keychain.

## Continuous integration

For one-shot CI runs (e.g. `aitcc app deploy` from a workflow), seed the runner with a session captured on a desktop machine:

```sh
# Desktop (already logged in):
aitcc auth export --format env >> $GITHUB_ENV       # or store as a secret
# CI (with the secret exposed as $AITCC_SESSION):
aitcc app deploy ./aitc-sdk-example.ait --json
```

When `AITCC_SESSION` is set, every command reads the session from that env var instead of the local file. `logout` / `workspace use` / other write paths are silenced under env mode so a CI host never materialises a session file. Use `aitcc auth import --from-env` if you actually want the blob persisted to disk (mainly for restoring a desktop after a wipe).

> **KR-only**: console session cookies are bound to KR residential IPs. The same `AITCC_SESSION` blob succeeds from a Korean machine but **fails with `401` / `errorCode: 4010`** from non-KR egress, including GitHub-hosted runners (Azure US/EU). Use a KR self-hosted runner or run the command yourself. See [`docs/api/auth-session.md`](./docs/api/auth-session.md).

## Update notifications

When running interactively, `aitcc` occasionally checks for a newer release and prints a one-line notice on stderr if one exists. The check is rate-limit friendly:

- At most one network call every 24 hours, no matter how often you run commands.
- Even a failed check updates the throttle window, so a broken network or a 403 from GitHub does not loop back within minutes.
- Conditional GET (`If-None-Match`) — a 304 response does not consume the anonymous GitHub rate-limit bucket.
- The check is skipped entirely when stdout is not a TTY, when `--json` is passed, or when `AITCC_NO_UPDATE_CHECK=1` is set.

Cached state lives at `$XDG_CACHE_HOME/aitcc/upgrade-check.json` (fallback `~/.cache/aitcc/upgrade-check.json`).

## Machine-readable output (`--json`)

Every command accepts `--json`. When set:

- All normal output goes to stdout as a single JSON document on one line.
- All diagnostics go to stderr as plain text.
- Exit codes are meaningful and documented per command (see `src/exit.ts`).

`agent-plugin` skills shell out with `--json` exclusively and parse stdout.

## Telemetry

`aitcc` collects anonymous usage statistics split into two tiers. See the [privacy page](https://docs.aitc.dev/privacy) for details.

### Tier 0 — anonymous daily ping (on by default, opt-out)

Once per day per machine, a minimal anonymous ping is sent on every invocation. Collected: `{source, version, platform}`. No PII, no `anon_id` — the server derives a daily hash from IP + User-Agent using a rotating salt, and stores nothing else. This is the minimum signal needed to know "is anyone actually using this version?"

Three ways to opt out:

- `AITCC_TELEMETRY=off` environment variable — disables all telemetry for this shell session
- `--no-telemetry` flag — disables for this single invocation only (not permanent)
- `aitcc telemetry tier0-off` — permanently opts out (persisted to the state file)

### Tier 1 — detailed events (off by default, opt-in)

On first run in a TTY, the CLI prompts for consent. In CI or pipe environments it silently defaults to deny. Collected: command name, version, platform, random persistent anonymous ID (`anon_id`). No personally identifiable information (email, session, user ID, etc.) is ever sent.

```sh
aitcc telemetry status          # show both tier status + anon ID
aitcc telemetry status --json   # machine-readable output
aitcc telemetry enable          # enable Tier 1 events
aitcc telemetry disable         # disable Tier 1 events
aitcc telemetry delete          # request deletion of Tier 1 server data + rotate local anon ID
aitcc telemetry tier0-off       # permanently opt out of Tier 0 daily ping
aitcc telemetry tier0-on        # re-enable Tier 0 after a previous tier0-off
```

State file: `$XDG_CONFIG_HOME/aitcc/telemetry.json` (fallback `~/.config/aitcc/telemetry.json`, mode `0600`).

## Status

The following command groups are implemented end-to-end:

- Auth & session: `login` / `logout` / `whoami` / `auth` (export/import)
- Workspace: `workspace` / `members` / `me` / `notices`
- Mini-app: `app` — `init` / `ls` / `show` / `status` / `deploy` / `register` / `ratings` / `reports` / `metrics` / `events` / `messages` / `share-rewards`, `app bundles` (`ls`/`deployed`/`upload`/`review`/`release`/`test-push`/`test-links`), `app certs` (`ls`/`show`/`issue`/`revoke`)
- Misc: Deploy Key issuance (`keys`), `telemetry`, `upgrade` (self-update), `completion` (shell completion)

`app logs` is deferred until the backend endpoint is available. See the [organization landing page](https://aitc.dev/) for the full roadmap.

## Pre-commit hook

Optional but recommended. After cloning, activate the standard pre-commit hook (runs `biome check` on staged files):

```sh
git config core.hooksPath .githooks
```

This is a developer convenience for fast feedback before push. CI runs the same checks as the enforcement layer, so contributors who don't activate the hook will still see lint failures in their PR.

---

Community open-source project.
