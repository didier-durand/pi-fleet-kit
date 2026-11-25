# Extensions

Pi extensions shared by the fleet. Two loading channels — the repo-local
one is what compose uses for the extensions below:

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
| `extensions/pi-obs/` | Session observability: live token/cost/model footer, `/pi-obs` reports, and out-of-process OpenTelemetry export (OTLP/HTTP → Jaeger) — read-only, zero side effects on the session. Wired into every agent via compose; the Jaeger UI is available at `http://localhost:16686` | [pi-obs/README.md](pi-obs/README.md) |
| `pi-web-access` (Pi Package, npm) | Web search, URL fetching, GitHub repo cloning, PDF extraction, YouTube transcription — the web-research toolchain | [package on npm](https://www.npmjs.com/package/pi-web-access) · [source](https://github.com/nicobailon/pi-web-access) |

Loading details per channel are above; installation specifics
(`pi install npm:pi-web-access`, once per agent home) in the Pi Package
bullet.

## Community packages — install from npm

The two packaged extensions are published as standalone Pi Packages,
installable into any Pi agent (no fleet-kit infrastructure required):

```bash
pi install npm:pi-git-status
pi install npm:pi-prompt-trigger
```

Or try one without installing (ephemeral cache mode):

```bash
pi -e npm:pi-git-status
```

Inside this fleet, the repo-local channel (`--extension` via the
`/repo-extensions` mount) takes precedence over installing these packages
into the agents' homes — do not mix both for the same extension, or it
loads twice.

## Publishing a new version

Each extension directory is a self-contained npm package (own
`package.json` with the `pi` manifest and `pi-package` keyword, own
`CHANGELOG.md`). To release:

1. Bump `version` in `extensions/<name>/package.json`.
2. Add a matching `## [x.y.z]` heading to `extensions/<name>/CHANGELOG.md`
   (Pi shows entries newer than the last seen version on next launch).
3. `cd extensions/<name> && npm publish`.

`peerDependencies` pin the host-provided `@earendil-works/pi-coding-agent`
with a `*` range — never list it in `dependencies` (Pi module-maps it, a
bundled copy would create duplicate registries). No build step: Pi loads
TypeScript extensions directly. (`pi-obs` follows the same layout —
publishable, but not yet on npm; release it by the same three steps.)

CI gates every extension: `check-extension.sh` (manifest, CHANGELOG,
tsc, npm-pack tarball equality, optional live-load smoke test) and
`run-tests.sh` (unit tests + V8 coverage with a Markdown job summary),
each driven by its own GitHub workflow.
