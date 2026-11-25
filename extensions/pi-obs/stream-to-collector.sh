#!/usr/bin/env bash
# stream-to-collector.sh — pi-obs OTEL stream, Leg 2: session -> piobs --otlp
# -> a REAL OpenTelemetry Collector (otelcol), which parses every record
# with its own pdata implementation and re-emits them to a file. The
# reference-toolchain way to stream a session into the OTel ecosystem.
#
# Usage:
#   ./stream-to-collector.sh <session-file> [options] [-- piobs flags]
#
# Options:
#   --config=<file>   collector config (default: tests/tools/
#                     otelcol-structural.yaml — OTLP/HTTP in, file out)
#   --col-bin=<path>  collector binary (default: otelcol-contrib, then
#                     otelcol, from PATH)
#   --port=<n>        collector OTLP/HTTP port (default: a free port)
#   --out=<file>      collector file-exporter output (default: temp file;
#                     printed; set PI_OBS_COL_OUT for the config's ${env:})
#   --keep            keep the output file (default: removed on exit)
#   -h, --help        this help
#
# Anything after "--" is passed to piobs report verbatim
# (e.g. -- --branch=<id> --capture-prompts).
#
# Requires: otelcol-contrib or otelcol on PATH (or --col-bin), node >= 23.6.
# Exit codes: piobs's exit code (0 success, 1 replay error, 2 usage);
# a collector startup failure exits 1. No leftovers: the collector process
# and temp files are always cleaned up.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PI_OBS_DIR=$SCRIPT_DIR   # the scripts live at the pi-obs package root

usage() {
	sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

SESSION=""
CONFIG="$PI_OBS_DIR/tests/tools/otelcol-structural.yaml"
COL_BIN=""
PORT=""
OUT=""
KEEP=false
PIOBS_FLAGS=""
while [ $# -gt 0 ]; do
	case "$1" in
		--config=*) CONFIG="${1#--config=}" ;;
		--col-bin=*) COL_BIN="${1#--col-bin=}" ;;
		--port=*) PORT="${1#--port=}" ;;
		--out=*) OUT="${1#--out=}" ;;
		--keep) KEEP=true ;;
		-h|--help) usage 0 ;;
		--) shift; PIOBS_FLAGS="$*"; break ;;
		-*) echo "stream-to-collector: unknown option $1 (try --help)" >&2; exit 2 ;;
		*) if [ -z "$SESSION" ]; then SESSION="$1"; else echo "stream-to-collector: unexpected argument $1" >&2; exit 2; fi ;;
	esac
	shift
done
[ -n "$SESSION" ] || { echo "stream-to-collector: a <session-file> is required (try --help)" >&2; exit 2; }
[ -f "$SESSION" ] || { echo "stream-to-collector: cannot read session file \"$SESSION\"" >&2; exit 1; }
[ -f "$CONFIG" ] || { echo "stream-to-collector: cannot read collector config \"$CONFIG\"" >&2; exit 1; }

if [ -z "$COL_BIN" ]; then
	if command -v otelcol-contrib >/dev/null 2>&1; then COL_BIN=$(command -v otelcol-contrib);
	elif command -v otelcol >/dev/null 2>&1; then COL_BIN=$(command -v otelcol);
	else echo "stream-to-collector: no otelcol-contrib/otelcol on PATH (use --col-bin)" >&2; exit 1; fi
fi

pick_free_port() {
	python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
[ -n "$PORT" ] || PORT=$(pick_free_port)

OWN_OUT=false
if [ -z "$OUT" ]; then
	OUT=$(mktemp "${TMPDIR:-/tmp}/piobs-col-XXXXXX")
	OWN_OUT=true
fi
COL_LOG=$(mktemp "${TMPDIR:-/tmp}/piobs-col-log-XXXXXX")
COL_PID=""
cleanup() {
	[ -n "$COL_PID" ] && kill "$COL_PID" 2>/dev/null || true
	rm -f "$COL_LOG"
	if [ "$OWN_OUT" = true ] && [ "$KEEP" = false ]; then rm -f "$OUT"; fi
}
trap cleanup EXIT INT TERM

# --- start the collector (bounded readiness wait) ---------------------------
PI_OBS_COL_PORT="$PORT" PI_OBS_COL_OUT="$OUT" "$COL_BIN" --config "$CONFIG" >"$COL_LOG" 2>&1 &
COL_PID=$!
READY=false
for _ in $(seq 1 30); do
	sleep 1
	grep -q "Everything is ready" "$COL_LOG" 2>/dev/null && READY=true && break
done
if [ "$READY" != true ]; then
	echo "stream-to-collector: the collector did not become ready (see $COL_LOG)" >&2
	exit 1
fi
echo "collector ready on 127.0.0.1:$PORT ($COL_BIN, output: $OUT)"

# --- stream the session through piobs --otlp --------------------------------
set +e
# shellcheck disable=SC2086 # PIOBS_FLAGS is deliberately word-split
"$PI_OBS_DIR/bin/piobs" report "$SESSION" --otlp --endpoint="http://127.0.0.1:$PORT" $PIOBS_FLAGS >/dev/null
RC=$?
set -e

# let the collector flush, stop it, then summarize what it re-emitted
sleep 3
kill "$COL_PID" 2>/dev/null || true
COL_PID=""
echo ""
if [ "$RC" = 0 ]; then
	echo "==> piobs streamed the session (exit 0); the collector accepted every record:"
else
	echo "==> piobs exited $RC; whatever arrived was still ingested:" >&2
fi
python3 - "$OUT" <<'PYEOF'
import json, sys
from collections import Counter
spans, metrics, logs = Counter(), 0, 0
records = 0
try:
    for line in open(sys.argv[1]):
        if not line.strip(): continue
        rec = json.loads(line)  # the collector's pdata parse validated it on ingest
        records += 1
        for rs in rec.get("resourceSpans", []):
            for ss in rs.get("scopeSpans", []):
                for sp in ss.get("spans", []):
                    spans[sp["name"]] += 1
        for rm in rec.get("resourceMetrics", []):
            for sm in rm.get("scopeMetrics", []):
                metrics += len(sm.get("metrics", []))
        for rl in rec.get("resourceLogs", []):
            for sl in rl.get("scopeLogs", []):
                logs += len(sl.get("logRecords", []))
except FileNotFoundError:
    pass
print(f"    collector records re-emitted: {records}")
for name, count in sorted(spans.items()):
    print(f"    span {name}: {count}")
print(f"    metric points: {metrics} · log records: {logs}")
PYEOF
[ "$KEEP" = true ] && echo "collector output kept at: $OUT"
exit "$RC"
