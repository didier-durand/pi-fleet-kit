#!/usr/bin/env bash
# Launch one Pi agent in its Docker sandbox — at most one instance per agent.
#
# Used by the Warp tab configs and agents_start.sh. If the agent is already
# running in an open tab, print a notice and exit instead of starting a
# second copy, so repeated launches never produce duplicate agent tabs or
# agent processes.
#
# How "already running in an open tab" is detected:
#   - Closing a Warp tab kills the docker *client* but NOT its container,
#     which keeps running headless (an "orphan"). A running container alone
#     therefore does NOT prove a tab is open.
#   - Before starting an agent, this script touches a heartbeat file and
#     leaves a small background loop refreshing it every 5s. The loop dies
#     with the tab (it watches the docker client's PID), so a fresh
#     heartbeat = open tab; a stale heartbeat + live container = orphan.
#   - Orphans are removed automatically, then a fresh tab is opened.
#
# The container also gets a fixed name (the agent's name) plus a fleet
# label, so even in a race (two tabs opening at once) Docker itself refuses
# the duplicate container name. Containers started manually (plain
# `docker compose run`, no fleet label) are never touched: they count as
# "in use", so the icon just skips that agent.
#
# Usage:
#   agent_run.sh <agent>          # launch (or refuse if already up)
#   agent_run.sh --check <agent>  # exit 0 if the agent is up in a tab, 1 if not
#                                 # (heals orphans first)
#
# Docker is looked up on PATH *and* in the usual install locations: this
# script may be invoked from launchers (Automator apps, etc.) whose PATH
# does not include /usr/local/bin or /opt/homebrew/bin.

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PI_COMPOSE_FILE:-$WARP_DIR/../compose.yml}"
HB_DIR="${PI_HEARTBEAT_DIR:-$HOME/.pi-agent-fleet}"
FRESH_SECS=15   # heartbeat is refreshed every 5s; older than this = stale
FLEET_LABEL="pi.agent.fleet=1"
ALL_AGENTS=(pi-configs pi-coding pi-research pi-personal)

# --- Parse arguments ----------------------------------------------------------

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && { CHECK_ONLY=1; shift; }

[[ $# -eq 1 ]] || { echo "usage: $0 [--check] <agent>  (one of: ${ALL_AGENTS[*]})" >&2; exit 1; }
agent="${1//_/-}"
hb="$HB_DIR/heartbeat.$agent"

known_agent() {
  local a
  for a in "${ALL_AGENTS[@]}"; do [[ "$a" == "$agent" ]] && return 0; done
  return 1
}
known_agent || { echo "error: unknown agent '$agent' (expected one of: ${ALL_AGENTS[*]})" >&2; exit 1; }

# --- Locate docker (PATH may be minimal in launcher contexts) ---------------

docker_bin() {
  local p
  command -v docker >/dev/null 2>&1 && { command -v docker; return 0; }
  for p in /usr/local/bin/docker /opt/homebrew/bin/docker "$HOME/.docker/bin/docker" /usr/bin/docker; do
    [[ -x "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}
DOCKER="$(docker_bin)" || { echo "error: docker not found (is Docker Desktop installed?)" >&2; exit 1; }

# --- Container / heartbeat state ----------------------------------------------

# Running containers for this agent started OUTSIDE this launcher (plain
# `docker compose run`: no fleet label). Never touched; count as in-use.
ext_running() {
  [[ -n "$("$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --format '{{.ID}}' 2>/dev/null)" ]] || return 1
  [[ -z "$("$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --filter "label=$FLEET_LABEL" --format '{{.ID}}' 2>/dev/null)" ]]
}

# Running containers started BY this launcher (fleet label).
fleet_running() {
  [[ -n "$("$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --filter "label=$FLEET_LABEL" --format '{{.ID}}' 2>/dev/null)" ]]
}

# Container with the agent's fixed name in any state (created, exited).
named_exists() {
  [[ -n "$("$DOCKER" ps -a --filter "name=^${agent}$" --format '{{.ID}}' 2>/dev/null)" ]]
}

file_mtime() {  # portable: macOS stat first, GNU stat fallback
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# Fresh heartbeat = an open tab's loop touched it recently.
heartbeat_fresh() {
  [[ -f "$hb" ]] || return 1
  local age=$(( $(date +%s) - "$(file_mtime "$hb")" ))
  (( age <= FRESH_SECS ))
}

# True if the agent is up in an open tab (or in use elsewhere), i.e. a new
# tab must NOT be opened for it.
agent_up() {
  ext_running && return 0
  heartbeat_fresh || return 1
  fleet_running || named_exists
}

# Remove containers this launcher started but that no tab claims anymore
# (tab closed without stopping the container), plus fixed-name leftovers.
heal_orphans() {
  if fleet_running && ! heartbeat_fresh; then
    echo "note: '$agent' has a container but no open tab claims it — removing orphan container" >&2
    "$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --filter "label=$FLEET_LABEL" -q 2>/dev/null \
      | xargs "$DOCKER" rm -f >/dev/null 2>&1 || true
  fi
  if named_exists && ! fleet_running; then
    "$DOCKER" rm -f "$agent" >/dev/null 2>&1 || true
  fi
}

# --- Run ----------------------------------------------------------------------

heal_orphans

if (( CHECK_ONLY )); then
  agent_up && exit 0 || exit 1
fi

if agent_up; then
  echo "'$agent' is already running in an open tab — not starting a second copy."
  echo "Use that tab, or /new inside that pi session for a fresh start."
  exit 0
fi

# Heartbeat: touch now, then refresh every 5s from a background loop that
# dies as soon as the docker client it watches is gone (tab closed, or the
# container exited). A stale heartbeat therefore means "no open tab".
mkdir -p "$HB_DIR"
touch "$hb"
parent=$$
(
  while sleep 5; do
    kill -0 "$parent" 2>/dev/null || exit 0          # client gone (tab closed / pi quit)
    comm="$(ps -p "$parent" -o comm= 2>/dev/null || true)"
    [[ -n "$comm" && "$comm" != *docker* ]] && exit 0  # PID reused: really gone
    mkdir -p "$HB_DIR" 2>/dev/null || true
    touch "$hb" 2>/dev/null || true
  done
) &

exec "$DOCKER" compose -f "$COMPOSE_FILE" run --rm --name "$agent" --label "$FLEET_LABEL" "$agent"
