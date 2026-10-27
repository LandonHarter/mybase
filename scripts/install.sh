#!/bin/sh
# Installs the mybase CLI (a standalone binary, no runtime needed) from GitHub releases.
#   curl -fsSL https://raw.githubusercontent.com/landonharter/mybase/master/scripts/install.sh | sh
# MYBASE_VERSION=0.1.0 picks a version (default: latest); MYBASE_INSTALL_DIR sets where (default ~/.local/bin).
set -eu

repo="landonharter/mybase"
dir="${MYBASE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "mybase: unsupported OS $(uname -s). On Windows, download mybase-windows-x64.exe from https://github.com/$repo/releases" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "mybase: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

if [ -n "${MYBASE_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/v$MYBASE_VERSION/mybase-$os-$arch"
else
  url="https://github.com/$repo/releases/latest/download/mybase-$os-$arch"
fi

mkdir -p "$dir"
tmp="$(mktemp)"
echo "Downloading $url"
curl -fSL --progress-bar "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dir/mybase"
echo "Installed $("$dir/mybase" version 2>/dev/null | head -n 1 || echo mybase) to $dir/mybase"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add it to your PATH: export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Next: mybase login --url <your mybase URL>"
