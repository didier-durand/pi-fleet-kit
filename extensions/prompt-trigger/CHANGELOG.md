# Changelog

## [0.2.0] - 2026-11-26

The mailbox protocol (SPECS v1.1.0, R9–R12): the prompt bridge becomes
the agent-to-agent mailbox from the fleet's mailbox architecture —
task delegation with answers.

- **Envelope (R9)**: messages in `inbox/` are JSON envelopes (id, from,
  to, type request|reply|error, correlation_id, created, body,
  attempts), built by the new `send.sh` helper — agents never
  hand-craft JSON. Fail-closed: malformed envelopes → `failed/` with
  the parse error recorded. Backward compatible: raw (non-JSON) files
  in the exchange root remain legacy prompts.
- **Maildir (R10)**: the exchange dir gains
  `inbox/working/pending/processed/failed`; claim = atomic
  `mv inbox → working`; completion = `working → processed` after the
  reply; `MAX_ATTEMPTS` (3) escalation; crash recovery replays
  `working/` at startup; `processed/` retention (last 100).
- **Ledger (R11)**: append-only `ledger.ndjson` of handled message ids
  — at-most-once work across restarts and delete failures (replaces
  the v1.0.0 duplicate-delivery risk).
- **Replies (R12)**: after a request's turn settles, a reply envelope
  (type reply, correlation_id echoed, body = the turn's final
  assistant text) is written to the sender's inbox; error replies
  after max attempts or interruption; dedupe by correlation_id;
  unreachable sender → failed/ + ledger note.
- 63 unit tests (22 legacy + 15 envelope + 26 mailbox lifecycle),
  all hermetic; coverage 98.9% statements / 96.2% branches / 100%
  functions — the house ≥95% bar met on every reported metric.

## [0.1.0] - 2026-11-23

First public release.

- **Unit tests + coverage CI**: 22 tests (real temp dirs, mocked poll
  interval, fs-race scenarios in a child process with mocked node:fs)
  covering dormancy, stability windows, rewrites, directives, followUp
  queuing and shutdown; `prompt-trigger-unit-tests` workflow reports
  coverage in the job summary (100% statements/branches/functions).
  Package metadata gains `"type": "module"` and a `test` script.

- Watches `PI_TRIGGER_DIR`; any regular file appearing there is injected
  into the session as if typed by the user, then deleted (one file = one
  prompt).
- `/new [kickoff]` directive on the first line starts a fresh session,
  optionally with a kickoff message.
- Stability check: only files unchanged across two consecutive polls and
  older than the stability window are consumed (atomic-write friendly).
- Zero token cost while idle; caps consumption at 5 files per tick.
- Unset `PI_TRIGGER_DIR` leaves the extension dormant.
- `/new` directive: session-control typing aligned with the host `ExtensionCommandContext` (runtime behavior unchanged).
