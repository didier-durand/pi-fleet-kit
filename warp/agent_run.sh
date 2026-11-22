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
#     with the tab (it watches the docker client's PID) and deletes the
#     heartbeat on exit, so: fresh heartbeat = open tab.
#   - Before launching (or before reporting state with --check), EVERY
#     container for this agent that is NOT claimed by an open tab is
#     removed first. Unclaimed = orphans left by closed tabs, duplicate
#     instances from older versions of this setup (random names, no fleet
#     label), or manual `docker compose run` sessions — none has a fresh
#     heartbeat. One click therefore converges to exactly one container
#     per agent.
#   - The launched container also gets a fixed name (the agent's name) and
#     a fleet label, so even in a race (two tabs opening at once) Docker
#     itself refuses the duplicate container name.
#
# Usage:
#   agent_run.sh <agent>          # clean up unclaimed, then launch
#   agent_run.sh --check <agent>  # clean up unclaimed, then exit 0 if the
#                                 # agent is up in a tab, exit 1 if not
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

# --- Locate docker (PATH may be minimal in launcher contexts) -----------------

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

# Running containers for this agent, all launchers / versions combined.
all_ids()   { "$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --format '{{.ID}}' 2>/dev/null; }

# Running containers started by THIS launcher (fleet label).
fleet_ids() { "$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --filter "label=$FLEET_LABEL" --format '{{.ID}}' 2>/dev/null; }

# Running container with the agent's fixed name, if any.
named_id()  { "$DOCKER" ps --filter "name=^${agent}$" --format '{{.ID}}' 2>/dev/null; }

# Container with the agent's fixed name in any state (created, exited).
named_exists() { [[ -n "$("$DOCKER" ps -a --filter "name=^${agent}$" --format '{{.ID}}' 2>/dev/null)" ]]; }

file_mtime() {  # portable: macOS stat first, GNU stat fallback; validates output
  local t=""
  t="$(stat -f %m "$1" 2>/dev/null || true)"
  case "$t" in ''|*[!0-9]*) t="$(stat -c %Y "$1" 2>/dev/null || true)" ;; esac
  case "$t" in ''|*[!0-9]*) t=0 ;; esac
  echo "$t"
}

# Fresh heartbeat = an open tab's loop touched it recently.
heartbeat_fresh() {
  [[ -f "$hb" ]] || return 1
  (( $(date +%s) - "$(file_mtime "$hb")" <= FRESH_SECS ))
}

# An open tab claims the agent: fresh heartbeat + our container running.
claimed() { heartbeat_fresh && [[ -n "$(fleet_ids)" ]]; }

# Agent is up (in a tab, or mid-launch race): fresh heartbeat + container.
agent_up() { heartbeat_fresh && { [[ -n "$(fleet_ids)" ]] || named_exists; }; }

# --- Cleanup before launch ----------------------------------------------------

# Remove every container for this agent that is not claimed by an open tab:
#   - claimed: keep the tab's container, drop any OTHER running duplicate
#     (legacy instance from an older launcher version, manual run).
#   - unclaimed: drop ALL running containers (orphans, duplicates, manual).
# Plus fixed-name leftovers in a non-running state (created, exited).
heal_unclaimed() {
  local id keep
  if claimed; then
    local keep fleet_list in_fleet f
    keep="$(named_id)"
    fleet_list="$(fleet_ids)"
    for id in $(all_ids); do
      [[ "$id" == "$keep" ]] && continue
      in_fleet=0
      for f in $fleet_list; do [[ "$id" == "$f" ]] && { in_fleet=1; break; }; done
      (( in_fleet )) && continue   # our own container: keep
      echo "note: '$agent': removing duplicate container $id" >&2
      "$DOCKER" rm -f "$id" >/dev/null 2>&1 || true
    done
  else
    for id in $(all_ids); do
      echo "note: '$agent': removing unclaimed container $id (orphan / duplicate / manual run)" >&2
      "$DOCKER" rm -f "$id" >/dev/null 2>&1 || true
    done
  fi
  if [[ -z "$(named_id)" ]] && named_exists; then
    "$DOCKER" rm -f "$agent" >/dev/null 2>&1 || true
  fi
}

# --- Run ----------------------------------------------------------------------

heal_unclaimed

if (( CHECK_ONLY )); then
  agent_up && exit 0 || exit 1
fi

if agent_up; then
  echo "'$agent' is already running in an open tab — not starting a second copy."
  echo "Use that tab, or /new inside that pi session for a fresh start."
  exit 0
fi

# Heartbeat: touch now, then refresh every 5s from a background loop that
# dies (and deletes the heartbeat) as soon as the docker client it watches
# is gone — tab closed, or the container exited. No heartbeat therefore
# means "no open tab", and the next click cleans up before relaunching.
mkdir -p "$HB_DIR"
touch "$hb"
parent=$$
(
  while sleep 5; do
    if ! kill -0 "$parent" 2>/dev/null; then rm -f "$hb" 2>/dev/null; exit 0; fi
    comm="$(ps -p "$parent" -o comm= 2>/dev/null || true)"
    if [[ -n "$comm" && "$comm" != *docker* ]]; then rm -f "$hb" 2>/dev/null; exit 0; fi
    mkdir -p "$HB_DIR" 2>/dev/null || true
    touch "$hb" 2>/dev/null || true
  done
) &

exec "$DOCKER" compose -f "$COMPOSE_FILE" run --rm --name "$agent" --label "$FLEET_LABEL" "$agent"
