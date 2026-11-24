---
name: apply-pull-request
description: >
  Creator-side mirror of the review dialog: takes the reviewer's last
  round of findings (severity-tagged BLOCKERs and SUGGESTIONs) and makes
  sure every still-active one is applied — or explicitly rebutted — before
  the next round of discussion with the reviewer. Unlike the reviewer, the
  creator DOES modify the artifacts: code, PR body, and follow-up commits
  on the PR branch. What it never touches: the review thread itself, the
  reviewer's comments, and any history rewriting that would hide prior
  rounds. Maintains a findings ledger so nothing is silently dropped, and
  regression-checks that earlier rounds' fixes survive later ones. Use
  when a review round came back with findings and the PR must be updated
  and sent back for the next round.
---

# Applying a Pull Request Review

Skill version: 1.0.0 (semver — matches tag skill-apply-pull-request-1.0.0)
Author: Didier Durand
Date: 2026-11-24


The creator half of the PR review dialog (the reviewer half issues the
verdicts described below — this skill is self-contained: the finding
format it consumes is embedded here). One rule governs everything: **no
finding from the last round still disappears into the next one.**

## Finding format (what a review round delivers)

Each round of review output is a structured list:

```text
PR <n> — review <round k>
Body:   PASS | FAIL (what's missing/misplaced)
Change: PASS | concerns below
Findings:
  [BLOCKER] <file/section> — <what + concrete suggestion>
  [SUGGESTION] <file/section> — <what + concrete suggestion>
Verdict: CHANGES REQUESTED | APPROVED
```

- `BLOCKER` — must be fixed before the PR can be approved.
- `SUGGESTION` — apply it, or rebut it with a stated reason; silently
  ignoring it is forbidden.
- `Verdict: APPROVED` ends the dialog — nothing to apply; acknowledge and
  stop.

## Hard constraints — never violated

- **Modify your own artifacts, never the review record.** You may edit
  code, the PR body, and push follow-up commits to the PR branch. You may
  not edit or delete the reviewer's comments or reviews, resolve their
  threads as if they agreed, rewrite history to hide prior rounds
  (no force-push of reviewed commits — add commits on top), or merge the
  PR yourself.
- **The reviewer reviews; you apply.** Do not pre-empt the next round by
  re-reviewing your own fixes and declaring the dialog over — the reviewer
  issues the verdicts, you produce the revisions.
- **The operator arbitrates deadlocks.** If a BLOCKER cannot be fixed
  (conflicting requirement, upstream bug, genuine disagreement with the
  reviewer), do not fake a fix and do not stall — surface the deadlock to
  the operator with both positions stated.

## The findings ledger

Maintain a ledger across rounds — every finding ever received, with:

```text
| id  | round | severity  | file/section | finding        | status            | response                |
| F3  | 2     | BLOCKER   | src/auth.ts  | missing input check | fixed (a1b2c3d) | commit message        |
| F5  | 2     | SUGGESTION| README       | clarify flag   | rebutted          | <reason>                |
```

Statuses: `open` → `fixed` (commit reference) → or `rebutted` (reason).
A finding that was `rebutted` in round k and re-raised by the reviewer in
round k+1 becomes a BLOCKER in the ledger — a repeated disagreement is
not a style discussion, it goes to the operator.

## The workflow

1. **Parse the last round** into the ledger. Findings from earlier rounds
   that are still `open` are carried into this round's scope — the last
   round is the trigger, not the boundary of your obligations.
2. **Apply, in severity order** — BLOCKERs first, then SUGGESTIONS:
   - **Fixed**: make the change the finding asks for (or a better one
     that demonstrably solves it), as clean follow-up commits; note the
     commit in the ledger.
   - **Rebutted**: only with a concrete reason the reviewer can act on
     ("this conflicts with REQ-3", "the alternative costs X for Y") —
     "as designed" or "works for me" are not rebuttals.
3. **Regression check before sending back**: verify that every finding
   marked `fixed` in *earlier* rounds still holds in the current state —
   later fixes must not undo earlier ones.
4. **Body check**: if the review said `Body: FAIL`, update the PR body to
   the standard (Summary / Evidence / Merge Danger) in the same pass.
5. **Close the round** — report per finding, on the dialog channel:

   ```text
   PR <n> — response to review <round k>
   [BLOCKER] F3 src/auth.ts — fixed in a1b2c3d (input validated, test added)
   [SUGGESTION] F5 README — fixed in a1b2c3d
   [SUGGESTION] F6 docs — rebutted: conflicts with REQ-3 (details)
   All round-k findings addressed — ready for review <round k+1>.
   ```

   - **GitHub-origin PR**: post as a PR comment (`gh pr comment <n>
     --body "<response>"`) and mark the reviewer mentally ready — never
     use `gh pr review` yourself (that verb belongs to the reviewer).
   - **Local / non-GitHub origin**: deliver the same response directly to
     the reviewer's channel.
6. **Every finding addressed = ready for the next round.** The state
   "some findings quietly unaddressed, re-review requested anyway" is the
   one outcome this skill exists to prevent.
