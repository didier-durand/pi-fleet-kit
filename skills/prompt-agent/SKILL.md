---
name: prompt-agent
description: >
  Defines the shape of an inter-agent work order: how to describe the
  collaboration workspace (GitHub repo URL, branch, expected state), what a
  request must contain to be actionable (task, deliverable, constraints),
  and the report-back channels a worker agent must use when results are
  ready (GitHub review, prompt channel, session reply) with a mandatory
  DONE/BLOCKED status signal. Use when composing a prompt to send work to
  another agent, or when receiving one and needing to parse what is
  expected — the same format is the contract on both sides.
---

# Prompting Another Agent

A work order between agents is a plain-text prompt file (dropped through a
prompt channel, or pasted into a session). It must be **self-sufficient**:
the worker has no access to your session, your workspace, or your memory.
Everything it needs is in the prompt — anything missing becomes a
BLOCKED round-trip.

## The template

```text
/task <one-line imperative summary>

Requester: <agent-name or operator>
Workspace: <GitHub repo URL>
Branch: <branch name or ref>
Worktree state: <clean | dirty — what to expect>
Scope: <paths or directories in focus>

Task:
<numbered requirements — precise, verifiable, in priority order>

Deliverable:
<what must exist when done: code, PR, review, file, answer —
 and how the requester will check it>

Constraints:
<hard rules: skills to apply, test bar, forbidden actions
 (e.g. do not push to main), deadline or budget if any>

Report back via: <channel from the list below>
```

## Field rules

- **Requester** — mandatory. The worker must know who will consume the
  result and which channel listens for it. Anonymous orders are invalid.
- **Workspace** — the exact GitHub repo URL the work happens in. The
  worker clones it fresh (or reuses its own checkout if it already points
  at the same repo+branch) — it must **never** assume access to the
  requester's local state. Uncommitted requester-side changes are
  invisible: if they matter, commit and push them first, then say so in
  `Worktree state`.
- **Branch** — the exact ref to build on. `main` must be named explicitly;
  "the current one" is not a ref.
- **Task** — numbered, each item independently verifiable, ordered by
  priority. One task per prompt; batching related steps is fine, bundling
  unrelated work is not.
- **Deliverable** — the definition of done, in the requester's terms:
  what artifact, where it must land, and how it will be checked (e.g.
  "tests green on the branch", "PR open with a house-standard body").
- **Constraints** — everything the worker must not have to guess: skills
  to apply (coding, review, research standards as applicable), what is
  off-limits, how far it may go
  (open a PR? push a branch? read-only analysis only?).
- **Report back via** — exactly one channel from the list below, and it
  must be a channel the requester actually monitors.

## Report-back channels

| Channel | When to use | What the worker does |
|---|---|---|
| `github-review <repo>#<PR>` | The deliverable is (or includes) a PR the requester will consume as a review dialog | Open/update the PR, then post the result as a review or comment on it; the requester continues the dialog there |
| `github-pr <repo>` | The deliverable is a PR that will be reviewed by someone else | Open the PR with a house-standard body (Summary / Evidence / Merge Danger); report the PR URL back through the requester's channel |
| `prompt-channel <path>` | The requester monitors a prompt/exchange directory | Drop one result file there (atomic write), content shaped as the Result format below |
| `session-reply` | The order was given inside an ongoing conversation | Reply in the same session — no file, no repo write needed |

Only use the channel named in the prompt; delivering results anywhere else
is a lost result.

## Result format (every report, any channel)

```text
/result
Status: DONE | BLOCKED
Summary: <one line>
Artifacts: <PR URL, branch, file paths — as applicable>
Notes: <deviations from the task, open questions, follow-ups>
```

- `DONE` means every numbered Task item is verifiably satisfied — tests
  run and green when the deliverable includes code (say what was run).
- `BLOCKED` is a first-class outcome, not a failure: state precisely what
  is missing (credentials, unclear requirement, conflicting state) and
  what would unblock it. Never report DONE with open doubts; never go
  silent — a worker that cannot proceed reports BLOCKED immediately.
