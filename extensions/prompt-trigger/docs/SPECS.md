# prompt-trigger — file-triggered prompts for a running pi TUI

Specification version: 1.1.1 (semver — matches the tag `specs-prompt-trigger-1.1.1`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** partially implemented — v0.1.0 ships R1–R8 (the
> prompt-dropper layer, live in the fleet). This revision adds
> **R9–R12: the mailbox protocol** (envelope, maildir state machine,
> ledger, replies), aligning the extension with the fleet's
> agent-to-agent mailbox architecture (summarized normatively in
> §Context and grounding, item 4) — specified ahead of implementation,
> so coding agents can execute it against this contract.

## Objective

`prompt-trigger` is a **pi coding agent extension** that bridges
automation to a running pi TUI: when a file appears in a watched
directory, its content is injected into the session **as if typed by the
user** (visible in the TUI, turn started or queued), and the file is
deleted. One file = one prompt.

It is the watchdog-to-agent bridge: an external process (cron, hook,
another agent, a script) drops a prompt file; the running agent picks it
up without the operator typing.

## Context and grounding

1. **Pi extension standard.** A TypeScript module (jiti-loaded, no build
   step) exporting a default factory over `ExtensionAPI`; loaded via
   repo-local `--extension /repo-extensions/prompt-trigger/prompt-trigger.ts`.
   Runs inside the pi process.
2. **Zero-token idle.** The poll loop (`readdirSync` + `statSync` per
   file) costs zero tokens. Tokens are consumed only when a prompt is
   actually delivered.
3. **Fleet context.** Each agent has its own exchange dir
   (`$PI_FLEET_KIT_HOME/pi-exchange/<agent>`, mounted as `/exchange`),
   so no agent sees another agent's files.
4. **The fleet mailbox (architecture summary, inlined).** The fleet
   exchanges work through per-agent maildirs under
   `pi-exchange/<agent>/`. Levels, as implemented:

   - **Level 1 — the message.** Agent-to-agent messages are JSON
     envelopes (`msg-<ts>-<pid>` id, `from`, `to`, `session_id`, `type`
     request|reply|error, `correlation_id`, `created`, `body`,
     `attempts`, optional attachments) built exclusively by `send.sh`
     and dropped atomically into the RECIPIENT's `inbox/`. The sending
     session's identity rides in the envelope (R13) so telemetry can
     tie the two agents' traces together.
   - **Level 2 — the work ledger.** The recipient's extension claims
     envelopes (atomic rename inbox → working), records handled ids in
     an append-only `ledger.ndjson` (at-most-once), delivers the body
     as a prompt, and auto-replies: a `reply` envelope echoing
     `correlation_id` lands in the ORIGINAL sender's inbox when the
     turn settles — task delegation with answers.
   - **Cross-cutting.** The maildir IS the state machine (inbox →
     working → processed/failed, plus pending); dotfiles are never
     consumed as prompts; per-agent dirs are pairwise-isolated (R8);
     the trace-identity chain (R13) makes every exchange a distributed
     trace; attachments (R14, planned) ride alongside the envelope
     under `attachments/<msg-id>/`.

   (The original architecture document, `pi-mailbox-arch.json`, was
   removed from the repository — this summary is normative now.)

## Artifact structure

```text
prompt-trigger/
├── prompt-trigger.ts          # the entire extension (single file, ~196 lines)
├── prompt-trigger.test.ts     # 22 tests (real temp dirs, mocked interval, fs-race scenarios)
├── scripts/
│   └── race-scenario.mjs      # child-process fs-race scenarios (mocked node:fs)
├── package.json               # pi package manifest
├── README.md · CHANGELOG.md
└── docs/
    ├── SPECS.md               # this document
    └── DEV_PLAN.md            # implementation plan
```

Single-file by design: the extension's entire logic (watching, stability
checks, directives, queuing) fits in one readable file.

## Glossary

- **Exchange dir** — `PI_TRIGGER_DIR`; the watched directory where prompt
  files are dropped. Mounted as `/exchange` inside the container.
- **Stability window** — a file must be unchanged across two consecutive
  polls AND have an mtime older than `STABILITY_MS` (500ms) before it is
  consumed. Atomic-write friendly: the producer writes to a temp name
  then renames into place, so the file is fully written before the
  extension sees it.
- **Consumed** — the file's content was sent to the agent, and the file
  was deleted.
- **`/new [kickoff]`** — the first line of the file: starts a FRESH
  session (token-free), optionally with a kickoff message as the first
  prompt of the new session.

## Requirements

| ID | Name | Summary | Priority | Status |
|---|---|---|---|---|
| R1 | Safety | Never harms or alters the agent; failures are silent (dormant) | 1 | shipped 0.1.0 |
| R2 | Zero-harm idle | Zero token cost while idle; tokens only on actual delivery | 2 | shipped 0.1.0 |
| R3 | Atomic-write safety | Only stable files are consumed; partial writes never reach the agent | 3 | shipped 0.1.0 |
| R4 | One file = one prompt | Each file is consumed (deleted) exactly once | 4 | shipped 0.1.0 |
| R5 | Directives | `/new [kickoff]` starts a fresh session; plain content is a prompt | 5 | shipped 0.1.0 |
| R6 | Queuing | Mid-run prompts queue as followUp instead of interrupting | 6 | shipped 0.1.0 |
| R7 | Dormancy | Unset `PI_TRIGGER_DIR` leaves the extension dormant | 7 | shipped 0.1.0 |
| R8 | Privacy | Dotfiles are never consumed; no agent can see another agent's files | 8 | shipped 0.1.0 |
| R9 | Envelope | Mailbox messages carry the standard envelope; `send.sh` builds them | 9 | shipped 0.2.0 |
| R10 | Maildir | inbox/working/pending/processed/failed + atomic claim | 10 | shipped 0.2.0 |
| R11 | Ledger | append-only handled-ids: at-most-once work; startup replay | 11 | shipped 0.2.0 |
| R12 | Replies | auto-reply envelope echoing correlation_id to the sender's inbox | 12 | shipped 0.2.0 |
| R13 | Trace identity | envelopes carry the sender session id; deliveries become session entries the receiver's telemetry links to the sender's trace (distributed traces) | 13 | shipped 0.3.0 |
| R14 | Attachments | messages carry files in `attachments/<msg-id>/`, listed in the header; send.sh copies them before the envelope commit | 14 | planned 0.4.0 |

### R1 — Never harms the agent

All filesystem failures (missing dir, unreadable file, delete failure)
are silently absorbed: the extension stays dormant or retries on the
next tick. No unhandled exceptions, no error dialogs.

### R2 — Zero-token idle

The poll loop runs every `POLL_MS` (1500ms) and does only filesystem
operations. No LLM calls, no network, no token cost.

### R3 — Atomic-write safety

A file is consumed only when:
- its size and mtime are unchanged across two consecutive poll ticks;
- its mtime is at least `STABILITY_MS` (500ms) old.

A file being rewritten between ticks is re-observed (size/mtime changed)
— never consumed mid-write. The re-observed version is consumed on a
later tick once stable.

### R4 — One file = one prompt

After consumption, the file is deleted (`tryDelete`). A delete failure
(prompt delivered but file kept) is silently retried on the next tick.
A file that vanishes between scan and read is skipped.

### R5 — Directives

- `content === "/new"` or `content.startsWith("/new ")`: starts a fresh
  session via `(ctx as ExtensionCommandContext).newSession({})`.
  With a kickoff (`"/new review the PR"`), the kickoff text is sent as
  the first message of the new session.
- Any other content: delivered as a user message via
  `pi.sendUserMessage(content)`.

### R6 — Queuing

When the agent is streaming (`agent_start` → `agent_end`), prompts are
sent with `{ deliverAs: "followUp" }` — queued after the current work,
never interrupting. When idle, prompts are sent directly.

### R7 — Dormancy

`PI_TRIGGER_DIR` unset → no timer, no notification, no consumption.
The directory disappearing at tick time → silent tick (readdirSync
catches and returns).

### R8 — Privacy and isolation

- Files whose name starts with `.` are never consumed (dotfiles are
  never prompts).
- Non-regular entries (directories, symlinks) are skipped.
- Per-agent exchange dirs: each agent mounts its own
  `$PI_FLEET_KIT_HOME/pi-exchange/<agent>` as `/exchange` — no agent
  sees another agent's files.

### R9 — Envelope protocol (mailbox level 1)

Aligned with the fleet's agent-to-agent mailbox architecture
(§Context and grounding, item 4), the flat prompt-file format evolves
into the standard envelope:

- Every mailbox message is a JSON object with exactly these fields:
  `id` (unique: `msg-<ts>-<pid>`), `from` (sender agent id), `to`
  (recipient agent id), `type` (`request` | `reply` | `error`),
  `session_id` (the SENDING session's pi session id — the receiver's telemetry links its spans to the sender's trace, R13), `correlation_id` (echoes the request `id` on replies), `created`
  (ISO timestamp), `body` (the prompt text), `attempts` (retry counter,
  maintained by the extension) — plus the optional `attachments` field (file metadata list, R14).
- A `send.sh` helper (in the extension dir) builds and drops envelopes —
  **agents never hand-craft JSON**; malformed messages are impossible
  through the helper.
- **Backward compatibility (transition rule)**: a file in the exchange
  dir whose content is NOT a valid envelope JSON is treated as a legacy
  raw prompt (R5 behavior, consumed as today). Files in `inbox/` MUST be
  envelopes; a malformed envelope there is moved to `failed/` with the
  parse error recorded — never consumed, never silently dropped.

### R10 — Maildir state machine (mailbox level 1)

The exchange dir evolves from a flat drop zone into the maildir layout
(same root, subdirs added — the compose mount does not change):

```text
/exchange/
├── <legacy raw prompt files>   # backward compat: consumed as R4/R5
├── inbox/                      # envelopes awaiting consumption
├── working/                    # claimed, being processed
├── pending/                    # (reserved) scheduled/deferred messages
├── processed/                  # handled, reply written (bounded retention)
└── failed/                     # MAX_ATTEMPTS exhausted or malformed
```

- **Claim is atomic**: `mv inbox/<msg> working/<msg>` — same filesystem,
  atomic rename; exactly one consumer per inbox.
- **Completion**: after the reply is written, `mv working/<msg>
  processed/<msg>`.
- **Failure**: a processing error (or malformed envelope) moves the
  message to `failed/` — with the error recorded; after
  `MAX_ATTEMPTS` (3) failed delivery attempts, it stays in `failed/`
  and an error reply is sent to the sender (R12).
- **Crash recovery**: on session start, files found in `working/` are
  replayed (claimed but unfinished) — back to the head of processing.

### R11 — Ledger: at-most-once work (mailbox level 2)

- An append-only ledger file (`ledger.ndjson` in the exchange root)
  records every consumed message id.
- Before claiming a message, the extension checks the ledger: an
  already-handled id is moved straight to `processed/` (never
  re-executed) — at-most-once work, even across restarts and delete
  failures. The ledger replaces the delete-failure duplicate-delivery
  risk documented in v1.0.0's Risks section.

### R12 — Replies: task delegation (the architecture's key insight)

Prompting becomes asynchronous task delegation — every request gets a
reply, and replies are matchable:

- After a `request`-type envelope is handled (the agent's turn
  settles), the extension writes a **reply envelope** to the SENDER's
  inbox: `type: "reply"`, `correlation_id` = the request's `id`,
  `body` = the agent's answer (the turn's final assistant text).
- Replies are themselves mailbox messages — consumed by the sender's
  own prompt-trigger instance and injected as user messages (resume
  prompts).
- `error`-type replies carry the failure reason (after MAX_ATTEMPTS or
  a malformed body). A reply whose `correlation_id` is already in the
  sender's ledger is dropped (dedupe).
- Reply path: the exchange dirs share a common parent
  (`$PI_FLEET_KIT_HOME/pi-exchange/`), so a reply to agent `from` is
  written to `/exchange/../<from>/inbox/` — resolved against the fleet
  layout. A request whose sender's inbox is unreachable is moved to
  `failed/` with a ledger note (an error reply has nowhere to go).

### R13 — Trace identity (distributed traces)

Every envelope carries `session_id` — the SENDING session's pi session
id (required, fail-closed). Chain of custody:

- the prompt-trigger extension publishes its identity as
  `<exchange-dir>/.sender` at session start (a dotfile: never consumed
  as a legacy prompt, R8-adjacent);
- `send.sh` reads it and fails closed without it — an untraceable
  message is refused, not sent;
- on delivery the extension appends a `mailbox` session entry
  (`pi.appendEntry`, custom entries are not LLM-visible);
- pi-obs derives live trace ids deterministically from the session id
  (`deriveTraceId`, R3b parity) and turns the branch's mailbox entries
  into OTLP span links on the receiver's session span
  (`traceId = deriveTraceId(sender session_id)` + the
  `pi.mailbox.session_id` link attribute) — Jaeger connects the two
  agents' traces. Replies carry the replier's session id, so the chain
  is traceable in both directions.

### R14 — Attachments

A message may carry files. They live in a per-recipient subdirectory
keyed by message id — `pi-exchange/<agent>/attachments/<msg-id>/` — and
are LISTED in the header:

- the envelope gains an OPTIONAL `attachments` field: an array of
  `{ name, bytes, sha256 }` (sorted by name); absent or empty means no
  attachments — 0.3.x envelopes remain valid (additive change);
- the path of each file is DERIVABLE (never stored):
  `attachments/<msg-id>/<name>` relative to the recipient's exchange
  dir (`/exchange/<agent>/attachments/<msg-id>/<name>` in-container);
- name safety (fail-closed): `[A-Za-z0-9][A-Za-z0-9._-]*`, ≤ 255 chars,
  no path separators, no leading dot (R8 adjacency: dotfiles are never
  prompts and never listed);
- caps at send (fail-closed in `send.sh`): ≤ 10 attachments and ≤ 20 MiB
  total per message — exceeding is a loud send error, NOTHING is sent;
- commit discipline: `send.sh --attach=<path>` (repeatable) COPIES each
  source into `attachments/<msg-id>/` BEFORE writing the envelope — the
  envelope is the commit point. An orphaned attachments dir (crash
  before the envelope) is inert: the receiver never scans
  `attachments/` without an envelope referencing it;
- the state machine moves ONLY the envelope (inbox → working →
  processed/failed): attachments stay in place, keyed by id — the
  receiver reads them after processing too; retention/cleanup is
  deferred to a later housekeeping step (non-goal for 0.4.0);
- delivery: when the envelope lists attachments, the extension appends
  ONE manifest line to the delivered prompt (so the receiving LLM knows
  where the files are): `\n[mailbox attachments: /exchange/<to>/attachments/<id>/<name> …]` —
  the body itself is never modified;
- replies may carry attachments by the same mechanism (e.g. a generated
  artifact flowing back);
- integrity: `send.sh` records sha256 per file; verification before use
  is the CONSUMER's responsibility (the mailbox is a transport, not a
  validator);
- telemetry: no new OTLP fields — the manifest line rides in the
  delivered text, captured by the existing prompt machinery.

## Explicit non-goals

- **Watching (inotify/FSEvents)** — the extension polls on a timer, not
  with filesystem events. Polling is portable, zero-dependency, and
  sufficient for the 1.5s latency budget.
- **Multiple files per prompt** — one file = one prompt; no batching.
- **Priority ordering** — files are consumed in sorted-name order.
- **File content validation** — the content is delivered as-is; no
  syntax or format checking.

## Deliverable specification

- Ships as a Pi Package (`pi-prompt-trigger` on npm).
- Published tarball: exactly `prompt-trigger.ts`, `README.md`,
  `CHANGELOG.md`.
- Test suite: 22 tests (real temp dirs, mocked poll interval via
  `mock.timers`, fs-race scenarios in a child process with mocked
  `node:fs`), coverage 100% statements / 100% branches / 100% functions.

## General constraints

- Zero external dependencies at runtime (only `node:fs`, `node:path`).
- `POLL_MS` = 1500ms; `STABILITY_MS` = 500ms; `MAX_FILES_PER_TICK` = 5
  (observation cap — the cap gates the observe loop, not consumption).
- The extension clears its timer on `session_shutdown`.

## Open questions

- **inotify-based watching**: could reduce latency from 1.5–3s to
  <100ms. Deferred: platform-specific (inotify/FSEvents/ReadDirectoryChangesW)
  and the 1.5s budget is sufficient for the watchdog use case.
- **Prompt priority**: a high-priority flag (filename prefix) that
  consumes before lower-priority files. Deferred: no current need.

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-11-25 | Didier Durand | retroactive spec from shipped v0.1.0; versioned per house convention |
| 1.1.0 | 2026-11-25 | Didier Durand | mailbox protocol: R9 envelope + send.sh, R10 maildir state machine, R11 ledger (at-most-once), R12 replies with correlation — aligned with pi-mailbox-arch.json levels 1–2; per-requirement status column added |
| 1.1.1 | 2026-11-26 | Didier Durand | R9–R12 implemented and shipped in v0.2.0; statuses updated |
