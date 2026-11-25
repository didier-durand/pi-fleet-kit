# git-status — Implementation Plan

Plan version: 1.0.0 (semver — matches the tag `impl-plan-git-status-1.0.0`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** executed — the extension ships as v0.2.0. Derived from
> `extensions/git-status/docs/SPECS.md` (requirements R1–R7). This is a
> **retroactive** plan: the extension was built incrementally across
> versions 0.1.0 and 0.2.0 before the spec was formalized; this document
> describes the actual build sequence and the architectural decisions it
> embodied.

## Ordering principle

**Single-repo core first, multi-repo and naming after.** v0.1.0
established the minimal footer (branch, ahead/behind, dirty count, line
stats) against the workspace toplevel. v0.2.0 added the three
architectural changes that turned a single-repo footer into a
fleet-aware tracker: repo discovery (R3b), origin-name derivation (R4),
and the hermetic test suite that pins every parsing/guard branch.

## Steps (chronological, as shipped)

### Step 1 — v0.1.0: single-repo footer (R1, R2, R3, R5, R7)

- Footer status line: branch (`## main…`), ahead/behind vs upstream
  (parsed from `[ahead N, behind M]`), dirty file count from
  `--porcelain=v1`, +/- line stats via `git diff --shortstat` (worktree
  and index summed when they differ; ahead range via `@{u}..HEAD`).
- Refresh triggers: `session_start`, `tool_result`, `agent_end`,
  throttled at 500ms with burst coalescing.
- Hidden entirely when the workspace is not a git repo.
- Guardrails: >500 dirty files skips diffing; >500 lines renders `>500`.

### Step 2 — v0.2.0: multi-repo discovery (R3b)

- `resolveRepos()`: `/workspace` toplevel via `git rev-parse
  --show-toplevel`, plus nested clones via `find /workspace -maxdepth 3
  -name .git -type d` (node_modules excluded, deduped, shallowest-first).
- Dispatch: 1 repo → `refreshSingle()` (rich footer); N repos →
  `refreshMulti()` (compact segments, `MAX_REPOS` = 5, `+N more`).
- Rediscovery: any tracked repo vanishing → full re-discovery on the
  same tick.

### Step 3 — v0.2.0: repo naming from origin (R4)

- `repoDisplayName()`: `git config --get remote.origin.url` → last path
  segment after `/` or `:`, `.git` stripped; directory basename as
  fallback for repos without origin or with degenerate URLs.
- Cached per root (`nameCache` Map); cleared on full rediscovery.

### Step 4 — v0.2.0: hermetic test suite (R8)

- 40 unit tests (Node built-in test runner, zero test dependencies):
  scriptable `pi.exec` fakes routing on `(cmd, args)` signatures.
- Covers: shortstat parsing (full/deletion-only/count-less/unparseable),
  origin-name derivation (https, scp, empty, trailing-colon, fallback),
  repo discovery (toplevel, nested, node_modules exclusion, dedupe),
  rich footer (byte-for-byte: ahead/behind/behind-only, sums, guards,
  no-upstream, git-failure reset), compact segments (cap + `+N more`,
  partial/all-stale), dispatch, no-UI mode, rediscovery, factory
  (throttle coalescing, poll ticks, streaming suppression, shutdown —
  via `mock.timers` with mocked `Date`).
- Coverage: 100% statements / 96.9% branches / 100% functions.

### Step 5 — v0.2.0: CI workflow

- `git-status-check-sanity`: manifest, CHANGELOG, tsc, tarball equality,
  optional live-load smoke test.
- `git-status-unit-tests`: the 40-test suite under c8, per-file coverage
  in the job summary.

## Architectural decisions

- **Single file** (`git-status.ts`, ~291 lines): the entire extension —
  discovery, parsing, rendering, throttling, rediscovery — fits in one
  readable file. Internal functions are exported for testability
  (`_resetState()` for state reset between test cases).
- **`pi.exec` over `child_process`**: the extension never spawns
  processes directly; all git interaction goes through `pi.exec`, which
  the test fakes can intercept.
- **Module-level state** (`repos`, `nameCache`): global, not per-factory.
  The footer is a singleton per session — one repo list, one cache.
  `_resetState()` is the test seam.
- **`mock.timers` for throttle tests**: `Date` + `setTimeout` mocked so
  coalescing behavior is deterministic (mock clock starts at 0, which
  the tests advance past `MIN_INTERVAL_MS` before the first call).

## Plan-level definition of done

- All R1–R7 requirements satisfied and test-pinned.
- CI green: sanity + unit-test workflows.
- npm package publishable (`npm pack` produces exactly the declared files).
- Extension loads via `pi -e` and answers (live-load smoke test in CI).

## Risks

- **Git version drift**: the `--porcelain=v1` format is stable; if a
  future git version changes the format, the parser must be updated.
- **Large repos**: >500 dirty files skip diffing; the footer still shows
  the count but without line stats (documented degradation).

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-11-25 | Didier Durand | retroactive plan from shipped v0.2.0; versioned per house convention |
