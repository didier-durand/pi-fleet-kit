#!/usr/bin/env bash
# Install the Warp Tab Configs from this repo into the user's Warp config.
#
# Copies every tab_configs/*.toml into Warp's tab-config directory for the
# current platform (same detection as agents_start.sh):
#   macOS (stable):       $HOME/.warp/tab_configs/
#   Linux:                ${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/
#   Windows (Git Bash):   %APPDATA%\warp\Warp\data\tab_configs\
# Any platform: override with TAB_CONFIGS_DIR before running.
#
# Usage:
#   ./tabs_install.sh       # copy configs (skip identical files)
#   ./tabs_install.sh -f    # overwrite even if identical
#   TAB_CONFIGS_DIR=~/.warp-preview/tab_configs ./tabs_install.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/tab_configs" && pwd)"

# Platform-specific default, mirroring agents_start.sh (single source of
# truth would be nicer, but this must work standalone in plain bash):
os_default_tab_configs_dir() {
  case "$(uname -s)" in
    Darwin) echo "$HOME/.warp/tab_configs" ;;
    Linux)  echo "${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs" ;;
    MINGW*|MSYS*|CYGWIN*)
      # Windows (Git Bash / MSYS); %APPDATA%\warp\Warp\data\tab_configs\
      echo "${APPDATA}\\warp\\Warp\\data\\tab_configs" ;;
    *) echo "" ;;
  esac
}

DEST_DIR="${TAB_CONFIGS_DIR:-$(os_default_tab_configs_dir)}"
if [[ -z "$DEST_DIR" ]]; then
  echo "error: unsupported platform '$(uname -s)' — set TAB_CONFIGS_DIR explicitly" >&2
  exit 1
fi
FORCE=0

while getopts ":f" opt; do
  case "$opt" in
    f) FORCE=1 ;;
    *) echo "Usage: $0 [-f]" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$SRC_DIR" ]]; then
  echo "error: source directory not found: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

copied=0
skipped=0
for src in "$SRC_DIR"/*.toml; do
  [[ -e "$src" ]] || { echo "no .toml files in $SRC_DIR" >&2; exit 1; }
  name="$(basename "$src")"
  dest="$DEST_DIR/$name"
  if [[ -e "$dest" ]] && (( ! FORCE )) && cmp -s "$src" "$dest"; then
    echo "  unchanged: $name"
    skipped=$((skipped + 1))
  else
    cp -f "$src" "$dest"
    echo "  installed: $name -> $dest"
    copied=$((copied + 1))
  fi
done

echo
echo "Done: $copied installed, $skipped unchanged."
echo "New configs appear in Warp's '+' menu automatically."
