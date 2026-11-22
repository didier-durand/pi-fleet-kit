#!/usr/bin/env bash
# Bundled script for the hello-world skill: prints a greeting with a timestamp,
# plus the current user and pi session id, proving that skills can carry and
# execute their own supporting files.
set -euo pipefail

name="${1:-World}"
user="$(id -un 2>/dev/null || whoami)"
session_id="${PI_SESSION_ID:-unknown}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hello, ${name}! — executed from skills/hello-world/scripts/hello.sh"
echo "current user: ${user}"
echo "current session id: ${session_id}"
