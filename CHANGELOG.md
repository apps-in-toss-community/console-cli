# @ait-co/console-cli

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
