---
name: write-code
description: >
  Language-independent coding standard for producing clean, well-tested,
  well-commented code in any programming language: consistent formatting
  and naming, small single-purpose units, explicit error handling, relevant
  why-comments, and unit tests covering at least 95% of functional code
  with meaningful assertions. Use when writing new code, refactoring, or
  reviewing whether produced code meets the house bar — applies to every
  language and runtime the agent touches.
---

# Writing Code

The rules below are language-independent: they apply whether the file is
TypeScript, Python, Go, shell, or anything else. Where a language has an
official formatter or style guide, it wins over taste — but never over the
test and comment requirements.

## Structure

- **Small, single-purpose units.** A function does one thing at one level
  of abstraction; if you need "and" to describe it, split it. As a guide:
  short functions (≤ ~40 lines), shallow nesting (≤ 3 levels), few
  parameters (≤ ~4; more → an options object or record).
- **Names carry the design.** Names say what a thing *is* or *does* in the
  problem's vocabulary — no `data`, `tmp`, `foo2`, no abbreviations that
  save two characters and cost a reader a minute. Consistent naming within
  a file; consistent vocabulary with the surrounding codebase.
- **No dead code, no commented-out code, no speculative generality.**
  Anything unreachable or unused is deleted, not parked. History lives in
  version control, not in the source.
- **Fail loudly and early.** Validate inputs at the boundary, return or
  raise errors instead of returning nulls/sentinels where the language
  offers better constructs, and never swallow an error silently. Every
  error path a caller can hit is either handled or declared.
- **Explicit over clever.** If a line needs a paragraph to explain the
  trick, prefer the boring version. Cleverness is justified only by a
  measured need, and then it must carry an explanatory comment.

## Formatting

- **Automate it.** Use the language's standard formatter and linter if
  configured in the repo; if none exists, match the file's existing style
  exactly (indentation, quoting, brace placement) — a diff must never
  contain formatting-only churn.
- **Consistent idioms**: same error style, same logging pattern, same
  test layout within a module. Mixed idioms in one file are a defect.
- **No noise**: no trailing whitespace, no blank-line soup, no import
  disorder (group and order per language convention), no commented-out
  requires/imports.

## Comments

- **Explain why, not what.** The code says what it does; a comment earns
  its place by saying *why* — the constraint, the tradeoff, the reason for
  a workaround, the invariant being protected. Delete what-is comments.
- **Comment at decision points**: workarounds (with the upstream
  issue/link if one exists), non-obvious algorithms, security or data-loss
  considerations, and public API contracts (docstrings/doc comments on
  every exported symbol).
- **Comments live with the code**: accurate, current, and updated in the
  same change that alters the code. A stale comment is worse than none —
  if editing code invalidates a comment, rewrite it in the same commit.
- **TODOs are actionable**: `TODO: <what> <why> <pointer>`, never bare.

## Tests — the house bar

- **Coverage: at least 95% of functional code** — statements and branches
  across the logic you produce or touch. Generated boilerplate, trivial
  accessors, and `main()` wiring are excluded from "functional"; anything
  containing decisions, transformations, or error paths is not.
- **Meaningful assertions, not coverage theater**: each test asserts a
  behavior someone could observe (output, state change, error raised), not
  that a line executed. One behavior per test; the test name states the
  behavior and the expectation.
- **Cover the edges the code promises to handle**: empty and oversize
  inputs, boundary values, error paths and failure injection, and at least
  one regression test for every bug fixed.
- **Tests are first-class code**: same formatting and naming standard,
  arrange-act-assert (or given-when-then) layout, no shared mutable state,
  deterministic (no sleeps, no real network/clock/filesystem where a
  language idiom provides a seam — inject or fake it).
- **Fast by default**: the unit suite for a change should run in seconds,
  so it actually gets run.
- **Verify, never assume**: run the tests before claiming they pass; a
  report without a run is unverified. If the environment truly cannot run
  them, say so explicitly and treat the claim as open.

## Working with existing code

- **Match the neighborhood**: in an existing file, its conventions win
  over this skill's defaults; improving a file means leaving it more
  consistent, not half-migrated to new rules.
- **Change the smallest surface that solves the problem**: no drive-by
  reformatting, no opportunistic rewrites of untouched logic.
- **Leave tests green and stronger than found**: every change ships with
  the tests that pin its behavior.
