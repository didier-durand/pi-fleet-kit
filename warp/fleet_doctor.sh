#!/usr/bin/env bash
# Fleet doctor: diagnose why a closed agent's tab does not reopen.
# Usage: fleet_doctor.sh <agent>     (e.g. fleet_doctor.sh pi-coding-1)
# Safe to run anytime; it only READS state (no docker calls that modify).

set -u
AGENT="${1//_/-}"
WARP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fleet root: heartbeat dir and the repo's compose file derive from it.
FLEET_ROOT="${PI_FLEET_KIT_HOME:-$HOME}"
HB_DIR="${PI_HEARTBEAT_DIR:-$FLEET_ROOT/.pi-agent-fleet}"
HB="$HB_DIR/heartbeat.$AGENT"
DOCKER="docker"
command -v docker >/dev/null 2>&1 || DOCKER="/usr/local/bin/docker"
[[ -x "$DOCKER" ]] || DOCKER="/opt/homebrew/bin/docker"
[[ -x "$DOCKER" ]] && true || DOCKER="$HOME/.docker/bin/docker"
[[ -x "$DOCKER" ]] || DOCKER="/usr/bin/docker"
echo "0) docker binary used: ${DOCKER}"

echo "=== fleet doctor: $AGENT ==="
echo "1) heartbeat file: $HB"
if [[ -f "$HB" ]]; then
  pid="$(cat "$HB" 2>/dev/null || echo '?')"
  echo "   exists, recorded PID: $pid"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "   kill -0:            $(kill -0 "$pid" 2>/dev/null && echo ALIVE || echo DEAD)"
    echo "   ps state (Z=zombie):$(ps -p "$pid" -o state= 2>/dev/null || echo ' <no output>')"
    echo "   ps comm:            $(ps -p "$pid" -o comm= 2>/dev/null || echo ' <no output>')"
  fi
else
  echo "   MISSING (no claim — check should report 'down')"
fi
echo
echo "2) agent_run.sh --check result:"
"$WARP_DIR/agent_run.sh" --check "$AGENT" 2>&1
echo "   exit code: $?"
echo
echo "3) containers for this agent (docker ps):"
"$DOCKER" ps --filter "label=com.docker.compose.service=$AGENT" --format '   {{.ID}}  {{.Names}}  {{.Status}}' 2>&1
echo
echo "4) docker reachable: $("$DOCKER" ps >/dev/null 2>&1 && echo yes || echo NO)"
echo "5) compose file: $(ls "$WARP_DIR/../compose.yml" 2>/dev/null || echo 'NOT FOUND')"
echo "6) all heartbeats in $HB_DIR:"
ls -la "$HB_DIR" 2>/dev/null | grep -v '^total' | grep -v '^d' || echo "   (directory missing or empty)"
echo
echo "7) last fleet launch log (/tmp/pi-agent-fleet.log, from the app):"
tail -30 /tmp/pi-agent-fleet.log 2>/dev/null || echo "   (no log — the app has not launched agents yet)"
echo
echo "8) your shell's docker/PATH (for comparison):"
echo "   command -v docker: $(command -v docker || echo 'not on PATH')"
echo "   PATH: $PATH"
