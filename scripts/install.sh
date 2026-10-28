#!/bin/sh
# Installs the mybase CLI (a standalone binary, no runtime needed) from GitHub releases.
#   curl -fsSL https://raw.githubusercontent.com/landonharter/mybase/master/scripts/install.sh | sh
# With --setup (or MYBASE_SETUP=1) it then runs `mybase server setup` to install the server here.
# Without it, it offers to when Docker is installed and there's a terminal to ask on.
#   curl -fsSL https://raw.githubusercontent.com/landonharter/mybase/master/scripts/install.sh | sh -s -- --setup
# MYBASE_VERSION=0.1.0 picks a version (default: latest); MYBASE_INSTALL_DIR sets where (default ~/.local/bin).
set -eu

setup="${MYBASE_SETUP:-}"
for arg in "$@"; do
  case "$arg" in
    --setup) setup=1 ;;
    --no-setup) setup=0 ;;
  esac
done

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

# `curl | sh` uses stdin for the script, so prompts read from the terminal directly.
has_tty() { (exec </dev/tty) 2>/dev/null; }
if [ -z "$setup" ] && command -v docker >/dev/null 2>&1 && has_tty; then
  printf "Set up a mybase server on this machine now? [Y/n] "
  read -r answer </dev/tty || answer=n
  case "$answer" in
    "" | y | Y | yes | YES) setup=1 ;;
    *) setup=0 ;;
  esac
fi

if [ "$setup" = 1 ]; then
  if ! has_tty; then
    echo "mybase: --setup needs a terminal. Run \`$dir/mybase server setup\` yourself (or add --yes for defaults)." >&2
    exit 1
  fi
  exec "$dir/mybase" server setup </dev/tty
fi
echo "Next: mybase server setup (to run a server here), or mybase login --url <your mybase URL>"
