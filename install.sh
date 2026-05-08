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
#                        If unset and $HOME is also unset/missing, falls back
#                        to /tmp/aitcc-install (not on PATH by default).
#   AITCC_QUIET=1        Suppress non-error output.
#
# Asset 404s (release tag published but binary upload not yet visible) are
# retried with exponential backoff up to ~30s before giving up.

set -eu

REPO="apps-in-toss-community/console-cli"
VERSION="${AITCC_VERSION:-latest}"
QUIET="${AITCC_QUIET:-0}"

# -- resolve install dir -----------------------------------------------------
# `${AITCC_INSTALL_DIR:-...}` would treat an explicit empty export the same
# as unset, but we want to be explicit so that the "$HOME unset" warning
# fires for both `unset HOME` and `HOME=""` callers.
if [ -z "${AITCC_INSTALL_DIR:-}" ]; then
  if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
    INSTALL_DIR="$HOME/.local/bin"
  else
    INSTALL_DIR="/tmp/aitcc-install"
    # shellcheck disable=SC2016  # $HOME is intentionally literal in the message.
    printf 'aitcc installer: warning: $HOME is unset; falling back to %s (not on PATH by default)\n' \
      "$INSTALL_DIR" >&2
  fi
else
  INSTALL_DIR="$AITCC_INSTALL_DIR"
fi

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
# `dl_once` writes the URL body to $2 and prints the HTTP status code on
# stdout (or "000" if the transport itself failed). The wrapper `dl_retry`
# turns 404s — caused by the brief race between a release being tagged and
# its assets becoming visible on the CDN — into a bounded exponential
# backoff. Any other non-200 status fails fast: a 5xx or DNS failure won't
# fix itself by waiting, and silently retrying would mask real breakage.
if command -v curl >/dev/null 2>&1; then
  dl_once() {
    # `--retry 3` here covers transient transport hiccups (TLS reset etc.);
    # the explicit 404 retry sits one layer up.
    curl -sSL --retry 3 --retry-delay 2 \
      -o "$2" -w '%{http_code}' "$1" 2>/dev/null || printf '000'
  }
elif command -v wget >/dev/null 2>&1; then
  dl_once() {
    # wget exit codes: 0=ok, 8=server issued error response. Map both 404
    # and any other non-zero into a status string for dl_retry to inspect.
    if wget -q -O "$2" "$1" 2>/dev/null; then
      printf '200'
    else
      # `--spider` does a HEAD-equivalent so we can read the status without
      # re-downloading. Captured stderr lines look like "  HTTP/1.1 404 ...".
      status=$(wget --spider -S "$1" 2>&1 | awk '/^[ \t]*HTTP\// {code=$2} END {print code+0}')
      [ "$status" -gt 0 ] 2>/dev/null && printf '%s' "$status" || printf '000'
    fi
  }
else
  die "need curl or wget"
fi

# Retry only on 404. POSIX-only arithmetic; macOS BSD sleep accepts integer
# seconds. Total elapsed wait capped at ~30s (1+2+4+8+8+8 = 31).
dl_retry() {
  url=$1
  out=$2
  attempt=0
  total=0
  while :; do
    status=$(dl_once "$url" "$out")
    if [ "$status" = "200" ]; then
      return 0
    fi
    if [ "$status" != "404" ] || [ "$total" -ge 30 ]; then
      err "download failed: $url (status $status)"
      return 1
    fi
    delay=$((1 << attempt))
    if [ "$delay" -gt 8 ]; then
      delay=8
    fi
    log "asset not yet available (404), retrying in ${delay}s..."
    sleep "$delay"
    total=$((total + delay))
    attempt=$((attempt + 1))
  done
}

dl() { dl_retry "$1" "$2"; }

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
dl "$sums_url" "$tmp/SHA256SUMS" || die "failed to download $sums_url"

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
    codesign --force --sign - --options runtime --timestamp=none "$dest" >/dev/null 2>&1 || true
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

# -- shell completion hint ---------------------------------------------------
# We don't modify the user's rc files automatically — editing someone's
# shell config without asking is a line we'd rather not cross. Instead
# we detect the current shell and print the exact one-liner they can
# paste once. `aitcc completion <shell>` emits the script at runtime, so
# sourcing it via process substitution (bash) keeps the install
# idempotent: re-running picks up the latest aitcc's command tree.
shell_name="$(basename "${SHELL:-}")"
case "$shell_name" in
  bash)
    log ""
    log "Shell completion (bash): add this to ~/.bashrc:"
    log "  source <(aitcc completion bash)"
    ;;
  zsh)
    log ""
    log "Shell completion (zsh): run once, then open a fresh shell:"
    log "  aitcc completion zsh > \"\${fpath[1]}/_aitcc\""
    ;;
  fish)
    log ""
    log "Shell completion (fish): run once:"
    log "  aitcc completion fish > ~/.config/fish/completions/aitcc.fish"
    ;;
esac
