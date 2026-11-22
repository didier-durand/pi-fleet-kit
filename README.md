# pi-configs

See the dedicated READMEs: [extensions/](extensions/README.md),
[warp/](warp/README.md), [skills/](skills/), [docs/](docs/).

## Machine requirements (portability)

No path in this repo is user-specific: all runtime paths are `${HOME}`- or
tilde-relative (compose mounts, tab configs, scripts, the Swift app), and
scripts locate themselves relative to their own directory. The one
**convention** other files depend on: clone this repo to **`~/pi-configs`**
(exactly that name/location) and keep agent workspaces under
`~/pi-agents/`. Everything else adapts per machine; tool lookup covers the
standard install locations on macOS (`/usr/local/bin`, `/opt/homebrew/bin`,
`~/.docker/bin`) and Linux.

# pi-configs

## Per-agent skills

Each agent loads **only the skills assigned to it** — defined in
`compose.yml` per service (mount the skill dir read-only, then pass
`--skill /repo-skills/<name>`, repeatable):

| Agent | Skills |
|---|---|
| `pi-configs` | `build-skill`, `github-best-practices` |
| `pi-coding` | `github-best-practices` |
| `pi-research` | `publishing-best-practices`, `github-best-practices` |
| `pi-personal` | `publishing-best-practices`, `hello-world`, `github-best-practices` |

To change an agent's list: edit that service's two blocks in `compose.yml`
(the mounts under `volumes:` and the `--skill` flags under `command:`), then
relaunch the tab. Skills live in `skills/` and are mounted read-only, so
agents can never modify them; updates flow through `git pull`.

Infrastructure for running [Pi](https://github.com/earendil-works/pi-coding-agent)
coding agents in Docker sandboxes, with reproducible GitHub authentication
mirroring the host's setup.

## Contents

| File | Purpose |
|---|---|
| `compose.yml` | Defines the agent services. Currently four agents — `pi-configs`, `pi-coding`, `pi-research`, `pi-personal` — all running the `pi-sandbox` image, each with its own persistent Pi-home volume and a bind-mounted workspace under `~/pi-agents/`. |
| `Dockerfile.pi` | Builds the `pi-sandbox` image: Node 24 base, git + ripgrep, `pi` installed globally, the entrypoint wrapper below, and a non-root `pi` user (least privilege — the agent runs unprivileged). |
| `utils/entrypoint.sh` | Container entrypoint. Before handing off to `pi`, it configures the agent's git environment from env vars passed by Compose: commit identity (`GITHUB_USER_NAME`/`GITHUB_USER_EMAIL`) and a token-based git credential helper (`GITHUB_TOKEN`) — the container has no keyring, so auth must come from the environment. |
| `.env` | Credentials bridge for Compose. Holds **`${VAR}` references only** (e.g. `GITHUB_TOKEN=${GITHUB_TOKEN}`), resolved from the host shell when `docker compose` runs. |
| `.gitignore` | Excludes `.DS_Store` and the legacy agent workspace (`finance-agent/`); agent workspaces now live outside this repo in `~/pi-agents/`. |
| `.githooks/pre-commit` | Secret-leak guard (see below). |
| `package.json` | Pi package manifest (see below). |
| `skills/` | Installable Pi skills; each subdirectory holds a `SKILL.md` (Agent Skills spec). Currently `hello-world`. |
| `warp/` | Warp editor config: Tab Configs for the agents (`tab_configs/`), an installer (`tabs_install.sh`), an all-agents launcher (`agents_start.sh`), and feature-request drafts (`issues/`). |

## Pi package (fetching skills from GitHub)

This repo is a valid [Pi package](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md):
`package.json` declares the `pi-package` keyword and points Pi's `pi.skills`
manifest at `./skills`, so any agent can fetch its skills directly from this
GitHub repository with:

```bash
pi install git:github.com/didier-durand/pi-configs@v1.0.0
```

(Git tags and commits are pinned; `pi update --extensions` reconciles the
checkout without moving a pinned ref.)

Inside the Docker sandboxes, agents can do the same — `GITHUB_TOKEN` is
already passed through for git-over-HTTPS auth, so no extra login is needed:

```bash
pi install git:github.com/didier-durand/pi-configs@v1.0.0
```

Only the resources declared in the manifest (`skills/`) are loaded; the rest
of the repo (compose, Dockerfile, warp configs) is ignored by Pi.

## Usage

```bash
# Build the image (once, from this directory):
docker build -t pi-sandbox -f Dockerfile.pi .

# Run the agent:
docker compose -f ~/pi-configs/compose.yml run --rm pi-personal

# Teardown (deletes volumes and ALL agent state):
docker compose -f ~/pi-configs/compose.yml down -v
```

### Environment variables passed to agents

| Variable | Sourced from | Used for |
|---|---|---|
| `OPENROUTER_API_KEY` | host env via `.env` reference | Pi's `openrouter` provider |
| `GITHUB_TOKEN` | host env via `.env` reference | `gh` CLI + git-over-HTTPS auth inside the container |
| `GITHUB_USER_NAME` | host env passthrough | git commit author name |
| `GITHUB_USER_EMAIL` | host env passthrough | git commit author email |

If these are exported in your shell, nothing else is needed. `.env` exists as
a fallback so the Compose file documents its own expectations.

> ⚠️ **CAUTION — `.env` must contain references, never literal secrets.**
> This file is tracked in git on purpose, and it can stay safe **only** as
> long as every value is a `${VAR}` placeholder resolved from the host
> environment. Writing a real token (e.g. `GITHUB_TOKEN=ghp_…`) into `.env`
> puts a live credential into git history — an irreversible leak, even in a
> private repo. The pre-commit hook below blocks this, but treat the hook as
> a seatbelt, not a licence.

## Secret-leak guard (pre-commit hook)

Every commit is scanned before it lands:

1. **`.env` policy** — any `*TOKEN*/*KEY*/*SECRET*/*PASSWORD*=` line must be
   a `${VAR}` reference, empty, or a quoted placeholder.
2. **All staged files** — checked against known token signatures (`ghp_`,
   `gho_`, `github_pat_`, `sk-or-v1-`, `sk-…`, `AKIA…`, `glpat-`, `xox…`,
   PEM private keys). Matches block the commit; only line numbers are
   reported, never the secret itself.

**Required one-time setup per clone** (git hooks are local config and do not
travel with the repo):

```bash
git config core.hooksPath .githooks
```

Emergency bypass (avoid): `git commit --no-verify`.
