#!/bin/sh
# aitcc installer
#
# Downloads the latest aitcc binary for your OS/arch from GitHub
# Releases, verifies its SHA-256, and installs it to $HOME/.local/bin.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | sh
#
# Environment variables:
#   AITCC_VERSION        Pin to a specific tag (e.g. "v0.1.1"). Default: latest.
#   AITCC_INSTALL_DIR    Install location. Default: $HOME/.local/bin.
#   AITCC_QUIET=1        Suppress non-error output.

set -eu

REPO="apps-in-toss-community/console-cli"
INSTALL_DIR="${AITCC_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${AITCC_VERSION:-latest}"
QUIET="${AITCC_QUIET:-0}"

log() {
  [ "$QUIET" = "1" ] || printf '%s\n' "$*"
}

err() {
  printf 'aitcc installer: %s\n' "$*" >&2
}

die() {
  err "$*"
  exit 1
}

# -- detect OS ---------------------------------------------------------------
uname_s=$(uname -s)
case "$uname_s" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *)
    die "unsupported OS: $uname_s (Windows users: download the .exe from https://github.com/$REPO/releases)"
    ;;
esac

# -- detect arch -------------------------------------------------------------
uname_m=$(uname -m)
case "$uname_m" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *)
    die "unsupported arch: $uname_m"
    ;;
esac

binary="aitcc-${os}-${arch}"

# -- resolve download URLs ---------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/$REPO/releases/latest/download"
else
  base_url="https://github.com/$REPO/releases/download/${VERSION}"
fi
bin_url="$base_url/$binary"
sums_url="$base_url/SHA256SUMS"

# -- pick tools --------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL --retry 3 --retry-delay 2 --output "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -q -O "$2" "$1"; }
else
  die "need curl or wget"
fi

if command -v shasum >/dev/null 2>&1; then
  sha_check() { shasum -a 256 -c "$1"; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha_check() { sha256sum -c "$1"; }
else
  die "need shasum or sha256sum to verify the download"
fi

# -- stage to a temp dir -----------------------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t aitcc)
trap 'rm -rf "$tmp"' EXIT INT TERM

log "Downloading $binary..."
dl "$bin_url" "$tmp/$binary" || die "failed to download $bin_url"

log "Downloading SHA256SUMS..."
if ! dl "$sums_url" "$tmp/SHA256SUMS"; then
  err "could not fetch SHA256SUMS from $sums_url"
  err "the release may still be uploading; wait a minute and retry"
  exit 1
fi

# Keep only the line for our binary, then verify.
(
  cd "$tmp"
  grep " $binary\$" SHA256SUMS > SHA256SUMS.filtered || {
    err "no checksum entry for $binary in SHA256SUMS"
    exit 1
  }
  sha_check SHA256SUMS.filtered >/dev/null || {
    err "checksum mismatch for $binary — aborting"
    exit 1
  }
)

log "Checksum OK."

# -- install -----------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
dest="$INSTALL_DIR/aitcc"

# If an existing binary is root-owned and we're not root, bail with guidance.
if [ -f "$dest" ] && [ ! -w "$dest" ]; then
  die "existing $dest is not writable by the current user; remove it manually or re-run with sudo"
fi

chmod 0755 "$tmp/$binary"
mv "$tmp/$binary" "$dest"

# On macOS, strip the quarantine attribute (set by curl when downloading via
# Safari/Finder, no-op for direct shell download) and re-apply an ad-hoc
# signature as a safety net. Binaries built in CI are already ad-hoc signed,
# but a re-sign here is harmless and recovers the case where the CI signature
# was lost in transit.
if [ "$os" = "darwin" ]; then
  xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$dest" >/dev/null 2>&1 || true
  fi
fi

log "Installed to $dest"

# -- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    log "aitcc is on your PATH. Run: aitcc --version"
    ;;
  *)
    log ""
    log "NOTE: $INSTALL_DIR is not on your PATH."
    log "Add it to your shell profile, e.g.:"
    log "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
