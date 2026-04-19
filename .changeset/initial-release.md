---
'@ait-co/console-cli': minor
---

Initial 0.1.0 release of `ait-console`.

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
