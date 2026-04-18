# PLAN — `ait-console` CLI

This is a living design doc for the `console-cli` repo. It defines the command
surface, auth/session model, build pipeline, and release strategy for the
`ait-console` CLI.

> This is an **unofficial, community-maintained** project. It is not affiliated
> with or endorsed by Toss or the Apps in Toss team. The CLI drives the public
> developer console from a user's authenticated browser session — it is **not**
> a client for a blessed, documented API, and behavior may break whenever the
> console UI changes.

## 1. Command surface

### MVP (0.1.x, what this scaffold PR targets)

| Command                      | Status   | Purpose                                                                                                                     |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ait-console --version`      | ✅ done  | Print embedded version (injected at build time from `package.json`).                                                         |
| `ait-console --help`         | ✅ done  | Usage output. Powered by `citty`.                                                                                            |
| `ait-console whoami`         | ✅ done  | Show currently logged-in user from local session. Exits non-zero if no session. First real consumer of the session module.  |
| `ait-console upgrade`        | ✅ done  | Query GitHub Releases latest, compare to embedded version, download matching platform/arch binary, atomically replace self. |

### Next (tracked, not in this PR)

| Command                       | Notes                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ait-console login`           | Opens a browser window to the Toss OAuth page (headful Playwright); captures the session when the callback lands.     |
| `ait-console logout`          | Deletes the session file.                                                                                              |
| `ait-console deploy [path]`   | Drives the console's deploy flow with a headless Playwright using the stored session.                                   |
| `ait-console logs [--tail]`   | Scrape/stream logs from the console.                                                                                    |
| `ait-console status`          | App status / last deploy summary.                                                                                       |
| `ait-console mcp`             | (Deferred; umbrella MCP strategy matrix keeps this as `?`.) Could expose the same ops as an MCP stdio server.           |

Non-goals for 0.1.x: plugin system, multi-account switching, release-notes
generation. These live behind explicit Dave approval for `minor`/`major`.

## 2. Session storage

- **Location** follows the XDG Base Directory spec with a sensible fallback:
  - `$XDG_CONFIG_HOME/ait-console/session.json`, falling back to
    `~/.config/ait-console/session.json` on Linux/macOS.
  - On Windows: `%APPDATA%\ait-console\session.json`.
- **Permissions**: directory `0700`, file `0600`. `fs.mkdir({ mode: 0o700 })`
  + `fs.writeFile({ mode: 0o600 })`. On Windows we best-effort the mode call
  (no-op) and rely on user profile ACLs.
- **Shape** (stable for 0.1.x, versioned for future migrations):
  ```jsonc
  {
    "schemaVersion": 1,
    "user": { "id": "...", "email": "...", "displayName": "..." },
    "cookies": [ /* Playwright storageState cookies */ ],
    "origins": [ /* Playwright storageState origins */ ],
    "capturedAt": "2026-04-19T00:00:00.000Z"
  }
  ```
- **Secrecy rules**: `ait-console whoami` prints `user.email` / `displayName`
  only. `cookies` and `origins` are **never** printed, logged, or attached to
  `--verbose` output. Playwright screenshots are off by default.
- **No OS keychain yet**. Rationale: keychain (`keytar`, Windows Credential
  Manager, Secret Service) adds native deps that `bun build --compile` cannot
  bundle cleanly across platforms. A 0600 file in an `XDG_CONFIG_HOME` dir is
  the pragmatic floor for a first release; keychain can be added behind a flag
  later without migrating data (we just move `cookies`/`origins` into the
  keychain and keep the rest in `session.json`).

## 3. Login mechanism

Decision: **localhost callback server** with PKCE-style one-shot code capture.

- `login` spawns a local HTTP server on an ephemeral port (pick via
  `server.listen(0)`), opens the user's default browser to the Toss OAuth URL
  with `redirect_uri=http://127.0.0.1:<port>/callback` and a random `state`
  nonce, waits for the callback, validates `state`, then closes the server and
  writes the session.
- Why not copy-paste a code? Copy-paste UX is worse in practice (users lose
  focus, paste the wrong token), and it pushes the security boundary to
  whatever app they paste from. A localhost callback on `127.0.0.1` is the
  same pattern `gh auth login --web`, `gcloud auth login`, and `firebase
  login` all use, and it scopes the secret to a single-use redirect.
- Agent-plugin compatibility: `login` is **never** called by `agent-plugin`
  skills. The plugin refuses to deploy if `whoami --json` shows no session and
  tells the user to run `ait-console login` themselves in a terminal. This
  keeps the interactive step out of the agent.
- **This PR does not implement login.** The scaffold leaves a stub so `whoami`
  has a clear "not logged in" story.

## 4. Output format

- Default: human-readable, color when stdout is a TTY (detect with
  `process.stdout.isTTY`, respect `NO_COLOR`).
- Machine: every command accepts `--json`. When set:
  - All normal output goes to stdout as a single JSON document on one line.
  - All diagnostics go to stderr as plain text.
  - Exit codes are meaningful and documented per command (see `src/exit.ts`).
- `agent-plugin` skills shell out with `--json` exclusively and parse stdout.

## 5. Build pipeline

- **Dev**: pnpm. `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm build` (tsdown → `dist/cli.mjs`, used for npm install path).
- **Binaries**: `bun build --compile --target=<target>` via
  `scripts/build-bin.ts`, output `dist-bin/ait-console-<os>-<arch>[.exe]`.
  - Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
    `windows-x64`. (No `windows-arm64` — Bun support is still partial.)
- **Version embedding**: build-time `AIT_CONSOLE_VERSION` define reads
  `package.json`'s `version`. Both tsdown and Bun compile paths inject it.

## 6. Distribution channels

Three install paths, ranked by expected usage:

1. **GitHub Releases binary via `install.sh`** (primary for humans).
   - `curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | sh`
   - Detects OS (`uname -s`) and arch (`uname -m`), maps to the binary name,
     downloads the release asset from
     `https://github.com/apps-in-toss-community/console-cli/releases/latest/download/<name>`,
     verifies with `shasum -a 256 -c` against the `SHA256SUMS` asset, installs
     to `$HOME/.local/bin/ait-console` (0755), and prints a PATH hint.
   - Optional `AIT_CONSOLE_VERSION=v0.1.1 install.sh` pin.
2. **npm global** (`npm i -g @ait-co/console-cli`). Ships `dist/cli.mjs`,
   which requires a Node 24 runtime. This is the path `agent-plugin` uses
   when a project already has Node installed.
3. **Homebrew tap** — deferred. Not in scope for 0.1.x.

### 6.1 Why publish to npm if binaries are primary?

Two reasons:
1. `agent-plugin` already assumes Node is on the user's PATH (it runs under a
   coding agent in a dev environment). Shipping via npm lets the plugin declare
   `@ait-co/console-cli` as a peer and let users install it with their existing
   package manager — no separate installer pitch inside a skill.
2. TypeScript consumers (future programmatic use from other tools in the org)
   can `import type { DeployResult } from '@ait-co/console-cli'` without us
   spinning up a separate `@ait-co/console-cli-types` package. `dist/` includes
   `.d.mts` via tsdown.

Both paths are kept in sync by Changesets — version bump happens once, `npm
publish` and the binary release are both driven by the same tag.

## 7. Self-update (`ait-console upgrade`)

Algorithm:
1. `GET https://api.github.com/repos/apps-in-toss-community/console-cli/releases/latest`
   (no auth; public repo). Respect `GITHUB_TOKEN` env if set to avoid
   anonymous rate limits.
2. Parse `tag_name` (strip leading `v`). Compare to embedded version. If
   equal, print "already up to date" and exit 0. `--force` bypasses the check.
3. Locate the current executable path. Under Bun's compiled binary,
   `process.execPath` is the binary itself. Under npm/Node,
   `process.execPath` is `node` — in that case we refuse to self-upgrade and
   tell the user to `npm i -g @ait-co/console-cli@latest`.
4. Pick the right asset name from platform/arch, download to
   `<exePath>.new.<timestamp>`.
5. Verify SHA-256 against the `SHA256SUMS` asset.
6. `chmod 0755`, then **atomic replace**: `fs.renameSync(new, exePath)`.
   POSIX `rename(2)` is atomic on the same filesystem. On Windows we can't
   rename a running exe, so we `rename` the current exe to `<exePath>.old`,
   rename `<new>` to `<exePath>`, and schedule the `.old` for deletion on next
   start (simple "clean stale `.old` on boot" check).
7. Re-exec the new binary with `--version` as a smoke test.

## 8. Release flow

- **Type A** per umbrella policy. `.changeset/` is active.
- Trigger: merging a "Version Packages" PR on `main`.
- `changesets/action`:
  1. Bumps `package.json` version and updates CHANGELOG.
  2. Runs `npm publish --provenance --access public`.
  3. Creates a GitHub Release with the tag `@ait-co/console-cli@x.y.z`.
- **New**: on release creation, a separate workflow (`release-binaries.yml`)
  runs matrix builds on Linux/macOS/Windows, produces the binaries and a
  `SHA256SUMS` file, and uploads them as assets on the just-created release
  using `gh release upload`.
- `install.sh` reads `releases/latest`, so users always get the most recent
  version unless they pin with `AIT_CONSOLE_VERSION`.

## 9. `install.sh` dry-run

Reasoning through the script without running it:

- `set -eu` — fail fast, no unset vars.
- `uname -s` → `Linux`|`Darwin` (mapped), else abort with a helpful message.
- `uname -m` → `x86_64`→`x64`, `arm64`/`aarch64`→`arm64`, else abort.
- Binary name: `ait-console-<os>-<arch>` (no `.exe` since we skip Windows in
  shell; Windows users should use WSL or grab the `.exe` manually).
- Download URL pattern:
  `https://github.com/apps-in-toss-community/console-cli/releases/latest/download/<name>`
  and `.../SHA256SUMS`.
- Verify: `grep " $NAME$" SHA256SUMS | shasum -a 256 -c -`. Aborts on
  mismatch.
- Install dir: `${AIT_CONSOLE_INSTALL_DIR:-$HOME/.local/bin}`. Create with
  `mkdir -p`, `chmod 0755` the binary, `mv` into place.
- PATH hint: if `command -v ait-console` returns empty post-install, print a
  one-liner to add the dir to `$PATH` for bash/zsh/fish.
- Quiet mode via `AIT_CONSOLE_QUIET=1` suppresses non-error output (for piped
  installers in setup scripts).

Edge cases exercised mentally:
- CI runner with no `$HOME` → export fallback to `/tmp` (unusual but survives).
- `shasum` missing (Linux distros) → fall back to `sha256sum`.
- 404 on asset (race between release creation and asset upload) → retry with
  exponential backoff up to 30 s, then fail with "release binaries may still
  be uploading; try again in a minute."
- Existing binary owned by root (`sudo` install from older version) → detect
  and abort with instructions rather than failing mid-rename.

## 10. Open questions

- Where does `login` actually land the user? The developer console login page
  URL and the OAuth scopes are pending discovery. Until that's known, the
  `login` command stays stubbed.
- Do we want to sign the macOS binaries? Answer: not for 0.1.x. Users
  `chmod +x` and run with `xattr -d com.apple.quarantine` if Gatekeeper
  complains; document in README. Proper notarization is a 1.0 item.
- Do we want a `deploy` dry-run mode before wiring real automation? Yes —
  add `--dry-run` to all mutating commands from day one.
