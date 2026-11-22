#!/usr/bin/env bash
# Launch one Pi agent in its Docker sandbox — at most one instance per agent.
#
# Used by the Warp tab configs (and agents_start.sh). If a container for the
# agent is already running — e.g. its tab is already open in Warp — print a
# notice and exit instead of starting a second copy, so repeated launches
# never produce duplicate agent tabs or agent processes.
#
# The container gets a fixed name (the agent's name), so even in a race
# (e.g. a double-click opening two tabs at once) Docker itself refuses the
# duplicate container name: a second instance cannot start.
#
# Usage:
#   agent_run.sh pi-coding      # hyphens or underscores both accepted

set -euo pipefail

WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${PI_COMPOSE_FILE:-$WARP_DIR/../compose.yml}"
ALL_AGENTS=(pi-configs pi-coding pi-research pi-personal)

[[ $# -eq 1 ]] || { echo "usage: $0 <agent>  (one of: ${ALL_AGENTS[*]})" >&2; exit 1; }
agent="${1//_/-}"

known_agent() {
  local a
  for a in "${ALL_AGENTS[@]}"; do [[ "$a" == "$agent" ]] && return 0; done
  return 1
}
known_agent || { echo "error: unknown agent '$agent' (expected one of: ${ALL_AGENTS[*]})" >&2; exit 1; }

# Single-instance guard: `docker compose run` containers carry the
# com.docker.compose.service label, so this detects the agent whether it was
# started from a Warp tab or straight from the CLI.
if running="$(docker ps --filter "label=com.docker.compose.service=$agent" --format '{{.Names}}' 2>/dev/null)" && [[ -n "$running" ]]; then
  echo "'$agent' is already running (container: $running) — not starting a second copy."
  echo "Close its tab first, or use /new inside that pi session for a fresh start."
  exit 0
fi

exec docker compose -f "$COMPOSE_FILE" run --rm --name "$agent" "$agent"
