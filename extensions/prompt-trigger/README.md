# `prompt-trigger` extension

Shared loading info (channels, Pi Package vs `--extension`): [pi-fleet-kit extensions README](https://github.com/didier-durand/pi-fleet-kit/blob/main/extensions/README.md).

## Purpose

Lets an **external watchdog** drive a *running, visible* agent: the watchdog
monitors a directory and drops a prompt file; the extension injects its
content into the session **as if typed by the user** — visible in the TUI,
turn started (or queued) — and consumes the file. The bridge between your
automation and the interactive session you are watching.

## How it is configured

| Piece | Where | Value |
|---|---|---|
| Watched directory (container view) | `PI_TRIGGER_DIR` env per agent | `/exchange` |
| Watched directory (host view) | compose mount per agent | `$PI_FLEET_KIT_HOME/pi-exchange/<agent>` — per-agent exchange dir, so no agent sees another agent's files |
| Dormant when | env unset or directory missing | extension polls nothing |

The extension announces itself in the TUI at startup:
`[prompt-trigger] watching /exchange (poll 1500ms)`.

## The watchdog contract (producer protocol)

- **One file = one prompt.** Content is UTF-8 text; the whole file is the
  prompt, except directives (below).
- **Write atomically**: write to a temp name, then rename into the watched
  directory — never write the final file in place across multiple `write()`
  calls.
- The extension only consumes files that are **stable**: unchanged across
  two consecutive polls AND at least 0.5s old. Anything still being written
  is picked up on a later poll.
- **The file is deleted by the extension** after consumption — one file
  never fires twice, and the watchdog gets implicit acknowledgment by the
  file disappearing.
- Multiple files dropped at once are consumed **sequentially** (max 5 per
  poll tick), each producing one user message.

## Directives

The first line of the file may be a control directive:

| First line | Effect | Token cost |
|---|---|---|
| `/new` | Start a **fresh session** (empty context, no model call) | zero |
| `/new <kickoff>` | Fresh session, then `<kickoff>` sent as the first message | kickoff only |
| anything else | Whole content injected as a user prompt | the prompt |

Directives are handled **in the extension itself** — `/new` is NOT routed
through command processing (custom injections bypass it); the extension
calls `ctx.newSession()` programmatically. Any unknown `/xxx` first line is
treated as regular prompt text, not a command.

## What the agent sees

The injected prompt appears in the TUI **as if typed by the user** — same
styling, same placement in the transcript, stored as a genuine user message
in the session file (so `/export`, `/resume`, `/fork` and compaction treat
it like any other exchange).

- **Idle agent**: the turn starts immediately.
- **Busy agent** (mid-run): the prompt is **queued** as a follow-up
  (`deliverAs: "followUp"`) — it never interrupts running work; it runs
  after the current turn settles.

## Cost and performance

| Aspect | Detail |
|---|---|
| Idle cost | a `readdir`/`stat` every 1.5s — **zero tokens** until a file delivers a prompt |
| Poll interval | 1500ms, plus a 500ms stability window (two unchanged sightings) |
| Latency | a dropped prompt is typically consumed within ~1.5–3s |
| Throughput | up to 5 prompts per poll tick, processed in sequence |
| Failure mode | directory missing → dormant; unreadable file → retried next tick; `/new` failure → error notice in the TUI |

## Deliberate design choices

- **Polling over `fs.watch`**: inotify events are unreliable across
  bind-mounted volumes — the exact setup here. Polling costs nothing in
  tokens and is dependable.
- **Directive allowlist stays small**: only `/new` is emulated. Other
  built-in TUI commands are deliberately not replicated; realistic
  watchdog needs are "run this task" and "start fresh".
- **Deletion instead of marker files**: no state file, no cursor — the
  directory IS the queue.
