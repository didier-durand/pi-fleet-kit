#!/bin/bash
#
# send-traces-to-dash0.sh — emit ANY OTel trace file to Dash0 (OTLP/HTTP).
#
# Sends every OTLP record of the input to the Dash0 ingress as an OTLP/JSON
# ExportTraceServiceRequest (POST https://<endpoint>:4318/v1/traces, Bearer
# auth). The input is normalized first, so it may be:
#   - otelcol file-exporter JSONL (one OTLP/JSON object per line)
#   - a single OTLP/JSON export in ANY formatting (pretty-printed included)
#   - a JSON array of OTLP/JSON exports
#   - any of the above gzip-compressed (detected by magic bytes, not by name)
#   - a dirty JSONL stream (a truncated/junk line costs that line only)
# Export order is preserved. NOTE: Dash0 queries are time-ranged — records
# with old timestamps are accepted but only visible to queries covering
# their window.
#
# Credentials (env, NEVER argv — argv is visible in ps output):
#   DASH0_TOKEN     the Dash0 auth token (auth_…), required
#   DASH0_ENDPOINT  the org's ingestion host (ingress.<region>.dash0.com,
#                   as shown in Dash0 Settings → Endpoints; a scheme or
#                   :4317/:4318 port is tolerated and stripped), required.
#                   DASH0_GRPC_ENDPOINT is accepted as a fallback alias
#                   (the common local export: host[:4317])
#
# Usage:
#   send-traces-to-dash0.sh [--limit N] <input>
#
#   --limit N   send only the first N normalized OTLP records (default: all)
#
# Bounded: --max-time 60 per request; a non-2xx reply, a curl failure, or a
# non-empty OTLP partialSuccess error fails the run with the record number.
#
# Exit codes: 0 ok · 1 operational failure · 2 usage.
#
# The repo twins: secret DASH0_TOKEN + variable DASH0_ENDPOINT hold the same
# values in CI (see download-traces-from-dash0.sh for the way back).

set -eu

usage() {
	sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
}

die() { echo "send-traces-to-dash0: $*" >&2; exit 1; }
note() { echo "send-traces-to-dash0: $*"; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

LIMIT=0
INPUT=""
while [ $# -gt 0 ]; do
	case "$1" in
		--limit)
			[ $# -ge 2 ] || die "--limit needs a value: --limit N"
			LIMIT=$2; shift 2 ;;
		--limit=*) LIMIT=${1#--limit=}; shift ;;
		-h | --help) sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) echo "send-traces-to-dash0: unknown option: $1" >&2; usage ;;
		*)
			if [ -z "$INPUT" ]; then INPUT=$1
			else echo "send-traces-to-dash0: too many arguments: $1" >&2; usage
			fi
			shift
			;;
	esac
done
case "$LIMIT" in ''|*[!0-9]*) die "--limit must be a non-negative integer" ;; esac
[ -n "$INPUT" ] || usage
[ -f "$INPUT" ] || die "input not found: $INPUT"

[ -n "${DASH0_TOKEN:-}" ] || die "DASH0_TOKEN is not set (env; see --help)"
[ -n "${DASH0_ENDPOINT:-}" ] || DASH0_ENDPOINT=${DASH0_GRPC_ENDPOINT:-}
[ -n "${DASH0_ENDPOINT:-}" ] || die "DASH0_ENDPOINT is not set (env; see --help)"

# --- resolve the endpoints ---------------------------------------------------
ep=$DASH0_ENDPOINT
case "$ep" in https://*) ep=${ep#https://} ;; http://*) ep=${ep#http://} ;; esac
ep=${ep%%:*}
OTLP_URL="https://$ep:4318/v1/traces"
case "$ep" in ingress.*) ;; *) note "warning: DASH0_ENDPOINT does not start with 'ingress.' — is it the ingestion host?" ;; esac

# --- normalize the input (same shapes as otlp-traces-to-html.sh, this directory) ---
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

magic=$(head -c 2 "$INPUT" | od -An -tx1 | tr -d ' \n')
if [ "$magic" = "1f8b" ]; then
	gzip -dc "$INPUT" > "$TMP/raw" || die "gzip decompression failed: $INPUT"
else
	cp "$INPUT" "$TMP/raw"
fi

FILTER='if type == "array" then .[] else . end
	| select(type == "object")
	| select(has("resourceSpans") or has("resourceMetrics") or has("resourceLogs"))'
SALVAGE='fromjson? // empty
	| select(type == "object")
	| select(has("resourceSpans") or has("resourceMetrics") or has("resourceLogs"))'

jsonl="$TMP/normalized.jsonl"
if ! jq -c "$FILTER" "$TMP/raw" > "$jsonl" 2>"$TMP/jq.err"; then
	if ! jq -R -c "$SALVAGE" "$TMP/raw" > "$jsonl" 2>/dev/null; then
		die "input is neither a JSON stream nor line-salvageable: $INPUT"
	fi
fi
[ -s "$jsonl" ] || die "no OTLP records (resourceSpans/resourceMetrics/resourceLogs) found in: $INPUT"

total=$(wc -l < "$jsonl" | tr -d ' ')
if [ "$LIMIT" -gt 0 ] && [ "$LIMIT" -lt "$total" ]; then
	sed -n "1,${LIMIT}p" "$jsonl" > "$TMP/slice.jsonl"
	mv "$TMP/slice.jsonl" "$jsonl"
	total=$LIMIT
fi

# --- emit, one ExportTraceServiceRequest per record ---------------------------
# NOTE: never print DASH0_TOKEN; the reply body carries no secret.
i=0
while IFS= read -r rec; do
	i=$((i + 1))
	code=$(printf '%s' "$rec" | curl -sS --max-time 60 -o "$TMP/reply" \
		-w '%{http_code}' -X POST "$OTLP_URL" \
		-H "Authorization: Bearer $DASH0_TOKEN" \
		-H "Content-Type: application/json" \
		--data-binary @-) || die "record $i/$total: curl failed (network/timeout)"
	case "$code" in
		2*) ;;
		*) die "record $i/$total: HTTP $code from $OTLP_URL — $(head -c 200 "$TMP/reply")" ;;
	esac
	errmsg=$(jq -r '.partialSuccess.errorMessage // ""' "$TMP/reply" 2>/dev/null || echo "unparseable reply")
	[ "$errmsg" = "" ] || die "record $i/$total: rejected by Dash0: $errmsg"
	note "record $i/$total → HTTP $code"
done < "$jsonl"

note "sent $i OTLP record(s) to $OTLP_URL — all accepted (no partialSuccess errors)"
