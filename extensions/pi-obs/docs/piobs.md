# piobs — the standalone pi-obs CLI, explained

> **Just want a report?**
> ```sh
> ./bin/piobs report ~/.pi/agent/sessions/<slug>/<session>.jsonl
> ```
> One OTLP/JSON export-request body per line on stdout — pipes
> straight into `otelcol` or `jq`. Exit 0 on success; see
> [Exit codes](#5-exit-codes).

`piobs` is the **post-mortem report engine of the
[pi-obs](../README.md) extension, outside the pi process** — a
standalone binary for finished sessions: no agent, no model, no
extension host. Same resolution rules, same replay engine, same
privacy rules, same output encoding as the in-pi `/pi-obs report`
command — plus what that command could never control: real process
exit codes.

Everything below is live-verified against `piobs 0.1.0` on the
checked-in fixtures (`tests/fixtures/sessions/`).

## Contents

- [1. Installation](#1-installation)
- [2. Commands](#2-commands)
- [3. Arguments](#3-arguments—session-ids-vs-paths)
- [4. Options](#4-options)
- [5. Exit codes](#5-exit-codes)
- [6. Configuration](#6-configuration)
- [7. Output format](#7-output-format)
- [8. Recipes](#8-recipes)
- [9. piobs vs /pi-obs report](#9-piobs-vs--pi-obs-report)
- [10. Troubleshooting](#10-troubleshooting)

---

## 1. Installation

`piobs` is a sh wrapper over `node src/cli.ts` — **no dependencies,
no build step** (node ≥ 23.6 runs the TypeScript directly via native
type stripping).

```sh
cd extensions/pi-obs
npm link                 # puts piobs on PATH (/opt/homebrew/bin/piobs or equivalent)
piobs --help
```

Without linking, call the wrapper directly:

```sh
./bin/piobs …            # or: node src/cli.ts …
```

Requirements: node ≥ 23.6 on PATH. Nothing else — the report engine
is pure computation over the session file.

## 2. Commands

```
piobs report <session-id | path> [session-dir] [flags]
piobs version
piobs --help | -h
```

| Command | What it does |
|---|---|
| `report` | Emit a deterministic OTel report of a finished session (the R3b replay): one complete OTLP/JSON export-request body per line, always on stdout. Flags add sinks (`--file`, `--otlp`). |
| `version` | `piobs 0.1.0 (pi-obs)` |
| `--help` / `-h` | The full usage text (also shown by `report --help`). Exit 0. |
| *(no arguments)* | Same as `--help` — exit 0. |

`report` is **model-free**: it never calls a model, never starts the
agent, and never writes anything except its declared outputs.

## 3. Arguments — session ids vs paths

The first positional argument is either:

- **A path** (used verbatim) — detected when it contains `/` or ends
  with `.jsonl`. Absolute or relative to your cwd. For archives and
  containers where no session directory is mounted.
  ```sh
  piobs report tests/fixtures/sessions/straight.jsonl
  ```
- **A session id** (resolved) — anything else. pi-obs scans the
  sessions directory's `.jsonl` files and matches by **header id**
  (`{"type":"session","id":…}` on the first line): the header wins,
  file names are ignored — a renamed copy still resolves.
  ```sh
  piobs report 0193aaaa-0001-7000-8000-000000000001
  ```

The optional **second positional** is a session directory for id
resolution (when the target project differs from the default):

```sh
piobs report <session-id> /path/to/some/sessions
```

It may only follow a **session id** — a directory after a path is a
usage error (exit 2). The default directory comes from
`--sessions-dir`.

## 4. Options

| Flag | Value | Meaning |
|---|---|---|
| `--branch=<entry-id>` | entry id | Select the branch **ending at** this entry (walks the `id`/`parentId` chain). Default: the file's active branch (its last id-bearing entry). Abandoned-branch entries are excluded. |
| `--file=<path>` | path | **Also** write the report to a file — the exact same OTLP/JSON-per-line encoding as stdout, line for line. The R2 session-directory rule applies (a target inside a session directory is refused, exit 1). Rotation follows `PI_OBS_FILE_MAX_*`. |
| `--otlp` | — | **Also** POST the report to an OTLP/HTTP endpoint (per-signal `/v1/traces\|metrics\|logs`, with the exporter's retry policy). Needs `--endpoint`, `PI_OBS_OTLP_ENDPOINT`, or the settings block — otherwise exit 1. |
| `--endpoint=<url>` | URL | The OTLP endpoint for `--otlp`. Overrides `PI_OBS_OTLP_ENDPOINT` and the settings block. |
| `--capture-prompts` | — | R2 **opt-in**: include verbatim user/assistant text. The documented redaction list (credential assignments, `sk-` keys, bearer tokens, AWS key ids) is applied — redacted bytes become `[REDACTED]`. Default: length + SHA-256-12 hash only. |
| `--capture-tool-io` | — | R2 **opt-in**: include tool result bodies (redacted the same way). Default: omitted. |
| `--service=<name>` | name | OTel `service.name` on the report's resource. Default: `pi-agent` (or `PI_OBS_RESOURCE_SERVICE`). |
| `--sessions-dir=<dir>` | path | Default sessions directory for id resolution. Default: `~/.pi/agent/sessions` (honoring `PI_HOME`). |
| `--help`, `-h` | — | Full usage; exit 0. |

Value flags use the `--flag=value` form; `--flag value` (space) is
**not** supported — an unknown or malformed flag is a usage error
(exit 2) that names the offending flag.

## 5. Exit codes

| Code | Meaning | Example messages |
|---|---|---|
| `0` | Success (report emitted; all flagged sinks worked) | — |
| `1` | Replay/IO error — actionable, names the offender | `no session with id X under DIR (N session file(s) scanned by header)` · `ambiguous session id X: matches 2 files (…)` · `cannot read session file "P" (…)` · `session file "P" is empty` · `… is inside a session directory` · `--otlp needs an endpoint (…)` |
| `2` | Usage error | `unknown flag "--wat"` · `report needs a <session-id \| path> argument` · `unexpected argument "c"` · `unknown command "bogus"` |

Every usage error also prints the one-line synopsis:
`usage: piobs report <session-id | path> [session-dir] [flags] — try 'piobs --help'`.

## 6. Configuration

Precedence (R6): **flag > environment variable > `pi-obs` settings
block (`${PI_HOME:-~/.pi}/agent/settings.json`) > default**. The
flags that override configuration: `--endpoint`, `--service`, and
the capture opt-ins.

| Variable | Default | Used by piobs for |
|---|---|---|
| `PI_OBS_OTLP_ENDPOINT` | — | `--otlp` endpoint (fallback when no `--endpoint`) |
| `PI_OBS_CAPTURE_PROMPTS` | `0` | Default for prompt capture (flag overrides) |
| `PI_OBS_CAPTURE_TOOL_IO` | `0` | Default for tool-IO capture (flag overrides) |
| `PI_OBS_RESOURCE_SERVICE` | `pi-agent` | Default `service.name` |
| `PI_OBS_FILE_MAX_BYTES` / `PI_OBS_FILE_MAX_FILES` | `10485760` / `5` | `--file` rotation |
| `PI_HOME` | `~/.pi` | Settings block + default sessions dir (`$PI_HOME/agent/sessions`) |

The full table (including the live-exporter variables that only
matter inside pi) is in the [README](../README.md#configuration-telemetry--specs-r6).

## 7. Output format

Every stdout line is one **complete OTLP/JSON export-request body** —
`{"resourceSpans":…}`, `{"resourceMetrics":…}`, or
`{"resourceLogs":…}` — ingestable by any OTLP/JSON consumer:

```sh
$ piobs report tests/fixtures/sessions/straight.jsonl | head -c 100
{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"str…
# 13 lines: 4 spans + 9 metric points
```

Properties worth knowing:

- **Deterministic** — trace/span ids are hash-derived from the
  session id + entry ids, timestamps come from the entries: the same
  session replays **byte-identically**, every time.
- **The span set mirrors the entry set**: one `pi.model` span per
  assistant message (with `gen_ai.*` usage attributes), `pi.tool`
  spans from tool results, the root `pi.session`; spans hang
  directly off the root (runs/turns are live-only concepts).
- **The resource carries `pi.replayed=true` and `pi.replay.source`**
  — marking the trace as offline-replayed, never live-captured.
- **Live-only data is omitted, never fabricated**: no
  time-to-first-token, no durations, no streaming counters.
- Progress/summary messages (`piobs: wrote 13 line(s) to …`) go to
  **stderr**, so stdout stays clean for pipes.

## 8. Recipes

```sh
# quick inspection: what's in this session?
piobs report session.jsonl | jq -r '.resourceSpans[]?.scopeSpans[]?.spans[]?.name'
# → pi.model, pi.tool bash, pi.model, pi.session

# tokens and cost, straight from the model spans
piobs report session.jsonl | jq -r '[.resourceSpans[]?.scopeSpans[]?.spans[]?
  | select(.name=="pi.model") | .attributes[]? | select(.key|startswith("gen_ai.usage"))]'

# ingest into any OTLP collector: replay the lines as OTLP/HTTP POSTs
piobs report session.jsonl | while IFS= read -r line; do
  case "$line" in *resourceSpans*) sig=traces;; *resourceMetrics*) sig=metrics;; *) sig=logs;; esac
  printf '%s' "$line" | curl -s -o /dev/null -H 'Content-Type: application/json' \
    --data-binary @- "http://localhost:4318/v1/$sig"
done

# the same, through pi-obs's own exporter (retry policy included)
piobs report session.jsonl --otlp --endpoint=http://collector:4318

# a specific fork of a branched session, to a file
piobs report session.jsonl --branch=<entry-id> --file=branch.jsonl

# privacy check: what WOULD be captured (opt-ins) — default leaks nothing
piobs report session.jsonl --capture-prompts | grep -c REDACTED
```

All of the above run model-free — safe on any machine, CI included
(the black-box suite's CLI level does exactly this).

### Streaming helpers

Two parameterized scripts wrap the full stream flows (both: free-port
picking, bounded readiness waits, cleanup traps, exit-code
propagation, and `-- <piobs flags>` passthrough):

```sh
# Leg 1 — the dependency-free look: stream into the throwaway OTLP
# receiver, which captures every request for inspection
./stream-to-receiver.sh <session-file> [--port=…] [--out=…] [--keep] [-- --branch=<id>]

# Leg 2 — the real thing: stream into an OpenTelemetry Collector
# (otelcol-contrib/otelcol from PATH, or --col-bin=…), which parses
# every record with its own pdata implementation and re-emits them
./stream-to-collector.sh <session-file> [--config=…] [--col-bin=…] [--port=…] [--out=…] [--keep] [-- <piobs flags>]
```

Both print a stream summary (requests by signal / records and spans
re-emitted) and exit with piobs's own code (0/1/2). `--keep` preserves
the capture/output file for inspection.

## 9. piobs vs /pi-obs report

| | `piobs` (standalone) | `/pi-obs report` (inside pi) |
|---|---|---|
| Engine | identical (Step 7 replay) | identical |
| Output | identical OTLP/JSON-per-line | identical |
| Exit codes | **0 / 1 / 2** (real) | not controllable (pi exits its own way) |
| Sessions dir default | `~/.pi/agent/sessions` | `ctx.sessionManager.getSessionDir()` (the live workspace's) |
| Needs | node ≥ 23.6 | a running pi with the extension loaded |
| Extra flags | `--endpoint`, `--service`, `--sessions-dir`, `--capture-*` | capture settings follow the live telemetry config |
| Progress messages | stderr | the command's usual emit channel |

The full in-session command surface (including `status`, `flush`, and
`help` — which lists every `/pi-obs` subcommand with a one-line
description) is documented in the README's feature table; `/pi-obs
help` prints it live in any session.

## 10. Troubleshooting

| You see | It means / do this |
|---|---|
| `no session with id X under DIR (N session file(s) scanned by header)` | No file's **header** carries that id. Check the id (`piobs report <path>` and look at the first line), or pass the right `[session-dir]` / `--sessions-dir`. |
| `ambiguous session id X: matches 2 files (…)` | Two files claim the same header id. Pass a file **path** instead of the id. |
| `cannot read session file "P" (…)` | Unreadable/missing path — the message carries the path and the OS error. |
| `session file "P" is empty (or every line is malformed)` | Nothing to replay. |
| `session file "P" has no session header (…)` | Not a pi session file. |
| `--branch entry "E" not found in P` | The entry id isn't in this file — ids are per-session. |
| `… is inside a session directory` | `--file` refused by the R2 privacy rule; choose another target. |
| `--otlp needs an endpoint (…)` | Set `--endpoint`, `PI_OBS_OTLP_ENDPOINT`, or the settings block. |
| `unknown flag "--x" (flags with values use --flag=value)` | Value flags need the `=` form. |

---

*Regenerate nothing — this document is maintained by hand; every
command shown was executed against `piobs 0.1.0` and the fixtures in
`tests/fixtures/sessions/`. When the CLI grammar changes, update
`src/cli.ts`'s `HELP` and this document together.*
