# Changelog

## [0.2.0] - 2026-11-24

Repo discovery: the footer no longer requires /workspace itself to be a
git repository.

- At session start the extension resolves which repo to track: /workspace
  if it is (or is inside) a repo, otherwise the shallowest nested clone
  found by a bounded scan (maxdepth 3, node_modules excluded).
- Discovery is retried while unresolved — a workspace cloned after the
  agent starts is picked up within one poll interval.
- Footer is prefixed with the repo name: `my-repo: ⎇ main …` — always
  identifies which repo the line describes, even with several clones in
  the workspace.
- All git plumbing runs against the discovered root (`git -C`), so the
  footer tracks the right repo regardless of the session cwd.
- Repo disappearing (workspace reset, .git removed) clears the footer and
  triggers re-discovery instead of leaving stale state.

## [0.1.0] - 2026-11-23

First public release.

- Footer status line: branch, ahead/behind vs upstream, dirty file count,
  +/- line stats for the worktree and the ahead range.
- Refreshes after every tool call (bash / edit / write), on agent turn end,
  and at session start; throttled to ~2 refreshes/second.
- Hidden entirely when the workspace is not a git repo.
- Linux/macOS/Windows(Git Bash) compatible: plain `git` plumbing only.
