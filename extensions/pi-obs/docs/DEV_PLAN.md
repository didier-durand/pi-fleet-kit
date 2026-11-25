# pi-obs — Implementation Plan

Plan version: 1.0.0 (semver — matches the tag `impl-plan-1.0.0`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** executed — every step shipped in pi-obs v0.1.9. Derived from
> `extensions/pi-obs/SPECS.md` (requirements R1–R8 + R3b). **Convention:**
> each step is a self-contained milestone, executable by a dedicated
> prompt against this plan; artifacts land under `extensions/pi-obs/`.
> Every step ends with tests mapped to the ACs of SPECS.md.

## Ordering principle (deliberate)

**Pure, pi-independent modules first — a sink always exists before a
source.** Steps 1–5 build the telemetry pipeline (entity builders, queue,
exporters) as plain TypeScript libraries with no pi imports at runtime;
Step 6 wires the live capture (the first code pi ever loads) only once
the queue and both exporters exist, so a capture point never lands
without a destination. Post-mortem replay (Step 7) comes after the
builders it shares; the consolidated black-box suite (Step 9) comes last,
after everything it verifies exists.

**Coverage gate (every step, no exceptions):** each step's tests are
written *with* the step and must reach **≥ 90% lines and branches** on
every module the step touches, measured with Node's built-in runner:

```sh
cd extensions/pi-obs
npm test        # node --test --experimental-test-coverage tests/unit/*.test.ts tests/unit/exporters/*.test.ts
```

(Step 10 moved the suites to `tests/unit/**`; `npm run typecheck`
(`tsc --noEmit`, strict) is a co-gate — Node's type-stripping does no
type checking.)

(No `--experimental-strip-types` flag: the explicit flag triggers a
nondeterministic V8 coverage-attribution bug — measured during Step 6
as identical runs flipping between 70% and 99% on index.ts. Node's
default stripping pipeline, on since v23.6, attributes correctly; CI
and local development pin Node 26.)

- Node ≥ 23.6 required for flagless type stripping in the gate command
  (Node ≥ 22.6 still runs tests with the explicit flag — but the flag
  corrupts coverage attribution, hence the flagless default; the
  `pi-agent` image's floating `node:slim` base satisfies ≥ 23.6).
- Runtime pi imports in modules are `import type` only (erased at
  execution), so unit tests run without the pi package; the pi-facing
  wiring (Step 6) is tested through a **mock `ExtensionAPI` harness**
  shipped as part of that step — pi-obs's own code, not a test-only
  shortcut.
- Anything below the gate must be a documented exclusion (module, lines,
  written reason) — e.g. the one live-only flush path proven by the
  black-box suite — and never silence by default.
- `index.ts` (the only file pi loads) is measured too: the mock harness
  drives subscriptions, handlers, commands, and the print-mode emit path
  to the same gate.

SPECS priority order (R1 safety > R2 privacy > R3 coverage > R4
formatting > R5 export > R6 config > R7 UX > R8 testing) governs
conflicts *within* steps; this plan only sequences *when* requirements
are addressed.

## Execution status

Incremental execution log — one step lands (implementation + tests green
+ coverage ≥ 90%) before the next begins. Verification commands run from
`extensions/pi-obs/` unless noted.

| Step | Theme | Status | Verification |
|---|---|---|---|
| 1 | semconv + config foundations | ✅ done | 23/23 tests · coverage 100% lines / 98.55% branches (gate ≥ 90 both) |
| 2 | OTel entity builders (model.ts) | ✅ done | 35/35 tests · model.ts 100% lines / 94.74% branches (gate ≥ 90 both) |
| 3 | Bounded queue + dispatch (queue.ts) | ✅ done | 44/44 tests · queue.ts 100% lines / 100% branches · enqueue ≈ 0.7 µs/op (budget 1000) |
| 4 | File exporter (OTLP/JSON per line) | ✅ done | 52/52 tests · file.ts 100%/100% · otlp-json.ts 100%/97.3% |
| 5 | OTLP/HTTP exporter + test receiver | ✅ done | 62/62 tests · otlp.ts 100%/97.6% · receiver 100%/100% |
| 6 | Live capture wiring (41 hooks, A–D) | ✅ done | 83/83 gate run · index.ts 99.7%/92.4% · live smoke ✔ (model-gated) |
| 7 | Post-mortem replay (replay.ts) | ✅ done | 96/96 suite · replay.ts 100%/93.3% · live smoke ✔ |
| 8 | Commands & UX completion (report/status/flush) | ✅ done | 103/103 suite · index.ts 100%/93.1% · stats goldens byte-identical |
| 9 | Black-box suite (test_pi_obs.sh) + hardening | ✅ done | 11/11 checks (live+tools) · 2/2 stock skips clean · 5 real bugs fixed |
| 10 | Standard-layout restructure (src/tests/docs, typecheck gate) | ✅ done | 104/104 + typecheck clean · suite 11/11 (full) / 2/2 (stock) · shim verified |
| 11 | Standalone piobs CLI (bin/piobs, --help, exit codes) | ✅ done | 111/111 + typecheck ✔ · suite 14/14 (full) / 5/5 (stock) · C1-C3 model-free |

## Overview

| Stage | Steps | Theme | Requirements covered |
|---|---|---|---|
| A — Foundations (pure, no pi) | 1–3 | attribute/config model, OTel entities, delivery | R4 (registry, entities), R6, R1 (never-block mechanics), R5 (delivery core) |
| B — Exporters (pure) | 4–5 | file exporter, OTLP backend exporter | R5, R2 (mechanics: redaction points) |
| C — Live capture (pi wiring) | 6 | hook inventory A–D, hierarchy, fault isolation | R1, R2, R3, R4 live, R7 (status line) |
| D — Post-mortem | 7 | offline replay from session id/path | R3b, R2 parity |
| E — UX & suite | 8–9 | report/status/flush commands, consolidated tests | R7, R8 (all ACs end-to-end) |

---

## Stage A — Foundations (pure modules, no pi at runtime)

### Step 1 — semconv.ts + config.ts

**Scope.** The two data contracts of the extension, fully unit-testable:
- `semconv.ts` — the R4 attribute registry: every `gen_ai.*` binding
  used, and every `pi.*` attribute (name, type, source hook, meaning) in
  one add-only table; a lookup helper that fails closed (unknown
  attribute → error in tests, log in production).
- `config.ts` — the R6 surface: the complete `PI_OBS_*` table of SPECS,
  the `pi-obs` settings.json block, precedence
  (env > settings > defaults), and the "inactive until an exporter is
  configured" master rule.

**Deliverables:** `semconv.ts`, `config.ts`, `semconv.test.ts`,
`config.test.ts`.

**Tests (coverage ≥ 90%):** registry completeness (every attribute
emitted by later steps exists here; every table row has a type and a
source); precedence chain (env beats settings beats default; each of
the 13 `PI_OBS_*` variables parsed, defaulted, and rejected on invalid
values — non-numeric batch size, negative queue, unknown exporter);
inactive-by-default (no endpoint and no file → disabled); settings block
parsed and merged without pi running.

**Verification:** `node --experimental-strip-types --test
--experimental-test-coverage semconv.test.ts config.test.ts` — green,
gate met, numbers recorded in the status table.

**As built (executed):** delivered as specced — `semconv.ts` (5 spans +
17 span events + 10 metrics + 8 `gen_ai.*` + 40 `pi.*`/resource
attributes, all add-only; fail-closed `mustLookup*` for tests,
`reportUnknownAttribute` as the never-throwing production twin) and
`config.ts` (the 13-variable `PI_OBS_*` surface, env > settings >
default per key, errors collected — never thrown — with the default
standing; `active = enabled && exporter configured`). Completeness is
enforced mechanically: the test extracts every `gen_ai.*`/`pi.*` name
SPECS commits to and fails on any unregistered one (caught two real
gaps while writing it: `pi.replay`, and header segments after a
malformed one). One addition beyond the deliverable list:
`package.json` with `{"type":"module"}` (module-type marker for Node's
runner — no dependency, jiti unaffected). Result: 23/23 tests, 100%
lines / 98.55% branches on both modules, gate ≥ 90 enforced by
`--test-coverage-lines/branches=90` (non-zero exit below). The R6
[doc] AC (README documents the same table) landed with this step.

### Step 2 — OTel entity builders (model.ts)

**Scope.** The single formatting path everything else uses (R4):
- span builder (W3C trace/span IDs minted from crypto RNG; hierarchy
  helpers `pi.session` → `pi.run` → `pi.turn` → `pi.model`/`pi.tool`;
  attributes, events, status, timing),
- metric builder (counters/histograms per the R4 metric table),
- log-record builder (severity levels for health/fault reports),
- GenAI application from pi payload shapes (provider/model/usage/
  stopReason fixtures; cache-read and reasoning tokens as
  token-type-distinguished counters; `pi.cost.total`),
- **deterministic ID derivation** for R3b: session id + entry ids →
  stable trace/span ids (hash-based), so replays are byte-stable.

**Deliverables:** `model.ts`, `model.test.ts` (+ checked-in payload
fixtures under `tests/fixtures/`).

**Tests (coverage ≥ 90%):** ID format/length/uniqueness; hierarchy
parent/child invariants; GenAI attribute set for a fixture `message_end`
usage payload (exact expected attributes, SPECS R4 AC); metric
name/type/table conformance; deterministic derivation — same inputs →
byte-identical ids across runs (SPECS R3b determinism AC, proven here at
the unit level); malformed payload → never throws (R1 fault isolation
starts here).

**Verification:** same runner over `model.test.ts`; gate met.

**As built (executed):** delivered as specced — `model.ts` (span
builders with the R3 hierarchy helpers, metrics, log records, GenAI
application from payload shapes, deterministic R3b derivation) and
three checked-in fixtures (realistic / minimal / malformed
`message_end`). The contract split is explicit: EXTERNAL payload data
never throws (a null payload is handled — the tests caught the gap);
INTERNAL registry violations (unregistered/mistyped names, wrong
metric kind, missing breakdown attributes) throw `SemconvError` —
fail closed in tests, caught by the capture wrapper's fault isolation
in production. Writing the byte-stable-replay test exposed a real
design gap: the hierarchy helpers took no span id, so R3b could not
derive ids below the root — they now take `SpanOpts { spanId, nowMs }`.
The RNG is injectable so the W3C all-zero redraw (p ≈ 2⁻¹²⁸) is
actually tested, not excluded. Result: 35/35 tests, model.ts 100%
lines / 94.74% branches — gate met with no documented exclusions.

### Step 3 — Bounded queue + dispatch (queue.ts)

**Scope.** The R1/R5 delivery core: bounded queue
(`PI_OBS_QUEUE_MAX`, default 4096), **drop-oldest** overflow with a
drop counter, asynchronous drain with fan-out to active exporters,
flush-with-timeout (never hung by a dead exporter), and the
enqueue-is-cheap contract (the ≤ 1 ms hook budget of R1 is measured
against this module).

**Deliverables:** `queue.ts`, `queue.test.ts`.

**Tests (coverage ≥ 90%):** overflow drops the *oldest* and increments
the counter; a consumer slower than a producer never blocks the
producer (timing-asserted enqueue under a stalled drain); flush drains
to empty and respects its timeout against a hanging consumer; dispatch
fan-out errors in one exporter do not affect the other; shutdown
flush path; counters observable for Step 8's `/pi-obs status`.

**Verification:** runner over `queue.test.ts`; gate met; enqueue-cost
micro-benchmark recorded in the status table (µs/op).

**As built (executed):** delivered as specced — `queue.ts` (bounded,
drop-oldest, microtask-scheduled async drain with per-exporter
isolation in the fan-out, bounded flush-with-timeout, shutdown-then-
closed semantics where post-shutdown enqueues are counted drops, and
`enqueued/dropped/drained` counters for Step 8). `onDrop` /
`onExportError` hooks let the wiring emit the R4 drop/fault log
records without the queue knowing about them. Measured locally:
**enqueue ≈ 0.7 µs/op** over 20 000 ops under a stalled drain — about
1400× inside the 1 ms R1 hook budget. Tests (9) cover every plan AC
with real timers and ≥ 10× CI margins, including a fixed-clock
drop-order proof, the timing-asserted enqueue-under-stall, flush
timeout vs a hanging consumer (released afterwards), fan-out
isolation, and the closed-queue drop path. Result: 44/44 suite tests;
queue.ts at 100% lines / 100% branches — gate met with no exclusions.

---

## Stage B — Exporters (pure)

### Step 4 — File exporter (exporters/file.ts)

**Scope.** The R5 file leg: writes finished telemetry as **OTLP/JSON
export-request bodies, one per line**; size-based rotation
(`PI_OBS_FILE_MAX_BYTES` / `PI_OBS_FILE_MAX_FILES`, oldest dropped);
target-directory handling with the R2 rule (never inside a session
directory); append-only single-writer discipline; the R2 redaction
application point for any opt-in captured text.

**Deliverables:** `exporters/file.ts`, `exporters/file.test.ts`.

**Tests (coverage ≥ 90%):** every written line parses as JSON and is a
valid OTLP/JSON record shape (resource-spans / resource-metrics /
resource-logs); rotation with a tiny byte limit produces exactly N
files, oldest dropped (SPECS R5 AC); unreadable/read-only target
directory → error report + drop counter, never a throw (R1); session-dir
target rejected with the R2 message; redaction applied to canary text
before write (R2 AC at this module); concurrent appends from the queue
drain stay line-atomic.

**Verification:** runner over `file.test.ts`; gate met.

### Step 5 — OTLP/HTTP exporter + test receiver (exporters/otlp.ts)

**Scope.** The R5 backend leg: HTTP POST, OTLP/JSON encoding, batching
(`PI_OBS_OTLP_BATCH`), timeout (`PI_OBS_OTLP_TIMEOUT_MS`), extra
headers, exponential-backoff retry to a bounded attempt count, then
drop-and-count; `http://` endpoints accepted with a one-time warning.
Ships `tests/otlp_receiver.ts` — a minimal in-process OTLP/HTTP JSON
receiver with request capture, reused by this step's tests and the
Step 9 suite.

**Deliverables:** `exporters/otlp.ts`, `tests/otlp_receiver.ts`,
`exporters/otlp.test.ts`.

**Tests (coverage ≥ 90%):** batches arrive at the receiver as valid
OTLP/JSON with the expected spans/attributes (SPECS R5 AC, unit level);
batch boundaries at the configured size; non-2xx → retry → then drop
count (receiver scripted with 500s); connection refused → bounded retry
→ drop, never a hang (timeout enforced); header injection; killing the
receiver mid-run never rejects to the caller (the queue's error path).

**Verification:** runner over `otlp.test.ts` (+ `queue.test.ts` re-run
green); gate met.

**As built (executed):** delivered as specced. Design decisions worth
recording: (1) one `PI_OBS_OTLP_ENDPOINT` configures all three
signals — the exporter derives per-signal URLs (a bare base gains
`/v1/traces|metrics|logs`; an endpoint ending in `/v1/<signal>` has
that segment rewritten), because a mixed OTLP body is not valid OTLP;
(2) chunks are merged into one OTLP request per signal (the shared
`otlp-json.ts` serialization, parsed and merged — no parallel
formatting); (3) `export()` never rejects — failures surface through
`onError` + the drop counter (requests/retries also counted for
`/pi-obs status`); (4) the receiver's standalone entry lives in
`tests/otlp_receiver_main.ts` so the harness module itself stays
fully covered. Writing the tests caught a real R2 gap (an empty-array
redaction default would have DISABLED redaction — now defaults to the
documented list) and a test-side bug (`assert.doesNotThrow` does not
await promises — `doesNotReject` throughout). Result: 62/62 suite
tests (queue re-run green); otlp.ts 100%/97.6%, receiver 100%/100% —
gate met, no exclusions.

---

## Stage C — Live capture (first pi-loaded code)

### Step 6 — Hook wiring: the 41-hook usage inventory (hooks.ts + index.ts)

**Scope.** The heart of R3, plus the R1/R2 runtime disciplines:
- `hooks.ts` — the R3 usage inventory in code: categories A (36
  subscribed, entity per hook), B (2 metrics-only), C (12
  inert-handler constraint, listed), D (3 not subscribed, reasons),
  with a registry API the tests can walk.
- `index.ts` — subscriptions for exactly the A∪B hooks; the
  fault-isolation wrapper (any handler throw → one stderr report,
  emission disabled, agent unaffected); span hierarchy lifecycle
  (`session_start` mints the trace, `session_shutdown` closes + flush);
  R2 capture rules (header names only; length + SHA-256-12 hash by
  default; `PI_OBS_CAPTURE_PROMPTS`/`PI_OBS_CAPTURE_TOOL_IO` opt-ins
  with redaction); the R4 metrics feed from category-B hooks;
  config-driven exporter activation; the retained footer status line;
  `pi.appendEntry` **never** called (R1 observation-only AC).
- `tests/harness.ts` — the mock `ExtensionAPI`/`ExtensionContext`
  harness (event emitter recording subscriptions; fake
  `sessionManager.getBranch()` over fixture entries; fake `ui`), used
  by all of index.ts's unit tests.

**Deliverables:** `hooks.ts`, `index.ts`, `tests/harness.ts`,
`hooks.test.ts`, `index.test.ts`.

**Tests (coverage ≥ 90%, index.ts included via the harness):**
inventory ACs — a test walks all 41 documented hooks and asserts each
appears in exactly one category, and the 3 category-D hooks have **no**
registered handler (SPECS R3 AC); every category-C handler returns
`undefined` (inert, R3 C-list); a scripted fake event sequence (prompt
→ turn → model call with usage → tool call → settle) produces exactly
`pi.session` > `pi.run` > `pi.turn` > { `pi.model`, `pi.tool …` }
(SPECS R3 smoke AC, harness-level); a throwing handler is isolated
exactly once (R1 AC); canary secret never reaches the queue with any
capture setting (R2 AC); no `appendEntry` call in any path (R1).
Plus a **live smoke** (model-gated on `OPENROUTER_API_KEY`): a scripted
`pi -e ./pi-obs/index.ts -p …` run with the file exporter produces a
report file whose trace matches the expected hierarchy, and a re-run
without pi-obs yields identical agent output/exit code (R1 AC).
Model-free CI path: unit tests only, live smoke auto-skips.

**Verification:** runner over `hooks.test.ts index.test.ts` (gate met);
`pi -e` smoke when a key is present; status table updated with coverage
numbers + smoke result.

**As built (executed):** delivered as specced — `hooks.ts` (the 41-row
inventory, categories A/B/D + the 12 C flags), `index.ts` (stats
feature retained verbatim + the capture wiring: 38 wrapped
subscriptions, R2 capture-time redaction, session_shutdown bounded
flush, appendEntry never called), `tests/harness.ts` (mock API + ctx
with recording spies), `hooks.test.ts` (6), `index.test.ts` (15), and
the model-gated live smoke in `tests/live_smoke.test.ts` — **outside
the coverage glob**, see below. Writing the tests caught six real
issues: (1) TypeScript parameter properties crash strip-only mode —
the LiveCapture constructor was rewritten; (2) raw MetricData objects
were enqueued instead of wrapped items (no type checking under
stripping — 8 sites fixed via a metric() helper); (3) the C-list was
over-marked (project_trust/user_bash are decision hooks but not in
SPECS' normative 12); (4) the harness's runCommand/emit closed over
the original contextOptions — test reassignments were silently
ignored; (5) **coverage measurement**: the explicit
`--experimental-strip-types` flag causes NONDETERMINISTIC V8 coverage
attribution (identical runs flipping 70%↔99% on index.ts), and
spawnSync blocking the event loop corrupts collection too — the gate
command is now flagless (Node ≥ 23.6 default), the smoke spawns
asynchronously, and the smoke file sits outside the gated glob
(CI stays model-free per plan); (6) span-close cascades
(run → turn → model) so aborted streams never dangle. Design notes:
switch/fork cancellation outcomes of OTHER handlers are unobservable
under the inert constraint — reason+target recorded instead; header
names are buffered to the model span (before_provider_headers fires
before the span opens). Result: **83/83** on the gate run — index.ts
99.67%/92.41% (only the R1 never-fault empty catch uncovered),
stats.ts 100%/92.19%, all files 99.94%/95.85%; live smoke PASSED
locally under a key: `pi -e` exported pi.session > pi.run > pi.turn >
pi.model and the same prompt without the extension gave identical
output and exit code (R1 AC).

---

## Stage D — Post-mortem

### Step 7 — Post-mortem replay (replay.ts)

**Scope.** R3b end-to-end on pure module code: session-file loading
(JSONL, malformed lines skipped), **id resolution** (scan session
directory headers for `type:"session"` with matching `id` — header wins
over filename; ambiguity/missing-id/unreadable-path = distinct hard
errors), path mode (verbatim), branch selection (`--branch=<entry-id>`;
active-branch rebuild from `id`/`parentId` like pi replays), the
deterministic replay through **the same builders as live capture**
(entry timestamps → span timestamps; assistant messages → `pi.model`
with usage; tool results → `pi.tool`; user messages → `pi.user.input`
events; `usage`/`compaction`/`model_change`/`thinking_level_change`/
`tree` entries → their R3 entities), `pi.replay=true` +
`pi.replay.source` marking with live-only fields omitted (never
fabricated), and R2 parity redaction.

**Deliverables:** `replay.ts`, `replay.test.ts`, fixture session files
under `tests/fixtures/sessions/` (a straight session; one with a branch
fork; one with compaction + usage entries; one with a canary secret in
a user message; one malformed-line file).

**Tests (coverage ≥ 90%):** span-set vs entry-set equivalence per
fixture (one `pi.model` span per assistant message, tool spans from tool
results, root `pi.session` present; usage/cost equal to the entry sums
— SPECS R3b AC); replay of the same fixture twice → byte-identical
output (R3b AC); resolution: renamed-file-with-matching-header resolves,
unknown id / unreadable path / ambiguous id fail with distinct
messages; `--branch` selects the requested branch and excludes
abandoned entries; compaction entries produce `pi.session.compact`
events; live-only fields absent and `pi.replay` present; canary redacted
by default, present only with the opt-in.

**Verification:** runner over `replay.test.ts`; gate met.

**As built (executed):** delivered as specced — `replay.ts` (loading
with malformed-line skip; header-authoritative id resolution with
distinct unknown/ambiguous/unreadable errors; path mode verbatim;
branch selection; deterministic replay through the SAME builders as
live capture; live-only fields omitted with `pi.replay=true` +
`pi.replay.source` on the resource; R2 parity redaction on entry
bodies; OTLP/JSON-per-line output) plus 8 fixture session files with
REAL pi shapes (v3 headers, block-array contents, id/parentId chains):
straight, forked, compacted (extended with tree / system-message /
null-message / unknown-type / field-less entries), canary, malformed,
errors, empty, no-header. Writing the tests caught four real bugs:
(1) `startToolSpan`'s 4-arg signature misused — opts passed as
attributes → SemconvError; (2) **every root event defaulted to
`Date.now()`** — wall-clock leaked into an allegedly byte-stable
report (the determinism test caught a 1 ms drift between two runs;
all events now use the entry clock); (3) an id-less trailing entry
EMPTIED the default branch — the default leaf now requires an id;
(4) undefined event attributes would have thrown on field-less
entries (an `eventOn` helper cleans them, mirroring live capture).
Design notes: replay spans hang directly off `pi.session` (runs/turns
are live-only concepts); usage entries emit their counters plus a
`pi.model.cache_warming` entity; tool durations/TTFT are omitted, not
zeroed. Result: 13 replay tests; replay.ts 100%/93.33%; suite
**96/96**, all files 99.94%/95.49%; the Step 6 live smoke re-ran green.

---

### Step 10 — Standard-layout restructure (no behavior change)

**Scope.** Conform to SPECS' normative Artifact structure: `src/` for
all runtime code behind a one-line `index.ts` re-export shim (jiti
entry + auto-discovery paths unchanged); `tests/unit/` (coverage
gated) separated from `tests/live/` (model-gated, outside the
coverage glob — now explicit layout instead of a glob accident);
`tests/tools/` consolidating the standard-tools assets (including
`.weaver.toml`); `docs/` for SPECS + DEV_PLAN; a real `package.json`
(scripts: typecheck/test/suite/gen:registry) with devDependencies
(typescript, @types/node, @earendil-works/pi-coding-agent for the
`import type` contract); `tsconfig.json` strict + `noEmit` — a
TYPECHECK GATE (Node's stripping does none; Steps 6–7 each shipped a
type-error class bug it would have caught). No behavior change:
replay determinism tests must prove byte-identical output across the
move; the shim must load via both `pi -e` and auto-discovery.

**Deliverables:** the restructured tree, `package.json` +
`package-lock.json`, `tsconfig.json`, the shim, path fixes (imports,
SPECS/fixture references, the gate command in its four synced homes:
package.json script, test_pi_obs.sh, pi-obs-tests.yml, this plan),
README testing-section update, and fixes for whatever `tsc --noEmit`
surfaces.

**Verification:** `npm run typecheck` green; the coverage gate green
on `tests/unit/**`; `./test_pi_obs.sh` green on the stock path AND
with model + tools; live smoke green; the replay determinism tests
proving byte-identical fixture output; CI green on both
architectures including the new typecheck step.

**As built (executed):** no behavior change, proven four ways — the
replay determinism tests (byte-identical fixture output), the stats
goldens (byte-identical command output), 104/104 unit tests, and the
full suite 11/11 with model + tools (2/2 + clean skips stock). The
shim loads via BOTH `pi -e ./pi-obs/index.ts` and auto-discovery
(symlink under `~/.pi/agent/extensions/`). The new typecheck gate
(`tsc --noEmit`, strict, with `@earendil-works/pi-coding-agent` as a
devDependency so `import type` resolves) immediately paid for itself:
181 findings on first run — real contract fixes in src (pi's
`on()`/`registerCommand` boundary needed a typed adapter + loose
handler cast; `CtxLike` widened to pi's `string | undefined` returns;
`Rng` typed as returning `Buffer` so `toString("hex")` typechecks;
an `unknown.message` access; `rootEvent` attrs properly
`AttrValue | undefined`), plus mechanical test tightening. It also
flagged one dead-by-design path (the wiring-level queue
`onExportError` — pi-obs exporters never reject by design, faults
flow through their own onError) which was REMOVED rather than
excluded. The remaining two uncovered lines in index.ts are the
R1 never-fault empty catches — documented here as the plan's allowed
exclusion class (index.ts 99.61%/92.36%, well above the gate).


### Step 11 — Standalone `piobs` CLI

**Scope.** SPECS R3b's `piobs` command: `bin/piobs` (sh wrapper ->
`node src/cli.ts`) + `src/cli.ts` — the report engine outside the pi
process. Full grammar with `--help` (binary + per-command), the same
resolution/R2 rules as `/pi-obs report`, flags: `--branch`, `--file`,
`--otlp`, `--endpoint=<url>`, `--capture-prompts`, `--capture-tool-io`,
`--service=<name>`, `--sessions-dir=<dir>`, positional `[session-dir]`.
EXIT CODES (the AC the in-pi command could not honor): 0 success,
1 replay/IO error, 2 usage. package.json `bin` entry. Tests: pure
arg-parsing in `tests/unit/cli.test.ts` (coverage-gated) +
end-to-end spawns in `tests/cli/piobs-cli.test.ts` (outside the
coverage glob — child processes corrupt V8 coverage). The black-box
suite gains a model-free CLI level.

**Deliverables:** `bin/piobs`, `src/cli.ts` (with exported
parse/runCli for tests), `readSettingsPiObsBlock` moved from
`src/index.ts` to `src/config.ts` (shared), package.json bin,
tests, README CLI section, suite CLI checks.

**Verification:** typecheck + coverage gate green; CLI e2e tests
green; suite green (stock + full); CI green on both architectures;
`piobs --help` shown.

**As built (executed):** delivered as specced — `bin/piobs` (sh
wrapper → `node src/cli.ts`, no deps, no build), `src/cli.ts`
(exported `parseArgs`/`runCli`/`HELP` for the pure tests),
`readSettingsPiObsBlock` moved from index.ts to config.ts (shared),
package.json `bin` + `npm link` install path. Grammar: report
target/optional-dir + `--branch/--file/--otlp/--endpoint/
--capture-prompts/--capture-tool-io/--service/--sessions-dir`,
`--help`/`-h`, `version`. Exit codes honored: 0/1/2 verified
end-to-end. Tests: 7 pure (grammar matrix, runCli happy/errors via
injected IO — coverage-gated, `src/cli.ts` covered) + 3 e2e spawns
in `tests/cli/` (the REAL wrapper; outside the coverage glob per the
structure rule). The suite gained a model-free CLI level (C1-C3) —
full run 14/14 (was 11/11), stock 5/5. One suite bug caught while
adding C3: unguarded non-zero exits under `set -eu` killed the
script mid-level (`E=0; cmd || E=$?` discipline applied). Writing
the typecheck pass caught the loose `(args as Record<…>)` cast and
a test helper's swapped signature.

---

## Stage E — UX & suite

### Step 8 — Commands & UX completion (index.ts command surface)

**Scope.** R7: `/pi-obs report <session-id | path> [--otlp] [--file=<path>]
[--branch=<entry-id>]` (grammar parsed here, engine = Step 7; stdout
OTLP/JSON-per-line by default in print mode; `--otlp` reuses the Step 5
exporter with its retry policy; `--file=<path>` reuses Step 4);
`/pi-obs status` (active exporters, queue depth, exported/dropped
counters, last export timestamps and errors — fed by Step 3 counters);
`/pi-obs flush`; the pre-existing `stats`/`json`/`all` commands
**byte-identical** (regression-tested); print-mode stdout emission.

**Deliverables:** updates to `index.ts` (+ `tests/harness.ts` if
needed), `commands.test.ts`.

**Tests (coverage ≥ 90%):** grammar table (all subcommands + flags:
valid, ambiguous, missing args → distinct errors); `status` reflects
configuration changes (endpoint set/unset, file on/off) and shows queue
+ drop counters after a scripted drain; `flush` empties the queue and
reports; `report` happy path through the mock harness on a fixture
session file (stdout lines parse as OTLP/JSON); **stats regression**:
`stats.ts` untouched and its outputs byte-identical to the
pre-spec implementation on the same fixtures (SPECS R7 AC).

**Verification:** runner over `commands.test.ts` + full module re-run;
gate met.

**As built (executed):** delivered as specced. The command surface
moved into its own registration (`registerPiObsCommand`) so the subs
can see the wiring state; `registerStatsFeature` keeps the footer
hooks. `status` reads NEW exporter health (both exporters now track
`lastExportAt` + a STICKY `lastError` — the last failure stays
visible for diagnosis, last-export tracks success independently) plus
the queue counters; `flush` is a bounded forced drain with a timeout
message that never hangs the command; `report` parses the full grammar
(path vs id detection, the two-arg id+dir form, --otlp / --file /
--branch, distinct usage messages for missing args, unknown flags, and
stray tokens), reuses Step 7's engine, always emits stdout, and the
flagged sinks reuse the report's OWN resource (exposed by
`ReplayReport.resource`) so `pi.replay` marking survives. The stats
regression is proven two ways: golden strings for `/pi-obs`, `/pi-obs
json`, and `/pi-obs all` (fixed-mtime file) are byte-identical, and
`git log -- stats.ts` shows exactly one commit — the pre-spec
original: untouched. Result: 7 command tests; suite **103/103**;
index.ts 100%/93.11%; all files 100%/96.29%; the Step 6 live smoke
re-ran green.

### Step 9 — Black-box suite + hardening (test_pi_obs.sh)

**Scope.** R8, the consolidated proof: `test_pi_obs.sh` with the
AC → check table in its header comment; POSIX bash 3.2-safe, `set -eu`,
clean skips when node/pi are missing, model-gated levels, cleanup
traps, PASS/FAIL per check with a summary. Levels:
- **unit**: every `*.test.ts` module suite (Steps 1–8) with the
  coverage gate asserted by the script (parse the runner's coverage
  output; ≥ 90% per module or FAIL);
- **live**: scripted `pi -e` runs — file-exporter trace validation,
  `/pi-obs report` against the run's own just-written session file
  (R3b live AC), OTLP receiver delivery (Step 5 receiver on a free
  port), `/pi-obs status` accuracy;
- **standard-tools** (SPECS R4 gate, optional binaries): when `otelcol`
  and `weaver` are on PATH the suite runs the reference-toolchain
  conformance level, skipped with an explicit SKIP notice otherwise —
  never a FAIL on a stock machine. Two checks per SPECS R4:
  1. **Structural (Collector):** the live run's file-exporter JSONL
     replays line-by-line as OTLP/HTTP POSTs into a minimal local
     `otelcol` (checked-in config: otlp receiver → file/debug
     exporter); every record must be accepted — the pdata parse is the
     reference OTLP/JSON wire check (camelCase, hex IDs, string int64s).
  2. **Semantic (Weaver):** the pi-obs OTLP exporter streams through
     the Collector (relay OTLP/HTTP → OTLP/gRPC, since `weaver
     registry live-check` ingests gRPC) into `weaver registry
     live-check --fail-on violation` against the PINNED GenAI
     semantic-convention registry plus the `pi.*` registry generated
     from `semconv.ts`; zero `violation` findings required (zero
     `missing_attribute`/`illegal_namespace` for `pi.*`).
  Tool versions + semconv registry revision are pinned in the suite for
  reproducible findings (download once, cache per runner);
- **isolation**: unreachable OTLP endpoint (agent unaffected, drop
  counter > 0), read-only export directory, fault-injection (handler
  throw → agent unaffected), canary privacy across all capture
  settings (R2 ACs end-to-end).

**Deliverables:** `test_pi_obs.sh`, `README.md` completion (configuration
table mirroring R6, exporter setup, privacy defaults, coverage policy),
the standard-tools level's checked-in assets — a minimal `otelcol`
config (otlp receiver → relay + file output), the generated `pi.*`
Weaver registry, a `.weaver.toml` (matchers for the `pi.model`/`pi.tool`/
`pi.session` span names, `fail_on = "violation"`) and the pinned
versions/registry-revision table — plus a GitHub Actions step in
`pi-obs-tests.yml` installing both binaries so the level runs in CI,
and fixes for anything the suite catches.

**Tests (coverage ≥ 90%):** the suite is the test; its unit level
re-asserts the gate on every module. Anything the suite finds hard to
test is either fixed or becomes a documented exclusion in the status
table.

**Verification:** `./test_pi_obs.sh` exits 0 on a stock machine with
pi + node; with `OPENROUTER_API_KEY` the live/model level runs too;
with `otelcol` + `weaver` present the standard-tools level runs and
passes (Collector accepts every record, Weaver exits 0); with either
binary missing the level prints SKIP and the suite still exits 0;
no leftovers (temp dirs, receiver ports, processes).

**As built (executed):** the suite delivers all four levels with the
AC → check table in its header (R1–R8 each mapped). The
standard-tools level is verified end-to-end locally with the pinned
tools (otelcol-contrib 0.165.0, weaver 0.28.0, GenAI registry
v1.34.0): **11/11 checks** with model + tools; **2/2 + clean skips**
on the stock path (exit 0). Writing the suite caught **five real
conformance bugs**, all fixed: (1) trace/span ids were base64 on the
wire — OTLP/JSON mandates HEX (the Collector rejected every span);
(2) counters lacked `isMonotonic: true` — consumers read them as
up-down counters; (3) metric records lacked `unit` — units now live
in the semconv metric table and ride the wire; (4) `pi.replay`
(bool) collided with the `pi.replay.source` namespace — renamed to
`pi.replayed` (Weaver's namespace rule; SPECS amended); (5) exporter
faults and drop notices were stderr-only (an R4 violation) — they are
now OTel log records (one-shot per exporter, re-entrancy-guarded).
Also recorded: weaver matchers require `--v2`; the Collector relay
needs `compression: none` (weaver's gRPC listener rejects gzip); the
GenAI registry pin is v1.34.0 (v1.40.0 already deprecates
`gen_ai.system`, which SPECS R4 mandates); pi's print mode routes
extension output to stderr; sessions land under `~/.pi/agent/sessions`
(with the `.pi` segment). Handler-fault injection stays at unit level
(harness-proven) — mapped in the AC table.

---

## Plan-level definition of done

- All nine steps ✅ with coverage ≥ 90% lines + branches per touched
  module, numbers recorded in the execution-status table.
- Every SPECS R1–R8 + R3b acceptance criterion maps to a green check in
  `test_pi_obs.sh`'s header table.
- `pi list` reports the extension; the extension loads unmodified in
  TUI, `print`, `json`, and RPC modes.
- Sessions with pi-obs active are byte-identical in structure to
  sessions without it (no extra entry types — R1 AC, suite-asserted).
- The `pi-agent` image still builds and runs with pi-obs added to
  `PI_EXTENSIONS`, without build/run script changes.
- `stats.ts` and the original `/pi-obs` stats outputs unchanged.

## Risks in this ordering

- **Hook surface drift:** a future pi version may add/rename hooks.
  The Step 6 inventory test hard-codes the verified 41-hook list of
  SPECS grounding §2; on pi upgrade the test fails loudly, which is
  the designed behavior (spec first, code second).
- **Coverage theater:** the gate is per touched module per step, so a
  step cannot claim green by testing only its happy paths; the Step 9
  suite re-parses the runner output and fails the gate itself.
- **Timing sensitivity:** queue never-block assertions (Step 3) use
  wall-clock budgets; flaky-prone assertions must use generous bounds
  and be justified in the status table, never weakened silently.
- **Live-only paths:** the model-gated smoke tests (Step 6) and live
  levels (Step 9) skip without credentials; every skipped AC is also
  covered at harness level, so CI without a key still proves the AC.

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-11-25 | Didier Durand | imported from pi-tools; versioned per house convention; status updated to executed |
