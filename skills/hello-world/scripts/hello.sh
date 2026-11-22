#!/usr/bin/env bash
# Bundled script for the hello-world skill: prints a greeting with a timestamp,
# proving that skills can carry and execute their own supporting files.
set -euo pipefail

name="${1:-World}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hello, ${name}! — executed from skills/hello-world/scripts/hello.sh"
