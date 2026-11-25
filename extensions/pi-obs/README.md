# pi-obs — session observability for the pi coding agent

`pi-obs` is a pi extension that turns the agent's own activity into two
independent observability surfaces:

1. **Live stats** — a footer status line showing token count and cost,
   refreshed after every turn, plus `/pi-obs` commands for detailed
   reports (current session, all sessions, JSON export).
2. **OpenTelemetry telemetry** — when an exporter is configured, every
   pi lifecycle event (session start, turn start/end, tool calls, model
   calls) becomes standards-compliant OTel spans, metrics, and log
   records, exported via OTLP/HTTP (e.g. to Jaeger) and/or a rotating
   local file.

It is observation only: pi-obs never mutates the session, never writes
to git, never alters agent behavior, and never degrades the interactive
experience.

## In the fleet

The fleet's `compose.yml` wires pi-obs into every agent and exports to
a Jaeger v2 container:

| Compose env var | Value | Effect |
|---|---|---|
| `PI_OBS_OTLP_ENDPOINT` | `http://otlp-jaeger:4318` | Enables OTLP/HTTP export to the Jaeger container |
| `PI_OBS_RESOURCE_SERVICE` | `pi-agent-<agent>` | Each agent appears as a separate service in the Jaeger UI |
| `PI_OBS_CAPTURE_PROMPTS` | `1` | Verbatim prompt/completion text in traces (see [Capture options](#capture-options)) |

**Start Jaeger:** `docker compose up -d otlp-jaeger`
**Open the UI:** http://localhost:16686

In Jaeger you can browse traces per agent (each is a separate service),
drill into `pi.session` → `pi.run` → `pi.turn` → `{pi.model, pi.tool}`
hierarchies, see token counts and costs per turn, and read the verbatim
prompt/response text (with capture enabled).

## Commands

All commands work in TUI mode (output in the chat) and in print/JSON
mode (output on stdout — scriptable).

| Command | What it does |
|---|---|
| `/pi-obs` | Report of the current session's active branch: message counts, duration, token breakdown (in / out / cache read / reasoning), cost, and per-model totals with turn counts. |
| `/pi-obs json` | The same stats as raw JSON (for scripts and RPC consumers). |
| `/pi-obs all` | Aggregate across every session file of this project's session directory: grand totals plus the 15 most recent sessions (when · tokens · cost · file). |
| `/pi-obs status` | Telemetry health: active exporters, queue depth, counters, last export times, last error. |
| `/pi-obs flush` | Drain the telemetry queue now (bounded, with a timeout notice when a backend is dead). |
| `/pi-obs report <id\|path>` | Post-mortem replay of a finished session → deterministic OTLP/JSON report (stdout, one body per line), options `--otlp`, `--file=<path>`, `--branch=<entry-id>`. |
| `/pi-obs help` | The in-session usage surface: every subcommand with a one-line description, the telemetry env vars, and a pointer to the standalone `piobs --help`. |

## Footer status line

```
12.4k tok · $0.09
```

Live, refreshed on `session_start`, `session_tree`, `turn_end`, and
`agent_settled`. TUI only; absent in print/JSON mode. Shows cumulative
token count and cost for the current session's active branch.

## How it works

Two independent layers, both read-only with respect to the session:

**Stats** — pi sessions are JSONL files whose entries already carry the
telemetry: every assistant message records the `provider`/`model` that
produced it and its `usage` (tokens + cost), and `usage`-type entries
record model-attributed usage that is not an assistant message (e.g.
cache warming). pi-obs just reads them.

**Telemetry** — when an exporter is configured, pi's lifecycle events
are turned into OTel records (`hooks.ts`), queued (`queue.ts`, bounded),
and exported as OTLP/JSON — to an OTLP/HTTP endpoint (`exporters/otlp.ts`,
retries with backoff, drop-and-count) and/or a rotating local log file
(`exporters/file.ts`). Redaction runs before the queue and again at
serialization (see [Privacy and redaction](#privacy-and-redaction)).
Telemetry never blocks or alters the agent: failures land in
`/pi-obs status`.

## Configuration

All configuration is via `PI_OBS_*` environment variables, with an
optional `"pi-obs"` block in `${PI_HOME:-~/.pi}/agent/settings.json`
(camelCase keys). Precedence: **environment variable > settings block >
default**. Invalid values never crash the agent: they are reported on
stderr and the default stands for that key.

### Exporters

Telemetry is **inactive by default** until at least one exporter is
configured. The stats commands work regardless.

#### OTLP/HTTP exporter

| Variable | Default | Description |
|---|---|---|
| `PI_OBS_OTLP_ENDPOINT` | *(unset)* | OTLP/HTTP endpoint URL (e.g. `http://otlp-jaeger:4318`). Setting this enables OTLP export. The paths `/v1/traces`, `/v1/metrics`, `/v1/logs` are derived automatically. |
| `PI_OBS_OTLP_HEADERS` | *(unset)* | Extra HTTP headers as `k=v,k=v` (e.g. `api-key=secret,tenant=acme`). |
| `PI_OBS_OTLP_TIMEOUT_MS` | `5000` | Per-request timeout in milliseconds. |
| `PI_OBS_OTLP_BATCH` | `64` | Records batched per OTLP request. Higher = fewer requests, more data at risk if a batch fails. |

Behavior: retries with exponential backoff, drop-and-count on
persistent failure (the agent is never blocked — dead backends only
cost telemetry, not agent turns).

#### File exporter

| Variable | Default | Description |
|---|---|---|
| `PI_OBS_FILE` | `0` | `1` enables the file exporter (in addition to OTLP, or standalone). |
| `PI_OBS_FILE_PATH` | `${PI_SERVE_DIR:-~/.pi}/obs/pi-obs.jsonl` | Target log file (OTLP/JSON, one record per line — ingestable by otelcol or `jq`). |
| `PI_OBS_FILE_MAX_BYTES` | `10485760` (10 MiB) | Rotation size: when the active file exceeds this, it is rotated. |
| `PI_OBS_FILE_MAX_FILES` | `5` | Files kept total (active + rotated), oldest dropped. |

The file exporter refuses targets inside session directories (a safety
measure against overwriting pi's own data).

#### Master switch

| Variable | Default | Description |
|---|---|---|
| `PI_OBS_ENABLED` | `1` when any exporter is configured, `0` otherwise | Master switch. Set to `0` to explicitly disable telemetry even when an exporter is configured. The stats commands work regardless. |

### Capture options

These control **what content** is recorded in the telemetry spans.

| Variable | Default | Description |
|---|---|---|
| `PI_OBS_CAPTURE_PROMPTS` | `0` | When `1`, the span attribute `pi.content.text` carries the **verbatim text** of user prompts and LLM completions. When `0` (default), it carries a content length + SHA-256-12 hash (enough to identify and deduplicate, not readable). |
| `PI_OBS_CAPTURE_TOOL_IO` | `0` | When `1`, tool spans (`pi.tool`) carry the tool's **input arguments and output result body** (e.g. file content read, command stdout). When `0` (default), tool spans carry only the tool name, duration, and success/failure. |

**Redaction is always active**, regardless of capture settings. Every
string passes through a redaction list at two points (before the queue,
and again at serialization):

| Pattern | Example caught |
|---|---|
| Credential assignments | `API_KEY=…`, `PASSWORD=…`, `SECRET=…` |
| OpenAI-style keys | `sk-…` (48+ chars) |
| Bearer tokens | `Authorization: Bearer eyJ…` |
| AWS access key IDs | `AKIA…` (16 chars) |

Matched bytes are replaced by `[REDACTED]`.

### Queue and resource

| Variable | Default | Description |
|---|---|---|
| `PI_OBS_QUEUE_MAX` | `4096` | Bounded queue size. When full, the oldest records are dropped (drop-oldest backpressure — the agent is never blocked). |
| `PI_OBS_RESOURCE_SERVICE` | `pi-agent` | OTel `service.name` resource attribute. Set per-agent (e.g. `pi-agent-pi-coding-1`) to distinguish agents in the Jaeger UI. |

## Fleet integration (compose.yml)

The fleet's `compose.yml` configures each agent with:

```yaml
environment:
  - PI_OBS_OTLP_ENDPOINT=http://otlp-jaeger:4318
  - PI_OBS_RESOURCE_SERVICE=pi-agent-<agent>
  - PI_OBS_CAPTURE_PROMPTS=1
```

And a Jaeger v2 service:

```yaml
  otlp-jaeger:
    image: jaegertracing/jaeger:latest
    container_name: otlp-jaeger
    ports:
      - "16686:16686"   # Jaeger UI
    environment:
      - COLLECTOR_OTLP_ENABLED=true
```

Start Jaeger: `docker compose up -d otlp-jaeger`
Open the UI: `http://localhost:16686`

## Standalone CLI: `piobs`

The same report engine outside the pi process — real exit codes
(0 success · 1 replay/IO error · 2 usage):

```sh
./bin/piobs report ~/.pi/agent/sessions/<slug>/<session>.jsonl        # stdout OTLP/JSON-per-line
./bin/piobs report <session-id> --branch=<entry-id>                   # header-resolved, fork selected
./bin/piobs report <path> --file=report.jsonl --otlp --endpoint=http://collector:4318
./bin/piobs --help
```

Install on PATH: `npm link` (from `extensions/pi-obs`) or wire
`bin/piobs` yourself — a sh wrapper over `node src/cli.ts`, no
dependencies, no build step. Full CLI reference: [docs/piobs.md](docs/piobs.md).

## Privacy and redaction

**By default**, no verbatim text, no secrets, no credentials reach the
telemetry:

- Prompt/completion text → content length + SHA-256-12 hash
- Tool result bodies → omitted entirely
- Provider header values → never captured (names only)

**With capture enabled** (`PI_OBS_CAPTURE_PROMPTS=1`,
`PI_OBS_CAPTURE_TOOL_IO=1`), verbatim text is included, but the
redaction list still applies (credential assignments, `sk-` keys,
bearer tokens, AWS key IDs → `[REDACTED]`).

The file exporter refuses targets inside session directories (a safety
measure against overwriting pi's own data).

## Files

| File | Purpose |
|---|---|
| `index.ts` | Entry shim: re-exports `src/index.ts` (pi loads `<dir>/index.ts`). |
| `src/index.ts` | Extension wiring: footer status, `/pi-obs` commands, telemetry startup. |
| `src/stats.ts` | Pure statistics: `computeStats(entries)`, formatters, `reportSession`. No pi imports — reusable standalone. |
| `src/hooks.ts` | pi lifecycle events → OTel record builders. |
| `src/model.ts` | Telemetry data model (records, redaction types, trace/span ID derivation). |
| `src/config.ts` | `PI_OBS_*` env + settings parsing, validation, precedence. |
| `src/queue.ts` | Bounded telemetry queue with drop counters. |
| `src/exporters/file.ts` | Rotating OTLP/JSON-per-line log file exporter. |
| `src/exporters/otlp.ts` · `otlp-json.ts` | OTLP/HTTP exporter (retries, backoff) and shared OTLP/JSON encoding + redaction. |
| `src/replay.ts` | Post-mortem session replay → deterministic OTLP report. |
| `src/semconv.ts` | `pi.*` semantic-convention attribute names. |
| `src/cli.ts` | `piobs` CLI implementation. |
| `src/version.ts` | Version source (derives from `package.json`). |
| `bin/piobs` | Sh wrapper over `node src/cli.ts`. |
| `utils/bump-pi-obs.sh` | Release tool: bump, changelog, validate, signed tag, tarball, GitHub release. |
| `utils/traces-to-html.ts` | Renders an exported traces file as HTML for inspection. |
| `stream-to-collector.sh` · `stream-to-receiver.sh` | Pipe the file exporter's output into an OTel collector / receiver. |
| `test_pi_obs.sh` | Consolidated black-box suite (unit + live + standard-tools + isolation). |
| `docs/SPECS.md` · `DEV_PLAN.md` · `piobs.md` | Normative requirements (R1–R8), build plan, CLI reference. |
| `tests/` | Unit, exporters, live, cli, fixtures, weaver registry tooling. |

## Testing

- **Unit level**: `npm test` (coverage gate — every module ≥ 90% lines
  AND branches, enforced by Node's threshold flags over `tests/unit/**`).
  114 tests, hermetic and model-free. In this repo, the
  `pi-obs-unit-tests` workflow runs the same suite under c8 on every push
  and reports per-file coverage in the job summary.
- **Typecheck**: `npm run typecheck` (`tsc --noEmit`, strict).
- **Black-box suite**: `./test_pi_obs.sh` — unit + live (model-gated) +
  standard-tools + isolation levels, with the AC → check table in its
  header. Skips cleanly when prerequisites are missing.
- **Standard-tools conformance** (R4, when `otelcol` and `weaver` are on
  PATH): the Collector must accept every OTLP/JSON record, and
  `weaver registry live-check` must report zero violations. Pinned:
  otelcol-contrib 0.165.0, weaver 0.28.0, GenAI conventions v1.34.0.

## Packaging

The distributable payload is an allowlist (package.json `files`):
`index.ts` + `src/` + `bin/` + README + CHANGELOG — 18 files, ~48 kB
packed. pi-obs is a proper Pi package: `pi-package` keyword,
`pi.extensions` manifest, peerDependencies on the host (type-only,
never bundled), `CHANGELOG.md` version-headed for pi's "Extension
Updates" display. Publishable: `license: MIT`, `repository` field,
no `private` flag, zero runtime dependencies.

Releases are cut with `utils/bump-pi-obs.sh` — one identifier
everywhere: the GPG-signed commit, the signed tag, and the tarball are
all `pi-obs-X.Y.Z`. The version lives only in `package.json` (derived
everywhere via `src/version.ts`).

Install as a Pi package:

```sh
pi install $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs   # local dir
pi install npm:pi-obs@0.1.9                                    # once published
pi install git:github.com/didier-durand/pi-fleet-kit           # git source
pi -e $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs        # try one invocation
```
