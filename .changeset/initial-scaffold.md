---
'@ait-co/console-cli': patch
---

Add the initial CLI scaffold with `ait-console whoami` (reads local session
file) and `ait-console upgrade` (downloads the matching binary from the latest
GitHub release and atomically replaces itself). Both commands support `--json`
for machine-readable output. A second GitHub Actions workflow now builds
platform-specific binaries with `bun build --compile` for
Linux/macOS/Windows × x64/arm64 (windows-arm64 omitted) and attaches them —
plus a `SHA256SUMS` file — to the GitHub Release created by Changesets. The
repo-root `install.sh` detects OS/arch, verifies the checksum, and installs
to `$HOME/.local/bin`.
