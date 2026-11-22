# Extensions

Shared Pi extensions loaded by every agent via compose
(`--extension /repo-extensions/...`, read-only mount, one `git pull` to
update all agents).

### `git-status.ts` — live git state in the footer

**Why this extension exists:** each agent works in its **own independently
git-cloned repository** — the compose workspaces `~/pi-agents/<agent>` are
separate checkouts, cloned and updated at different times by different
sessions. Without this extension there is no per-agent way to see, at a
glance, *which repo state which agent is in*: whether its checkout is dirty
from mid-task edits, whether it has unpushed commits, or whether it lags
behind its upstream. The extension gives each agent TUI its own live,
self-scoped view (branch, ↑ahead / ↓behind, dirty count, ✓clean) of exactly
its own workspace — so an agent can never silently work from a stale or
modified checkout, and the operator can compare all four agents' states
cross-tab at a glance.

Renders one footer status line (ID `git-status`) made of colored parts:

| Part | Color | Meaning | When shown |
|---|---|---|---|
| `⎇ <branch>` | accent | Current branch (`⎇ detached` if detached HEAD) | Always, in a git repo |
| `↑<n>` | success | n commits **ahead** of the upstream remote | only when ahead > 0 |
| `↓<n>` | warning | n commits **behind** upstream | only when behind > 0 |
| `●<n>` | warning | n **uncommitted changes** (staged + unstaged + untracked) | only when n > 0 |
| `✓clean` | success | Zero changes in the worktree | replaces the dot when clean |

Examples: `⎇ main ✓clean` · `⎇ main ↑2 ●5` · `⎇ fix/heartbeat-race ↓1 ●1`

Behavior: refreshes after every tool call, at `agent_end`, and at session
start (throttled to ~2 runs/s); data from `git status --porcelain=v1 -b`;
auto-hides outside git repos; TUI-only. Deliberately omits staged/unstaged
split, stash count, and remote name — the agent runs `git status` itself
when it needs that depth.

