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

Currently loaded: `git-status.ts` (repo-local, all agents) and `pi-web-access`
(Pi Package, npm — web search, URL fetching, GitHub repo cloning, PDF
extraction, YouTube transcription; install once per agent home with
`pi install npm:pi-web-access`; source:
[github.com/nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)).

### `prompt-trigger.ts` — file-triggered prompts in the running TUI

**Purpose:** lets an external watchdog drive a *running, visible* agent: the
watchdog monitors a directory and drops a prompt file; the extension injects
its content into the session **as if typed by the user** (visible in the
TUI, turn started or queued) and consumes the file.

- **Config:** `PI_TRIGGER_DIR` env per agent (compose: each agent watches
  its own `~/pi-agents/<agent>/triggers` mounted at `/triggers`). Unset →
  extension dormant.
- **One file = one prompt.** The whole file content is the prompt, EXCEPT a
  first line of `/new [kickoff]`, which starts a **fresh session**
  (token-free) with the optional remainder as the new session's first
  message.
- **Producer protocol:** write files atomically (write to a temp name, then
  rename into the watched dir), or ensure content is fully flushed before
  the next poll (1.5s interval; files are only consumed after two
  consecutive polls see an unchanged, ≥0.5s-old file).
- **Consumption:** the extension **deletes** each file after sending it —
  one file never fires twice. Multiple files are consumed sequentially,
  max 5 per tick.
- **Busy handling:** prompts arriving mid-run are queued
  (`deliverAs: "followUp"`), never interrupting running work.
- **Idle cost:** a `readdir`/`stat` every 1.5s — **zero tokens** until a
  file actually delivers a prompt.
