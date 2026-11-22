---
name: publishing-best-practices
description: >
  Best practices for preparing content intended for publishing (blog posts,
  articles, newsletters, documentation, LinkedIn/Medium posts): research the
  web first, extract and verify key points, attribute every claim, and finish
  with a Sources section (short page description + URL per source). Use when
  the user asks to write, draft, prepare, or improve content for publication,
  or asks for research-backed writing.
---

# Publishing Best Practices

Follow the pipeline in order: Research → Extract → Draft → Attribute →
Sources → Review. The non-negotiables: nothing factual without a source,
no source without a URL, every claim traceable.

## 1. Research the web first

- **Never draft from memory alone** — even topics you "know" change. Search
  before writing.
- Use the available web tools (WebSearch, WebFetch, or `curl` for public
  APIs/pages). If NO web access is available in this session, **say so
  explicitly and stop**: memory-only content must be labeled as unverified —
  never present it as researched.
- Cast a wide net before narrowing:
  1. Official/primary sources first (vendor docs, standards, release notes,
     official blogs, papers).
  2. Authoritative secondary sources (reputable tech press, established
     blogs of practitioners, books).
  3. Community signal (HN/Reddit threads) — for sentiment and edge cases,
     NOT as factual authority; verify anything extracted from them.
- **Favor recency for fast-moving topics** (AI, cloud, frameworks): prefer
  pages from the last 12 months; note publication dates. A 2019 tutorial
  about a current tool is a liability, not a source.
- Cross-check every load-bearing fact against **at least two independent
  sources**. If sources disagree, say so in the draft ("Source A reports X,
  Source B reports Y") — don't silently pick one.
- Log every URL the moment you open it (see §4) — retroactive source
  hunting is how citations get lost.

## 2. Extract key points (research notes)

Before writing prose, build a notes layer — it keeps the draft honest and
gives the user an audit trail:

- For each source, capture:
  - **Key points**: the 2–5 claims/data/arguments actually usable
  - **Quotes worth citing** (verbatim, short, with surrounding context)
  - **Data**: numbers, versions, dates, benchmarks — copy them EXACTLY
- Tag each note with the source it came from; an unsourced note is a draft
  opinion, and must be either verified or dropped.
- Distinguish fact types — they carry different obligations:
  | Type | Obligation |
  |---|---|
  | Hard fact (number, date, version) | Source + exact copy, verify twice |
  | Claim/position (someone's argument) | Attribute to who said it |
  | Common knowledge (git exists) | No citation needed |
  | Your synthesis/opinion | Label as interpretation; no fake attribution |
- Prune: keep only points that serve the piece's thesis. A pile of
  everything-you-found is not research, it's a bookmark dump.
- Show the user the key-points list BEFORE writing the full draft when the
  topic is substantial — cheap course-correction beats expensive rewrite.

## 3. Draft the content

- **Structure before prose**: hook → context → core points (each backed by
  notes) → caveats/limits → takeaway. One idea per paragraph.
- Front-load the value: readers decide in the first two sentences whether to
  continue.
- Concrete over abstract: real numbers, versions, commands, and examples from
  the research beat vague generalities.
- **Distinguish voices clearly**:
  - Established fact: state plainly, cite (§4)
  - Your interpretation: "this suggests…", "in my experience…"
  - Speculation: label it explicitly or cut it
- Respect the target format and house style if the user gave one (length,
  tone, platform conventions: LinkedIn ≠ blog ≠ docs).
- Match the user's language; keep technical terms in their usual form.

## 4. Attribution and honesty

- **Attribute every non-obvious claim** to its source (inline mention of the
  source name is fine; the URL goes in Sources, §5).
- Quote sparingly and exactly — quote marks mean VERBATIM; paraphrase
  everything else in your own words.
- Never present someone else's analysis as your own; "according to <source>,
  …" is the minimum.
- Uncertainty stays visible: "as of <date>", "reported by <source>",
  "not yet independently confirmed".
- If a fact couldn't be verified, either cut it or flag it inline
  (e.g. "[unverified]") — never launder a guess into confident prose.

## 5. Sources section (mandatory)

End EVERY researched piece with a `## Sources` section:

- One entry per source actually used to produce the content (not every page
  opened — every page that contributed a key point, quote, or figure).
- Format: **short description of the page + its URL**:

  ```markdown
  ## Sources

  - Official Kubernetes documentation: pod lifecycle and restart policies —
    https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
  - OpenAI release notes, GPT-5 announcement (2025-08-07) —
    https://openai.com/index/.../
  - Hacker News discussion with practitioner feedback on X —
    https://news.ycombinator.com/item?id=...
  ```

- Description rules: 5–15 words saying WHAT the page is (not its title
  copy-pasted); include the author/site when meaningful; include the
  publication date when the topic is time-sensitive.
- Order sources by weight in the piece (most influential first), or group
  primary/secondary if there are many.
- **Validate URLs before finalizing**: re-fetch or at least re-check each one
  — a dead or wrong-link citation is worse than none.
- Paywalled pages: cite them anyway, note "(paywalled)".

## 6. Review pass before delivery

Run this checklist on the finished draft and fix violations:

- [ ] Every factual claim traceable to a source in the Sources list
- [ ] Numbers/dates/versions copied exactly, not from memory
- [ ] Opinions labeled as opinions; speculation cut or flagged
- [ ] Sources section present: description + URL per entry, URLs valid
- [ ] No leftover research-note scaffolding in the prose
- [ ] Format matches the target (length, tone, language, platform)
- [ ] Read it once end-to-end as a reader, not an author — cut the first
      paragraph if the piece only gets good after it

## Quick reference — the non-negotiables

1. Web research FIRST; no web access → say so, don't fake it.
2. Every key point tagged to a source during extraction.
3. Two independent sources for load-bearing facts; disagreements surfaced.
4. Voices separated: fact / attribution / interpretation / speculation.
5. `## Sources` section: short description + URL per source, URLs validated.
6. Final review pass against the checklist before delivery.
