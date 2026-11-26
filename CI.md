# CI — workflows, triggers, dependencies

Eleven GitHub workflows gate every artifact of this repo. This document
visualizes how they are triggered and how they chain into each other;
the workflows themselves live in [`.github/workflows/`](.github/workflows/).

## Trigger and dependency graph

```mermaid
flowchart LR
  subgraph TRIG["⌘ Event sources"]
    direction TB
    PUSH["git push → main<br/>path-filtered per workflow"]
    PR["pull_request<br/>same path filters"]
    CRON["⏰ schedule<br/>daily 04:00 UTC"]
    DISPATCH["▶ workflow_dispatch<br/>every workflow"]
  end

  subgraph EXT["🧩 Extension CI — one sanity + one unit-test workflow per extension"]
    direction TB
    GS_SANITY["git-status-check-sanity"]
    GS_UNIT["git-status-unit-tests"]
    PT_SANITY["prompt-trigger-check-sanity"]
    PT_UNIT["prompt-trigger-unit-tests"]
    OBS_SANITY["pi-obs-check-sanity"]
    OBS_UNIT["pi-obs-unit-tests"]
    OBS_COMPLIANCE["pi-obs-otel-compliance<br/>external OTLP dataset — parser vs ground truth"]
  end

  subgraph IMG["📦 Sandbox image CI"]
    direction TB
    BUILD["build-sandbox-image<br/>staging → verify → promote latest"]
    TESTIMG["test-sandbox-image<br/>live LLM — minimal + knowledge prompts"]
    GS_DOCKER["git-status-docker-tests<br/>40 tests inside the sandbox"]
    OBS_DOCKER["pi-obs-docker-tests<br/>115 tests inside the sandbox"]
    OBS_LIVE["pi-obs-otlp-live<br/>prompt/answer correlation over live OTLP"]
  end

  PUSH --> GS_SANITY & GS_UNIT & PT_SANITY & PT_UNIT & OBS_SANITY & OBS_UNIT & BUILD
  PR --> GS_SANITY & GS_UNIT & PT_SANITY & PT_UNIT & OBS_SANITY & OBS_UNIT
  CRON --> BUILD
  DISPATCH -.-> EXT
  DISPATCH -.-> IMG
  BUILD == "on success" ==> TESTIMG
  BUILD == "on success" ==> GS_DOCKER
  BUILD == "on success" ==> OBS_DOCKER
  OBS_UNIT == "on success" ==> OBS_COMPLIANCE
  OBS_DOCKER == "on success" ==> OBS_LIVE

  classDef trig fill:#FEF3C7,stroke:#B45309,color:#92400E
  classDef sanity fill:#CFFAFE,stroke:#0E7490,color:#155E75
  classDef unit fill:#DBEAFE,stroke:#1D4ED8,color:#1E40AF
  classDef compliance fill:#DCFCE7,stroke:#15803D,color:#166534
  classDef image fill:#FFF8EC,stroke:#C08A2D,color:#7A5410
  class PUSH,PR,CRON,DISPATCH trig
  class GS_SANITY,PT_SANITY,OBS_SANITY sanity
  class GS_UNIT,PT_UNIT,OBS_UNIT unit
  class OBS_COMPLIANCE,OBS_LIVE compliance
  class BUILD,TESTIMG,GS_DOCKER,OBS_DOCKER image
```

## Reading the graph

- **Solid edges** — direct triggers: a push (path-filtered) or pull request
  runs the six extension workflows; the daily cron runs the image build.
- **Dotted edges** — `workflow_dispatch`: every workflow can also be run
  manually from the Actions tab.
- **Thick edges** — `workflow_run` success-gates: the downstream workflow
  runs only when the upstream completed successfully. A failure upstream
  means the downstream never starts.

## The chains

1. **Extension change** (e.g. `extensions/git-status/**`) →
   sanity gate (manifest, CHANGELOG, tsc, tarball, live-load smoke) →
   unit tests with coverage (job summary per-test report).

2. **pi-obs unit tests pass** → **OTLP compliance**: the parser runs
   against the largest external OpenTelemetry dataset in the repo
   (a real OpenTelemetry-demo export, ~117k spans, 17 services) with the
   parser's span count cross-checked against an independent ground truth.

3. **Image change** (or the daily 04:00 UTC cron) → **build-sandbox-image**:
   builds amd64+arm64, pushes the immutable `sha-` tag, pulls it back
   from GHCR, smoke-runs both platforms (entrypoint, pi, git/gh/node),
   then — and only then — promotes the verified digest to `latest`/`main`
   (+ `daily` on the cron, semver on version tags). A failed verification
   leaves `latest` pointing at the last good image.

4. **Image verified** → three parallel consumers:
   `test-sandbox-image` (live LLM: minimal prompt + knowledge prompt,
   both platforms), `git-status-docker-tests` (the extension's 40 tests
   inside the sandbox), `pi-obs-docker-tests` (115 tests inside the
   sandbox) → **pi-obs-otlp-live** (a real prompt through the sandbox
   with pi-obs exporting OTLP; the captured spans must correlate the
   prompt with the answer on one traceId, displayed as a span tree in
   the job summary).

## Shared machinery

| Script | Used by |
|---|---|
| `utils/check-extension.sh <name>` | the three `*-check-sanity` workflows |
| `utils/run-tests.sh <name> [paths…]` | the three `*-unit-tests` workflows |
| `config/otelcol-jaeger.yaml` | the `otlp-jaeger` compose service (consumed in production, not CI) |
| `extensions/pi-obs/tests/tools/validate-external-otel.mjs` | `pi-obs-otel-compliance` |
| `extensions/pi-obs/tests/tools/otlp-capture-receiver.mjs` · `validate-otlp-correlation.mjs` · `otlp-trace-summary.mjs` | `pi-obs-otlp-live` |

Every job summary carries the house formatting: thousand-separated
numbers, per-check ✅/❌ rows, and (for unit tests) the per-test table
with durations.
