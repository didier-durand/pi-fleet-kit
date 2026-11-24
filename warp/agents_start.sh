#!/usr/bin/env bash
# Start all Pi agents in Warp, each in its own tab.
#
# For every agent defined in ../compose.yml (pi-fleet-kit, pi-coding-1,
# pi-review-1, pi-research, pi-personal), this script:
#   1. (optionally) installs its Tab Config into Warp's config directory,
#      reusing tabs_install.sh (idempotent — only changed files are copied);
#   2. opens the config as a tab in Warp via the `warp://tab_config/<name>`
#      URI scheme — but ONLY for agents that are not already up in an open
#      tab (detected via container + per-tab heartbeat). When an agent's
#      tab is (re)opened, agent_run.sh removes that agent's unclaimed
#      containers — orphans from closed tabs, duplicates from older setups,
#      manual runs — before launching. Checks are read-only: one agent's
#      cleanup never touches another agent's containers. If
#      EVERY requested agent is already up, the script just brings the
#      Warp window to the front and opens nothing at all — the expected
#      behavior of a second click on the fleet icon.
#   3. verifies the result: every requested agent must end up running in
#      exactly one tab. Missing agents are (re)opened on every click, so
#      any click converges to the desired state; a failure to start is
#      reported loudly.
#      The tab itself runs agent_run.sh, which starts the agent inside its
#      sandbox and enforces one instance per agent.
#
# Usage:
#   ./agents_start.sh                 # all agents, as tabs
#   ./agents_start.sh -w              # all agents, in a new Warp window
#   ./agents_start.sh pi-coding-1       # only the named agents
#   ./agents_start.sh -n pi-research pi-personal   # skip install, then open
#   ./agents_start.sh -R              # REORDER: stop the fleet, reopen ALL
#                                     # tabs in compose.yml order
#
# Options:
#   -w    open tabs in a new Warp window (default: new tabs in the focused
#         window; a new window is created anyway if none is open)
#   -n    skip the tab-config install step (useful if already installed)
#   -R    reorder: stop ALL agent containers, then reopen every tab in the
#         compose.yml order. Warp appends new tabs at the end of the bar and
#         offers no way to reposition them, so this is the only way to
#         restore the canonical order once tabs were opened out of order.
#         Sessions are preserved on disk: --continue resumes them.
#   -h    print usage
#
# Agent names may use hyphens (pi-coding-1) or underscores (pi_coding_1) —
# both map to the tab config of the same name.

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL_AGENTS=(pi-fleet-kit pi-coding-1 pi-coding-2 pi-review-1 pi-research pi-personal)

NEW_WINDOW=0
NO_INSTALL=0
REORDER=0

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while getopts ":wnRh" opt; do
  case "$opt" in
    w) NEW_WINDOW=1 ;;
    n) NO_INSTALL=1 ;;
    R) REORDER=1 ;;
    h) usage; exit 0 ;;
    *) echo "Usage: $0 [-w] [-n] [-R] [agent ...]" >&2; exit 1 ;;
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

# Bring the running Warp window to the front (no new window, no new tab).
focus_warp() {
  case "$OS" in
    Darwin) open -a Warp >/dev/null 2>&1 || true ;;
    Linux)  command -v wmctrl >/dev/null 2>&1 && wmctrl -xa Warp >/dev/null 2>&1 || true ;;
    *) true ;;
  esac
}

# True if a container for this agent is already up (i.e. its tab is already
# open). Delegates to agent_run.sh --check, which is strictly READ-ONLY: it
# only reports state (with the robust docker lookup, needed because
# launchers like Automator apps run this script with a minimal PATH).
# Container removal happens exclusively in agent_run.sh's launch path, and
# there only for the agent being launched — a click can thus never destroy
# other agents' healthy tabs.
agent_running() {
  "$WARP_DIR/agent_run.sh" --check "$agent" >/dev/null 2>&1
}

# --- Reorder mode: stop the fleet first, then reopen everything in order -----

if (( REORDER )); then
  echo "Reordering: stopping all agent containers (sessions kept on disk;"
  echo "tabs will resume them via --continue)."
  for agent in "${agents[@]}"; do
    "$WARP_DIR/agent_run.sh" --stop "$agent"
  done
fi

echo
echo "Opening agent tab(s) in Warp (skipping agents already running):"
opened=0
skipped=0
for agent in "${agents[@]}"; do
  if agent_running "$agent"; then
    echo "  skipped:  $agent (already running in an open tab)"
    skipped=$((skipped + 1))
    continue
  fi
  uri="warp://tab_config/${agent//-/_}"
  (( NEW_WINDOW )) && uri="$uri?new_window=true"
  if open_uri "$uri"; then
    echo "  started:  $agent  ($uri)"
    opened=$((opened + 1))
    # Brief pause so Warp processes the URIs in the order they are opened
    # (otherwise rapid-fire opens can land out of order).
    (( opened > 1 || skipped > 0 )) && sleep 0.7
  else
    echo "  FAILED:  $agent" >&2
  fi
done

echo
if (( REORDER )); then
  echo
  echo "Reorder done. New tabs are in compose.yml order at the end of the bar —"
  echo "close any old agent tabs left over (they now show a finished process)."
elif (( opened == 0 )); then
  echo "All requested agents are already running — focusing Warp (no new tabs)."
  focus_warp
else
  echo "Done: $opened started, $skipped skipped (already running)."
  echo "Each new tab runs agent_run.sh: one instance per agent, last session resumed."

  # Convergence check: ANY click must end with every requested agent up in
  # exactly one tab. Tabs just opened need a moment to boot their container,
  # so poll for up to ~10s before reporting a failure.
  echo
  echo "Verifying every requested agent is up..."
  verified=0
  for attempt in 1 2 3 4 5; do
    all_ok=1
    for a in "${agents[@]}"; do
      agent_running "$a" || all_ok=0
    done
    if (( all_ok )); then verified=1; break; fi
    sleep 2
  done
  if (( verified )); then
    echo "OK: all ${#agents[@]} requested agent(s) running, one instance each."
  else
    echo "WARNING: could not confirm some agent(s) are running — check their tabs for errors (docker down? image missing?)" >&2
  fi
fi
