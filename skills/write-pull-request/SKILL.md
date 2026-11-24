---
name: write-pull-request
description: >
  Defines the shape of a pull request body: a Summary that shows the change
  with the smallest clear visual, Evidence with a concrete before/after, and
  a Merge Danger call (one-way vs two-way door + blast radius). A format
  reference, not a workflow — it does not push branches or open PRs. Use
  whenever the agent writes, drafts, or rewrites a PR body — alone, after a
  code review, or when asked to open a pull request.
---

# Pull Request Body

Skill version: 1.1.0 (semver — matches tag skill-write-pull-request-1.1.0)
Author: Didier Durand
Date: 2026-11-24


Write the PR body in exactly three sections, in this order: **Summary**,
**Evidence**, **Merge Danger**. Skip all preambles — the body starts at the
`## Summary` heading. Keep prose brief: the reviewer already has the diff
open, so the body shows them its *shape* before they read it.

## The template

```markdown
## Summary

<diagram, diff-sketch, or tree>

## Evidence

- **Before:** <screenshot/output/failing test run>
- **After:** <screenshot/output/passing test run>

## Merge Danger

**Door:** <one-way or two-way>

<optional: description>

**Blast Radius:** <one-word description>

<optional: potential ramifications of merge>
```

## Section 1 — Summary

Pick the **smallest view** that makes the key point clear. One visual,
sometimes several, rarely all of them. Keep only the calls, files, props,
and boundaries the reviewer needs, each visual placed next to the short
text it supports.

- **Pseudocode** — for logic or an algorithm:
  ```text
  on(save)
    if content is unchanged
      return cached result
    write new content
    return fresh result
  ```
- **Call tree** — for runtime control flow:
  ```text
  submitForm
    createSession
      persistPrompt
      launchAgent
    navigateToSession
  ```
- **Component tree** — for UI structure, with state and module boundaries:
  ```text
  <SessionPage> (apps/example/src/routes/session.tsx)
    useSessionEvents()
    <SessionToolbar>
      <RunSkillButton> (packages/ui)
  ```
- **Shallow file tree** — for file responsibility or a broad refactor:
  ```text
  src/
  ├── commands/       # parses user actions
  ├── sessions/       # owns session state
  └── transport/      # sends API requests
  ```
- **Mermaid** — for component interaction, control flow, or data flow:
  ```mermaid
  sequenceDiagram
      participant User
      participant UI
      participant Daemon
      User->>UI: choose command
      UI->>Daemon: send expanded prompt
      Daemon-->>UI: stream result
  ```
- **Shaped diff** — when the point is *what changes* and the surrounding
  shape already exists; match the diff shape to the topic:
  ```diff
   on(save)
  -  write content
  +  if content is unchanged
  +    return cached result
  +  write new content
  +  invalidate cache
  ```
- **Whole code block** — when most of the block is new, when omitted
  context would hide ownership or order, or when the user needs a copyable
  target shape.

## Section 2 — Evidence

Concrete evidence that the change works. **Always a before and an after.**

Evidence is ranked in two grades — **S** (strongest) and **A** (strong);
pick the highest grade the change and environment allow:

- **S-tier: screenshots** — the strongest evidence, because the reviewer
  sees the actual result with their own eyes. Use when the change is visual
  (UI, layout, rendering) AND the environment can take a screenshot. A
  terminal-based agent that cannot screenshot falls back to A-tier.
- **A-tier: execution evidence** — test results and console output. Show
  the exact test that failed before and passes now, written as pseudocode,
  or the console output that changed. This is the default for non-visual
  changes: migrations, background jobs, refactors, library code.
- "Tests are green" on its own is a **claim**, not a before and after — it
  ranks below both: no reviewer can see *what* was verified.
- No UI? Use the non-screenshot evidence: the failing→passing test, the
  changed output, the migration log.

## Section 3 — Merge Danger

State whether this is a **one-way door** or a **two-way door**, and the
**blast radius**. The door call is the leading idea: it turns "is this safe
to merge?" from a gut feeling into a stated claim the reviewer can disagree
with — and tells them where to spend human review time.

- **Two-way door**: cheap to reverse. Skim these.
- **One-way door**: destructive actions and hard-to-reverse decisions —
  schema migrations, public API removals, anything that ships outward or
  deletes, a flagged rollout after its first write lands. Read these slowly.
- **Blast radius**: one word + optional ramifications — what could break if
  the change is wrong: layout shift, consumers of an API, mobile
  responsiveness.

**Self-grading honesty:** the agent that wrote the change is the one
grading its danger — be most suspicious of "two-way, small blast radius".
Base the call on the ticket/spec in front of you, not just the diff; the
diff often hides reversibility.

## Consistency with the commit series

The PR is the union of its commits — the body must describe exactly that
union. Derive it from the commit set, never from memory or from the last
commit alone:

```bash
git fetch origin && git log --oneline origin/main..HEAD   # the PR's commit set
git diff origin/main...HEAD --stat                        # the PR's real surface
```

Then check both directions:

- **Every commit is accounted for**: each commit subject in the set maps
  to something in the body — the Summary visual, Evidence, or Merge
  Danger. A commit the body doesn't mention is a red flag: either it
  doesn't belong in this PR (remove or split it) or the body is
  incomplete (rewrite). Nothing ships "between the lines".
- **Every body claim traces to a commit**: each statement in Summary/
  Evidence/Merge Danger must be backed by at least one commit in the set
  — no aspirational content ("adds X" with no commit doing X), no
  leftovers from an earlier draft describing work that was dropped.
- **Title = the dominant change**, not the last commit. With several
  logical changes (split by topic per house style), the title names the
  PR's primary change; the Summary covers the rest explicitly.
- **Clean the series before writing**: `fixup`/`wip`/typo-retry commits
  are squashed (only unpushed ones, or per repo policy) so the commit
  list reads as the change's real history; a body written on top of a
  noisy series inherits the noise.
- **Cumulative danger**: Merge Danger grades the PR as a whole — a
  series of individually two-way commits can sum to a one-way door;
  grade the union, not the last step. Evidence reflects the final state
  of the series (last commit's tests), not an intermediate one.
- **Re-derive after changes**: new commits pushed under review → re-run
  the checks above and rewrite the body where it drifted.

## Hard limits (what this skill does NOT do)

- It does **not** push a branch, open the PR, or triage review comments —
  body only.
- It writes the body **at one point in time**; if the PR changes
  substantially under review, rewrite the body (same shape).
- If the repo has a PR template, fill it and put **Summary / Evidence /
  Merge Danger** under it — do not produce two competing structures.
- The output is a **markdown PR body**, not HTML: Mermaid renders on
  GitHub/GitLab but not in a terminal — a call tree, file tree, or shaped
  diff reads everywhere.
- If the body is huge because the diff is huge, that's a PR-size problem —
  split the PR; the skill won't.

## It's working if

- The reviewer can tell what the PR changes from the Summary visual alone,
  before opening the diff.
- The body has no preamble: it starts at the Summary heading.
- Evidence shows a before and an after — not a claim that tests pass.
- Every PR states a door and a blast radius, and one-way doors are the ones
  reviewers slow down on.
- Body and commit series match in both directions: every commit is
  described, every claim traces to a commit; title names the dominant
  change.
