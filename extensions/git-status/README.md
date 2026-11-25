# `git-status` extension

Shared loading info (channels, Pi Package vs `--extension`): [pi-fleet-kit extensions README](https://github.com/didier-durand/pi-fleet-kit/blob/main/extensions/README.md).

## Why this extension exists

Each agent works in its **own independently git-cloned repository** — the
compose workspaces `$PI_FLEET_KIT_HOME/pi-agents/<agent>` are separate checkouts, cloned and
updated at different times by different sessions. Without this extension
there is no per-agent way to see, at a glance, *which repo state which agent
is in*: whether its checkout is dirty from mid-task edits, whether it has
unpushed commits, or whether it lags behind its upstream. The extension
gives each agent TUI its own live, self-scoped view of exactly its own
workspace — so an agent can never silently work from a stale or modified
checkout, and the operator can compare all agents' states cross-tab at a
glance.

**Complement to Warp's git view:** when running the agents in Warp tabs,
the two layers of git information are deliberately different. Warp's own
git status UI reflects the **host** copy of a repository (the directory the
tab's shell sits in), while this extension reflects the **agent's copy
inside the container** — a separate checkout that can legitimately differ
from the host's (dirty from the agent's own edits, ahead after the agent
committed, or behind until it pulls). Reading the two side by side in a tab
therefore shows both worlds at once: host state in the Warp UI, agent state
in the pi footer.

## The information it delivers

One footer status line (status entry ID `git-status`), composed of up to
six parts, left to right:

| Part | Color | Meaning | When shown |
|---|---|---|---|
| `<repo-name>:` | accent | Repo name from the origin remote (`remote.origin.url`; directory basename as fallback) — always identifies which repo the line describes | Always, inside a git repo |
| `⎇ <branch>` | accent | Current branch name (`⎇ detached` if detached HEAD) | Always, inside a git repo |
| `↑ c:<n> f:<m> l:+a/−d` | success | **n commits ahead** of upstream (`c:`), touching **m files** (`f:`), `+a/−d` changed lines (`l:`) | only when ahead > 0 |
| `↓ c:<n>` | warning | **n commits behind** the upstream remote (`c:`) | only when behind > 0 |
| `● f:<n> l:+a/−d` | warning | **n impacted files** (`f:`) uncommitted, `+a/−d` changed lines (`l:`) across worktree and index | only when 0 < n ≤ 500 and lines ≤ 500 |
| `● f:<n>>500L` | warning | Guard aligned with **lines**: more than 500 changed lines — file count still shown (`f:`), line counts withheld | when computed lines > 500, or n > 500 files (diff skipped for cost) |
| `✓clean` | success | Zero changes in the worktree | replaces the dot when clean |

Guardrail economics (line-aligned, as requested):

- **Lines are the guard metric**: whenever the diff is computable and the
  total of added+deleted lines exceeds 500, the footer shows `●<n>f>500L`
  — the exact number of impacted files is always known (free, from
  `git status`), the line counts are withheld (`>500L`).
- **File count as cost gate only**: when n exceeds 500 files, diffing is
  skipped entirely (cost scales with change surface); the footer then shows
  `●<n>f>500L` with the exact file count and the same lines-withheld form —
  no bare `●n` is ever displayed.
- Exact counts appear only in the sweet spot: ≤ 500 files AND ≤ 500 lines.

Reading examples:

```
my-repo: ⎇ main ✓clean                    in sync with origin, nothing to commit
my-repo: ⎇ main ↑ c:2 f:3 l:+41/−12 ● f:5 l:+156/−89  2 unpushed commits touching 3 files; 5 dirty files
my-repo: ⎇ fix/heartbeat-race ↓ c:1 ● f:1 l:+2/−0  1 behind origin, 1 dirty file
my-repo: ⎇ main ● f:412 l:>500           412 dirty files produced >500 changed lines — line counts withheld
my-repo: ⎇ main ● f:613 l:>500           613 dirty files — diff skipped for cost, file count still exact
```

What each part tells the operator, decision-wise:

- `⎇ branch` — which code line the agent is working on (never a surprise
  branch again)
- `↑ c:…` — the agent produced commits it hasn't shared: consider pushing or
  reviewing them
- `↓ c:…` — the checkout is stale relative to upstream: the agent may be
  working against outdated code; a pull/`/reload` is due
- `● f:…` — mid-task edits live in the worktree: do not `git checkout` or
  rebuild the workspace without preserving them
- `✓clean` — safe ground: the checkout can be reset/recloned without loss

## Behavior

| Aspect | Detail |
|---|---|
| Refresh triggers | after every tool call (bash/edit/write mutate git state), at `agent_end`, at `session_start`, **and on a periodic tick** (default 3s, `PI_GIT_POLL_MS` to override; skipped while a turn streams — tool events cover that window) |
| Refresh throttle | ~2 runs/second maximum, with burst coalescing |
| External actors | **detected**: the periodic tick re-reads git every ~3s, so changes from other terminals, sibling agents, or the watchdog appear within seconds — no tool call needed |
| Idle cost | a `git status` (+ shortstat diffs when counts changed) every ~3s — **zero tokens**; CPU a few ms per tick |
| Data source | `git status --porcelain=v1 -b` (stable plumbing format, portable), run with `git -C` against the discovered repo root |
| Repo discovery | at session start: /workspace if it is (or is inside) a repo, plus every nested clone (bounded scan, maxdepth 3, node_modules excluded), retried while none exist — a workspace cloned after launch is picked up within one poll interval. A vanished repo triggers full re-discovery |
| Single repo | the rich footer below (ahead/behind + line stats) |
| Multiple repos | one compact segment per repo, `│`-separated: `api: ⎇ main ↑2 ●3 │ web: ⎇ feat/ui ✓` — up to 5 shown, `+N more` beyond; line stats withheld to keep the refresh cheap |
| No repo found | the status entry clears itself entirely — and re-discovery keeps retrying, so the footer appears as soon as a repo shows up |
| Non-TUI modes | inert in `--print`/JSON mode (`ctx.hasUI` guard) |
| Sits alongside | Pi's built-in footer info (model, context usage) — it adds an entry, does not replace the footer |

## Deliberate omissions

Staged-vs-unstaged split, stash count, and remote name are **not** shown —
kept lean for a footer line. The agent runs `git status` itself whenever it
needs that depth; if you want any of them surfaced here, they are small
additions to `git-status.ts`.
