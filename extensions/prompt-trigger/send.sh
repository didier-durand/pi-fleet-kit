#!/usr/bin/env bash
# send.sh — drop a mailbox envelope into another agent's inbox (SPECS
# v1.1.0 R9). Agents never hand-craft JSON: this helper builds the
# envelope (exactly the spec's field set, via the same rules as
# src/envelope.ts) and writes it ATOMICALLY (tmp + rename), so malformed
# messages and partial writes are impossible through it.
#
# Usage:
#   send.sh <to> <body-file> [--type=request] [--correlation-id=<id>] [--from=<agent>]
#   cat body.txt | send.sh <to> -                      # body from stdin
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

[ $# -ge 1 ] || usage
while [ $# -gt 0 ]; do
	case "$1" in
		--type=*) TYPE="${1#--type=}" ;;
		--correlation-id=*) CORRELATION="${1#--correlation-id=}" ;;
		--from=*) FROM="${1#--from=}" ;;
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

# atomic: write to a tmp name in the DESTINATION directory, then rename
TMP="$INBOX/.tmp-$ID"
DST="$INBOX/$ID.json"

# the envelope is built by node with the exact JSON escaping rules of
# src/envelope.ts (the body is arbitrary text; JSON.stringify handles it)
printf '%s' "$BODY" | ID="$ID" FROM="$FROM" TO="$TO" SESSION="$SESSION_ID" TYPE="$TYPE" CORRELATION="$CORRELATION" CREATED="$CREATED" \
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
process.stdout.write(JSON.stringify(env) + "\n");
' > "$TMP"

mv "$TMP" "$DST"
echo "sent: $DST (from=$FROM to=$TO type=$TYPE id=$ID)"
