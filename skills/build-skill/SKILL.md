---
name: build-skill
description: >
  Guide for building new Pi agent skills (SKILL.md packages) with high
  engineering quality: portable across macOS/Linux (Windows when possible),
  brief yet complete, accurate in method, consistent in results, efficient in
  execution, and fluent in step coordination. Use when the user asks to
  create, build, write, improve, review, or refactor a skill — or says
  "make/build a skill for X".
---

# Build a Skill

**STRICT REQUIREMENT — SKILL.md standard conformance:** every skill produced
under this guide MUST conform to the [Agent Skills specification](https://agentskills.io/specification)
(a directory whose `SKILL.md` starts with valid frontmatter — `name:`,
`description:` — followed by instructions). Non-negotiable: no free-form
markdown files, no missing/invalid frontmatter, no renamed entry files.
Conformance is checked FIRST (§6 step 2) and a non-conforming skill is not
delivered. Pi accepts some deviations with warnings — do not rely on that;
build to the standard, not to the tolerance.

Skills are instruction packages, not applications. The deliverable is a
directory with a `SKILL.md` (frontmatter + instructions) and, only when
needed, supporting files. Build in this order: scope → portability → draft →
test → review → install.

## 1. Scope before writing

Answer these first (ask the user if ambiguous — one round, then proceed):

1. **Trigger**: what user words/tasks should load this skill?
2. **Outcome**: what does "done" look like, observably?
3. **Context**: which OS/tooling must it work on (defaults: macOS + Linux)?
4. **Existing coverage**: check the skills directory — extend or reference an
   existing skill instead of duplicating it.

**Brevity rule**: every sentence must either change behavior or prevent a
failure. If removing a sentence changes nothing, delete it. BUT: brevity
never costs completeness — every step the agent cannot infer, every failure
mode that would be silent, every decision the user must make: those stay.
Write instructions, not prose: tables > paragraphs, lists > narration,
exact commands > descriptions of commands.

## 2. Structure

```text
<skill-name>/
├── SKILL.md          # frontmatter + instructions (the contract)
├── scripts/          # ONLY if logic is reusable or too fiddly for inline bash
└── references/       # ONLY if large reference material must stay out of SKILL.md
```

Frontmatter — the two fields that matter most:

```yaml
---
name: <skill-name>            # kebab-case, verb-friendly (build-skill, not builder)
description: >
  <what it does> + <when to load it>. The description IS the router: list the
  concrete trigger words and tasks. "Use when the user asks to ..." — a vague
  description means the skill never loads when needed.
---
```

Rules:
- `SKILL.md` is self-contained: the agent should succeed with it alone.
  Supporting files are for bulk (long references, multi-use scripts) — never
  split one logical instruction across files.
- Use relative paths (`scripts/x.sh`) — Pi resolves them against the skill
  directory. Never absolute paths, never `~` assumptions.
- Keep `SKILL.md` under ~150 lines. If longer, the skill is doing several
  jobs — split it.

## 3. Portability (macOS, Linux, Windows)

The skill must not assume one platform. Inventory these five surfaces:

| Surface | macOS | Linux | Windows |
|---|---|---|---|
| Shell for scripts | bash 3.2 (!) | bash 5.x | Git Bash / WSL bash 5.x |
| `stat` mtime | `stat -f %m` | `stat -c %Y` | Git Bash: GNU `stat -c %Y` |
| `sed -i` | needs `-i ''` | `-i` alone | GNU: `-i` |
| Paths | `/Users/...`, `$HOME` | `$HOME`, XDG | `%APPDATA%`, `$HOME` under WSL/GitBash |
| Default tools | BSD coreutils | GNU coreutils | varies; assume Git Bash |

Portable-by-construction rules:

- **Prefer POSIX + common tools**: `grep`, `awk` on simple fields, `find`,
  `sort`, `cut`. Avoid GNU-only flags (`grep -P`, `sed -E` is fine, `xargs -r`
  is NOT portable, `stat` differs — detect or use alternatives like
  `date -r file +%s` on macOS).
- **No bash 4+ features**: no associative arrays (`declare -A`), no
  `${var,,}`, no `mapfile`/`readarray`. macOS ships bash 3.2. Test-safe
  subset: plain arrays, `${var//pattern/rep}`, `[[ ]]`, `local`, functions,
  `printf`.
- **OS detection once, used everywhere**:
  ```bash
  case "$(uname -s)" in
    Darwin) ... ;; Linux) ... ;;
    MINGW*|MSYS*|CYGWIN*) ... ;;   # Git Bash / MSYS on Windows
    *) echo "unsupported platform" >&2; exit 1 ;;
  esac
  ```
- **Windows**: target Git Bash / WSL (bash-compatible) — document any extra
  setup; if a step is genuinely impossible on Windows, say so in SKILL.md
  instead of letting it fail mysteriously. `uname -s` in Git Bash starts
  with MINGW — the case above catches it.
- **Never** rely on: GNU-specific long options, `/proc`, `systemd`, `open`
  without a fallback, clipboard tools (`pbcopy`/`xclip`) without detection.
- If a helper script must be portable, make the FIRST run a capability check
  (tools present? expected outputs sane?) and fail loudly with a one-line fix
  hint, not a stack trace.

## 4. The four quality axes (bake into every draft)

| Axis | Design question | Practical rule |
|---|---|---|
| **Accuracy** | Is the method the RIGHT one, not just a working one? | Prefer the canonical tool/technique for the job (documented API over scraped page, `gh` over raw REST, idempotent commands over clever ones). Cite the canonical command exactly; verify flags exist on all target platforms. |
| **Consistency** | Will it produce the same result next month? | Pin everything the skill depends on: paths relative to the skill dir, no reliance on CWD, no reliance on ambient state it doesn't check first. Idempotent steps (re-running is safe). Pre-flight checks (§5) turn environment drift into loud errors, not silent wrongness. |
| **Efficiency** | Minimal wasted motion? | No redundant re-reads of files already read; one pre-flight pass, not per-step re-checks; fail fast at step 1 rather than after 10 steps; direct commands over wrappers. Don't add steps for hypothetical cases — handle the real 95%, document the rest. |
| **Fluency & coordination** | Do the steps flow in sync, hand to hand? | Explicit sequencing: what runs BEFORE what, what depends on what, what runs in parallel. Every step's output feeds the next step's input NAMED (e.g. "save the ID from step 2 — step 4 needs it"). Interruption-safe: each step leaves state that a re-run can pick up. |

When drafting, walk the draft step by step and ask the four questions above;
each step should have an answer for all four or be deleted/merged.

## 5. Required sections (inventory)

A complete skill SKILL.md contains, in this order:

1. **Frontmatter** (name, description with triggers)
2. **Pre-flight** — environment checks with a decision table: check → status → action (never "check and hope")
3. **The procedure** — numbered steps, each with its exact commands and its expected outcome; failure actions inline (what to do when step N fails)
4. **Conventions/rules** — the short list of non-negotiables (the agent must not have to guess)
5. **Quick reference** — the non-negotiables compressed to one glanceable list at the END (mirrors and reinforces §4)

Omit a section only by conscious decision — "N/A because ..." — not by oversight.

## 6. Test before delivering

Skills ship only after a smoke test. Minimum:

1. **Syntax**: `bash -n scripts/*.sh` (if any scripts).
2. **SKILL.md standard conformance** (see the STRICT REQUIREMENT at the top):
   valid frontmatter with at least `name:` and `description:` as the very
   first block, name matching the directory in kebab-case, instructions
   following the frontmatter. Non-conforming = not delivered.
3. **Dry-run the steps by hand**: execute the procedure in a sandbox
   directory; every command must work AS WRITTEN (copy-paste fidelity) on at
   least macOS or Linux.
4. **Failure paths**: deliberately break one precondition (missing tool,
   wrong dir); the skill must fail LOUDLY with an actionable message, not
   silently do the wrong thing.
5. **Idempotence**: run the procedure twice; the second run must not corrupt
   state.
6. Report to the user: what was tested, on which platform(s), what was NOT
   tested (e.g. Windows untested).

## 7. Review checklist (for new or refactored skills)

- [ ] Conforms to the SKILL.md / Agent Skills standard (valid frontmatter, kebab-case name matching the directory)
- [ ] Description routes: contains "Use when ..." with concrete triggers
- [ ] Self-contained: succeeds with SKILL.md alone; relative paths only
- [ ] Portable: no bash 4+ features, `stat`/`sed -i`/paths handled per §3, OS case-statement if platform branching exists
- [ ] Brief: no sentence without behavioral effect; tables/lists over prose
- [ ] Complete: all five required sections present or consciously marked N/A
- [ ] Accurate: canonical methods; commands verified against target platforms
- [ ] Consistent: idempotent steps; explicit pre-flight; no CWD/ambient-state reliance
- [ ] Efficient: fail-fast; no redundant checks; no speculative steps
- [ ] Fluent: step dependencies named; outputs feed named inputs; re-runnable
- [ ] Tested: smoke-tested as written, failure path exercised, platform coverage stated

## Quick reference — the non-negotiables

1. Scope first: trigger, outcome, platform, existing coverage.
2. Router description ("Use when ...") or the skill will never load.
3. Portable: POSIX-safe subset, no bash 4+, per-platform quirks handled, Git Bash supported.
4. Brief but complete: every sentence changes behavior; every inferable step cut, every silent-failure mode covered.
5. Accuracy / Consistency / Efficiency / Fluency answered for every step.
6. All five sections present; smoke-tested as written before delivery.
