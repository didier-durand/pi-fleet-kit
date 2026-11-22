#!/usr/bin/env bash
# Launch one Pi agent in its Docker sandbox — at most one instance per agent.
#
# Used by the Warp tab configs and agents_start.sh. If a container for the
# agent already exists (e.g. its tab is already open), print a notice and
# exit instead of starting a second copy, so repeated launches never
# produce duplicate agent tabs or agent processes.
#
# The container gets a fixed name (the agent's name): even in a race
# (e.g. two tabs opening at the same moment), Docker itself refuses the
# duplicate container name — a second instance cannot start.
#
# Usage:
#   agent_run.sh <agent>          # launch (or refuse if already up)
#   agent_run.sh --check <agent>  # exit 0 if the agent is up, exit 1 if not
#
# Docker is looked up on PATH *and* in the usual install locations: this
# script may be invoked from launchers (Automator apps, etc.) whose PATH
# does not include /usr/local/bin or /opt/homebrew/bin.

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PI_COMPOSE_FILE:-$WARP_DIR/../compose.yml}"
ALL_AGENTS=(pi-configs pi-coding pi-research pi-personal)

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

# --- Parse arguments ----------------------------------------------------------

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && { CHECK_ONLY=1; shift; }

[[ $# -eq 1 ]] || { echo "usage: $0 [--check] <agent>  (one of: ${ALL_AGENTS[*]})" >&2; exit 1; }
agent="${1//_/-}"

known_agent() {
  local a
  for a in "${ALL_AGENTS[@]}"; do [[ "$a" == "$agent" ]] && return 0; done
  return 1
}
known_agent || { echo "error: unknown agent '$agent' (expected one of: ${ALL_AGENTS[*]})" >&2; exit 1; }

# --- Single-instance guard ----------------------------------------------------

# True if the agent already has a container: either a *running* container
# carrying the compose service label (started from a tab or the CLI), or a
# container with the agent's fixed name in ANY state (created, starting) —
# the latter closes the race between two tabs opening at the same moment.
agent_up() {
  [[ -n "$("$DOCKER" ps --filter "label=com.docker.compose.service=$agent" --format '{{.Names}}' 2>/dev/null)" ]] && return 0
  [[ -n "$("$DOCKER" ps -a --filter "name=^${agent}$" --format '{{.Names}}' 2>/dev/null)" ]] && return 0
  return 1
}

if (( CHECK_ONLY )); then
  agent_up && exit 0 || exit 1
fi

if agent_up; then
  echo "'$agent' is already running — not starting a second copy."
  echo "Use its existing tab (or /new inside that pi session for a fresh start)."
  echo "If NO tab shows it (orphaned container), reset with: docker rm -f $agent"
  exit 0
fi

exec "$DOCKER" compose -f "$COMPOSE_FILE" run --rm --name "$agent" "$agent"
