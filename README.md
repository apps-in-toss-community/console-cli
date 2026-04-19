# console-cli

> 🚧 **Work in Progress** — not yet published.
> 아직 개발 중입니다. 릴리스 전입니다.

`ait-console` is a community-maintained CLI for automating Apps in Toss developer console operations — log in once in a browser, then drive subsequent operations from your shell or from an AI coding agent via headless browser automation.

앱인토스 콘솔을 CLI로 자동화하는 커뮤니티 도구. 최초 로그인만 브라우저로 하고, 이후 작업은 headless 브라우저로 처리한다. (MCP 모드는 후순위 — [TODO.md](./TODO.md) 참고.)

> This is an **unofficial, community-maintained** project. Not affiliated with or endorsed by Toss or the Apps in Toss team. It drives the public developer console from a user's authenticated browser session — it is **not** a client for a blessed, documented API, and behavior may break whenever the console UI changes.
>
> 이 프로젝트는 **비공식 커뮤니티 프로젝트**입니다. 토스/앱인토스 팀과 제휴 관계가 아닙니다. 공식 API를 호출하지 않고 브라우저 세션을 통해 콘솔을 자동화하므로, 콘솔 UI가 바뀌면 동작이 깨질 수 있습니다.

## Install

### Platform binary (primary)

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | sh
```

The installer detects OS (`uname -s`) and arch (`uname -m`), downloads the matching binary from the latest GitHub Release, verifies it against `SHA256SUMS`, and installs it to `$HOME/.local/bin/ait-console`. Node is **not** required.

Pin a specific version:

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | AIT_CONSOLE_VERSION=v0.1.1 sh
```

Override the install directory with `AIT_CONSOLE_INSTALL_DIR=/custom/path` (default `$HOME/.local/bin`).

### npm (fallback)

If you already have Node 24+ on your PATH:

```sh
npm i -g @ait-co/console-cli
# or: pnpm add -g @ait-co/console-cli
```

This is the path that `agent-plugin` uses when a project already has Node installed.

## Quick usage

```sh
ait-console --version          # print the embedded version
ait-console login              # open the browser, capture the OAuth callback on localhost, save the session
ait-console login --no-browser # print the authorize URL instead of auto-opening a browser
ait-console logout             # delete the local session file
ait-console whoami             # show the currently logged-in user (exits non-zero if no session)
ait-console whoami --json      # machine-readable output for scripts and agents
ait-console upgrade            # self-update to the latest GitHub Release (binary installs only)
ait-console upgrade --dry-run  # check for an update without downloading or replacing
ait-console upgrade --force    # reinstall the latest release even if versions match
```

`ait-console upgrade` respects `GITHUB_TOKEN` to avoid anonymous GitHub API rate limits.

Planned commands — `deploy`, `logs`, `status` — are tracked in [TODO.md](./TODO.md).

### Login details

`ait-console login` spawns a short-lived HTTP server on `127.0.0.1:<random-port>` and waits for the OAuth provider to redirect back to `/callback` with a `code` and a `state` parameter. The `state` is a 32-byte crypto-random value generated per attempt and rechecked on arrival — any mismatch is rejected with a 400 and the login aborts. The server binds to the loopback interface only, listens for exactly one successful callback, and shuts down after either success or a 5-minute timeout (override with `--timeout <seconds>`).

The Apps in Toss developer console OAuth authorize URL is not publicly documented yet (see [CLAUDE.md](./CLAUDE.md) § "Open questions"). Until it is, set `AIT_CONSOLE_OAUTH_URL` (and optionally `AIT_CONSOLE_OAUTH_CLIENT_ID` / `AIT_CONSOLE_OAUTH_SCOPE`) to point at the real endpoint; without it, `login` exits with a usage error rather than calling a placeholder.

## Session storage

The local session lives at an XDG-compliant path with file mode `0600`:

- Linux/macOS: `$XDG_CONFIG_HOME/ait-console/session.json` (fallback `~/.config/ait-console/session.json`)
- Windows: `%APPDATA%\ait-console\session.json`

The containing directory is created with mode `0700`. Cookies and storage-state origins captured during login are **never** printed, logged, or attached to `--verbose` output — only `user.email` and `displayName` surface through `whoami`. Playwright screenshots are off by default.

See [CLAUDE.md](./CLAUDE.md) for the rationale behind using a plain `0600` file instead of an OS keychain.

## Machine-readable output (`--json`)

Every command accepts `--json`. When set:

- All normal output goes to stdout as a single JSON document on one line.
- All diagnostics go to stderr as plain text.
- Exit codes are meaningful and documented per command (see `src/exit.ts`).

`agent-plugin` skills shell out with `--json` exclusively and parse stdout.

## Status

Scaffold complete. `whoami`, `login`, `logout`, and `upgrade` are implemented (`login` still needs the real Toss OAuth endpoint — override via `AIT_CONSOLE_OAUTH_URL`); `deploy`, `logs`, `status` are not yet — see [TODO.md](./TODO.md). See the [organization landing page](https://apps-in-toss-community.github.io/) for the full roadmap.
