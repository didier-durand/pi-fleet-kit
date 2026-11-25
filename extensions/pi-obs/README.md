# pi-obs — session observability for the pi coding agent

`pi-obs` is a pi extension that answers, live and on demand: *how much
did this session — this project — actually spend?* It derives token
usage, cost, model breakdown, and durations from the session's own
entries — and, when an exporter is configured, mirrors the same facts
out-of-process as OpenTelemetry telemetry. It never mutates the
session: observation only, no extra entries, no side effects on agent
output.

## What you get

| Feature | Detail |
|---|---|
| Footer status | `12.4k tok · $0.09` — live, refreshed on `session_start`, `session_tree`, `turn_end`, `agent_settled`. TUI only; absent in print/JSON mode. |
| `/pi-obs` | Report of the current session's active branch: message counts, duration, token breakdown (in / out / cache read / reasoning), cost, and per-model totals with turn counts. |
| `/pi-obs json` | The same stats as raw JSON (for scripts and RPC consumers). |
| `/pi-obs all` | Aggregate across every session file of this project's session directory: grand totals plus the 15 most recent sessions (when · tokens · cost · file). |
| `/pi-obs status` | Telemetry health: active exporters, queue depth, counters, last export times, last error. |
| `/pi-obs flush` | Drain the telemetry queue now (bounded, with a timeout notice when a backend is dead). |
| `/pi-obs report <id\|path>` | Post-mortem replay of a finished session → deterministic OTLP/JSON report (stdout, one body per line), options `--otlp`, `--file=<path>`, `--branch=<entry-id>`. |
| `/pi-obs help` | The in-session usage surface: every subcommand with a one-line description, the telemetry env vars, and a pointer to the standalone `piobs --help`. Static output — identical in every session. |

## How it works

Two independent layers, both read-only with respect to the session:

**Stats** — pi sessions are JSONL files whose entries already carry the
telemetry: every assistant message records the `provider`/`model` that
produced it and its `usage` (tokens + cost), and `usage`-type entries
record model-attributed usage that is not an assistant message (e.g.
cache warming). `pi-obs` just reads them:

- the **active branch** (`ctx.sessionManager.getBranch()`) is scanned on
  `session_start`, `/tree` navigation, `turn_end`, and `agent_settled` —
  so forked branches are accounted for, not double-counted;
- **`/pi-obs all`** parses every `*.jsonl` file in the project's session
  directory (`ctx.sessionManager.getSessionDir()`), skipping unreadable
  files and malformed lines — one bad file never breaks the report.

**Telemetry** — when an exporter is configured (`PI_OBS_OTLP_ENDPOINT`
or `PI_OBS_FILE=1`), pi's lifecycle events are turned into OTel records
(`hooks.ts`), queued (`queue.ts`, bounded), and exported as
OTLP/JSON — to an OTLP/HTTP endpoint (`exporters/otlp.ts`, retries with
backoff, drop-and-count) and/or a rotating local log file
(`exporters/file.ts`). Redaction runs before the queue and again at
serialization (see [Privacy defaults](#privacy-defaults-r2)). Telemetry
never blocks or alters the agent: failures land in `/pi-obs status`.

All session statistics live in `stats.ts` — pure, no pi imports — so
pi-serve / picl or ad-hoc scripts can reuse it on session files
directly.

## Install

Copy or symlink this directory into the pi auto-discovery locations:

```sh
# global (all projects)
ln -s $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs ~/.pi/agent/extensions/pi-obs

# or project-local (after the project is trusted)
ln -s $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs <project>/.pi/extensions/pi-obs
```

Or test quickly without installing:

```sh
pi -e $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs/index.ts
```

## Usage

```console
$ pi
you> refactor the build script and re-run its tests
…

you> /pi-obs
pi-obs · session
messages: 18 (user 6 · assistant 6 · tool results 6)
duration: 4m 12s
tokens: 89.3k (in 71.2k · out 3.1k · cache read 14.9k · reasoning 2.0k)
cost: $0.0184
models: z-ai/glm-5.3 (6 turns, $0.0184)

you> /pi-obs all
pi-obs · 12 sessions · total 1.2M tok · $0.41

2026-11-17 10:14 · 2.9k tok · $0.0015 · 2026-11-17T10-14-57-…jsonl
2026-11-17 10:12 · 3.1k tok · $0.0021 · 2026-11-17T10-12-24-…jsonl
…

you> /pi-obs json
{ "userMessages": 6, "assistantMessages": 6, … }
```

The footer line appears (and stays updated) in TUI mode. In print/JSON
mode the UI surfaces are absent — but the commands still work, with
output going to stdout, so `pi -p '/pi-obs all'` is scriptable.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Entry shim: re-exports `src/index.ts` (pi loads `<dir>/index.ts`; everything else can move). |
| `src/index.ts` | The extension wiring: footer status line, the `/pi-obs [json\|all\|status\|flush\|report\|help]` command (TUI notify, stdout in print mode), session-file scanning, telemetry startup. |
| `src/stats.ts` | Pure statistics library: `computeStats(entries)`, formatters (`formatTokens`, `formatCost`, `formatDuration`), `reportSession`. No pi imports — reusable standalone (pi-serve, scripts). |
| `src/hooks.ts` | pi lifecycle events → OTel record builders. |
| `src/model.ts` | Telemetry data model (records, redaction types). |
| `src/config.ts` | `PI_OBS_*` env + settings parsing, validation, precedence. |
| `src/queue.ts` | Bounded telemetry queue with drop counters. |
| `src/exporters/file.ts` | Rotating OTLP/JSON-per-line log file exporter. |
| `src/exporters/otlp.ts` · `otlp-json.ts` | OTLP/HTTP exporter (retries, backoff, drop-and-count) and the shared OTLP/JSON record encoding + redaction. |
| `src/replay.ts` | Post-mortem session replay → deterministic OTLP report (powers `/pi-obs report` and the CLI). |
| `src/semconv.ts` | `pi.*` semantic-convention attribute names. |
| `src/cli.ts` | `piobs` CLI implementation (report engine outside the pi process). |
| `src/version.ts` | Single version source (derives from `package.json` for the OTel resource and CLI). |
| `bin/piobs` | Sh wrapper over `node src/cli.ts` — installable on PATH (`npm link`). |
| `utils/bump-pi-obs.sh` | Release tool: bump, changelog entry, package validation, GPG-signed commit+tag `pi-obs-X.Y.Z`, packed tarball, GitHub release upload. |
| `utils/traces-to-html.ts` | Renders an exported traces file as HTML for inspection. |
| `stream-to-collector.sh` · `stream-to-receiver.sh` | Pipe the file exporter's output into an OTel collector / receiver for local experiments. |
| `test_pi_obs.sh` | Consolidated black-box suite (unit + live + standard-tools + isolation levels). |
| `docs/SPECS.md` · `DEV_PLAN.md` · `piobs.md` | Normative requirements (R1–R8), the build plan, and the `piobs` CLI reference with verified examples. |
| `tests/unit/` (+ `exporters/`) | The coverage-gated unit suite (every module ≥ 90% lines and branches). |
| `tests/live/` · `tests/cli/` | Live `pi -e` smoke (model-gated, auto-skip) and standalone CLI end-to-end tests — both run as child processes, deliberately outside coverage runs. |
| `tests/fixtures/` · `tests/tools/` | Session fixtures and the weaver registry tooling (`npm run gen:registry`). |

## Configuration (telemetry — SPECS R6)

The observability telemetry is configured via `PI_OBS_*` environment
variables and a `"pi-obs"` block in `${PI_HOME}/agent/settings.json`
(camelCase keys). Precedence: **environment variable > settings block >
default**. Telemetry is **inactive by default** until an exporter is
configured (`PI_OBS_OTLP_ENDPOINT` or `PI_OBS_FILE=1`); the stats
command works regardless.

| Variable | Default | Meaning |
|---|---|---|
| `PI_OBS_ENABLED` | `1` when any exporter is configured | master switch |
| `PI_OBS_OTLP_ENDPOINT` | — | OTLP/HTTP endpoint URL (enables OTLP export) |
| `PI_OBS_OTLP_HEADERS` | — | extra headers, `k=v,k=v` |
| `PI_OBS_OTLP_TIMEOUT_MS` | `5000` | per-request timeout |
| `PI_OBS_OTLP_BATCH` | `64` | records per OTLP request |
| `PI_OBS_FILE` | `0` | `1` enables the file exporter |
| `PI_OBS_FILE_PATH` | `${PI_SERVE_DIR:-~/.pi}/obs/pi-obs.jsonl` | target log file |
| `PI_OBS_FILE_MAX_BYTES` | `10485760` (10 MiB) | rotation size |
| `PI_OBS_FILE_MAX_FILES` | `5` | files kept total (active + rotated), oldest dropped |
| `PI_OBS_CAPTURE_PROMPTS` | `0` | opt-in for prompt/completion text (R2) |
| `PI_OBS_CAPTURE_TOOL_IO` | `0` | opt-in for tool result bodies (R2) |
| `PI_OBS_QUEUE_MAX` | `4096` | bounded queue size |
| `PI_OBS_RESOURCE_SERVICE` | `pi-agent` | OTel `service.name` |

Invalid values never crash the agent: they are reported on stderr and
the default stands for that key.

## Telemetry setup (R5)

Telemetry is **inactive until an exporter is configured** (see the
table above). One or both legs:

```sh
# file exporter (OTLP/JSON records, one per line — ingestable by otelcol or jq)
PI_OBS_FILE=1 PI_OBS_FILE_PATH=/var/log/pi-obs.jsonl pi …

# OTLP/HTTP exporter (one endpoint configures all three signals:
# /v1/traces|metrics|logs are derived; retries with backoff, drop-and-count)
PI_OBS_OTLP_ENDPOINT=http://collector:4318 pi …
```

At runtime: `/pi-obs status` shows active exporters, queue depth,
counters, last export times and the last error; `/pi-obs flush`
forces a bounded drain; `/pi-obs report <session-id | path>
[session-dir] [--otlp] [--file=<path>] [--branch=<entry-id>]` emits a
deterministic post-mortem OTLP report (stdout, one OTLP/JSON body per
line) of a finished session.

### Standalone CLI: `piobs`

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
dependencies, no build step. The e2e tests in `tests/cli/` drive the
real wrapper. The complete command and option reference, with
verified examples and the troubleshooting table:
[docs/piobs.md](docs/piobs.md).

## Privacy defaults (R2)

No secrets, credentials, or verbatim text in telemetry by default:
prompt/completion text is replaced by a content length + SHA-256-12
hash; tool result bodies are omitted; provider header VALUES are never
captured (names only). `PI_OBS_CAPTURE_PROMPTS=1` / 
`PI_OBS_CAPTURE_TOOL_IO=1` opt in to verbatim capture — a documented
redaction list (credential assignments, `sk-` keys, bearer tokens,
AWS key ids) is applied before anything reaches the queue, and again
at serialization. The file exporter refuses targets inside session
directories.

## Packaging (R1/R8)

The distributable payload is an **allowlist** (package.json `files`):
`index.ts` (the shim) + `src/` + `bin/` + this README + `CHANGELOG.md`
— 18 files, ~48 kB packed. Nothing else ships: no tests,
fixtures, docs, suite, stream helpers, conformance assets, or
devDependencies.

pi-obs is a proper **Pi package** (per the pi agent's packages
conventions): an explicit `pi` manifest points discovery at the root
extension, the `pi-package` keyword makes it gallery-eligible, the
host package (`@earendil-works/pi-coding-agent` — a type-only
import) is declared in `peerDependencies` and never bundled, and
`CHANGELOG.md` (version-headed, matched against package.json) feeds
pi's "Extension Updates" display. The manifest is publishable:
`license: MIT` and a `repository` pointer are declared, there is no
`private` flag, and it carries zero runtime dependencies.

Install as a Pi package (any documented source):

```sh
pi install $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs           # local dir (loaded in place)
pi install npm:pi-obs@0.1.9                           # once published
pi install git:github.com/didier-durand/pi-fleet-kit  # git source (this repo)
pi -e $PI_FLEET_KIT_HOME/pi-fleet-kit/extensions/pi-obs                # try for one invocation
```

Or from the tarball directly:

```sh
npm pack                                   # pi-obs-0.1.9.tgz — the tag name IS the tarball name
tar xzf pi-obs-0.1.9.tgz && pi install ./package
npm i -g ./pi-obs-0.1.9.tgz                # or: piobs on PATH
```

`pi list` shows installed packages; the object form in settings
(`{"source": ..., "skills": [], ...}`) narrows which resources load;
`pi remove <source>` uninstalls. Releases are cut with
`utils/bump-pi-obs.sh` — one identifier everywhere: the GPG-signed
commit message, the signed tag, and the tarball are all
`pi-obs-X.Y.Z` (no `v`), with a `## [X.Y.Z] - date` changelog entry
inserted automatically, the artifact packed in the pi-obs root, and
the tarball uploaded to the GitHub release for the tag (notes from
the changelog) — it is never committed to the repo itself. The script
is repo-agnostic: it operates on whatever checkout hosts
`extensions/pi-obs/`.

The version is defined ONLY in `package.json` (`npm version
patch|minor|major` to bump — the OTel resource, scopes, and the CLI
derive it via `src/version.ts`). The packed artifact runs standalone
with **zero installed dependencies**: node ≥ 23.6 loads the TypeScript directly (the pi
extension path uses pi's own jiti, which has no such floor).

## Testing (R8)

- **Unit level**: `npm test` (the coverage gate — every module ≥ 90%
  lines AND branches, enforced by Node's threshold flags over
  `tests/unit/**`). 114 tests, hermetic and model-free. In this repo,
  the `pi-obs-unit-tests` workflow runs the same suite under c8 on
  every push and reports per-file coverage in the job summary
  (`utils/run-tests.sh pi-obs "tests/unit/**/*.test.ts"`).
- **Typecheck**: `npm run typecheck` (`tsc --noEmit`, strict) — a
  gate alongside coverage: Node's type-stripping does no type
  checking.
- **Black-box suite**: `./test_pi_obs.sh` — unit + live (model-gated
  on `OPENROUTER_API_KEY`) + standard-tools + isolation levels, with
  the AC → check table in its header. Skips cleanly when
  prerequisites are missing.
- **Standard-tools conformance** (R4, when `otelcol` and `weaver` are
  on PATH): the Collector must accept every OTLP/JSON record
  (structural), and `weaver registry live-check` must report zero
  violations against the pinned GenAI semantic conventions
  (v1.34.0) plus the generated `pi.*` registry
  (`tests/tools/weaver/`, regenerated by `npm run gen:registry`).
  Pinned tools: otelcol-contrib 0.165.0, weaver 0.28.0.

## Future work

- Per-day/per-project rollups with a `--since` filter on `/pi-obs all`.
- A `pi-obs` tool the agent can call to budget itself mid-task.
- picl integration: surface the same stats in `picl sessions show`.
