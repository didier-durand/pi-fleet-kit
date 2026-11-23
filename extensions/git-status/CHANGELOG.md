# Changelog

## [0.1.0] - 2026-11-23

First public release.

- Footer status line: branch, ahead/behind vs upstream, dirty file count,
  +/- line stats for the worktree and the ahead range.
- Refreshes after every tool call (bash / edit / write), on agent turn end,
  and at session start; throttled to ~2 refreshes/second.
- Hidden entirely when the workspace is not a git repo.
- Linux/macOS/Windows(Git Bash) compatible: plain `git` plumbing only.
