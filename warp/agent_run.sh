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
#   - Before starting an agent, this script writes a heartbeat file
#     containing the docker client's PID and leaves a small background loop
#     watching that PID. The heartbeat is PID-based (not time-based): an
#     agent counts as "claimed by an open tab" only while its client PID is
#     still alive. Closing the tab kills the client, so the claim lapses
#     IMMEDIATELY — no staleness window.
#   - Before launching (or before reporting state with --check), EVERY
#     container for this agent that is not claimed by an open tab is removed
#     first: orphans left by closed tabs, duplicate instances from older
#     versions of this setup, and manual `docker compose run` sessions.
#     One click therefore converges to exactly one container per agent.
#   - The launched container also gets a fixed name (the agent's name) and
#     a fleet label, so even in a race (two tabs opening at once) Docker
#     itself refuses the duplicate container name.
#
# Usage:
#   agent_run.sh <agent>          # heal own unclaimed containers, then launch
#   agent_run.sh --check <agent>  # READ-ONLY: exit 0 if the agent is up in a
#                                 # tab, exit 1 if not — never removes anything
#
# Healing (container removal) happens ONLY in the launch path, and only for
# the agent being launched. --check is used by agents_start.sh for ALL agents
# on every click, so it must be side-effect-free: a wrong negative there
# would otherwise destroy other agents' healthy containers.
#
# Docker is looked up on PATH *and* in the usual install locations: this
# script may be invoked from launchers (Automator apps, etc.) whose PATH
# does not include /usr/local/bin or /opt/homebrew/bin.

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PI_COMPOSE_FILE:-$WARP_DIR/../compose.yml}"
HB_DIR="${PI_HEARTBEAT_DIR:-$HOME/.pi-agent-fleet}"
FRESH_SECS=20   # claim needs a heartbeat touched within this window
                # (the tab's watcher refreshes every 5s; wide enough to
                # survive brief system stalls/sleep, tight enough to kill
                # PID-reuse false positives in seconds)
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

# True if the open tab's docker client (PID recorded in the heartbeat file)
# is still alive. PID-based: closing the tab kills the client, so the claim
# lapses immediately — no time window, no staleness race.
# Zombie-aware: a closed tab's client can linger as a ZOMBIE (dead but not
# yet reaped). Zombies still answer `kill -0` and show an empty `ps comm`,
# so both must be treated as DEAD — otherwise the claim would never lapse
# and the agent's tab could never be reopened. `ps -o state=` decides:
# empty (gone) or Z (zombie) => claim dead.
# ANY running container of the agent counts as evidence (not just fleet-
# labeled ones): containers predating the label scheme must not look
# "absent" and get destroyed; they just make the agent look busy.
heartbeat_alive() {
  [[ -f "$hb" ]] || return 1
  # mtime must be fresh: the tab's watcher touches it every 5s. A stale file
  # means the watcher is gone (tab closed / SIGKILLed) even if macOS has
  # since RECYCLED the recorded PID into some other process — the mtime
  # check defeats that false positive completely.
  local m="$(file_mtime "$hb")"
  (( $(date +%s) - m <= FRESH_SECS )) || return 1
  local pid state comm
  pid="$(cat "$hb" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -p "$pid" -o state= 2>/dev/null || true)"
  case "$state" in ''|Z*) return 1 ;; esac   # gone or zombie => claim dead
  comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  [[ -z "$comm" || "$comm" == *docker* ]]
}

file_mtime() {  # portable; validates output (some stat builds print labels)
  local t=""
  t="$(stat -f %m "$1" 2>/dev/null || true)"
  case "$t" in ''|*[!0-9]*) t="$(stat -c %Y "$1" 2>/dev/null || true)" ;; esac
  case "$t" in ''|*[!0-9]*) t=0 ;; esac
  echo "$t"
}

# An open tab claims the agent: a live client + at least one container.
claimed() { heartbeat_alive && { [[ -n "$(fleet_ids)" ]] || [[ -n "$(all_ids)" ]]; }; }

# Agent is up (in a tab, or mid-launch: client alive + container exists).
agent_up() { heartbeat_alive && { [[ -n "$(fleet_ids)" ]] || [[ -n "$(all_ids)" ]] || named_exists; }; }

# --- Cleanup before launch ----------------------------------------------------

# Remove every container for this agent that is not claimed by an open tab:
#   - claimed: keep the tab's container, drop OTHER running duplicates
#     (legacy instances from older launcher versions, manual runs).
#   - unclaimed: drop ALL running containers (orphans, duplicates, manual).
#   - fixed-name leftovers in a non-running state (created, exited) are
#     removed only when NO live client claims the agent — a tab whose
#     container is still being created has a live client and is protected.
heal_unclaimed() {
  local id keep fleet_list in_fleet f
  if claimed; then
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
  if [[ -z "$(named_id)" ]] && named_exists && ! heartbeat_alive; then
    "$DOCKER" rm -f "$agent" >/dev/null 2>&1 || true
  fi
}

# --- Run ----------------------------------------------------------------------

if (( CHECK_ONLY )); then
  # READ-ONLY: never heal from a check — agents_start.sh checks every agent
  # on every click, and a wrong negative here must not kill healthy tabs.
  agent_up && exit 0 || exit 1
fi

# Launch path: heal only THIS agent's unclaimed containers. Other agents'
# containers are never touched from here.
heal_unclaimed

if agent_up; then
  echo "'$agent' is already running in an open tab — not starting a second copy."
  echo "Use that tab, or /new inside that pi session for a fresh start."
  exit 0
fi

# Heartbeat: record this tab's docker client PID (the PID survives the exec
# below), then watch it from a background loop. When the tab closes (or the
# container exits), the client dies; the loop then removes the heartbeat —
# but only if it is still ours (another tab may have claimed the agent since).
mkdir -p "$HB_DIR"
parent=$$
echo "$parent" > "$hb"   # also sets mtime: claim valid immediately
(
  while sleep 5; do
    # Dead OR zombie parent => the tab is gone; release the claim.
    state="$(ps -p "$parent" -o state= 2>/dev/null || true)"
    if [[ -z "$state" || "$state" == Z* ]] || ! kill -0 "$parent" 2>/dev/null; then
      if [[ "$(cat "$hb" 2>/dev/null || true)" == "$parent" ]]; then rm -f "$hb" 2>/dev/null || true; fi
      exit 0
    fi
    comm="$(ps -p "$parent" -o comm= 2>/dev/null || true)"
    if [[ -n "$comm" && "$comm" != *docker* ]]; then
      if [[ "$(cat "$hb" 2>/dev/null || true)" == "$parent" ]]; then rm -f "$hb" 2>/dev/null || true; fi
      exit 0
    fi
    if [[ "$(cat "$hb" 2>/dev/null || true)" == "$parent" ]]; then
      touch "$hb" 2>/dev/null || true   # keep mtime recent (human-readable liveness)
    fi
  done
) &

exec "$DOCKER" compose -f "$COMPOSE_FILE" run --rm --name "$agent" --label "$FLEET_LABEL" "$agent"
