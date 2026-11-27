# prompt-trigger — Implementation Plan

Plan version: 1.1.1 (semver — matches the tag `impl-plan-prompt-trigger-1.1.1`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** executed — Steps 1–3 shipped in v0.1.0; Steps 4–7 (the
> **mailbox protocol**: envelope, maildir, ledger, replies) shipped in
> v0.2.0; R13 (trace identity: session_id in envelopes, distributed
> traces via span links) shipped in v0.3.0. Step 8 (attachments, R14)
> is specified ahead of implementation. Derived from
> `extensions/prompt-trigger/docs/SPECS.md`.

## Ordering principle

**Single file, all layers together.** Unlike pi-obs (which built pure
modules first, then wired live capture), prompt-trigger's entire logic
— watching, stability, directives, queuing — fits in one file with no
separable layers. The build order was: extension first, hermetic test
suite second, CI workflow third.

## Steps (as shipped)

### Step 1 — The extension (R1–R8)

Single file `prompt-trigger.ts` (~196 lines) implementing:

- **Session lifecycle**: `session_start` reads `PI_TRIGGER_DIR`, starts
  a `setInterval(POLL_MS)` poll loop; `session_shutdown` clears it.
- **Poll tick**: `readdirSync` on the exchange dir → sorted names →
  skip dotfiles → `statSync` each → compare with the pending map
  (size/mtime unchanged across two ticks AND mtime ≥ STABILITY_MS old
  → consume).
- **Consume**: `readFileSync` → trim → check for `/new` directive →
  `pi.sendUserMessage` (or `newSession` + kickoff) → `tryDelete`.
- **Busy tracking**: `agent_start`/`agent_end` toggle a `busy` flag;
  busy → `{ deliverAs: "followUp" }`.

### Step 2 — Hermetic test suite (R8)

22 tests (Node built-in test runner), three strategies:

1. **Real temp dirs, mocked poll interval**: `mock.timers` with
   `setInterval` only — tick firing is deterministic while stability
   arithmetic uses real wall-clock time (file mtimes backdated via
   `utimesSync`). Covers: dormancy, stable consumption, too-young
   rejection, rewrites, touch-only changes, `/new` (plain/kickoff/
   failure), empty files, dotfiles, directories, followUp queuing,
   missing dir, externally deleted files, shutdown.
2. **Child-process fs-race scenarios** (`scripts/race-scenario.mjs`):
   the `readFileSync`/`unlinkSync` catch paths (file vanishing between
   scan and read; delete failing after delivery) are deterministic only
   with mocked `node:fs` (`mock.module`, requires
   `--experimental-test-module-mocks`). Each scenario runs in a child
   process; c8 merges the child's V8 coverage automatically.
3. **Per-test timer control**: every test shuts the interval down —
   a leaked interval would keep the process alive forever.

### Step 3 — CI workflow

- `prompt-trigger-check-sanity`: manifest, CHANGELOG, tsc, tarball
  equality, optional live-load smoke test.
- `prompt-trigger-unit-tests`: the 22-test suite under c8, per-file
  coverage in the job summary.

## Architectural decisions

- **Polling over inotify**: portable (no platform-specific watchers),
  zero-dependency, sufficient for the 1.5s latency budget. The poll
  costs `readdirSync` + `statSync` per file — a few ms per tick.
- **`setInterval` over recursive `setTimeout`**: the interval is a fixed
  1500ms; no backoff or dynamic adjustment needed.
- **Stability = size + mtime, not content hash**: hashing every file
  every tick would cost O(filesize) per tick. Size+mtime comparison is
  O(1) per file and sufficient for atomic-write detection.
- **`MAX_FILES_PER_TICK` gates observation, not consumption**: the cap
  bounds how many new files are *noticed* per tick (prevents a burst
  from monopolizing the tick); stable files already in the pending map
  are all consumed in the same tick. Measured dynamics: a 7-file burst
  drains 6 + 1 over three ticks.
- **`tryDelete` is fire-and-forget**: if the delete fails, the file
  stays and the prompt was already delivered — the next tick's
  `statSync` + stability check would re-consume it (duplicate delivery).
  In practice, the pending map entry is deleted before the delete
  attempt, so a delete failure means the file is simply orphaned
  (not re-consumed until the next full stability cycle).

## Steps 4–7 — mailbox protocol (specified ahead of implementation)

The divergences from the fleet's mailbox architecture (summarized
normatively in SPECS §Context and grounding, item 4) are closed in
three steps, ordered
by dependency: the envelope defines what a message IS, the maildir
defines where messages LIVE, the ledger defines what has been DONE, and
replies close the loop (task delegation with answers).

### Step 4 — Envelope + send.sh (R9)

- `src/envelope.ts`: parse/validate/build the envelope
  (`id`, `from`, `to`, `type` request|reply|error, `correlation_id`,
  `created`, `body`, `attempts`) — fail-closed: invalid → move to
  `failed/` with the parse error recorded (never consumed, never
  dropped).
- `send.sh` (extension root): builds + drops envelopes atomically
  (tmp + mv) — agents never hand-craft JSON. Usage:
  `send.sh <to> <body-file> [--type=request] [--correlation-id=<id>]`.
- Backward compat: raw (non-envelope) files in the exchange ROOT stay
  legacy prompts (R5); envelopes live in `inbox/`.
- Tests: envelope parsing/serialization round-trip; malformed → failed/;
  send.sh atomicity; raw-file compat.

### Step 5 — Maildir state machine (R10)

- Subdirs: `inbox/ working/ pending/ processed/ failed/` (created on
  session start, idempotent).
- Claim: `mv inbox/<msg> working/<msg>` (atomic rename, exactly one
  consumer); completion: `mv working/<msg> processed/<msg>` after the
  reply; failure: `mv working/<msg> failed/<msg>` + error record;
  `MAX_ATTEMPTS` (3) enforced via the envelope's `attempts` counter.
- Crash recovery: session-start scan replays `working/` (claimed but
  unfinished).
- Retention: `processed/` bounded (keep the last 100, prune on start).
- Tests: claim atomicity (one claimer wins), recovery replay,
  attempts escalation to failed/, retention pruning.

### Step 6 — Ledger + replies (R11, R12)

- `ledger.ndjson` (append-only, exchange root): consumed message ids;
  checked before claiming — an already-handled id moves straight to
  `processed/` (at-most-once across restarts and delete failures).
- Reply emission: after a `request` turn settles, write a reply envelope
  (type reply, correlation_id = request id, body = the turn's final
  assistant text) to `/exchange/../<from>/inbox/` via the same atomic
  tmp+mv discipline.
- Reply dedupe: correlation_id already in the sender's ledger → drop.
- Sender unreachable (no inbox dir): move to `failed/` + ledger note.
- Tests: ledger at-most-once (double delivery attempt), reply content
  correlation, dedupe, unreachable-sender handling.

### Step 7 — Suite + CI upgrade

- All new modules ≥ 90% lines+branches (the package's gate).
- New workflow coverage: the sanity workflow's tarball check includes
  `send.sh` + new sources; the unit-test workflow picks up the new
  test files automatically.
- Live check: two sandbox containers exchanging envelopes end-to-end
  (request → reply → correlation) — mirrors pi-obs-otlp-live's pattern.

## Step 8 — Attachments (R14, specified ahead of implementation)

Additive protocol extension (0.3.x envelopes remain valid; ship as
0.4.0). Ordered by dependency:

### Step 8a — Envelope metadata (src/envelope.ts)

- `Envelope` gains an OPTIONAL `attachments?: AttachmentMeta[]` where
  `AttachmentMeta = { name: string; bytes: number; sha256: string }` —
  sorted by name; absent/empty means none.
- `parseEnvelope` validates fail-closed: array of objects, name safe
  (`[A-Za-z0-9][A-Za-z0-9._-]*`, ≤ 255 chars, no separators, no leading
  dot), `bytes` a positive integer, `sha256` 64 lowercase hex chars, at
  most 10 entries. A violation parses to `undefined` (→ `failed/`, as
  every other envelope violation).
- `buildReply` threads attachments through (replies may attach).

### Step 8b — send.sh

- `--attach=<path>` (repeatable): verifies the source exists, derives
  the safe basename, computes sha256, COPIES into
  `$INBOX/../attachments/<id>/<basename>` (mkdir -p) — BEFORE the
  envelope is written (the envelope is the commit point).
- Caps: > 10 files or > 20 MiB total → loud error, nothing sent (the
  attachments dir for that id is removed).
- Back-compat: no `--attach` → envelope exactly as today (no field).

### Step 8c — Delivery (prompt-trigger.ts)

- No state-machine changes: claim/reply/processed move ONLY the
  envelope; attachments stay under `attachments/<msg-id>/`.
- On delivery, if the envelope lists attachments, append ONE manifest
  line to the delivered prompt:
  `[mailbox attachments: /exchange/<to>/attachments/<id>/<name> …]` —
  the body itself is never modified; the receiving LLM learns where the
  files are.
- `mailbox` session entries (R13) already carry the envelope metadata;
  no telemetry changes.

### Step 8d — Suite + CI upgrade

- envelope tests: shape validation, name safety, caps; round-trip with
  attachments; replies carrying attachments.
- send.sh tests: copy-before-commit, caps fail closed and remove the
  staged dir, orphaned dir is inert (envelope absent → never consumed).
- delivery test: the manifest line reaches the LLM; body unchanged.
- CI (fleet test): an attachment-carrying exchange end to end — the
  sender attaches a file via its bash tool, the receiver reads it from
  `attachments/<id>/` and answers with its content (proving the file
  actually crossed the mount).
- Version 0.4.0; SPECS R14 row → shipped; README usage section.


## Plan-level definition of done

- v1.0.0 (shipped): all R1–R8 requirements satisfied and test-pinned.
- v1.1.0 (to implement): all R9–R12 requirements satisfied and
  test-pinned; two sandbox containers exchange envelopes end-to-end
  (request → reply → correlation) in CI.
- CI green: sanity + unit-test workflows.
- npm package publishable (`npm pack` produces exactly the declared files).
- Extension loads via `pi -e` and answers (live-load smoke test in CI).

## Risks

- **Latency**: a dropped prompt is consumed within 1.5–3s (two poll
  ticks + stability window). For interactive use this is fine; for
  sub-second automation it is not (see Open questions in SPECS.md).
- **Orphaned files on delete failure**: a delete failure leaves the file
  in the exchange dir; it will be re-consumed on a later tick (after
  another stability cycle), causing duplicate delivery. Mitigation:
  the `tryDelete` catch absorbs the error; the file is removed from the
  pending map, so the next sighting is treated as a first observation
  (requiring another full stability cycle before re-consumption).

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-11-25 | Didier Durand | retroactive plan from shipped v0.1.0; versioned per house convention |
| 1.1.0 | 2026-11-25 | Didier Durand | mailbox protocol steps 4–7 (envelope+send.sh, maildir, ledger+replies, suite/CI) specified ahead of implementation — closes the divergences from pi-mailbox-arch.json levels 1–2 |
| 1.1.1 | 2026-11-26 | Didier Durand | steps 4–7 executed and shipped in v0.2.0 (47 tests, all gates green) |
| 1.2.0 | 2026-11-27 | Didier Durand | R13 trace identity shipped in v0.3.0 (session_id in envelopes, .sender identity file, mailbox session entries, pi-obs span links); Step 8 — attachments (R14) specified ahead of implementation: header-listed files under attachments/<msg-id>/, send.sh --attach with copy-before-commit, delivery manifest line |
| 1.2.1 | 2026-11-27 | Didier Durand | mailbox architecture summary inlined in SPECS (normative); step-4 divergence references repointed |
