#!/usr/bin/env bash
# send.sh — drop a mailbox envelope into another agent's inbox (SPECS
# v1.1.0 R9). Agents never hand-craft JSON: this helper builds the
# envelope (exactly the spec's field set, via the same rules as
# src/envelope.ts) and writes it ATOMICALLY (tmp + rename), so malformed
# messages and partial writes are impossible through it.
#
# Usage:
#   send.sh <to> <body-file> [--type=request] [--correlation-id=<id>] [--from=<agent>]
#             [--attach=<path>]... [--attach=<path>]...
#   cat body.txt | send.sh <to> -                      # body from stdin
#
# Attachments (R14): each --attach file is COPIED into the recipient's
# attachments/<msg-id>/ BEFORE the envelope is written — the envelope is
# the commit point (an orphaned staged dir without an envelope is inert).
# Caps: at most 10 attachments and 20 MiB total per message — exceeding
# is a loud error and NOTHING is sent.
#
# The exchange layout (fleet root): every agent has its own exchange dir
#   $PI_FLEET_KIT_HOME/pi-exchange/<agent>/   (mounted as /exchange)
# so the recipient's inbox is $PI_TRIGGER_DIR/../<to>/inbox/.
# The sender id (--from) defaults to $PI_AGENT_ID, then to the basename
# of $PI_TRIGGER_DIR (this agent's own exchange dir name).
#
# The envelope lands as inbox/msg-<epoch-ms>-<pid>.json.
#
# Exit codes: 0 sent · 1 failure (recipient missing) · 2 usage.

set -eu

usage() {
	sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-2}"
}

TO=""
BODY_FILE=""
TYPE="request"
CORRELATION=""
FROM="${PI_AGENT_ID:-}"
ATTACH_SOURCES=()

[ $# -ge 1 ] || usage
while [ $# -gt 0 ]; do
	case "$1" in
		--type=*) TYPE="${1#--type=}" ;;
		--correlation-id=*) CORRELATION="${1#--correlation-id=}" ;;
		--from=*) FROM="${1#--from=}" ;;
		--attach=*) ATTACH_SOURCES+=("${1#--attach=}") ;;
		-h|--help) usage 0 ;;
		-)                          # body from stdin (must precede the option pattern)
			if [ -z "$BODY_FILE" ]; then BODY_FILE="-"; else echo "send.sh: unexpected argument $1" >&2; exit 2; fi ;;
		-*) echo "send.sh: unknown option $1 (try --help)" >&2; exit 2 ;;
		*) if [ -z "$TO" ]; then TO="$1"; elif [ -z "$BODY_FILE" ]; then BODY_FILE="$1"; else echo "send.sh: unexpected argument $1" >&2; exit 2; fi ;;
	esac
	shift
done

[ -n "$TO" ] || usage
[ -n "$BODY_FILE" ] || usage
case "$TYPE" in request|reply|error) ;; *) echo "send.sh: invalid --type=$TYPE" >&2; exit 2 ;; esac

[ -n "${PI_TRIGGER_DIR:-}" ] || { echo "send.sh: PI_TRIGGER_DIR is not set (run inside an agent container)" >&2; exit 1; }
[ -z "$FROM" ] && FROM="$(basename "$PI_TRIGGER_DIR")"

INBOX="$PI_TRIGGER_DIR/../$TO/inbox"
[ -d "$INBOX" ] || { echo "send.sh: recipient inbox not found: $INBOX (is $TO's exchange dir mounted with inbox/ created?)" >&2; exit 1; }

# body: file or stdin ("-")
if [ "$BODY_FILE" = "-" ]; then
	BODY="$(cat)"
elif [ -f "$BODY_FILE" ]; then
	BODY="$(cat "$BODY_FILE")"
else
	echo "send.sh: body file not found: $BODY_FILE" >&2
	exit 1
fi
[ -n "$BODY" ] || { echo "send.sh: empty body — nothing to send" >&2; exit 2; }

# correlation_id is REQUIRED for reply/error, FORBIDDEN for request (the
# same fail-closed rule as src/envelope.ts parseEnvelope)
case "$TYPE" in
	reply|error) [ -n "$CORRELATION" ] || { echo "send.sh: --correlation-id is required for --type=$TYPE" >&2; exit 2; } ;;
	request)     [ -z "$CORRELATION" ] || { echo "send.sh: a request carries no --correlation-id (replies echo it)" >&2; exit 2; } ;;
esac

ID="msg-$(date +%s%3N)-$$"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# the sending session's identity (R13): the session_start handler of the
# prompt-trigger extension publishes it as a dotfile in this agent's
# exchange dir (dotfiles are never consumed as legacy prompts). Fail-closed:
# an envelope without session_id would be rejected by the receiver, so a
# missing identity is a loud error here, not a silently untraceable message.
SENDER_FILE="$PI_TRIGGER_DIR/.sender"
if [ -f "$SENDER_FILE" ]; then
	SESSION_ID="$(node -e 'try { const d = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String(d.session_id ?? "")); } catch { process.stdout.write(""); }' < "$SENDER_FILE")"
fi
if [ -z "${SESSION_ID:-}" ]; then
	echo "send.sh: no sender identity at $SENDER_FILE (is the prompt-trigger extension active on this agent? it publishes .sender at session start)" >&2
	exit 1
fi
if [ "$SESSION_ID" = "unknown" ]; then
	echo "send.sh: sender identity is "unknown" — the session id was unavailable at session start; refusing to send an untraceable message" >&2
	exit 1
fi
printf 'session_id: %s\n' "$SESSION_ID" >&2  # visibility: the trace identity riding on this message

# --- attachments (R14): stage BEFORE the envelope — the envelope is the commit point ---
RECIPIENT_ROOT="$PI_TRIGGER_DIR/../$TO"
STAGE_DIR="$RECIPIENT_ROOT/attachments/$ID"
ATTACH_JSON=""
if [ "${#ATTACH_SOURCES[@]}" -gt 0 ]; then
	[ "${#ATTACH_SOURCES[@]}" -le 10 ] || { echo "send.sh: too many attachments (${#ATTACH_SOURCES[@]}; max 10)" >&2; exit 1; }
	mkdir -p "$STAGE_DIR"
	TOTAL=0
	for SRC in "${ATTACH_SOURCES[@]}"; do
		[ -f "$SRC" ] || { echo "send.sh: attachment not found: $SRC" >&2; rm -rf "$STAGE_DIR"; exit 1; }
		NAME="$(basename "$SRC")"
		if ! printf '%s' "$NAME" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
			echo "send.sh: unsafe attachment name: $NAME (expected [A-Za-z0-9][A-Za-z0-9._-]*, no separators, no leading dot)" >&2
			rm -rf "$STAGE_DIR"; exit 1
		fi
		cp "$SRC" "$STAGE_DIR/$NAME"
	done
	# sizes + hashes + the sorted metadata list — one node pass (sha256sum is not portable; node is)
	ATTACH_JSON="$(STAGE="$STAGE_DIR" node -e '
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const cap = 20 * 1024 * 1024;
const list = fs.readdirSync(process.env.STAGE).sort().map((name) => {
	const body = fs.readFileSync(path.join(process.env.STAGE, name));
	return { name, bytes: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
});
const total = list.reduce((n, a) => n + a.bytes, 0);
if (total > cap) { console.error(`send.sh: attachments total ${total} bytes exceeds the 20 MiB cap`); process.exit(1); }
process.stdout.write(JSON.stringify(list));
')" || { rm -rf "$STAGE_DIR"; exit 1; }
	printf 'attachments: %s file(s), %s byte(s) staged\n' "$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).length))" "$ATTACH_JSON")" "$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).reduce((n, a) => n + a.bytes, 0)))" "$ATTACH_JSON")" >&2
fi

# atomic: write to a tmp name in the DESTINATION directory, then rename
TMP="$INBOX/.tmp-$ID"
DST="$INBOX/$ID.json"

# the envelope is built by node with the exact JSON escaping rules of
# src/envelope.ts (the body is arbitrary text; JSON.stringify handles it)
printf '%s' "$BODY" | ID="$ID" FROM="$FROM" TO="$TO" SESSION="$SESSION_ID" TYPE="$TYPE" CORRELATION="$CORRELATION" CREATED="$CREATED" ATTACH="$ATTACH_JSON" \
	node -e '
const env = {
	id: process.env.ID,
	from: process.env.FROM,
	to: process.env.TO,
	session_id: process.env.SESSION,
	type: process.env.TYPE,
	correlation_id: process.env.CORRELATION || null,
	created: process.env.CREATED,
	body: require("fs").readFileSync(0, "utf8"),
	attempts: 0,
};
const attachments = JSON.parse(process.env.ATTACH || "null");
if (Array.isArray(attachments) && attachments.length > 0) env.attachments = attachments;
process.stdout.write(JSON.stringify(env) + "\n");
' > "$TMP"

mv "$TMP" "$DST" || { rm -rf "$STAGE_DIR"; exit 1; } # the envelope is the commit: a failed commit leaves nothing sent
echo "sent: $DST (from=$FROM to=$TO type=$TYPE id=$ID)"
