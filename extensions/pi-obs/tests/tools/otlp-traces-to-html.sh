#!/bin/bash
#
# otlp-traces-to-html.sh — render ANY OTel trace file as HTML (or markdown),
# built on extensions/pi-obs/utils/traces-to-html.ts.
#
# Accepts, in any combination:
#   - otelcol file-exporter JSONL (one OTLP/JSON object per line)
#   - a single OTLP/JSON export, in ANY formatting (pretty-printed included)
#   - a JSON array of OTLP/JSON exports
#   - any of the above gzip-compressed (detected by magic bytes, not by name)
#   - a dirty JSONL stream (a truncated/junk line costs that line only)
#
# Normalization (jq): everything is turned into clean one-object-per-line
# JSONL preserving export order (the tool attributes metrics by that order):
#   stream mode  : if the WHOLE file is a valid JSON stream (single doc,
#                  array, or clean JSONL) → jq emits each OTLP record compact
#   salvage mode : otherwise → per-line fromjson?, dropping bad lines
# Records without resourceSpans/resourceMetrics/resourceLogs never pass.
#
# POSIX bash 3.2; set -eu; cleanup trap; no unbounded waits.
#
# Usage:
#   otlp-traces-to-html.sh [--markdown] <input> [output]
#   otlp-traces-to-html.sh --self-test [fixture]
#
#   output defaults to <input-without-.gz>.html (or .md in --markdown).
#
# Exit codes (mirrors the tool): 0 ok · 1 operational failure · 2 usage.

set -eu

usage() {
	sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
}

die() { echo "otlp-traces-to-html: $*" >&2; exit 1; }
note() { echo "otlp-traces-to-html: $*"; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)
TOOL="$REPO_ROOT/extensions/pi-obs/utils/traces-to-html.ts"
[ -f "$TOOL" ] || die "traces-to-html.ts not found at: $TOOL"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v node >/dev/null 2>&1 || die "node is required"

# keep only OTLP records, in input order
FILTER='if type == "array" then .[] else . end
	| select(type == "object")
	| select(has("resourceSpans") or has("resourceMetrics") or has("resourceLogs"))'
SALVAGE='fromjson? // empty
	| select(type == "object")
	| select(has("resourceSpans") or has("resourceMetrics") or has("resourceLogs"))'

MODE=html
SELF=0
INPUT=""
OUTPUT=""
for arg in "$@"; do
	case "$arg" in
		--markdown) MODE=md ;;
		--self-test) SELF=1 ;;
		-h | --help) sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		-*) echo "otlp-traces-to-html: unknown option: $arg" >&2; usage ;;
		*)
			if [ -z "$INPUT" ]; then INPUT=$arg
			elif [ -z "$OUTPUT" ]; then OUTPUT=$arg
			else echo "otlp-traces-to-html: too many arguments: $arg" >&2; usage
			fi
			;;
	esac
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP" "$FIX_TMP"' EXIT INT TERM
FIX_TMP=""

# --- self-test ---------------------------------------------------------------
# Exercises every accepted shape on a real fixture and cross-checks totals.
# Runs BEFORE the main pipeline (no <input> is required for it).
if [ "$SELF" = 1 ]; then
	FIXTURE=${INPUT:-$REPO_ROOT/extensions/pi-obs/tests/fixtures/data/traces.json.gz}
	[ -f "$FIXTURE" ] || die "self-test fixture not found: $FIXTURE"
	FIX_TMP=$(mktemp -d)
	# variants: v1 gz jsonl · v2 plain jsonl · v3 pretty single doc ·
	# v4 array of records · v5 dirty jsonl (junk line) · v6 gz array
	cp "$FIXTURE" "$FIX_TMP/v1.jsonl.gz"
	gzip -dc "$FIXTURE" > "$FIX_TMP/v2.jsonl"
	jq -c 'select(has("resourceSpans") or has("resourceMetrics") or has("resourceLogs"))' "$FIX_TMP/v2.jsonl" \
		| head -n 1 | jq '.' > "$FIX_TMP/v3-pretty.json"
	jq -s '.' "$FIX_TMP/v2.jsonl" > "$FIX_TMP/v4-array.json"
	{ printf 'not json at all\n'; cat "$FIX_TMP/v2.jsonl"; } > "$FIX_TMP/v5-dirty.jsonl"
	gzip -c "$FIX_TMP/v4-array.json" > "$FIX_TMP/v6-array.json.gz"

	spans_of() { sed -n 's/^\([0-9]*\) span(s).*/\1/p'; }
	n1=$("$0" "$FIX_TMP/v1.jsonl.gz" "$FIX_TMP/v1.html" | spans_of)
	n2=$("$0" "$FIX_TMP/v2.jsonl" "$FIX_TMP/v2.html" | spans_of)
	n3=$("$0" "$FIX_TMP/v3-pretty.json" "$FIX_TMP/v3.html" | spans_of)
	n4=$("$0" "$FIX_TMP/v4-array.json" "$FIX_TMP/v4.html" | spans_of)
	n5=$("$0" "$FIX_TMP/v5-dirty.jsonl" "$FIX_TMP/v5.html" | spans_of)
	n6=$("$0" "$FIX_TMP/v6-array.json.gz" "$FIX_TMP/v6.html" | spans_of)
	md=$("$0" --markdown "$FIX_TMP/v2.jsonl" "$FIX_TMP/v2.md" | spans_of)

	[ -n "$n1" ] && [ "$n1" -gt 0 ] || die "self-test: gz JSONL rendered no spans"
	[ "$n1" = "$n2" ] || die "self-test: gz vs plain JSONL disagree ($n1 vs $n2)"
	[ "$n1" = "$n4" ] || die "self-test: gz vs array disagree ($n1 vs $n4)"
	[ "$n1" = "$n5" ] || die "self-test: dirty JSONL lost spans ($n1 vs $n5)"
	[ "$n1" = "$n6" ] || die "self-test: gz array disagrees ($n1 vs $n6)"
	[ "$n1" = "$md" ] || die "self-test: markdown total disagrees ($n1 vs $md)"
	[ -n "$n3" ] && [ "$n3" -ge 1 ] || die "self-test: pretty single doc rendered no spans"
	for v in v1 v2 v3 v4 v5 v6; do
		grep -q "<h1>pi-obs — collected traces" "$FIX_TMP/$v.html" \
			|| die "self-test: $v.html lacks the page heading"
	done
	grep -q "### pi-obs — collected traces (rendered)" "$FIX_TMP/v2.md" \
		|| die "self-test: markdown lacks its heading"

	note "self-test PASS — 6 shapes + markdown, $n1 span(s) each (pretty doc: $n3)"
	exit 0
fi

# --- input checks (main pipeline) -------------------------------------------
[ -n "$INPUT" ] || usage
[ -f "$INPUT" ] || die "input not found: $INPUT"

# --- decompress (magic bytes, not the file name) ----------------------------
raw="$TMP/raw"
magic=$(head -c 2 "$INPUT" | od -An -tx1 | tr -d ' \n')
if [ "$magic" = "1f8b" ]; then
	gzip -dc "$INPUT" > "$raw" || die "gzip decompression failed: $INPUT"
else
	cp "$INPUT" "$raw"
fi

# --- normalize to clean JSONL, order-preserving ------------------------------
jsonl="$TMP/normalized.jsonl"
if ! jq -c "$FILTER" "$raw" > "$jsonl" 2>"$TMP/jq.err"; then
	# the whole file is not a valid JSON stream — dirty JSONL: salvage
	# line by line (a bad line costs that line, never the render)
	if ! jq -R -c "$SALVAGE" "$raw" > "$jsonl" 2>/dev/null; then
		die "input is neither a JSON stream nor line-salvageable: $INPUT"
	fi
fi
[ -s "$jsonl" ] || die "no OTLP records (resourceSpans/resourceMetrics/resourceLogs) found in: $INPUT"
records=$(wc -l < "$jsonl" | tr -d ' ')

# --- render --------------------------------------------------------------------
case "$INPUT" in
	*.gz | *.GZ) base=${INPUT%.*} ;;
	*) base=$INPUT ;;
esac
[ -n "$OUTPUT" ] || OUTPUT="$base.$([ "$MODE" = md ] && echo md || echo html)"

if [ "$MODE" = md ]; then
	node "$TOOL" --markdown "$jsonl" "$OUTPUT" || die "markdown rendering failed (input: $INPUT)"
else
	node "$TOOL" "$jsonl" "$OUTPUT" || die "HTML rendering failed (input: $INPUT)"
fi
[ -s "$OUTPUT" ] || die "renderer produced no output: $OUTPUT"

note "rendered $records OTLP record(s) → $OUTPUT"
