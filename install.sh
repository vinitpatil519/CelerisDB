#!/bin/sh
# Installs the latest `celeris` release for Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/vinitpatil519/CelerisDB/main/install.sh | sh
#
# Environment:
#   CELERIS_VERSION      a release tag such as v0.1.0 (default: latest)
#   CELERIS_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
set -eu

REPO="vinitpatil519/CelerisDB"
VERSION="${CELERIS_VERSION:-latest}"
DEST="${CELERIS_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "celeris install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required"
}

need curl
need tar
need uname

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os_part="unknown-linux-gnu" ;;
  Darwin) os_part="apple-darwin" ;;
  *) fail "unsupported OS '$os' (use install.ps1 on Windows, or Docker)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch_part="x86_64" ;;
  arm64 | aarch64) arch_part="aarch64" ;;
  *) fail "unsupported CPU '$arch'" ;;
esac
target="$arch_part-$os_part"
asset="celeris-$target.tar.gz"

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset ($VERSION)..."
curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "download failed: $base/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256" || fail "checksum download failed"

expected=$(cut -d ' ' -f 1 <"$tmp/$asset.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

tar xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$DEST"
install -m 0755 "$tmp/celeris-$target/celeris" "$DEST/celeris"

echo "Installed $("$DEST/celeris" --version) to $DEST/celeris"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Add $DEST to your PATH to run 'celeris' directly." ;;
esac
echo "Next: celeris init && celeris start"
