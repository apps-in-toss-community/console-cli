# console-cli

> 🚧 **Pre-1.0 (`0.1.x`)** — published to npm but the surface is still small. `whoami` / `login` / `logout` / `upgrade` are usable today; `deploy` / `logs` / `status` are next on [TODO.md](./TODO.md).
> 1.0 이전 단계입니다. 일부 명령(`whoami`/`login`/`logout`/`upgrade`)만 동작하고, `deploy`/`logs`/`status`는 진행 중입니다.

`aitcc` is a community-maintained CLI for automating Apps in Toss developer console operations — log in once in a browser, then drive subsequent operations from your shell or from an AI coding agent via headless browser automation.

앱인토스 콘솔을 CLI로 자동화하는 커뮤니티 도구. 최초 로그인만 브라우저로 하고, 이후 작업은 headless 브라우저로 처리한다. (MCP 모드는 후순위 — [TODO.md](./TODO.md) 참고.)

> This is an **unofficial, community-maintained** project. Not affiliated with or endorsed by Toss or the Apps in Toss team. It drives the public developer console from a user's authenticated browser session — it is **not** a client for a blessed, documented API, and behavior may break whenever the console UI changes.
>
> 이 프로젝트는 **비공식 커뮤니티 프로젝트**입니다. 토스/앱인토스 팀과 제휴 관계가 아닙니다. 공식 API를 호출하지 않고 브라우저 세션을 통해 콘솔을 자동화하므로, 콘솔 UI가 바뀌면 동작이 깨질 수 있습니다.

## Install

### Platform binary (primary)

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | sh
```

The installer detects OS (`uname -s`) and arch (`uname -m`), downloads the matching binary from the latest GitHub Release, verifies it against `SHA256SUMS`, and installs it to `$HOME/.local/bin/aitcc`. Node is **not** required.

Pin a specific version:

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | AITCC_VERSION=v0.1.1 sh
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
aitcc login              # launch a browser window, sign in there, and capture the session cookies
aitcc logout             # delete the local session file
aitcc whoami             # show the currently logged-in user live from the console API
aitcc whoami --offline   # use the cached identity without hitting the API
aitcc whoami --json      # machine-readable output for scripts and agents
aitcc upgrade            # self-update to the latest GitHub Release (binary installs only)
aitcc upgrade --dry-run  # check for an update without downloading or replacing
aitcc upgrade --force    # reinstall the latest release even if versions match
```

`aitcc upgrade` respects `GITHUB_TOKEN` to avoid anonymous GitHub API rate limits.

Planned commands — `deploy`, `logs`, `status` — are tracked in [TODO.md](./TODO.md).

### Login details

`aitcc login` launches a Chrome-family browser via the Chrome DevTools Protocol, navigates it to the Apps in Toss developer console sign-in URL, and waits for the main frame to reach the post-login workspace page. Once it does, the CLI dumps all cookies over CDP (including `HttpOnly` auth cookies that JavaScript can't see) and persists them to the local session file. The browser runs against a temporary, isolated `--user-data-dir` that is wiped on exit, so your everyday browser profile is never touched.

The CLI looks for Chrome in the standard OS install locations (Google Chrome, Chromium, Microsoft Edge). Override the executable with `AITCC_BROWSER=/path/to/chrome` if your install is elsewhere; override the sign-in URL with `AITCC_OAUTH_URL` if you need to point at a staging environment. `--timeout <seconds>` controls how long the CLI will wait for sign-in to finish (default 300s).

## Session storage

The local session lives at an XDG-compliant path with file mode `0600`:

- Linux/macOS: `$XDG_CONFIG_HOME/aitcc/session.json` (fallback `~/.config/aitcc/session.json`)
- Windows: `%APPDATA%\aitcc\session.json`

The containing directory is created with mode `0700`. Cookies captured during login are **never** printed, logged, or attached to `--verbose` output — only `user.email`, `name`, and workspace summary surface through `whoami`.

See [CLAUDE.md](./CLAUDE.md) for the rationale behind using a plain `0600` file instead of an OS keychain.

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

## Status

`login`, `logout`, `whoami`, and `upgrade` are implemented end-to-end — `login` drives a real browser over CDP and `whoami` reads the live console member API. `deploy`, `logs`, `status` are next — see [TODO.md](./TODO.md). See the [organization landing page](https://apps-in-toss-community.github.io/) for the full roadmap.

## Pre-commit hook

Optional but recommended. After cloning, activate the standard pre-commit hook (runs `biome check` on staged files):

```sh
git config core.hooksPath .githooks
```

This is a developer convenience for fast feedback before push. CI runs the same checks as the enforcement layer, so contributors who don't activate the hook will still see lint failures in their PR.

선택 사항이지만 권장합니다. clone 후 표준 pre-commit hook을 활성화하면 staged 파일에 `biome check`가 자동으로 돕니다 (push 전에 빠른 피드백). 활성화하지 않아도 동일한 검사가 CI에서 실행되므로 PR 단계에서 lint 실패를 볼 수 있습니다.
