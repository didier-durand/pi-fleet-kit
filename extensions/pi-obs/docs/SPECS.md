# pi-obs — OpenTelemetry observability extension for the pi coding agent

Specification version: 1.0.1 (semver — matches the tag `specs-1.0.1`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** implemented — the extension ships as v0.1.9 (see
> `package.json`); this spec is the contract it was built against.
> The existing `stats.ts` summary feature (`/pi-obs` stats command)
> predates this spec and is retained unchanged (R7).

## Objective

`pi-obs` is a **pi coding agent extension** that turns the agent's own
activity into standards-compliant **OpenTelemetry** telemetry. It hooks
into the **full pi extension event surface** — user interaction, tool
calls, model calls, session lifecycle — transforms what it observes into
OTel traces, metrics, and log records, and **exports them either to an
OpenTelemetry backend (OTLP) or to a local log file** — either, both, or
neither, by configuration.

It is observation only: pi-obs MUST NOT modify sessions, alter agent
behavior, or degrade the interactive experience.

## Context and grounding (must be respected)

1. **Pi extension standard.** pi-obs is a standard extension of
   `@earendil-works/pi-coding-agent` (v1.5.2 surface, verified against
   its `docs/extensions.md`): a TypeScript module (jiti-loaded, no
   build step) exporting a default factory over `ExtensionAPI`;
   auto-discovery from `~/.pi/agent/extensions/pi-obs/index.ts` or
   project-local `.pi/extensions/`; hot-reloadable; testable ad hoc via
   `pi -e ./pi-obs/index.ts`. The entry is a one-line shim re-exporting
   `src/index.ts` (see Artifact structure) — discovery and `-e` paths
   stay stable while the implementation lives in `src/`. It runs
   inside the pi process with the
   user's permissions, and MUST respect `ctx.mode`
   (`tui`/`rpc`/`json`/`print`) and `ctx.hasUI` guards. It MUST run
   inside the `pi-agent` Docker image when added to `PI_EXTENSIONS`.
2. **The hook inventory is fixed by pi, not by us.** The extension event
   surface (verified against `docs/extensions.md` of the installed
   version) is exactly **41 hooks**, grouped:
   - **startup/resources (3):** `project_trust`, `resources_discover`,
     `mcp_servers_change`;
   - **user interaction (4):** `input` (raw typed/API text, source
     `interactive|rpc|extension`, streaming behavior),
     `ui_prompt_start` / `ui_prompt_end`, `user_bash`;
   - **agent and model (16):** `before_agent_start`, `agent_start`,
     `agent_end`, `agent_before_settle`, `agent_settled`, `turn_start`,
     `turn_end`, `context`, `context_with_system`,
     `before_provider_headers`, `before_provider_request`,
     `after_provider_response`, `provider_stream_event`,
     `message_start`, `message_update`, `message_end`;
   - **model selection/decisions (3):** `model_select`,
     `thinking_level_select`, `cache_warming_decision`;
   - **tool calls (5):** `tool_execution_start`, `tool_call` (can block
     or mutate), `tool_execution_update`, `tool_result` (can mutate),
     `tool_execution_end`;
   - **session lifecycle (10):** `session_start` (reason
     `startup|reload|new|resume|fork`), `session_shutdown`,
     `session_info_changed`, `session_before_switch`,
     `session_before_fork`, `session_before_compact` /
     `session_compact` / `session_compact_failed`,
     `session_before_tree` / `session_tree`.
   R3's usage inventory MUST account for each of the 41 exactly once.
   No capability outside this surface may be assumed; anything pi does
   not expose is a stated limitation, not an invented one.
3. **Telemetry data is already on the wire.** Assistant `message_end`
   payloads carry `provider`, `model`, `usage`
   (input/output/cacheRead/cacheWrite/reasoning/totalTokens + cost) and
   `stopReason`; session files record the same. pi-obs reuses these
   facts — it does not compute cost itself.
4. **OpenTelemetry standards.** Formatting follows the OTel data model
   (traces/spans, metrics, log records; W3C trace context IDs) and the
   GenAI semantic conventions (`gen_ai.*` attributes for requests,
   models, token usage, operation names) where they apply; anything
   pi-specific lives in a documented `pi.*` custom attribute namespace.
   Export follows OTLP. The OTLP/JSON encoding is implemented natively
   (zero npm dependencies) so the extension stays portable and bakeable
   into images; adopting the official `@opentelemetry/*` SDK is an
   open question (§Open questions), not the default.
5. **Replay source (post-mortem grounding).** Sessions are pi's own
   append-only JSONL files under
   `${PI_HOME:-~/.pi}/agent/sessions/<workspace-slug>/…jsonl` whose entries
   (`message` roles, `usage`, `compaction`, `model_change`, `tree`, …)
   carry timestamps, providers, models, usage/cost, and branch structure
   (`id`/`parentId`) — sufficient to rebuild a faithful timeline of a
   **finished** session offline, without any live hook (R3b). pi-obs
   reads these files; it MUST NOT rewrite or annotate them.
6. **Repo conventions.** All artifacts are generated from prompt/spec
   files; tests are black-box and POSIX bash 3.2-safe under `set -u`;
   no secrets baked or logged; images stay minimal and parametrized.
   Sessions are pi's own JSONL — canonical, never rewritten by tools.

## Artifact structure (normative)

The extension follows a standard TypeScript project layout, adapted to
pi's jiti/no-build loading (grounding §1). This structure is
normative — later steps and contributions conform to it:

```
pi-obs/
├── package.json        # name/version/scripts/engines/devDependencies
├── tsconfig.json       # strict, noEmit (a typecheck gate, never a build)
├── index.ts            # jiti entry SHIM: re-exports ./src/index.ts
│                       #   (auto-discovery and `pi -e` keep loading this)
├── README.md           # user-facing docs (root, npm convention)
├── test_pi_obs.sh      # the black-box suite entry (root, repo convention)
├── bin/piobs           # the standalone CLI entry (sh wrapper -> node src/cli.ts)
├── stream-to-receiver.sh   # OTEL stream helper, Leg 1 (piobs --otlp into
│                           #   the throwaway receiver; parametrized)
├── stream-to-collector.sh  # OTEL stream helper, Leg 2 (piobs --otlp into
│                           #   a real otelcol; parametrized)
├── src/                # ALL runtime code (jiti-loaded, no build output)
│   ├── index.ts        # the real entry (subscriptions + commands)
│   ├── version.ts      # the version, derived from package.json (single source)
│   ├── semconv.ts  config.ts  model.ts  queue.ts
│   ├── hooks.ts    replay.ts    stats.ts
│   └── exporters/      # file.ts, otlp.ts, otlp-json.ts
├── tests/
│   ├── unit/           # *.test.ts — the coverage-gated run
│   │   └── exporters/
│   ├── live/           # model-gated tests, DELIBERATELY outside the
│   │                   #   coverage glob (child-process runs corrupt
│   │                   #   V8 coverage collection)
│   ├── cli/            # standalone-CLI end-to-end tests (child-process
│   │                   #   spawns — also outside the coverage glob)
│   ├── harness.ts      # the mock ExtensionAPI/ExtensionContext
│   ├── otlp_receiver.ts / otlp_receiver_main.ts
│   ├── fixtures/       # payload + session fixtures (checked in)
│   └── tools/          # standard-tools assets: gen_weaver_registry.ts,
│                       #   otelcol-*.yaml, weaver/ (manifest, generated
│                       #   pi_registry.yaml, weaver.toml). The stream
│                       #   helpers live at the package root (they are
│                       #   user utilities, not test assets)
└── docs/
    ├── SPECS.md        # this document (the source of truth)
    ├── DEV_PLAN.md
    └── piobs.md        # the standalone CLI reference
```

Rules:
- **No build output ever**: `tsc --noEmit` only. pi loads `src/*.ts`
  through the root `index.ts` shim; a `dist/` that runtime depends on
  would violate grounding §1.
- **Packaging is an allowlist, not a build**: the distributable
  payload is exactly `index.ts` + `src/` + `bin/` + `package.json` +
  `README.md` (enforced by the package.json `files` field — `npm
  pack` yields 18 files, ~48 kB). Everything else — tests, fixtures,
  docs, SPECS/DEV_PLAN, the suite, the stream helpers, the
  standard-tools assets, devDependencies — is repository material
  and MUST NOT ship. The packed artifact must work standalone with
  ZERO installed dependencies (both the extension via the shim and
  the piobs CLI).
- **Pi package conventions** (per the pi agent's packages doc): an
  explicit `pi` manifest in package.json (`extensions: ["./index.ts"]` — the
  extension lives at the package root), the `pi-package` keyword
  (gallery eligibility), the host package in `peerDependencies`
  with a `*` range (the single agent import is type-only — never
  bundled, never in `dependencies`), and a version-headed
  `CHANGELOG.md` shipped in the tarball (matched against
  package.json's version for pi's "Extension Updates"). Installable
  via every documented source: `pi install <local dir>`, `npm:`,
  `git:`, or `pi -e`.
- **The typecheck is a gate**: `npm run typecheck` must pass locally
  and in CI alongside the coverage gate. Node's type-stripping does
  no type checking — the devDependency on
  `@earendil-works/pi-coding-agent` exists so `import type` resolves
  and the entry-point contract is checked at commit time.
- **Coverage glob**: `tests/unit/**` (and only that) — the unit/live
  and unit/cli splits in `tests/` are load-bearing, not cosmetic: any
  test that spawns child processes lives outside the glob (they
  corrupt V8 coverage collection).
- **Standard-tools assets** live under `tests/tools/` with the
  generated registry checked in and regenerated by
  `tests/tools/gen_weaver_registry.ts`.

## Glossary (use these terms consistently)

- **hook** — one pi extension event subscription (`pi.on(...)`) and its
  handler; the only capture mechanism pi-obs has.
- **capture point** — a defined point in the agent's activity where
  telemetry is produced (a hook, possibly combined with its event data).
- **span** — an OTel span: one named, timed operation. pi-obs builds a
  hierarchy: `pi.session` → `pi.run` → `pi.turn` → { `pi.model`, `pi.tool <name>` }.
- **trace** — the full span tree of one session, identified by a W3C
  trace ID minted at `session_start`.
- **exporter** — a sink for finished telemetry: the OTLP exporter
  (HTTP to a backend) or the file exporter (OTLP/JSON records, one per
  line, in a local log file).
- **dialexecog** — the dialogue-and-execution cognition stream (term
  shared with `pi-serve/SPECS.md`): assistant text/thinking deltas, tool
  calls and results, usage/cost, run lifecycle events.
- **GenAI semconv** — the OTel semantic conventions for generative AI
  (`gen_ai.*` span attributes).

## Requirements

### How to read this section

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119. Each requirement has **Statement**,
**Details**, and **AC** (acceptance criteria, verified mechanically by
`pi-obs/test_pi_obs.sh` unless tagged **[doc]**).

**Requirements index:**

| ID  | Area        | Obligation (one line)                                                            | Priority tier |
|-----|-------------|----------------------------------------------------------------------------------|---------------|
| R1  | Safety      | Standard-conformant extension that never harms or alters the agent               | 1 (highest)   |
| R2  | Privacy     | No secrets or prompt content in telemetry without explicit opt-in                 | 2 |
| R3  | Coverage    | Every documented pi hook mapped to a defined OTel entity                          | 3 |
| R3b | Post-mortem | OTel-formatted report replayed offline from a session id or a session file path    | 3 |
| R4  | Formatting  | OTel data model + GenAI semantic conventions, `pi.*` custom namespace             | 4 |
| R5  | Export      | OTLP backend export and local log-file export, independently switchable          | 5 |
| R6  | Config      | Environment-variable + settings configuration with documented precedence         | 6 |
| R7  | UX          | `/pi-obs` stats retained; `status`/`flush` surface exporter health                 | 7 |
| R8  | Testing     | Black-box suite proving R1–R7 without white-box knowledge                         | 8 |

**Priority when requirements conflict** (highest first): safety (R1) >
privacy (R2) > coverage (R3, R3b) > formatting (R4) > export (R5) > the
remaining requirements. The one anticipated conflict — full coverage
(R3) vs. zero overhead (R1) — resolves by *degrading capture fidelity*
(e.g. counting `message_update` deltas as metrics instead of span
events), never by blocking the agent.

### R1 — A standard, zero-harm extension

**Statement.** pi-obs is a pi extension in the standard layout and
conventions, and its observation MUST NOT degrade, block, or alter the
agent in any mode.

**Details.**
- Layout: `pi-obs/index.ts` as the entry (directory-style extension);
  auxiliary modules beside it; TypeScript via jiti; no build step; no
  native modules; core path with **zero npm dependencies**.
- Observation only: MUST NOT append entries, mutate messages, rewrite
  session files, or inject anything into LLM context. (Registering
  read-only `/pi-obs` commands is allowed — commands are user-initiated.)
- Failure isolation: every hook handler is wrapped; any throw is caught,
  reported once on stderr, and disables that handler's *emission* (not
  the agent). pi-obs MUST never propagate an exception to pi.
- Overhead: synchronous per-hook work ≤ 1 ms (attribute assembly +
  enqueue); everything else (serialization, I/O, export) is asynchronous.
- Mode behavior: telemetry is captured in all modes (`tui`, `rpc`,
  `json`, `print`); UI-facing features (footer status, notify) are
  guarded by `ctx.hasUI` as usual.
- Shutdown: `session_shutdown` (all reasons) flushes queued telemetry;
  pending data MUST NOT be silently lost when pi exits normally.

**AC.**
- pi-obs loads via auto-discovery and via `pi -e` on the installed
  pi version; `pi list` reports it.
- A scripted session (`pi -e ./pi-obs/index.ts -p …`) with the exporter
  pointed at an unreachable endpoint completes with identical output
  and exit code to the same session without pi-obs.
- Session files of a run with pi-obs active are byte-identical in
  structure to a run without it (no extra entry types).
- A fault-injection unit test (handler that always throws) leaves the
  agent run unaffected and stderr carrying exactly one report per
  handler.

### R2 — Privacy by default

**Statement.** Telemetry MUST NOT contain secrets, credentials, or
verbatim user/assistant text unless explicitly enabled.

**Details.**
- Provider headers: `before_provider_headers` records header **names**
  only, never values. No `*_API_KEY`, token, or `Authorization` value is
  ever captured, in any attribute, event, or log body.
- Prompt and completion text: omitted by default; only lengths
  (character counts) and a stable content hash (SHA-256, first 12 hex)
  are recorded. `PI_OBS_CAPTURE_PROMPTS=1` opts in to full prompt text
  on `input` events; assistant text capture follows the same switch.
- Tool I/O: file paths and command lines ARE captured (they are the
  work being observed); tool *result* bodies are omitted unless
  `PI_OBS_CAPTURE_TOOL_IO=1`.
- A documented redaction list (key names and value patterns) is applied
  to any opt-in captured text before export; redacted bytes are replaced
  by `[REDACTED]`.
- The file exporter target directory MUST NOT be inside any session
  directory; default is `${PI_SERVE_DIR:-~/.pi}/obs/pi-obs.jsonl`
  (separate from telemetry sources).

**AC.**
- A canary test exports with `PI_OBS_CAPTURE_PROMPTS=1` while exporting
  `SECRET_CANARY=<value>`; neither the value nor any substring ≥ 8 chars
  of it appears in the export file or receiver payload.
- With defaults, no exported record contains a `content`/`text`/prompt
  body; lengths and hashes are present instead.
- `before_provider_headers`-derived records contain header names only.

### R3 — Full hook coverage

**Statement.** Every one of the 41 documented hooks (grounding §2)
appears **exactly once** in the usage inventory below — subscribed (with
its emission and any handler constraint) or explicitly **not**
subscribed (with a reason). Nothing is silently ignored.

**Details.**
- The inventory is normative and has four categories:
  - **A — subscribed, emitting entities** (36 hooks): each maps to a
    defined OTel entity (table below).
  - **B — subscribed, metrics-only** (2 hooks): feed R4 counters and
    measurements only — no span or span-event emission (volume
    control).
  - **C — inert-handler constraint** (12 of the subscribed hooks): the
    decision/transformation hooks where the pi-obs handler MUST observe
    only — list below.
  - **D — not subscribed** (3 hooks): reasons stated per hook.
- `session_start` mints the trace (W3C trace ID) and opens the root
  `pi.session` span; `session_shutdown` closes it and flushes. `/tree`
  navigation, compaction, forks, switches, renames, and model/thinking
  level changes are span events on the root span, keeping one trace per
  session lifetime.
- Streaming deltas MUST NOT become individual spans or events; they
  feed category-B metrics (counters, time-to-first-token).

**A — Subscribed, emitting entities (36 hooks):**

| Hook | Entity |
|---|---|
| `session_start` | start of root span `pi.session` (attrs: `pi.session.id`, `pi.session.file`, `pi.session.reason`, `pi.cwd`) — the trace id is DERIVED from the session id (`deriveTraceId(sessionId)`, R3b parity), so any component holding a session id can resolve the trace |
| mailbox deliveries | a `mailbox` session entry (appended by the prompt-trigger extension on delivery) becomes a span LINK on the receiver's `pi.session` span: `traceId = deriveTraceId(sender session_id)` + the `pi.mailbox.session_id` link attribute — distributed traces across agents |
| `session_shutdown` | end of root span; flush |
| `session_info_changed` | span event `pi.session.renamed` |
| `session_before_switch` / `session_before_fork` | span event `pi.session.switch` / `pi.session.fork` (with cancellation outcome) |
| `session_before_compact` / `session_compact` / `session_compact_failed` | span event `pi.session.compact` (reason, outcome, tokens before) |
| `session_before_tree` / `session_tree` | span event `pi.session.tree` (target, summary presence) |
| `project_trust` / `resources_discover` | span event `pi.resources` (reason) |
| `input` | span event `pi.user.input` (source, streaming behavior, length, hash; text per R2) |
| `user_bash` | span event `pi.user.bash` (command line, outcome) |
| `ui_prompt_start` / `ui_prompt_end` | span event `pi.ui.prompt` (kind, duration) |
| `before_agent_start` | start of span `pi.run` (child of root) |
| `agent_start` / `agent_end` / `agent_before_settle` / `agent_settled` | attributes/events on `pi.run` (aborted flag at settle) |
| `turn_start` / `turn_end` | start/end of span `pi.turn` (child of `pi.run`) |
| `before_provider_headers` | header **names only** as event `pi.model.headers` on the model span (R2: values never) |
| `before_provider_request` | start of span `pi.model` (child of `pi.turn`; GenAI semconv attrs, R4) |
| `after_provider_response` | event `pi.model.response_status` (status) |
| `message_end` | end of `pi.model`; GenAI usage + stop-reason attributes |
| `model_select` | span event `pi.session.model_change` (provider, model id) — parity with session `model_change` entries replayed by R3b |
| `thinking_level_select` | span event `pi.session.thinking_level_change` (level) — parity with `thinking_level_change` entries |
| `cache_warming_decision` | span event `pi.model.cache_warming` (decision observed) — the resulting `cache_warm` usage is a session entry, replayed by R3b |
| `tool_execution_start` | start of span `pi.tool <name>` (child of `pi.turn`) |
| `tool_call` | event on the tool span (blocked/mutated outcome) |
| `tool_result` / `tool_execution_end` | end of tool span (is-error, duration; result body per R2) |
| `context` / `context_with_system` | span event `pi.context` (message count in/out) — read-only observation |

**B — Subscribed, metrics-only (2 hooks):**

| Hook | Metric contribution (R4) |
|---|---|
| `message_update` | delta counters (`pi.messages` by role, streaming bytes); first-delta timestamp closes the `pi.model.time_to_first_token` measurement opened at `before_provider_request` |
| `tool_execution_update` | `pi.tool.updates` counter |

**C — Inert-handler constraint (12 subscribed hooks):** these hooks
can decide or transform (`input` can transform/handle; `context` /
`context_with_system` can modify messages; `before_provider_headers`
can mutate headers; `before_provider_request` can replace the payload;
`tool_call` can block/mutate; `tool_result` can mutate; the
`session_before_*` hooks can cancel; `cache_warming_decision`
participates in a decision). The pi-obs handler MUST observe only: it
returns `undefined` (pi's default continue) and thereby never blocks,
cancels, transforms, replaces, or decides anything. This is R1
zero-harm, made per-hook explicit:

`input`, `context`, `context_with_system`, `before_provider_headers`,
`before_provider_request`, `tool_call`, `tool_result`,
`session_before_switch`, `session_before_fork`,
`session_before_compact`, `session_before_tree`,
`cache_warming_decision`.

**D — Not subscribed (3 hooks), with reasons:**

| Hook | Reason |
|---|---|
| `provider_stream_event` | Highest-fire-rate hook (per raw provider event). Its OTel-relevant content is already covered: text/thinking deltas via `message_update` (B), usage via `message_end` (A). A no-op subscription at this frequency is pure overhead (R1 economy) with no additional entity. |
| `message_start` | No unique entity: the `pi.model` span opens at `before_provider_request` and closes at `message_end`; time-to-first-token is measured from request start to the first `message_update` delta. A subscription would be a no-op. |
| `mcp_servers_change` | Resource configuration change, not agent activity; no session entry records it (so R3b replay cannot reproduce it either). MAY be added later as a span event under the add-only rule if MCP observability becomes a requirement. |

**AC.** A unit test walks the complete 41-hook inventory (grounding §2)
and fails if any hook is missing from the implementation's registry or
appears in more than one category; the same test asserts that the 3
category-D hooks have **no** registered handler. A live smoke run of a
scripted session (one prompt, one tool call, one model call) produces a
trace containing exactly the spans `pi.session` > `pi.run` > `pi.turn` >
{ `pi.model`, `pi.tool …` }.

### R3b — Offline replay: post-mortem OTel reports

**Statement.** pi-obs generates an OTel-formatted report for a **finished**
session — selected by **session id** or by **session file path** — without
running the agent, for post-mortem analysis.
**Details.**
- **Command surface:**
  - `/pi-obs report <session-id>` — resolve the id against the current
    workspace's session directory
    (`ctx.sessionManager.getSessionDir()`); a session directory may be
    given as `/pi-obs report <session-id> <dir>` when the target project
    differs from the current one;
  - `/pi-obs report <path>` — a session file path (absolute, or relative
    to `ctx.cwd`), for archives and containers where no session
    directory is mounted;
  - **`piobs`** — a standalone CLI (`bin/piobs`, node-backed, no pi
    process) exposing the same report engine outside the agent:
    `piobs report <session-id | path> [session-dir]` with the same
    flags (`--branch`, `--file`, `--otlp`), the same resolution and
    R2 rules, plus `--endpoint=<url>`, `--capture-prompts`,
    `--capture-tool-io`, `--service=<name>`, `--sessions-dir=<dir>`,
    and `--help`. Where the in-pi command cannot control the process
    exit code, the standalone CLI MUST: 0 success, 1 replay/IO error,
    2 usage error. The default sessions directory is
    `~/.pi/agent/sessions` (pi's own location).
- **Resolution:** a session id is resolved to a file by scanning the
    session directory for a header entry
  (`{"type":"session","id":"<uuid>"}`) with a matching `id` (file
  name is not authoritative — the header wins); ambiguous matches (the
  same id in multiple files) MUST be reported as an error, not guessed.
  A path argument is used verbatim; a missing/unreadable/empty file is a
  hard error with the offending path.
- **Replay engine (offline):** the file's entries are replayed through
  the **same entity builders as live capture** (R3/R4) — no parallel
  formatting code path: entry timestamps become span timestamps;
  assistant messages open/close `pi.model` spans (per
  `provider`/`model`/`usage` from the entry), tool results close
  matching `pi.tool` spans, user messages are `pi.user.input` events,
  `usage`/`compaction`/`model_change`/`tree` entries become their R3
  entities; the W3C trace/span IDs are **re-derived deterministically**
  from the session id + entry `id`s (stable across replays), so a
  re-run of the report yields a byte-stable output.
- **Unavailable live data is marked, not fabricated:** fields only a
  live hook can know (streaming deltas, time-to-first-token, UI prompt
  durations) MUST be omitted — the report carries
  `pi.replayed=true` on the resource and a `pi.replay.source`
  attribute (renamed from `pi.replay` during Step 9's Weaver
  conformance: an attribute may not also be a namespace prefix) —
  never synthesized values.
- **Branch handling:** the active branch is rebuilt from the entry tree
  (`id`/`parentId`) exactly as pi replays it; abandoned-branch entries
  are excluded from spans by default. `--branch=<entry-id>` selects the
  branch ending at that entry. Compaction entries contribute their
  `pi.session.compact` event and token counts, per pi semantics.
- **Output:** by default the report is written as **OTLP/JSON export
  request bodies** (one per line — the same encoding as the file
  exporter, R5) to stdout — so it pipes straight into `otelcol` or jq;
  `--otlp` (or `PI_OBS_OTLP_ENDPOINT`) reuses the OTLP exporter with the
  same batching/retry policy to **post the report to a backend**, and
  `--file=<path>` writes it to a file (same rotation policy as R5).
- **Privacy parity (R2):** the same redaction/opt-in rules govern
  replayed content — a post-mortem report of a session is subject to
  the same capture switches, applied to entry message bodies.

**AC.**
- `/pi-obs report <path>` on a fixture session file produces an
  OTLP/JSON-per-line report that a checker script validates: every line
  parses; the span set matches the entry set (one `pi.model` span per
  assistant message, `pi.tool` spans from tool results, root
  `pi.session`); usage/cost attributes equal the sum of the entries'
  `usage` fields.
- The same fixture replayed twice yields **byte-identical** output
  (deterministic IDs).
- Resolution ACs: a header-`id` mismatch (file renamed) still resolves;
  an unknown session id, an unreadable path, and an ambiguous id all
  fail with distinct, actionable error messages (exit non-zero in
  print mode).
- `--otlp` against the suite's throwaway receiver delivers the same
  span set as the stdout report.
- Replay of a fixture containing a secret-looking value in a user
  message applies R2 redaction by default.

### R4 — OpenTelemetry-standard formatting

**Statement.** All captured data is formatted as OTel entities — spans,
metrics, and log records — following the GenAI semantic conventions and
a documented `pi.*` custom namespace.

**Details.**
- **IDs and context:** W3C-compliant trace and span IDs, minted with a
  cryptographically adequate RNG; span parent/child relations follow the
  R3 hierarchy. Spans carry OTel `status` (`error` on failed tool
  results, aborted runs, provider errors) and end timestamps.
- **GenAI semconv (MUST where applicable):** on `pi.model` spans —
  `gen_ai.system` (pi provider name), `gen_ai.operation.name`
  (`generate_content`), `gen_ai.request.model` and
  `gen_ai.response.model`, `gen_ai.usage.input_tokens` /
  `gen_ai.usage.output_tokens` (cache-read and reasoning tokens add a
  `gen_ai.token.type`-distinguished counter), `gen_ai.response.id`
  when pi provides one.
- **Custom namespace `pi.*`:** every non-standard attribute is
  registered in a single `semconv.ts` table (name, type, hook, meaning)
  — e.g. `pi.session.id`, `pi.turn.index`, `pi.cost.total`,
  `pi.tool.name`, `pi.hook`. Adding attributes extends the table; the
  table is the contract.
- **Metrics (OTel data model):** counters `pi.model.requests`,
  `pi.tokens` (attributes: token type), `pi.cost.total` (USD),
  `pi.tool.calls` (tool name), `pi.messages` (role); histograms
  `pi.model.duration`, `pi.model.time_to_first_token`, `pi.turn.duration`,
  `pi.tool.duration`.
- **Log records:** exporter health events, dropped-telemetry notices,
  and handler-fault reports (R1) are OTel log records with severity,
  never stderr-only.
- **Cost:** recorded as `pi.cost.total` (sum of message usage cost) —
  cost is not OTel-standard; it stays in the custom namespace.
- **Standard-tool validation (not self-asserted):** conformance claims are
  backed by the reference OSS toolchain wherever those tools can run:
  1. **OpenTelemetry Collector** (`otelcol`) — the structural gate. Every
     exported record MUST be accepted by a locally running Collector's
     OTLP receiver: its parse is the reference wire-format check (the
     OTLP/JSON encoding rules — lowerCamelCase field names, hex trace/span
     IDs, string-encoded int64s — included); anything it rejects is a
     defect in pi-obs, not in the Collector.
  2. **Weaver** (`weaver registry live-check`) — the semantic gate.
     Emitted telemetry is validated against the pinned GenAI
     semantic-convention registry plus pi-obs's own `pi.*` registry
     (generated from the `semconv.ts` table — the table is the contract);
     findings gate at the `violation` level (non-zero exit).
  Both tools are Apache-2.0 and freely obtainable; tool versions and the
  semconv registry revision are PINNED by the test suite for reproducible
  findings. When either binary is absent the level is skipped cleanly
  with an explicit notice (R8) — the gate upgrades assurance, never
  blocks the stock-machine suite.

**AC.** Unit tests assert: trace/span ID format; the GenAI attribute set
on a captured model span given a fixture `message_end` payload; metric
name/type table matches this section. **[doc]** The `pi.*` registry
table exists and every attribute emitted appears in it. When `otelcol`
and `weaver` are present, the CI gate holds: the Collector accepts
every exported record of a scripted session, Weaver reports zero
`violation`-level findings (including zero `missing_attribute` /
`illegal_namespace` for the `pi.*` namespace), and the gate exits
non-zero on any violation.

### R5 — Dual exporters: OTLP backend or local log file

**Statement.** pi-obs offers two independently switchable exporters —
OTLP over HTTP to an OpenTelemetry backend, and a local log file —
and either, both, or neither may be active.

**Details.**
- **OTLP exporter:** OTLP/HTTP POST, JSON encoding (`application/json`),
  configurable endpoint URL, header map, request timeout, and batch
  size; responses outside 2xx are retried on an exponential backoff up
  to a bounded number of attempts, then the batch is dropped and
  counted. Endpoints under `http://` are accepted (local collectors are
  the norm) and warned about once on stderr.
- **File exporter:** writes finished telemetry as **OTLP/JSON export
  request bodies, one per line** (resource-spans / resource-metrics /
  resource-logs records) into a local log file — i.e. the file is
  later-ingestable by any OTLP/JSON consumer, not a bespoke format.
  Size-based rotation: `PI_OBS_FILE_MAX_BYTES` per file, keep
  `PI_OBS_FILE_MAX_FILES` rotated files, oldest dropped.
- **Delivery policy (both):** telemetry is enqueued synchronously by
  hooks and drained asynchronously. The queue is bounded
  (`PI_OBS_QUEUE_MAX`, default 4096 items); when full, the **oldest**
  item is dropped and a drop counter increments. Export MUST NOT block
  any pi hook or the UI turn — a slow/unreachable backend only ever
  costs telemetry, never latency (priority R1 > R5).
- **Flush:** on `session_shutdown` and before normal process exit; a
  best-effort timeout bounds the flush so shutdown is never hung by a
  dead backend.

**AC.**
- With the file exporter enabled, a scripted session produces a file
  where every line parses as JSON and is a valid OTLP/JSON record;
  line count ≥ spans + metric batches of the run.
- With a local throwaway OTLP receiver (node script, part of the test
  suite): requests arrive with OTLP/JSON bodies containing the expected
  spans/attributes; killing the receiver mid-run does not affect the
  agent (exit code and output unchanged, drop counter > 0 in `status`).
- Rotation: a run configured with a tiny `PI_OBS_FILE_MAX_BYTES`
  produces exactly `PI_OBS_FILE_MAX_FILES` files.

### R6 — Configuration

**Statement.** pi-obs is configured via `PI_OBS_*` environment variables
and a `pi-obs` settings block, with documented precedence and defaults
covering the standard case.

**Details.** Precedence: environment variable > settings.json
(`${PI_HOME}/agent/settings.json` key `"pi-obs"`) > default. Telemetry
is **inactive by default** until an exporter is configured
(`PI_OBS_OTLP_ENDPOINT` or `PI_OBS_FILE=1`); the stats command works
regardless.

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
| `PI_OBS_FILE_MAX_FILES` | `5` | rotated files kept |
| `PI_OBS_CAPTURE_PROMPTS` | `0` | R2 opt-in for prompt/completion text |
| `PI_OBS_CAPTURE_TOOL_IO` | `0` | R2 opt-in for tool result bodies |
| `PI_OBS_QUEUE_MAX` | `4096` | bounded queue size |
| `PI_OBS_RESOURCE_SERVICE` | `pi-agent` | OTel `service.name` resource attribute |

The OTel resource is fixed apart from `service.name`,
`service.version` (extension version), and `pi.*` identifying
attributes (`pi.session.id` is per-trace, in spans).

**AC.** A settings/config unit test drives the precedence chain
(env beats file beats default); the table above is the complete
documented surface. **[doc]** README documents the same table.

### R7 — Commands and UX

**Statement.** The existing `/pi-obs` stats surface is retained
unchanged, and pi-obs adds `status`/`flush` views for exporter health and
a `report` command for post-mortem analysis (R3b).

**Details.**
- `/pi-obs`, `/pi-obs json`, `/pi-obs all` — unchanged from the current
  implementation (source: session entries, `stats.ts`).
- `/pi-obs status` — exporter activity: which exporters are active,
  queue depth, exported/dropped counters, last export timestamps and
  errors. Output goes to stdout in print mode (existing convention).
- `/pi-obs flush` — force a synchronous drain of the queue (bounded by
  the flush timeout); reports what was flushed.
- `/pi-obs report <session-id | path> [--otlp] [--file=<path>] [--branch=<entry-id>]`
  — the R3b post-mortem report; argument grammar, resolution rules,
  output modes, and ACs are normative in R3b.
- `/pi-obs help` — lists every `/pi-obs` subcommand with a one-line
  description, plus the telemetry env vars and a pointer to the
  standalone `piobs --help` CLI. Static output: no session state is
  consulted, so it is identical in every session and trivially
  scriptable.
- Footer status (`pi-obs` key) continues to show the session's live
  token/cost summary in TUI mode.

**AC.** `/pi-obs help` lists every subcommand (`json`, `all`, `status`,
`flush`, `report`, `help`) in a scripted run; `/pi-obs status` reflects
configuration changes (e.g. endpoint set/unset) correctly in a scripted
run; `/pi-obs flush` drains the queue
(queue depth reaches 0 in `status`); the pre-existing stats command
outputs are byte-identical before and after this spec's implementation.

### R8 — Black-box testability

**Statement.** A `pi-obs/test_pi_obs.sh` suite proves R1–R8 mechanically,
without white-box knowledge of pi internals, following repo test
conventions.

**Details.**
- POSIX bash, `set -eu` with bash-3.2-safe constructs; skips cleanly
  (with an explicit notice) when prerequisites are missing (node, pi,
  and — for the standard-tools level — `otelcol`/`weaver` on PATH);
  every check prints PASS/FAIL with a final summary.
- Levels: unit (node, pure modules: **hook usage inventory (41 hooks,
  categories A–D, per R3)**, semconv table,
  exporters against fixtures, **replay engine against fixture session
  files — span-set vs entry-set equivalence, determinism across replays,
  and the R3b resolution errors**), live (scripted `pi -e` runs with
  the file exporter, canary privacy checks, receiver-based OTLP checks,
  **`/pi-obs report` against the run's own just-written session file**),
  **standard-tools** (gated on `otelcol`/`weaver` presence, R4: the
  file-exporter JSONL replays line-by-line through a minimal local
  Collector — accept/reject — and the live OTLP stream flows through
  the Collector into `weaver registry live-check` — Collector relay,
  OTLP/HTTP → OTLP/gRPC — with `fail_on=violation` against the pinned
  GenAI + `pi.*` registries; tool versions and registry revisions
  pinned for reproducibility),
  isolation (unreachable endpoint, read-only target directory, handler
  faults).
- Model-dependent checks are gated on `OPENROUTER_API_KEY` presence, as
  in the repo's other suites.
- The suite cleans up everything it creates (temp dirs, receiver port).

**AC.** `./test_pi_obs.sh` exits 0 on a stock machine with pi + node;
with `otelcol` and `weaver` additionally present, the standard-tools
level runs and passes (Collector accepts every line of the live run's
file-exporter trace; Weaver exits 0 — zero violations); with either
binary missing, the level prints SKIP and the suite still exits 0;
each requirement's ACs above map to named checks in the suite
(AC → check table included in the script's header comment).

## Explicit non-goals

- No metrics/query **backend** of its own (Grafana, Prometheus, Tempo,
  Jaeger are external; pi-obs only exports).
- No OTLP/gRPC in v1 (HTTP+JSON only; gRPC is a possible later phase).
- No adoption of the official `@opentelemetry/*` SDK in v1 — the zero-dep
  OTLP/JSON encoder is the deliberate default (see Open questions).
- No capture of pi-internal state beyond the documented extension event
  surface (no monkey-patching, no file scraping of other tools).
- No rewriting or annotating of pi session files — sessions stay
  canonical; telemetry is a parallel, derived stream.
- No PII/secret discovery beyond the R2 redaction list — pi-obs is not
  a DLP product.

## Deliverable specification

`extensions/pi-obs/` must contain, after implementation:

| File | Purpose |
|---|---|
| `index.ts` | Extension wiring: hook subscriptions (R3), command registration (R7), lifecycle/flush (R1) |
| `hooks.ts` | Hook → capture-point registry; the R3 usage inventory (categories A–D) in code |
| `replay.ts` | Offline replay engine: session-file loading, id/path resolution, entry → entity builders shared with live capture (R3b) |
| `semconv.ts` | Attribute registry: `gen_ai.*` bindings + every `pi.*` attribute (R4) |
| `model.ts` | OTel entity builders: spans/metrics/log records, W3C IDs, hierarchy (R4) |
| `queue.ts` | Bounded async queue + drain/dispatch (R1, R5) |
| `exporters/otlp.ts` | OTLP/HTTP JSON exporter: batch, retry, timeout, headers (R5) |
| `exporters/file.ts` | OTLP/JSON-per-line file exporter with rotation (R5) |
| `config.ts` | Env/settings/defaults resolution, precedence (R6) |
| `stats.ts` | Existing pure stats library — retained unchanged (R7) |
| `test_pi_obs.sh` | Black-box suite, AC → check table in header (R8) |
| `README.md` | Updated: configuration table, exporter setup, privacy defaults |
| `SPECS.md` | This document |

Additional deliverable acceptance criteria:

- Every requirement R1–R8 appears in the implementation; every one of
  the 41 documented hooks appears exactly once in the R3 usage inventory
  (categories A–D), and only category-A/B hooks are subscribed (R3 AC).
- No file in the deliverable list imports anything outside node stdlib,
  the pi-provided module set, or local modules.
- The document follows repo conventions: generated from this spec, with
  the implementation reporting its provenance.

## General constraints

- No secrets in telemetry, logs, or the test suite (R2 governs).
- No pi-internal APIs beyond the documented extension surface; if a
  capability is missing (e.g. no hook exposes internal queue state),
  the limitation is stated, not worked around by poking internals.
- pi's session format and event stream stay canonical — pi-obs derives
  from them, never writes to them.
- The extension must remain loadable by the installed pi version and
  bakeable into the `pi-agent` image via `PI_EXTENSIONS` without
  modifying the image's build or run scripts.

## Open questions

- **Official OTel SDK?** Zero-dep OTLP/JSON is the v1 default for
  portability; adopting `@opentelemetry/*` (with `with-deps` layout)
  could later replace the hand-rolled encoder if a feature needs it
  (gRPC, e.g.).
- **Trace propagation across clients.** picl/pi-serve sessions could
  carry a `traceparent` so a session resumed elsewhere continues the
  same trace — needs a `picl-meta`-style convention; deferred.
- **Sampling policy.** v1 keeps sampling at 1.0 with drop-oldest
  backpressure; head sampling (dropping whole turns) is a policy
  question, not a mechanism one.
- **Cost currency.** `pi.cost.total` assumes the provider's reported
  USD; a multi-currency story is out of scope until a need appears.

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-11-25 | Didier Durand | versioned per house convention; status updated to implemented |
| 1.0.1 | 2026-11-25 | Didier Durand | editorial: removed provenance references from the status note |
