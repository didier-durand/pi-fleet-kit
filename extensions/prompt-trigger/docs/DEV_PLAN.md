# prompt-trigger — Implementation Plan

Plan version: 1.0.0 (semver — matches the tag `impl-plan-prompt-trigger-1.0.0`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** executed — the extension ships as v0.1.0. Derived from
> `extensions/prompt-trigger/docs/SPECS.md` (requirements R1–R8). This is
> a **retroactive** plan: the extension was built and shipped as a single
> release before the spec was formalized; this document describes the
> architectural decisions and the test strategy.

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

## Plan-level definition of done

- All R1–R8 requirements satisfied and test-pinned.
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
