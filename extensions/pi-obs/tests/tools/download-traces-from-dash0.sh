#!/bin/bash
#
# download-traces-from-dash0.sh — download traces from Dash0 as OTLP/JSONL,
# ready for extensions/pi-obs/tests/tools/otlp-traces-to-html.sh (one
# OTLP/JSON payload per
# line, the exact shape the renderer — and any OTLP/JSON consumer — takes).
#
# Two modes:
#   query (default): POST /api/spans/download — the spans matching a time
#                    range (and an optional service.name filter), format
#                    ndjson, limit capped at 5000 by the API
#   --trace-id ID  : POST /api/trace/details — every span of ONE trace,
#                    written as a single compact OTLP/JSON line
#
# Credentials (env, NEVER argv — argv is visible in ps output):
#   DASH0_TOKEN     the Dash0 auth token (auth_…), required
#   DASH0_ENDPOINT  the org's ingestion host (ingress.<region>.dash0.com);
#                   the API URL is derived (ingress. → api.), required.
#                   DASH0_GRPC_ENDPOINT is accepted as a fallback alias
#                   (the common local export: host[:4317])
#
# Usage:
#   download-traces-from-dash0.sh [--from T] [--to T] [--service NAME]
#                                 [--limit N] [--trace-id ID] [output]
#
#   --from T       query start, Dash0 time syntax (default: now-1h)
#   --to T         query end, Dash0 time syntax (default: now)
#   --service NAME filter: resource attribute service.name is NAME
#                  (default: no filter — all services)
#   --limit N      max spans to export (default: 1000; API cap: 5000;
#                  ignored with --trace-id — a trace is fetched whole)
#   --trace-id ID  one whole trace by id (POST /api/trace/details;
#                  default: query mode)
#   output         (default: dash0-traces.jsonl in the current directory)
#
# The download is streamed (no Content-Length): a curl transfer error —
# including a partial body — fails the run, per the API's own guidance.
#
# Exit codes: 0 ok · 1 operational failure · 2 usage.
#
# The repo twins: secret DASH0_TOKEN + variable DASH0_ENDPOINT hold the same
# values in CI (see send-traces-to-dash0.sh for the way there).

set -eu

usage() {
	sed -n '3,38p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
}

die() { echo "download-traces-from-dash0: $*" >&2; exit 1; }
note() { echo "download-traces-from-dash0: $*"; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

FROM="now-1h"
TO="now"
SERVICE=""
LIMIT=1000
TRACE_ID=""
OUTPUT=""
while [ $# -gt 0 ]; do
	case "$1" in
		--from | --to | --service | --limit | --trace-id)
			[ $# -ge 2 ] || die "$1 needs a value: $1 <v>"
			case "$1" in
				--from) FROM=$2 ;;
				--to) TO=$2 ;;
				--service) SERVICE=$2 ;;
				--limit) LIMIT=$2 ;;
				--trace-id) TRACE_ID=$2 ;;
			esac
			shift 2 ;;
		--from=*) FROM=${1#--from=}; shift ;;
		--to=*) TO=${1#--to=}; shift ;;
		--service=*) SERVICE=${1#--service=}; shift ;;
		--limit=*) LIMIT=${1#--limit=}; shift ;;
		--trace-id=*) TRACE_ID=${1#--trace-id=}; shift ;;
		-h | --help) sed -n '3,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) echo "download-traces-from-dash0: unknown option: $1" >&2; usage ;;
		*)
			if [ -z "$OUTPUT" ]; then OUTPUT=$1
			else echo "download-traces-from-dash0: too many arguments: $1" >&2; usage
			fi
			shift
			;;
	esac
done
case "$LIMIT" in ''|*[!0-9]*) die "--limit must be a non-negative integer" ;; esac
[ "$LIMIT" -le 5000 ] || die "--limit $LIMIT exceeds the API cap of 5000 spans (use the Dash0 CLI for larger exports)"
[ -n "$TRACE_ID" ] && [ -n "$SERVICE" ] && die "--trace-id and --service are mutually exclusive"
[ -n "$TRACE_ID" ] && [ "$LIMIT" -ne 1000 ] && die "--trace-id takes no --limit (a trace is fetched whole)"

[ -n "${DASH0_TOKEN:-}" ] || die "DASH0_TOKEN is not set (env; see --help)"
[ -n "${DASH0_ENDPOINT:-}" ] || DASH0_ENDPOINT=${DASH0_GRPC_ENDPOINT:-}
[ -n "${DASH0_ENDPOINT:-}" ] || die "DASH0_ENDPOINT is not set (env; see --help)"
[ -n "$OUTPUT" ] || OUTPUT="dash0-traces.jsonl"

# --- resolve the API URL (ingress.<region> → api.<region>) --------------------
ep=$DASH0_ENDPOINT
case "$ep" in https://*) ep=${ep#https://} ;; http://*) ep=${ep#http://} ;; esac
ep=${ep%%:*}
case "$ep" in
	ingress.*) API_URL="https://api.${ep#ingress.}" ;;
	*) die "DASH0_ENDPOINT must be the ingestion host (ingress.<region>.dash0.com), got: $ep" ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- request (query mode or trace mode) ----------------------------------------
# NOTE: never print DASH0_TOKEN; bodies below carry no secret.
if [ -n "$TRACE_ID" ]; then
	URL="$API_URL/api/trace/details"
	jq -n --arg id "$TRACE_ID" --arg from "$FROM" --arg to "$TO" \
		'{traceId: $id, timeRange: {from: $from, to: $to}}' > "$TMP/body"
else
	URL="$API_URL/api/spans/download"
	if [ -n "$SERVICE" ]; then
		jq -n --arg from "$FROM" --arg to "$TO" --arg service "$SERVICE" --argjson limit "$LIMIT" \
			'{timeRange: {from: $from, to: $to}, format: "ndjson", limit: $limit,
				filter: [{key: "service.name", operator: "is", value: $service}]}' > "$TMP/body"
	else
		jq -n --arg from "$FROM" --arg to "$TO" --argjson limit "$LIMIT" \
			'{timeRange: {from: $from, to: $to}, format: "ndjson", limit: $limit}' > "$TMP/body"
	fi
fi

code=$(curl -sS --max-time 120 -o "$TMP/dl" -w '%{http_code}' -X POST "$URL" \
	-H "Authorization: Bearer $DASH0_TOKEN" \
	-H "Content-Type: application/json" \
	--data-binary "@$TMP/body") \
	|| die "curl failed (network/timeout/partial transfer — the download is streamed; retry)"

case "$code" in
	200) ;;
	*) die "HTTP $code from $URL — $(head -c 200 "$TMP/dl")" ;;
esac

# --- validate + write -----------------------------------------------------------
# query mode: the body IS ndjson (one OTLP/JSON payload per line); trace
# mode: one OTLP/JSON document — compacted to a single line so both outputs
# are the renderer's native input.
if [ -n "$TRACE_ID" ]; then
	jq -c '.' "$TMP/dl" > "$OUTPUT" || die "the trace/details reply is not valid JSON"
	records=1
else
	cp "$TMP/dl" "$OUTPUT"
	records=$(jq -R -c 'fromjson? // empty | select(has("resourceSpans"))' "$OUTPUT" | wc -l | tr -d ' ')
fi
spans=$(jq -s '[.[] | .resourceSpans[]?.scopeSpans[]?.spans[]?] | length' "$OUTPUT" 2>/dev/null || echo 0)
[ "$spans" -gt 0 ] || die "no spans in the download — widen the time range (--from) or drop the filter"

note "downloaded $spans span(s) · $records record(s) → $OUTPUT"
note "render: extensions/pi-obs/tests/tools/otlp-traces-to-html.sh $OUTPUT"
