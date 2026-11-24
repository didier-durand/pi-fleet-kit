---
name: review-pull-request
description: >
  Reviews a pull request against the house PR-body standard (Summary /
  Evidence / Merge Danger) and the quality of the change itself, while
  staying strictly read-only on the reviewed artifacts: no edits, commits,
  pushes, or merges. Output is comments and improvement suggestions only,
  delivered to the PR creator — posted back to GitHub as a review when the
  PR lives there (the dialog channel), delivered directly otherwise.
  Iterates with the creator (review → fix → re-review) until the PR
  reaches a satisfactory state, then issues an explicit approval verdict.
  Use whenever asked to review a pull request, re-review a revised PR, or
  act as the reviewer half of a review dialog.
---

# Pull Request Review

Review a pull request in a strict **read-only reviewer** role: the only
things you produce are observations, comments, and suggestions. The creator
of the PR applies them; you re-review their next revision. The dialog loops
until the PR is satisfactory.

## Hard constraints — never violated

- **Do not modify any reviewed artifact.** No edits to the diff, no new
  commits, no rebases, no pushes, no `gh pr merge`, no closing/reopening.
- **Stay read-only on the worktree**: do not `git add`, `git stash`, or
  otherwise touch the local worktree beyond read-only commands (`git
  status`, `git diff`, `git log`, `gh pr view`, `gh pr diff`).
- **Posting reviews is the dialog channel, not a modification**: when the
  PR lives on GitHub (see "Dialog channel" below), posting your review as
  a GitHub review is required — it is how the creator receives the dialog.
  What remains forbidden in every case: merging, closing/reopening, editing
  the PR body or title, replying to or resolving threads on the creator's
  behalf, and any commit/push.
- If a fix seems obvious and small, the temptation to "just do it" is
  exactly what this skill forbids — write it down as a suggestion instead.
- Exception requiring explicit instruction: only the PR creator applies
  changes; only the operator may override these constraints.

## What the PR must satisfy

The PR body follows the house standard — three sections, in order, no
preamble before `## Summary`, brief prose (the reviewer has the diff open):

1. **`## Summary`** — the smallest clear view of the change: one visual
   (pseudocode, call tree, component tree, shallow file tree, or Mermaid),
   placed next to the short text it supports.
2. **`## Evidence`** — concrete before/after: screenshot, output, or a
   failing-vs-passing test run, clearly labeled **Before** and **After**.
3. **`## Merge Danger`** — a **Door** call (one-way vs two-way) plus a
   one-word **Blast Radius**, with optional short ramifications.

If the PR was not written with the `write-pull-request` skill, judge it
against this embedded standard above — do not require anything beyond it
(no test-coverage lectures, no style preferences the standard doesn't set).

## Review procedure

1. **Read the PR whole** before judging: `gh pr view <n>` (body), then
   `gh pr diff <n>`. Never comment on a hunk in isolation.
2. **Check the body** against the three-section standard — order, headings,
   no preamble, smallest-clear-visual rule, labeled Evidence, Door +
   Blast Radius present.
3. **Check the change itself**: does the diff do what the Summary claims?
   Is the Door call honest (data migrations, irreversible API changes,
   config flips = one-way)? Does the Blast Radius match the touched surface?
4. **Verdict per finding, severity-tagged**:
   - `BLOCKER` — violates the standard (missing section, dishonest Door)
     or the change contradicts the body. Must be fixed before approval.
   - `SUGGESTION` — would improve clarity or evidence; creator's choice.
5. **Output format** (delivered per the dialog channel below):
   ```text
   PR <n> — review <round k>
   Body:   PASS | FAIL (what's missing/misplaced)
   Change: PASS | concerns below
   Findings:
     [BLOCKER] <file/section> — <what + concrete suggestion>
     [SUGGESTION] <file/section> — <what + concrete suggestion>
   Verdict: CHANGES REQUESTED | APPROVED
   ```
6. **`APPROVED` means every check passed**: body matches the standard, diff
   matches the claims, zero BLOCKERs. Unresolved SUGGESTIONs do not block
   approval — note them as follow-ups instead.

## Dialog channel — where the review goes

Determined by where the review request came from:

- **GitHub-origin PR** (you were asked to review `owner/repo#<n>`): the
  dialog happens **on GitHub**, one posted review per round. Post the
  exact structured output (body/change/Findings/Verdict format above) as
  the review body:
  - `CHANGES REQUESTED` → `gh pr review <n> --request-changes --body "<output>"`
  - `APPROVED` → `gh pr review <n> --approve --body "<output>"`
  - Unresolved SUGGESTIONs alongside an approval: `--approve --body ...`
    mentioning them as non-blocking follow-ups (never downgrade to a
    blocking state just because suggestions exist).
- **Local / non-GitHub origin** (a diff, a branch, a colleague's checkout):
  deliver the same output directly to the creator — chat, file, or prompt —
  and never post anywhere.
- The creator's replies come back the same way: new commits + your
  re-review trigger. If the creator responds in an unexpected channel,
  follow the PR's channel, and say once that you did so.

## The iterative dialog

- **Round 1**: full review as above, verdict `CHANGES REQUESTED` (or
  `APPROVED` if clean on first sight — say so and stop).
- **Creator's turn**: they apply fixes and come back with a revised PR
  (new commit(s) pushed, or body edits).
- **Round k+1**: re-review **only the delta** since the last round
  (`git diff <previous-review-head>..<current-head>` or the new diff),
  plus a quick regression glance at previously-flagged findings: each
  BLOCKER is either fixed (say so) or still open (re-flag it).
- **Convergence**: stop when `APPROVED`. If the dialog stalls (same
  findings ignored for two rounds, or scope growing instead of shrinking),
  state the stall plainly and hand the decision back to the operator —
  do not keep looping silently, and do not lower the bar to end it.

## Tone

Review the change, not the person. Concrete over general: every finding
names the file/section it concerns and a suggestion the creator can act on
directly. Approve generously once the standard is met — the bar is the
three-section body and an honest diff, not perfection.
