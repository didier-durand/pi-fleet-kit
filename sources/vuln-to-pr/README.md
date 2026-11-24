# vuln-to-pr — dataset of vulnerability-introducing pull requests

> Summary of a LinkedIn post by **Hedi Sfaxi** (November 2025):
> <https://lnkd.in/p/egqtFWYk>
> Status: practitioner's post announcing a dataset + eval harness — not a
> peer-reviewed paper. Links to the dataset were placed in the first
> comment of the post, which is not reproduced here.

## What it is

The author is building an AI security reviewer ("basically Greptile for
security") and hit an evaluation wall: there was no consistent dataset
connecting pull requests to the vulnerabilities they introduced, so there
was no way to measure whether a review agent actually catches
vulnerabilities. So they built one.

## Key facts

- **300+ annotated pull requests** from both modern and legacy open-source
  projects.
- Traces **118 security advisories** back to the PRs that first introduced
  each vulnerability — i.e., ground truth "this PR is where the bug got
  in", not just "this repo once had a CVE".
- A **small subset of the dataset is open-sourced**, together with an
  **eval harness** that measures a review agent's precision and recall on
  vulnerability detection.
- Designed to be **extended with known vulnerabilities from your own
  codebase** — the intended workflow is to specialize the benchmark with
  the vulnerability patterns that matter to you.

## Why it matters for an agent fleet

- **Measurement over vibes.** Any "reviewer catches vulnerabilities"
  claim needs a labeled benchmark; this is a ready-made starting point for
  precision/recall evaluation of `pi-review-*` agents.
- **The advisory→PR trace is the valuable part.** Introducing-commit
  ground truth is what makes false-negative measurement possible (the
  reviewer should have flagged PR X; did it?).
- **Extension path for private code.** Adding the fleet's own historical
  vulnerable PRs turns a public benchmark into a private regression suite
  for security review skills.

## Caveats

- Source is a social post: no formal paper, no peer review, dataset size
  and annotation quality are self-reported.
- The open-sourced subset is described as "small"; the full 300+ PR
  dataset is not stated to be public.
- Access the post's first comment for the actual dataset/harness links.
