# git-status — live git state in the pi footer

Specification version: 1.0.0 (semver — matches the tag `specs-git-status-1.0.0`)
Author: Didier Durand
Date: 2026-11-25

> **Status:** implemented — the extension ships as v0.2.0 (see
> `package.json`). This spec documents the contract the extension was
> built to (written retroactively from the shipped code, after the
> multi-repo rewrite of 0.2.0).

## Objective

`git-status` is a **pi coding agent extension** that keeps a live footer
status line reflecting the git state of the workspace the agent works in:
branch, ahead/behind vs upstream, uncommitted change count, and changed
line totals — refreshed after every tool call and periodically, at zero
token cost.

It is observation only: git-status MUST NOT modify sessions, alter agent
behavior, write to git, or degrade the interactive experience.

## Context and grounding

1. **Pi extension standard.** A TypeScript module (jiti-loaded, no build
   step) exporting a default factory over `ExtensionAPI`; auto-discovery
   from `~/.pi/agent/extensions/git-status/git-status.ts` or
   repo-local `--extension /repo-extensions/git-status/git-status.ts`.
   Runs inside the pi process with the user's permissions, and MUST
   respect `ctx.hasUI` guards (print/JSON mode: no UI to update).
2. **Plain `git` plumbing only.** All git interaction uses
   `pi.exec("git", [...])` — no shell wrapper, no `git status --porcelain`
   extensions beyond `-b` for branch/beat. Linux/macOS/Windows(Git Bash)
   compatible.
3. **Fleet context.** Each agent in the fleet has its own workspace
   clone; the footer reflects that agent's own checkout. The workspace
   root inside the container is always `/workspace`.

## Artifact structure

```text
git-status/
├── git-status.ts          # the entire extension (single file, ~291 lines)
├── git-status.test.ts     # 40 hermetic unit tests (scriptable pi.exec fakes)
├── package.json           # pi package manifest (pi-package keyword)
├── README.md · CHANGELOG.md
└── docs/
    ├── SPECS.md           # this document
    └── DEV_PLAN.md        # implementation plan
```

Single-file by design: the extension's entire logic (discovery, parsing,
rendering, throttling, rediscovery) fits in one readable file with no
external dependencies.

## Glossary

- **Footer status** — the pi TUI's status line, set via
  `ctx.ui.setStatus(ID, text)`; cleared with `setStatus(ID, undefined)`.
- **Repo discovery** — resolving which git repositories to track:
  `/workspace` itself (if inside a repo) plus every nested clone found by
  a bounded scan.
- **Rich footer** — the single-repo mode: repo name, branch, ↑ahead
  counts with line stats, ↓behind, dirty file count with +/- line stats,
  or ✓clean.
- **Compact segments** — the multi-repo mode: one `name: ⎇ branch ↑n ●n`
  segment per repo, `│`-separated, up to `MAX_REPOS` shown.

## Requirements

| ID | Name | Summary | Priority |
|---|---|---|---|
| R1 | Safety | Extension that never harms or alters the agent | 1 (highest) |
| R2 | Observation | Zero writes to git; footer only reflects state | 2 |
| R3 | Accuracy | Footer reflects the real git state within one poll interval | 3 |
| R3b | Multi-repo | Tracks all repos in the workspace, not just one | 3 |
| R4 | Repo naming | Footer identifies which repo via the origin remote name | 4 |
| R5 | Performance | Throttled, cached, zero-token idle, bounded cost | 5 |
| R6 | Resilience | Repo vanishing/reappearing handled without agent impact | 6 |
| R7 | Portability | Linux/macOS/Windows(Git Bash): plain `git` plumbing only | 7 |

### R1 — A standard, zero-harm extension

The extension MUST NOT modify any session entry, MUST NOT throw
unhandled exceptions on any git failure, and MUST NOT block the agent's
turn. All git commands are fire-and-forget from the extension's
perspective: a git failure clears the footer and triggers rediscovery
on the next tick.

### R2 — Observation only

The extension reads git state exclusively through `pi.exec("git", ...)`.
It never calls `git add`, `git commit`, `git push`, or any write
operation. It never writes to the session (no `pi.appendEntry`).

### R3 — Accuracy within one poll interval

The footer refreshes on:
- `session_start` — initial state;
- `tool_result` — every tool call can mutate git state;
- `agent_end` — the agent may have mutated state during the turn;
- a periodic poll (default 3s) — catches changes by external actors
  (the user in another terminal, sibling agents, the watchdog).

### R3b — Multi-repo tracking

The extension MUST discover and track **all** git repositories in the
workspace:

- Discovery: `/workspace` toplevel (if inside a repo) via
  `git rev-parse --show-toplevel`, plus every nested clone found by
  `find /workspace -maxdepth 3 -name .git -type d` (node_modules
  excluded, deduped, shallowest-first sort).
- **Single repo**: the rich footer (ahead/behind + line stats).
- **Multiple repos**: one compact segment per repo (name, branch,
  ahead/behind, dirty count), `│`-separated. Up to 5 shown (`MAX_REPOS`),
  `+N more` beyond. Line stats withheld in this mode (N repos × 3 diffs
  per tick would scale the refresh cost).
- **Rediscovery**: any tracked repo vanishing (workspace reset, .git
  removed) triggers full re-discovery on the same tick — new clones are
  picked up within one poll interval.

### R4 — Repo naming from the origin remote

The footer prefix is derived from `remote.origin.url`:
- `https://github.com/user/my-repo.git` → `my-repo`
- `git@github.com:user/repo.git` → `repo`
- Directory basename as fallback (no origin, or degenerate URL)
- Cached per repo root — one `git config` call per repo, not per tick;
  cache cleared on full rediscovery.

### R5 — Performance

- Throttled to `MIN_INTERVAL_MS` (500ms): git runs at most ~2×/second,
  with burst coalescing (a trailing refresh catches the last mutation).
- Line-stats guardrails: dirty files > 500 (`DIFF_FILE_LIMIT`) skip
  diffing entirely; changed lines > 500 (`LINE_LIMIT`) render as `>500`.
- Multi-repo mode withholds line stats (cost scales with repo count).
- Repo-name display cached per root.
- Idle cost: zero tokens; CPU a few ms per poll tick.

### R6 — Resilience

- A tracked repo disappearing clears the footer and triggers full
  rediscovery (replacement clones picked up on the same tick).
- A git command failing (deleted .git, corrupted repo) resets the
  tracked repos and clears the footer.
- The extension never throws unhandled exceptions on any of these paths.

### R7 — Portability

Plain `git` plumbing only: `git rev-parse`, `git status --porcelain=v1
-b`, `git diff --shortstat`, `git config --get remote.origin.url`,
`git -C <root>`. No shell wrapper. No `~` expansion (all paths are
absolute). macOS, Linux, Windows (Git Bash).

## Explicit non-goals

- **Git write operations** — the extension never modifies git state.
- **Push/pull detection** — the footer shows ahead/behind counts from
  the local refs, not live remote state (no network calls).
- **Per-file dirty listing** — the footer shows counts, not filenames.
- **Branch switching** — the extension reads the current branch; it
  never switches.

## Deliverable specification

- The extension ships as a Pi Package (`pi-git-status` on npm) with
  `pi-package` keyword, `pi.extensions` manifest, peerDependencies on
  `@earendil-works/pi-coding-agent` with a `*` range.
- Published tarball: exactly `git-status.ts`, `README.md`,
  `CHANGELOG.md` (npm `files` allowlist).
- Test suite: 40 hermetic unit tests (Node built-in test runner,
  scriptable `pi.exec` fakes — no live git, no LLM), coverage
  100% statements / 96.9% branches / 100% functions.

## General constraints

- Zero external dependencies at runtime (only `node:child_process` via
  `pi.exec`).
- The footer ID is `"git-status"` — one status entry per session.
- The status entry is set/cleared, never left stale (no-repo → cleared).

## Open questions

- **Remote fetch on demand**: should the extension trigger a `git fetch`
  to get live ahead/behind counts? Deferred: network calls from the
  footer would add latency and potential auth failures; the current
  counts reflect local refs only.

## Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-11-25 | Didier Durand | retroactive spec from shipped v0.2.0 (written after the multi-repo rewrite; versioned per house convention) |
