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
