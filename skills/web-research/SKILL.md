---
name: web-research
description: >
  Best practices for web research: keeping traceability of the source behind
  every piece of extracted content, cross-checking the same fact across
  multiple high-reputation sites, surfacing contradictions with a reasoned
  recommendation of which version to select, and spell-checking extracted
  content with domain-jargon tolerance and consistent regional spelling
  (French over Canadian French, US over UK English, etc.). Use when the task
  involves researching the web, collecting facts from multiple sites,
  compiling a fact base, or preparing verified content — alone or as the
  research stage before publishing-best-practices.
---

# Web Research

Pipeline: Trace → Cross-check → Reconcile → Spell-check. Every extracted
fact must be traceable, corroborated where possible, contradiction-checked,
and typo-free — in that order.

## 1. Traceability: every piece of content carries its source

Maintain a **source ledger** from the first extraction — a per-fact map,
built incrementally (never reconstructed afterwards):

```markdown
| # | Fact / content piece | Source name | URL | Date accessed |
|---|---|---|---|---|
| 1 | Pod restart policy default: Always | Kubernetes docs | https://kubernetes.io/docs/... | 2026-11-22 |
| 2 | Node 24 is current LTS | Node.js release schedule | https://nodejs.org/... | 2026-11-22 |
```

Rules:
- **No orphan content**: if a sentence in your final output can't be pointed
  to a ledger row, it's either common knowledge (state that) or must be
  deleted/sourced.
- Quote exactly when extracting; paraphrase only at writing time, keeping
  the ledger row attached.
- One URL per row — when a page feeds several facts, one row per fact, not
  one row per page.
- Keep the ledger in the deliverable (or as an annex) — the consumer must be
  able to audit any claim to its origin.

## 2. Cross-check across multiple high-reputation sites

For every **load-bearing fact** (numbers, dates, versions, claims that drive
conclusions), corroborate across **≥ 2 independent sites** — ideally 3.

Reputation hierarchy (consult top-down):

1. **Primary/official**: vendor docs, standards bodies, official release
   notes, regulator publications, original papers
2. **High-reputation secondary**: established reference outlets (e.g.
   Britannica-class encyclopedias), major technical publishers, top-tier
   press with editorial review
3. **Practitioner sources**: reputable blogs, known-expert posts — usable,
   but never the sole corroboration for a hard fact
4. **Aggregators/forums** (HN, Reddit, Q&A): signal and leads only — never
   corroborating sources

Cross-check rules:
- **Independence matters**: two sites citing the same press release are ONE
  source, not two. Trace to the underlying origin when possible.
- Prefer cross-checking at the **primary level**: if site B only quotes
  site A, find the primary source A cites and verify there.
- Dates and numbers must match **exactly** — "roughly the same number" is
  not a corroboration; investigate the discrepancy instead (§3).
- If corroboration is impossible (niche, very recent, or paywalled facts),
  say so explicitly in the output: "single-sourced: <source>" — and lower
  the claim's assertiveness accordingly.

## 3. Contradictions: surface, explain, recommend

When sources disagree, **never average, never silently pick**:

1. **Surface** — present the contradiction explicitly in the output:
   ```markdown
   > ⚠️ Contradiction: max output tokens for GLM-5.3-flash
   > - Source A (OpenRouter catalog, https://...): 131,072
   > - Source B (vendor blog, https://...): "up to 128K"
   ```
2. **Explain** the likely cause before recommending: publication dates
   (stale vs fresh), rounding ("up to 128K" ≈ 131,072), scope difference
   (different product tier/test conditions), transcription error.
3. **Recommend one and justify** the selection in one or two sentences.
   Tie-breakers, in order:
   - **Primary > secondary** (vendor over press)
   - **More precise > more vague** (131,072 > "about 128K" — vagueness is
     usually rounding of the precise figure)
   - **More recent > older** (for fast-moving subjects, with the date noted)
   - **Consistent with the majority of independent sources** (count real
     independence, not citations of the same origin)
   - **Internal coherence**: the version that agrees with the rest of the
     verified corpus wins over an isolated outlier
4. Mark the selected fact as the one used downstream; keep the rejected
   version in the ledger with the reason — the reader can audit the call.

## 4. Spell-check the extracted content

Run a spelling pass on ALL extracted/quoted text (ledger, notes, and final
prose) before delivery:

- **Tool-assisted pass**: use whatever is available (aspell/hunspell with the
  right language dictionary; in agents without tooling, a careful read pass
  focusing on proper nouns, numbers, and technical tokens).
- **Jargon tolerance**: build a per-topic allow-list BEFORE the pass and
  accept its words as correct — do not "fix" legitimate domain vocabulary.
  Collect jargon from the sources themselves (product names, protocol
  names, framework terms): e.g. Kubernetes → `Pod`, `etcd`, `kubectl`,
  `ConfigMap`; AI → `LoRA`, `RAG`, `tokenizer`, `inference`. A flag on a
  jargon word is a false positive; add to the allow-list, not to the text.
- **Proper nouns are never corrected on sight**: vendor names (OpenRouter,
  PostgreSQL), people, places — verify spelling against the source page,
  not against intuition.
- **Protect invariant strings**: URLs, code, commands, versions, file paths,
  identifiers (`gpt-5.3-flash`), and quoted text are exempt — spelling
  inside them must stay EXACTLY as extracted.
- Report each correction in a change list (before → after → which rule), so
  the user can audit the pass.

## 5. Regional spelling and dialect consistency

Pick ONE regional norm per document and enforce it; the default preference
order is **French over Canadian French**, **US over UK English** — unless
the user or target audience dictates otherwise:

| Norm | Prefer | Over |
|---|---|---|
| French (France) | `base de données`, `courriel`→*only if FR norm*, `logiciel`, `mendier` | Canadian French variants (`fin de semaine`, `-eur/-euse` job titles, English borrowings common in CA) |
| US English | `database`, `organization`, `color`, `program` | UK: `organisation`, `colour`, `programme` (except TV), `centre` |

- French specifics: prefer Académie-français-aligned forms; for technical
  vocabulary keep the accepted French term when one exists (`logiciel`,
  `cadriciel` is CA — prefer `framework` in FR-FR tech writing), keep
  anglicisms when they are the de-facto technical term.
- **One norm per document — no mixing**: a draft that says both
  `organization` and `organisation` has failed this check.
- When quoting: the QUOTE keeps its original spelling (never regionalize a
  quotation); regional consistency applies to your own prose only.
- Note the chosen norm at the top of the deliverable (e.g. "US English,
  French FR"), so reviewers know the reference.

## Quick reference — the non-negotiables

1. Source ledger first: every content piece → one row (name, URL, date).
2. ≥ 2 independent high-reputation sources per load-bearing fact; primary
   level preferred; single-sourced facts labeled as such.
3. Contradictions surfaced verbatim, cause explained, one selection
   recommended with tie-breaker reasoning.
4. Spell-check with a jargon allow-list; invariant strings untouched;
   corrections reported.
5. One regional norm per document (defaults: French-FR over CA, US over
   UK), quotes exempt.
