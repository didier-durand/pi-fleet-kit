# Extensions

Shared Pi extensions loaded by every agent via compose. Two loading
channels:

- **Repo-local** (`--extension /repo-extensions/...`): read-only mount,
  one `git pull` to update all agents.
- **Pi Package** (`pi install npm:pi-web-access`): installed into the
  agent's persistent home (`settings.json`), listed by `pi list` under its
  package name, auto-updated via `pi update --extensions`. Preferred over
  the `--extension` flag for npm packages: the flag's ephemeral cache mode
  shows the extension under its manifest directory name (`dist`) instead of
  the package name.

## Inventory — brief description per extension

| Extension | What it does | Docs |
|---|---|---|
| `git-status/` | Live per-agent git state in the pi footer (branch, ↑ahead/↓behind, dirty count, ✓clean) — each agent has its own checkout; complements Warp's host-side git view | [git-status/README.md](git-status/README.md) |
| `prompt-trigger/` | Turns files dropped in a watched directory into prompts in the running TUI (as if typed), with `/new [kickoff]` for fresh sessions — the watchdog-to-agent bridge | [prompt-trigger/README.md](prompt-trigger/README.md) |
| `pi-web-access` (Pi Package, npm) | Web search, URL fetching, GitHub repo cloning, PDF extraction, YouTube transcription — the web-research toolchain | [package on npm](https://www.npmjs.com/package/pi-web-access) · [source](https://github.com/nicobailon/pi-web-access) |

Loading details per channel are above; installation specifics
(`pi install npm:pi-web-access`, once per agent home) in the Pi Package
bullet.
