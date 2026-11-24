---
name: write-specifications
description: >
  Defines the main points of a good specification: a problem statement
  with context, explicit scope and non-goals, numbered and verifiable
  functional requirements, constraints and assumptions, measurable
  acceptance criteria, and a home for open questions — behavior only, no
  implementation design. Use when the user asks to write, draft, improve,
  or review a specification, requirements document, or feature brief.
---

# Specifications

A specification answers **what must be built and why** — not how. It is
the contract that requirements, plans, and reviews are all measured
against; ambiguity here multiplies into rework everywhere else.

## The required sections

1. **Problem statement** — what is wrong today, for whom, and why it
   matters now. One short paragraph; if the problem cannot be stated in
   two sentences, it is not understood yet.
2. **Scope** — explicitly two lists: *In scope* and **Non-goals** (what
   this spec deliberately does not cover). Non-goals prevent scope creep
   better than any other device in the document.
3. **Functional requirements** — numbered (`REQ-1`, `REQ-2`, …), each one
   a single verifiable statement of observable behavior. Use RFC-2119
   strength words (MUST / SHOULD / MAY) and use them consistently.
4. **Constraints & assumptions** — platform, performance, security,
   compatibility, regulatory limits the solution must live within;
   assumptions that, if wrong, change the spec.
5. **Acceptance criteria** — measurable, per requirement or per feature:
   the exact check (test, scenario, measurement) that proves each
   requirement is met. If an acceptance criterion cannot be written, the
   requirement is not yet well-defined.
6. **Open questions** — every unresolved decision, with owner and
   deadline. A spec with silent unknowns is a lie; a spec with listed
   unknowns is a plan.
7. **Glossary** — domain terms used with a precise meaning. One definition
   per term; terms are then used *only* with that meaning.
8. **External references** — every requirement or constraint that derives
   from an external document (an RFC, an API contract, a product spec, a
   standard, an issue thread) MUST cite that document: title and stable
   link, plus the section/version the requirement comes from. The spec
   then references the source instead of restating it — the source stays
   authoritative, the citation keeps the derivation checkable, and later
   readers (implementers, reviewers, auditors) can trace each requirement
   back to its origin without asking. If the source is versioned or may
   change, pin the exact version or anchor; a link that will silently
   point elsewhere is not a reference, it is a future bug.

## What makes a requirement good

- **Verifiable**: "the system MUST return results within 500 ms" — check.
  "the system MUST be fast" — not checkable, reject or sharpen it.
- **Atomic**: one behavior per requirement. Two MUSTs in one sentence can
  pass while half of it is broken.
- **Implementation-free**: no file names, no class designs, no API shapes
  unless the API *is* the deliverable. Design belongs to the
  implementation plan, not here.
- **Unambiguous pronoun-free**: "it", "the system", "the user" resolve to
  one named actor or component — name it every time.
- **Necessary**: if removing the requirement changes nothing observable,
  it does not belong in the spec.

## The specification process is iterative

Writing the spec is not one pass: draft, then self-review, then repeat
until the draft actually satisfies the process. Before returning anything
to the requester:

- **Self-review against the process** — check the draft against every
  requirement of this skill: are all required sections present, every
  `REQ-n` verifiable and atomic, every acceptance criterion actually
  writable, every non-goal stated, every external source cited, every
  glossary term used consistently? Whatever fails, fix the draft — then
  re-review. Iterate until the draft passes its own standard.
- **Unstated gaps are failures** — if something cannot be nailed down
  (a decision not yet made, a constraint unknown, a requirement not
  verifiable today), the spec MUST surface it as an explicit gap with its
  impact and owner. A gap that is documented is manageable; a gap that is
  omitted is a bug planted in the process downstream.

## Rules of engagement

- **Single source of truth**: the spec is where requirements live. When
  reality changes the requirements, change the spec first — plans, code,
  and tests follow it, never the reverse. Mark each approved requirement
  as such (owner + date) and keep a short change log at the bottom.
- **Review before build**: a spec is done when the requester confirms the
  acceptance criteria are what "done" means — not when the document is
  written. Circulating for that confirmation is part of writing it.
- **Precision over volume**: a one-page spec with ten sharp requirements
  beats a ten-page spec of hedges. Every sentence either constrains the
  solution or helps verify it — otherwise cut it.

## Versioning: tag every committed revision

Every commit that changes the specification document MUST be tagged in
the repo, so any agent or reader can pin a requirements baseline:

- **Tag name**: `specs-<x.y.z>` — independent of the implementation
  plan's tags and of the repo's release tags.
- **Version bump**: find the latest existing tag
  (`git tag -l 'specs-*' | sort -V | tail -1`) and increment the patch
  number; start at `specs-0.1.0` when none exists. Bump the **minor**
  version instead when the revision changes requirements substantively
  (added/removed `REQ-n`, changed acceptance criteria) — patch is for
  editorial fixes only.
- **Annotated tag**, one-line message summarizing the revision, placed on
  the exact commit that updates the document.
- **Push the tag with the commit** (`git push origin <tag>`): a tag that
  exists only locally is invisible to the rest of the fleet and does not
  count. If the push is rejected because the tag already exists, do not
  force-push — increment and retry.
- **Never retag or delete** an existing `specs-*` tag: the version history
  of the requirements is history.
