---
name: github-best-practices
description: >
  Inventory of best practices for working with GitHub (and git) as an agent:
  environment checks, authentication, branch/commit/PR workflow, issues and
  reviews, secret hygiene, and CI awareness. Use when creating commits,
  push or PR workflows, version tagging, reviewing code, managing issues,
  or before any GitHub operation that might fail silently (auth, identity,
  remote access).
---

# GitHub Best Practices for Agents

Work through the sections in order: verify the environment FIRST (sections 1–2),
then follow the workflow guidance. Never skip the pre-flight checks — most
"silent" agent failures on GitHub are auth or identity problems.

## 1. Pre-flight: verify the environment before anything else

Run these checks once per session, before the first GitHub operation:

```bash
# Identity: commits need a name and email
git config --global user.name  # must be non-empty
git config --global user.email # must be non-empty

# Auth: gh CLI ready? (prints the account if OK)
gh auth status

# Auth: token present for git-over-HTTPS and API calls
[[ -n "${GITHUB_TOKEN:-}" ]] && echo "GITHUB_TOKEN set" || echo "GITHUB_TOKEN MISSING"
```

Decision table:

| Check | Status | Action |
|---|---|---|
| `user.name`/`user.email` | empty | Set them from context if known; otherwise ASK the user — never invent an identity |
| `gh auth status` | fails | Fall back to `GITHUB_TOKEN` (see §2); if neither works, stop and report |
| `GITHUB_TOKEN` | missing | Use `gh` OAuth if logged in; otherwise ask the user |
| remote uses SSH (`git@github.com:`) | but no SSH key | Switch the remote to HTTPS (`git remote set-url origin https://github.com/OWNER/REPO.git`) |

## 2. Authentication rules

- **Prefer `gh` for API operations** (`gh api`, `gh pr`, `gh issue`) — it picks
  up auth automatically and handles pagination and errors.
- **`GITHUB_TOKEN` never goes into URLs, files, command output, or commit
  messages.** It may only flow through the credential helper or env vars.
- If a push fails with 403: check token **scopes** (`repo` for private repos,
  `workflow` to push `.github/workflows/` changes). Report exactly which scope
  is missing — don't retry blindly.
- Tokens in `git remote -v` output (embedded `https://TOKEN@github.com/...`)
  are a hygiene violation — fix with `git remote set-url origin <clean-url>`.
- For fine-grained PATs: repository access must include the target repo;
  "Contents: read/write" covers pushes, "Pull requests: read/write" covers PRs.

## 3. Repository orientation — do this before proposing changes

1. `git remote -v && git log --oneline -5` — know WHERE you are and the
   house commit style (read the last 10 messages; mimic their format).
2. Read `README.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`
   if present — they define the repo's conventions and they win over generic
   habits.
3. `git status` — never commit on top of unrelated dirty state; if the
   worktree has changes you didn't make, ask before touching them.
4. `git branch --show-current` — NEVER commit to `main`/`master` directly
   unless the user explicitly asked for it. Create a feature branch:
   `git checkout -b <type>/<short-slug>` with type in
   `feat|fix|docs|refactor|test|chore`.

## 4. Commits

- **One logical change per commit.** Unrelated changes belong in separate
  commits — ask or split, don't blend.
- Message format (subject + body):

  ```
  <type>: <imperative summary, <= 72 chars, no trailing period>

  <optional body: WHY the change was made, not a line-by-line diff restatement>
  ```

- Reference issues in the body (`Refs #123`, or `Fixes #123` to auto-close on
  merge to the default branch).
- **Never commit secrets, tokens, `.env`, credentials, or large binaries**
  without asking. Check `git status` before `git add`; prefer explicit paths
  over `git add -A`/`git add .` when the worktree is messy.
- Run the repo's own checks (lint/tests) BEFORE committing when they're fast;
  note in the commit or PR what was run.
- Don't amend/rebase pushed, shared history — only your own unpushed commits.

## 5. Branches and pull requests

- Branch names: `<type>/<short-slug>`, e.g. `fix/heartbeat-race`,
  `feat/fleet-reorder`. Lowercase, hyphen-separated, no spaces.
- Keep PRs small and single-purpose. A 5000-line PR will not be reviewed.
- Before opening a PR: sync with the base branch
  (`git fetch origin && git rebase origin/main` or merge per repo convention)
  and resolve conflicts locally.
- PR body must stand alone:

  ```
  ## What
  <what changed, 1–3 sentences>
  ## Why
  <motivation, linked issue(s): Fixes #N>
  ## How tested
  <commands run, tests added, or "not tested because ...">
  ```

- Fill the repo's PR template fields if a template exists.
- **DRAFT PR for incomplete work** (`gh pr create --draft`) so reviewers don't
  waste time; mark ready when complete.
- After review feedback: push additional commits to the SAME branch (don't
  open a new PR); squash-fixup commits only before merge if the repo allows.

```bash
# canonical PR creation
git push -u origin HEAD
gh pr create --title "<type>: summary" --body "$(cat <<'EOF'
## What
...
## Why
...
## How tested
...
EOF
)"
```

## 6. Issues, comments, reviews

- **Search before creating**: `gh issue list --search "<keywords>"` —
  duplicates annoy maintainers.
- Issue reports need: environment (OS/versions), reproduction steps, expected
  vs actual behavior, and logs trimmed to the relevant part.
- Never post the same content to multiple issues (cross-posting is spam).
- When reviewing: comment on the code, not the person; prefer questions over
  verdicts ("Have you considered X?" vs "X is wrong"); block only on real
  defects, leave style nits as non-blocking.
- Reference, don't duplicate: link to prior discussions instead of
  re-explaining them.

## 7. Hygiene and safety

- **Never** `git push --force` to shared branches; if a push is rejected,
  pull/rebase first. `--force-with-lease` on YOUR feature branch only, and
  only to fix your own mistake.
- Don't disable hooks (`--no-verify`) or skip CI without saying so explicitly
  and why.
- Delete merged branches: `git push origin --delete <branch>` + local prune
  (`git remote prune origin`), if the repo doesn't auto-delete.
- Keep forks in sync: add `upstream` remote, sync regularly; never commit to
  a fork's copy of the upstream default branch.
- Large assets → Git LFS or external storage, never plain git.

## 8. Automatic repo tagging (version-triggered)

The repo is tagged automatically — as part of the same commit-and-push
operation, without asking — whenever a versioned artifact gets a new
version:

1. **Component version bump**: `package.json`'s `version` field changes
   (root repo or a packaged component like an extension), normally
   accompanied by a `CHANGELOG.md` entry.
   → tag `v<new-version>` (e.g. `0.2.0` → `v0.2.0`), annotated.
2. **Versioned document**: an `.md` file whose header carries a semantic
   version in a `<prefix>-X.Y.Z` convention (e.g. `specs-1.2.0`,
   `impl-plan-0.3.0`) gets its header version bumped.
   → tag `<prefix>-<new-version>` (e.g. `specs-1.2.0`), annotated.

Rules:

- **Annotated tags only** (`git tag -a <name> -m "..."`), never lightweight.
- **Push the tag together with the commit it belongs to**
  (`git push origin main <tag>`), so history and tags never diverge.
- **Never move or delete an existing tag.** Before creating, verify it
  doesn't exist: `git rev-parse -q --verify refs/tags/<name>`. If it does,
  STOP and report — version reuse means something is wrong; re-tagging is
  only allowed with explicit user instruction.
- One tag per version event. If a commit bumps several artifacts, create
  all matching tags in the same push.
- If the bump was committed but the tag forgotten, tag the commit that
  introduced the version (find it with `git log -1 --format=%H -- <file>`),
  not HEAD.

## 9. CI awareness

- After pushing a PR, **check CI before declaring success**:
  `gh pr checks` (or `gh run list --branch <branch>`). If red, fetch the log
  (`gh run view <id> --log-failed`) and either fix or report the failure —
  don't hand over a red PR claiming it's done.
- Read `.github/workflows/*.yml` before adding CI steps: respect the repo's
  existing runner, matrix, and action-pinning conventions
  (actions pinned by SHA is a common requirement — follow the house style).
- Don't retrigger CI repeatedly hoping for a different result; investigate
  flakiness instead.

## 10. Quick reference — the non-negotiables

1. Identity + auth verified BEFORE first operation (§1).
2. Never commit to the default branch without explicit instruction (§3).
3. Explicit paths over `git add -A`; no secrets in commits, ever (§4).
4. PRs small, single-purpose, with What/Why/How-tested (§5).
5. Version bumps and versioned-doc headers get their annotated tag in the
   same push — and an existing tag is never moved (§8).
6. CI checked before claiming success (§9).
7. No force-pushes to shared branches, ever (§7).
