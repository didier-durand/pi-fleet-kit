# prompt-trigger — file-triggered prompts for a running pi TUI

Specification version: 1.0.0 (semver — matches the tag `specs-prompt-trigger-1.0.0`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** implemented — the extension ships as v0.1.0 (see
> `package.json`). This spec documents the contract the extension was
> built to (written retroactively from the shipped code, after the
> hermetic test suite of 0.1.0).

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

| ID | Name | Summary | Priority |
|---|---|---|---|
| R1 | Safety | Never harms or alters the agent; failures are silent (dormant) | 1 |
| R2 | Zero-harm idle | Zero token cost while idle; tokens only on actual delivery | 2 |
| R3 | Atomic-write safety | Only stable files are consumed; partial writes never reach the agent | 3 |
| R4 | One file = one prompt | Each file is consumed (deleted) exactly once | 4 |
| R5 | Directives | `/new [kickoff]` starts a fresh session; plain content is a prompt | 5 |
| R6 | Queuing | Mid-run prompts queue as followUp instead of interrupting | 6 |
| R7 | Dormancy | Unset `PI_TRIGGER_DIR` leaves the extension dormant | 7 |
| R8 | Privacy | Dotfiles are never consumed; no agent can see another agent's files | 8 |

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
