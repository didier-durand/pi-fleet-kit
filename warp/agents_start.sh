#!/usr/bin/env bash
# Start all Pi agents in Warp, each in its own tab.
#
# For every agent defined in ../compose.yml (pi-configs, pi-coding,
# pi-research, pi-personal), this script:
#   1. (optionally) installs its Tab Config into Warp's config directory,
#      reusing tabs_install.sh (idempotent — only changed files are copied);
#   2. opens the config as a tab in Warp via the `warp://tab_config/<name>`
#      URI scheme. The tab itself runs the agent's `docker compose run` line,
#      so the agent starts inside its sandbox as the tab opens.
#
# Usage:
#   ./agents_start.sh                 # all agents, as tabs
#   ./agents_start.sh -w              # all agents, in a new Warp window
#   ./agents_start.sh pi-coding       # only the named agents
#   ./agents_start.sh -n pi-research pi-personal   # skip install, then open
#
# Options:
#   -w    open tabs in a new Warp window (default: new tabs in the focused
#         window; a new window is created anyway if none is open)
#   -n    skip the tab-config install step (useful if already installed)
#   -h    print usage
#
# Agent names may use hyphens (pi-coding) or underscores (pi_coding) —
# both map to the tab config of the same name.

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL_AGENTS=(pi-configs pi-coding pi-research pi-personal)

NEW_WINDOW=0
NO_INSTALL=0

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while getopts ":wnh" opt; do
  case "$opt" in
    w) NEW_WINDOW=1 ;;
    n) NO_INSTALL=1 ;;
    h) usage; exit 0 ;;
    *) echo "Usage: $0 [-w] [-n] [agent ...]" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

# Normalize names (underscores -> hyphens) and build the selection.
# NOTE: no `declare -A` here — macOS still ships bash 3.2, which lacks
# associative arrays.
known_agent() {
  local n="$1" a
  for a in "${ALL_AGENTS[@]}"; do [[ "$a" == "$n" ]] && return 0; done
  return 1
}
agents=()
if (( $# )); then
  for arg in "$@"; do
    name="${arg//_/-}"
    if ! known_agent "$name"; then
      echo "error: unknown agent '$arg' (expected one of: ${ALL_AGENTS[*]})" >&2
      exit 1
    fi
    agents+=("$name")
  done
else
  agents=("${ALL_AGENTS[@]}")
fi

# --- Platform helpers -------------------------------------------------------

OS="$(uname -s)"

default_tab_configs_dir() {
  case "$OS" in
    Darwin) echo "$HOME/.warp/tab_configs" ;;
    Linux)  echo "${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs" ;;
    MINGW*|MSYS*|CYGWIN*)
      # Windows (Git Bash / MSYS); %APPDATA%\warp\Warp\data\tab_configs\
      echo "${APPDATA}\\warp\\Warp\\data\\tab_configs" ;;
    *) echo "" ;;
  esac
}

open_uri() {
  local uri="$1"
  case "$OS" in
    Darwin) command -v open >/dev/null && open "$uri" || { echo "error: 'open' not found" >&2; return 1; } ;;
    Linux)  command -v xdg-open >/dev/null && xdg-open "$uri" || { echo "error: 'xdg-open' not found (install xdg-utils)" >&2; return 1; } ;;
    MINGW*|MSYS*|CYGWIN*) start "" "$uri" ;;
    *) echo "error: unsupported platform '$OS' — open $uri manually" >&2; return 1 ;;
  esac
}

# --- 1. Install tab configs (idempotent) ------------------------------------

if (( ! NO_INSTALL )); then
  dest="${TAB_CONFIGS_DIR:-$(default_tab_configs_dir)}"
  if [[ -z "$dest" ]]; then
    echo "warning: unknown platform for tab-config dir; set TAB_CONFIGS_DIR and rerun tabs_install.sh" >&2
  else
    echo "Installing tab configs (if changed) into: $dest"
    TAB_CONFIGS_DIR="$dest" "$WARP_DIR/tabs_install.sh"
  fi
fi

# --- 2. Open one tab per agent ----------------------------------------------

echo
echo "Opening ${#agents[@]} agent tab(s) in Warp:"
for agent in "${agents[@]}"; do
  uri="warp://tab_config/${agent//-/_}"
  (( NEW_WINDOW )) && uri="$uri?new_window=true"
  if open_uri "$uri"; then
    echo "  started: $agent  ($uri)"
  else
    echo "  FAILED:  $agent" >&2
  fi
done

echo
echo "Done. Each tab runs its agent's 'docker compose run' command in its sandbox."
