#!/usr/bin/env bash
# stream-to-receiver.sh — pi-obs OTEL stream, Leg 1: session -> piobs --otlp
# -> the throwaway OTLP/HTTP receiver (tests/otlp_receiver_main.ts), which
# captures every request for inspection. The quick, dependency-free way to
# see exactly what piobs would stream to a backend.
#
# Usage:
#   ./stream-to-receiver.sh <session-file> [options] [-- piobs flags]
#
# Options:
#   --port=<n>      receiver port (default: a free port is picked)
#   --out=<file>    captured-stream output (default: a temp file, printed)
#   --keep          keep the capture file (default: removed on exit)
#   -h, --help      this help
#
# Anything after "--" is passed to piobs report verbatim
# (e.g. -- --branch=<id> --capture-prompts).
#
# Exit codes: piobs's exit code (0 success, 1 replay error, 2 usage).
# No leftovers: the receiver process and temp files are always cleaned up.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PI_OBS_DIR=$SCRIPT_DIR   # the scripts live at the pi-obs package root

usage() {
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

SESSION=""
PORT=""
OUT=""
KEEP=false
PIOBS_FLAGS=""
while [ $# -gt 0 ]; do
	case "$1" in
		--port=*) PORT="${1#--port=}" ;;
		--out=*) OUT="${1#--out=}" ;;
		--keep) KEEP=true ;;
		-h|--help) usage 0 ;;
		--) shift; PIOBS_FLAGS="$*"; break ;;
		-*) echo "stream-to-receiver: unknown option $1 (try --help)" >&2; exit 2 ;;
		*) if [ -z "$SESSION" ]; then SESSION="$1"; else echo "stream-to-receiver: unexpected argument $1" >&2; exit 2; fi ;;
	esac
	shift
done
[ -n "$SESSION" ] || { echo "stream-to-receiver: a <session-file> is required (try --help)" >&2; exit 2; }
[ -f "$SESSION" ] || { echo "stream-to-receiver: cannot read session file \"$SESSION\"" >&2; exit 1; }

pick_free_port() {
	python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
[ -n "$PORT" ] || PORT=$(pick_free_port)

OWN_OUT=false
if [ -z "$OUT" ]; then
	OUT=$(mktemp "${TMPDIR:-/tmp}/piobs-stream-XXXXXX")
	OWN_OUT=true
fi
RECV_LOG=$(mktemp "${TMPDIR:-/tmp}/piobs-recv-XXXXXX")
RECV_PID=""
cleanup() {
	[ -n "$RECV_PID" ] && kill "$RECV_PID" 2>/dev/null || true
	rm -f "$RECV_LOG"
	if [ "$OWN_OUT" = true ] && [ "$KEEP" = false ]; then rm -f "$OUT"; fi
}
trap cleanup EXIT INT TERM

# --- start the receiver (bounded readiness wait) ---------------------------
node "$PI_OBS_DIR/tests/otlp_receiver_main.ts" "$PORT" --out "$OUT" >"$RECV_LOG" 2>&1 &
RECV_PID=$!
READY=false
for _ in $(seq 1 20); do
	sleep 0.5
	grep -q "listening" "$RECV_LOG" 2>/dev/null && READY=true && break
done
if [ "$READY" != true ]; then
	echo "stream-to-receiver: the receiver did not start (see $RECV_LOG)" >&2
	exit 1
fi
echo "receiver listening on 127.0.0.1:$PORT (capture: $OUT)"

# --- stream the session through piobs --otlp -------------------------------
set +e
# shellcheck disable=SC2086 # PIOBS_FLAGS is deliberately word-split
"$PI_OBS_DIR/bin/piobs" report "$SESSION" --otlp --endpoint="http://127.0.0.1:$PORT" $PIOBS_FLAGS >/dev/null
RC=$?
set -e

# let the receiver flush its capture, stop it, then summarize
sleep 2
kill "$RECV_PID" 2>/dev/null || true
RECV_PID=""
echo ""
if [ "$RC" = 0 ]; then
	echo "==> piobs streamed the session (exit 0)"
else
	echo "==> piobs exited $RC" >&2
fi
python3 - "$OUT" <<'PYEOF'
import json, sys
from collections import Counter
signals, total_bytes = Counter(), 0
try:
    for line in open(sys.argv[1]):
        rec = json.loads(line)
        signals[rec["path"]] += 1
        total_bytes += rec["bytes"]
except FileNotFoundError:
    pass
if not signals:
    print("    (the receiver captured no requests)")
else:
    for path, count in sorted(signals.items()):
        print(f"    {path}: {count} POST(s)")
    print(f"    total: {sum(signals.values())} OTLP/HTTP request(s), {total_bytes/1e6:.1f} MB streamed")
PYEOF
[ "$KEEP" = true ] && echo "capture kept at: $OUT"
exit "$RC"
