# vuln-to-pr — dataset of vulnerability-introducing pull requests

> Source: LinkedIn post by **Hedi Sfaxi** (Konvu), November 2025:
> <https://lnkd.in/p/egqtFWYk>
> Artifacts repository (verified): **<https://github.com/KonvuInc/ci-security-review-bench>**
> (dataset named `vuln-to-pr-v1`; harness MIT-licensed, upstream code
> keeps its own licenses — see the repo's NOTICE).

## What it is

The author is building an AI security reviewer for CI at Konvu
("basically Greptile for security") and hit an evaluation wall: there was
no consistent dataset connecting pull requests to the vulnerabilities
they introduced, so there was no way to measure whether a review agent
actually catches vulnerabilities. So they built one — and open-sourced
the benchmark.

## The dataset (`vuln-to-pr-v1`)

- **321 annotated PRs**: 107 vulnerable + 214 controls.
- Traces **118 published security advisories** (June–November 2026) to
  the PRs that first introduced each vulnerability, across **28 real
  projects** (Payload, Outline, Plane, Discourse, Keycloak, Vaultwarden,
  Ghost, Traefik, …).
- Median PR: 11 files, ~316 added/deleted lines.
- **Controls**: audited-security-control PRs from the same projects —
  the reviewer must stay silent on them (false-alert measurement without
  a model call).
- The open **preview** contains 5 vulnerable PRs + 20 controls; the full
  dataset is the authors'.
- Annotation pipeline (documented in `docs/vuln-to-pr-v1.md`): extract
  advisories → derive candidate commits → resolve introducing PRs →
  independent dual-LLM verification → human verification.

## The eval harness

- **Vulnerable PR**: a judge model checks whether the reviewer's finding
  matches the advisory → reports **PR recall** and **advisory-matched
  precision**.
- **Control PRs**: any finding counts as a false alert.
- Also tracks reviewer **cost** and **median/p95 review time**;
  incomplete reviews do not pass. Run via `./bench judge` and
  `./bench score`.
- Extensible: an `add-reviewer` skill (Dockerfile + adapter, with agent
  and semgrep examples) integrates new reviewers into the harness.

## Why it matters for an agent fleet

- **Measurement over vibes**: a ready-made precision/recall benchmark for
  security review — directly applicable to evaluating `pi-review-*`
  agents on vulnerability detection.
- **The advisory→PR trace is the valuable part**: introducing-PR ground
  truth enables false-negative measurement (the reviewer should have
  flagged PR X — did it?), which self-reported reviews cannot give.
- **Extension path for private code**: the annotation pipeline doubles as
  a recipe for adding the fleet's own historical vulnerable PRs, turning
  the public benchmark into a private regression suite for security
  review.
- **False-alert discipline**: the control-PR mechanism measures noise, a
  frequent failure mode of security reviewers.

## Caveats

- Origin is a social post + self-published benchmark: no peer review;
  numbers are self-reported (though the annotation pipeline is documented
  and dual-verified).
- The fully open part is the preview subset + harness; the full dataset
  is not stated to be public.
- Post numbers ("300+ PRs") differ slightly from the repo (321 PRs, 107
  vulnerable) — the repo is the authoritative source.
