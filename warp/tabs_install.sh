#!/usr/bin/env bash
# Install the Warp Tab Configs from this repo into the user's Warp config.
#
# Copies every tab_configs/*.toml into $HOME/.warp/tab_configs/ (macOS
# stable; other platforms: set TAB_CONFIGS_DIR before running).
#
# Usage:
#   ./install.sh            # copy configs (skip identical files)
#   ./install.sh -f         # overwrite even if identical
#   TAB_CONFIGS_DIR=~/.warp-preview/tab_configs ./install.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/tab_configs" && pwd)"
DEST_DIR="${TAB_CONFIGS_DIR:-$HOME/.warp/tab_configs}"
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
