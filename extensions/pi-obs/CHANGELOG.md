## [0.2.0] - 2026-11-27

- Distributed traces across agents (R13): live session traces derive
  deterministically from the session id (`deriveTraceId` — replay
  parity); a mailbox delivery (appended by the prompt-trigger
  extension as a `mailbox` session entry) becomes an OTLP SPAN LINK on
  the receiver session span — `traceId = deriveTraceId(sender
  session_id)` + the `pi.mailbox.session_id` link attribute.
- The footer status carries a LIVE error report — `errors: total: N -
  faulted hooks: H - drop events: D - exporter faults: E` — updated
  the moment a fault is detected; `/pi-obs status` carries the same
  breakdown; zero faults keeps the footer clean.
- `pi.tool.input` registered in the semconv table (R4 add-only) — the
  tool_call handler no longer disables itself under
  `PI_OBS_CAPTURE_TOOL_IO=1`.
- Redaction tightened: credential-shaped assignments inside JSON
  (compact `JSON.stringify` and JSON-in-JSON escaped quotes) redact
  like shell/YAML `key=value` text.
- `/pi-obs errors`: list the detected error events in real time (a
  bounded in-session ring — kind, timestamp, detail; the durable copy
  stays in the OTel log records).
- `/pi-obs reset-errors`: zero the footer error counters and clean the
  footer on demand; detection re-arms (new faults counted fresh),
  faulted hooks stay disabled (R1).

# Changelog

## [0.1.9] - 2026-11-19

- Version bump from 0.1.8 (see `git log pi-obs-0.1.8..pi-obs-0.1.9` for changes).
- Imported into pi-fleet-kit and aligned to the house package layout:
  publishable manifest (no `private`), `license`/`repository` fields,
  same field order as `pi-git-status`/`pi-prompt-trigger`. The repo's
  extension sanity checker (`utils/check-extension.sh`) now covers
  pi-obs; its tsc gate gained `--allowImportingTsExtensions` (multi-file
  extensions import with explicit `.ts` extensions, as loaded by pi).

## [0.1.8] - 2026-11-19

- Version bump from 0.1.7 (see `git log pi-obs-0.1.7..pi-obs-0.1.8` for changes).

## [0.1.7] - 2026-11-18

- Version bump from 0.1.6 (see `git log pi-obs-0.1.6..pi-obs-0.1.7` for changes).

## [0.1.6] - 2026-11-18

- Version bump from 0.1.5 (see `git log pi-obs-0.1.5..pi-obs-0.1.6` for changes).

## [0.1.5] - 2026-11-18

- Version bump from 0.1.4 (see `git log pi-obs-0.1.4..pi-obs-0.1.5` for changes).

## [0.1.4] - 2026-11-18

- Version bump from 0.1.3 (see `git log pi-obs-0.1.3..pi-obs-0.1.4` for changes).

## [0.1.3] - 2026-11-18

- Versioning follows the TypeScript convention: `package.json` is the single
  source of truth; the OTel resource, instrumentation scopes, and the `piobs`
  CLI derive it via `src/version.ts` (anti-drift test included).
- `utils/bump-pi-obs.sh` — parametrized release flow in one command
  (`--patch/--minor/--major/--version=X.Y.Z [--no-push]`): bump, signed
  commit, signed tag `pi-obs-vX.Y.Z`, push, and the release artifact
  `pi-obs-vX.Y.Z.tgz` in the package root.
- Pi package conventions: explicit `pi` manifest (extension at the package
  root), `pi-package` keyword, host package in `peerDependencies` (type-only
  import — never bundled), this changelog.

## [0.1.2]

- First release cut with the bump flow (see 0.1.3).

## [0.1.1]

- Packaging as an allowlist: `npm pack` ships exactly the runtime payload
  (shim + `src/` + `bin/` + README) — 17 files, ~48 kB, zero dependencies;
  verified standalone in a bare directory (CLI, report, and `pi -e` load).

## [0.1.0]

- Initial release: OpenTelemetry observability for the pi agent — live
  capture of all 41 hooks (spans/metrics/logs), dual exporters (file +
  OTLP/HTTP), R2 redaction, post-mortem replay (`piobs` CLI), and a
  black-box suite with otelcol + weaver conformance.
