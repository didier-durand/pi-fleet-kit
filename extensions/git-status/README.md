# `git-status` extension

Shared loading info (channels, Pi Package vs `--extension`): [../README.md](../README.md).

## Why this extension exists

Each agent works in its **own independently git-cloned repository** — the
compose workspaces `~/pi-agents/<agent>` are separate checkouts, cloned and
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
five parts, left to right:

| Part | Color | Meaning | When shown |
|---|---|---|---|
| `⎇ <branch>` | accent | Current branch name (`⎇ detached` if detached HEAD) | Always, inside a git repo |
| `↑<n>·<m>f(+a/−d)` | success | **n commits ahead** of upstream, touching **m files**, `+a/−d` changed lines | only when ahead > 0 |
| `↓<n>` | warning | **n commits behind** the upstream remote | only when behind > 0 |
| `●<n>f(+a/−d)` | warning | **n impacted files** uncommitted (staged + unstaged + untracked together; `f` marks the file count, consistent with `↑`), `+a/−d` changed lines across worktree and index | only when n > 0, ≤ 500 |
| `●>500` | warning | Change surface too large — line counts skipped (diff cost would dominate) | when n > 500 |
| `✓clean` | success | Zero changes in the worktree | replaces the dot when clean |

Line-count economics: computed only when the corresponding count is
non-zero and ≤ 500 files — two `git diff --shortstat` calls (worktree,
index) plus one `@{u}..HEAD` diff for the ahead range, each a few
milliseconds on healthy repos. Above the 500-file guard the footer shows
`●>500`: exactly the case where diffing would be slow and a line count
meaningless. Display as requested: no bare `●n` fallback — oversized
change surfaces are shown as `●>500`.

Reading examples:

```
⎇ main ✓clean                    in sync with origin, nothing to commit
⎇ main ↑2·3f(+41/−12) ●5f(+156/−89)  2 unpushed commits touching 3 files (+41/−12); 5 dirty files (+156/−89)
⎇ fix/heartbeat-race ↓1 ●1f(+2/−0) 1 behind origin, 1 dirty file
⎇ main ●>500                     massive change surface — line counts withheld
```

Reading examples:

```
⎇ main ✓clean                    in sync with origin, nothing to commit
⎇ main ↑2 ●5                     2 unpushed commits, 5 dirty files
⎇ fix/heartbeat-race ↓1 ●1       1 behind origin, 1 dirty file — pull needed
```

What each part tells the operator, decision-wise:

- `⎇ branch` — which code line the agent is working on (never a surprise
  branch again)
- `↑n` — the agent produced commits it hasn't shared: consider pushing or
  reviewing them
- `↓n` — the checkout is stale relative to upstream: the agent may be
  working against outdated code; a pull/`/reload` is due
- `●n` — mid-task edits live in the worktree: do not `git checkout` or
  rebuild the workspace without preserving them
- `✓clean` — safe ground: the checkout can be reset/recloned without loss

## Behavior

| Aspect | Detail |
|---|---|
| Refresh triggers | after every tool call (bash/edit/write mutate git state), at `agent_end`, and at `session_start` |
| Refresh throttle | ~2 runs/second maximum, with burst coalescing |
| Data source | `git status --porcelain=v1 -b` (stable plumbing format, portable) |
| Outside a repo | the status entry clears itself entirely |
| Non-TUI modes | inert in `--print`/JSON mode (`ctx.hasUI` guard) |
| Sits alongside | Pi's built-in footer info (model, context usage) — it adds an entry, does not replace the footer |

## Deliberate omissions

Staged-vs-unstaged split, stash count, and remote name are **not** shown —
kept lean for a footer line. The agent runs `git status` itself whenever it
needs that depth; if you want any of them surfaced here, they are small
additions to `git-status.ts`.
