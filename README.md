# pi-fleet-kit

See the dedicated READMEs: [extensions/intro](extensions/README.md),
[extensions/git-status](extensions/git-status/README.md),
[extensions/prompt-trigger](extensions/prompt-trigger/README.md),
[warp/](warp/README.md), [skills/](skills/), [docs/](docs/).

## Machine requirements (portability)

No path in this repo is user-specific: all runtime paths are `${HOME}`- or
tilde-relative (compose mounts, tab configs, scripts, the Swift app), and
scripts locate themselves relative to their own directory. The one
**convention** other files depend on: clone this repo to **`~/pi-fleet-kit`**
(exactly that name/location) and keep agent workspaces under
`~/pi-agents/`. Everything else adapts per machine; tool lookup covers the
standard install locations on macOS (`/usr/local/bin`, `/opt/homebrew/bin`,
`~/.docker/bin`) and Linux.

## Per-agent skills

Each agent loads **only the skills assigned to it** — defined in
`compose.yml` per service (mount the skill dir read-only, then pass
`--skill /repo-skills/<name>`, repeatable):

| Agent | Skills |
|---|---|
| `pi-fleet-kit` | `build-skill`, `github-best-practices` |
| `pi-coding` | `github-best-practices` |
| `pi-review` | `github-best-practices` |
| `pi-research` | `publishing-best-practices`, `github-best-practices`, `web-research` |
| `pi-personal` | `publishing-best-practices`, `hello-world`, `github-best-practices`, `web-research` |

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
| `compose.yml` | Defines the agent services. Currently five agents — `pi-fleet-kit`, `pi-coding`, `pi-review`, `pi-research`, `pi-personal` — all running the `pi-sandbox` image, each with its own persistent Pi-home volume and a bind-mounted workspace under `~/pi-agents/`. |
| `Dockerfile.pi` | Builds the `pi-sandbox` image: Node 24 base, git + ripgrep, `pi` installed globally, the entrypoint wrapper below, and a non-root `pi` user (least privilege — the agent runs unprivileged). |
| `utils/entrypoint.sh` | Container entrypoint. Before handing off to `pi`, it configures the agent's git environment from env vars passed by Compose: commit identity (`GITHUB_USER_NAME`/`GITHUB_USER_EMAIL`) and a token-based git credential helper (`GITHUB_TOKEN`) — the container has no keyring, so auth must come from the environment. |
| `.env` | Credentials bridge for Compose. Holds **`${VAR}` references only** (e.g. `GITHUB_TOKEN=${GITHUB_TOKEN}`), resolved from the host shell when `docker compose` runs. |
| `.gitignore` | Excludes `.DS_Store` and the legacy agent workspace (`finance-agent/`); agent workspaces now live outside this repo in `~/pi-agents/`. |
| `.githooks/pre-commit` | Secret-leak guard (see below). |
| `package.json` | Pi package manifest (see below). |
| `skills/` | Installable Pi skills; each subdirectory holds a `SKILL.md` (Agent Skills spec). Currently `build-skill`, `github-best-practices`, `hello-world`, `publishing-best-practices`, `pull-request`, `web-research`. |
| `extensions/` | Shared Pi extensions (`git-status`, `prompt-trigger`), also published as standalone npm Pi Packages (`pi-git-status`, `pi-prompt-trigger`) — see [extensions/README.md](extensions/README.md). |
| `docs/` | Supplementary docs (e.g. registering the agents' SSH signing key on GitHub). |
| `LICENSE` | MIT license text. |
| `warp/` | Warp editor config: Tab Configs for the agents (`tab_configs/`), a launcher (`agent_run.sh`), an all-agents launcher (`agents_start.sh`), a config installer (`tabs_install.sh`), a fleet diagnostic (`fleet_doctor.sh`), a macOS Dock app builder (`build_fleet_app.sh`), and feature-request drafts (`issues/`). |

## Pi package (fetching skills from GitHub)

This repo is a valid [Pi package](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md):
`package.json` declares the `pi-package` keyword and points Pi's `pi.skills`
manifest at `./skills`, so any agent can fetch its skills directly from this
GitHub repository with:

```bash
pi install git:github.com/didier-durand/pi-fleet-kit@v0.1.0
```

(Git tags and commits are pinned; `pi update --extensions` reconciles the
checkout without moving a pinned ref.)

Inside the Docker sandboxes, agents can do the same — `GITHUB_TOKEN` is
already passed through for git-over-HTTPS auth, so no extra login is needed:

```bash
pi install git:github.com/didier-durand/pi-fleet-kit@v0.1.0
```

Only the resources declared in the manifest (`skills/`) are loaded; the rest
of the repo (compose, Dockerfile, warp configs) is ignored by Pi.

## Community packages on npm

The two extensions are also published as standalone, individually
installable Pi Packages — no fleet-kit infrastructure required:

```bash
pi install npm:pi-git-status      # live git state in the pi footer
pi install npm:pi-prompt-trigger  # file-triggered prompts for a running TUI
```

Both carry the `pi-package` keyword and appear in the Pi package gallery.
See [extensions/README.md](extensions/README.md) for details and the
release workflow.

## Running environment

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 12, "rankSpacing": 28, "padding": 6, "diagramPadding": 8, "subGraphTitleMargin": {"top": 4, "bottom": 2}}}}%%
flowchart TB
  subgraph MACHINE["Developer machine / Server"]
    subgraph HOST["HOST — macOS · Linux · Windows"]
    direction LR
    WARP["Warp terminal — one tab per agent<br/>agent_run.sh → docker compose run --rm<br/>one instance per agent: heartbeat claim + fixed container name<br/>agents_start.sh · tabs_install.sh · fleet_doctor.sh<br/>macOS: Pi Agent Fleet Dock app (swiftc)"]
    FILES["Host files & shell env<br/>~/pi-fleet-kit — compose.yml · Dockerfile.pi · extensions/ · skills/<br/>~/pi-agents/[agent] — workspace git clone<br/>~/pi-exchange/pi-coding · pi-review — watchdog drop dirs<br/>~/.ssh/pi-agent-signing — signing-only SSH key<br/>env: OPENROUTER_API_KEY · GITHUB_TOKEN · GITHUB_USER_NAME/EMAIL<br/>.env = dollar-brace references only"]
  end
  subgraph DOCKER["Docker — compose project: pi-agents · image: pi-sandbox"]
    direction LR
    FLEET["pi-fleet-kit<br/>pi-fleet-kit-home → ~/.pi/agent"]
    CODING["pi-coding<br/>pi-coding-home → ~/.pi/agent<br/>+ /exchange"]
    REVIEW["pi-review<br/>pi-review-home → ~/.pi/agent<br/>+ /exchange"]
    RESEARCH["pi-research<br/>pi-research-home → ~/.pi/agent"]
    PERSONAL["pi-personal<br/>pi-personal-home → ~/.pi/agent"]
  end
  end
  LLM["LLM providers (OpenRouter)<br/>model set per agent in compose.yml"]
  GH["GitHub<br/>clone / pull / push over HTTPS (GITHUB_TOKEN)<br/>SSH-signed commits → Verified badge"]
  NPM["npm registry · pi.dev/packages<br/>PI_PACKAGES=npm:pi-web-access<br/>pi-git-status · pi-prompt-trigger"]
  HOST -->|"docker compose run"| DOCKER
  HOST -->|"bind mounts · named volumes · env passthrough"| DOCKER
  DOCKER -->|"LLM API calls"| LLM
  DOCKER -->|"git over HTTPS · SSH signing"| GH
  DOCKER -->|"pi install"| NPM
  classDef warp fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
  classDef files fill:#F1F5F9,stroke:#64748B,color:#334155
  classDef yellow fill:#FEF3C7,stroke:#B45309,color:#92400E
  classDef blue fill:#DBEAFE,stroke:#1D4ED8,color:#1E40AF
  classDef cyan fill:#CFFAFE,stroke:#0E7490,color:#155E75
  classDef green fill:#DCFCE7,stroke:#15803D,color:#166534
  classDef magenta fill:#FCE7F3,stroke:#BE185D,color:#9D174D
  classDef llm fill:#FFF8EC,stroke:#C08A2D,color:#7A5410
  classDef gh fill:#F2FAF2,stroke:#3C8C4E,color:#256B36
  classDef npm fill:#FFF8EC,stroke:#C08A2D,color:#7A5410
  class WARP warp
  class FILES files
  class FLEET yellow
  class CODING blue
  class REVIEW cyan
  class RESEARCH green
  class PERSONAL magenta
  class LLM llm
  class GH gh
  class NPM npm
  style HOST fill:#F5F9FF,stroke:#4A78B5,color:#2B4C7E
  style DOCKER fill:#F7F4FD,stroke:#6A4FA3,color:#4C3575
  style MACHINE fill:#FBFDFF,stroke:#94A3B8,color:#334155
```

The whole system in one picture: the host runs **Warp** (one tab per agent,
launching through `agent_run.sh`) and, on macOS, the **Pi Agent Fleet** Dock
app; Docker runs five `pi-sandbox` containers from the `pi-agents` compose
project, each with its own persistent Pi-home volume, its own workspace git
clone, and read-only mounts of this repo's skills/extensions; outside, the
agents talk to the model API (OpenRouter), GitHub (HTTPS auth + SSH commit
signing), and npm (Pi Packages, including this repo's published extensions).

## Usage

```bash
# Build the image (once, from this directory):
docker build -t pi-sandbox -f Dockerfile.pi .

# Run the agent:
docker compose -f ~/pi-fleet-kit/compose.yml run --rm pi-personal

# Teardown (deletes volumes and ALL agent state):
docker compose -f ~/pi-fleet-kit/compose.yml down -v
```

### Agent workspaces must be git clones

Each agent works in its own independently cloned repository
(`~/pi-agents/<agent>`, mounted as `/workspace`) — the `git-status`
footer extension is inactive otherwise. `warp/agent_run.sh` bootstraps this
at launch: `pi-fleet-kit`'s workspace (a clone of this repo, its natural
domain) is cloned automatically from the origin if missing; other agents'
workspaces are per-project clones only you know, so the launcher warns and
prints the exact `git clone` command when a workspace is not a repo.

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

## Prerequisites

### Universal (the sandbox itself — no host-side Node/pi needed)

- **Docker + Compose v2**: Docker Desktop (macOS/Windows) or Docker Engine
  with the compose plugin (Linux). The `warp/` scripts also probe the usual
  Docker Desktop install locations (`/usr/local/bin`, `/opt/homebrew/bin`,
  `~/.docker/bin`, `/usr/bin`), so launcher contexts with a minimal `PATH`
  work too.
- **The repo at `~/pi-fleet-kit`** — the one path convention other files
  depend on (see [Machine requirements](#machine-requirements-portability)).
- **Credentials in the host shell** (the tracked `.env` holds only
  `${VAR}` references — the real values must be exported):
  `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_USER_NAME`,
  `GITHUB_USER_EMAIL`.
- **The sandbox image built once**:
  `docker build -t pi-sandbox -f Dockerfile.pi .`
- **Git hooks configured once per clone**:
  `git config core.hooksPath .githooks`
- **Network access** at first launch: npm registry (the `PI_PACKAGES`
  auto-install of `pi-web-access`) and the model API.
- **Agent workspaces as git clones** under `~/pi-agents/` (`git-status` is
  inactive otherwise) — see [Agent workspaces must be git
  clones](#agent-workspaces-must-be-git-clones).

### Warp terminal (the intended operating layer)

- [Warp](https://www.warp.dev) — available for macOS, Windows, and Linux
  (x64/ARM64).
- `warp/tabs_install.sh` then puts one tab config per agent into Warp's
  per-platform config directory (auto-detected on all three platforms).
- Every tab launches the agent through `warp/agent_run.sh`, which enforces
  **one instance per agent** (heartbeat claim, orphan healing, fixed
  container names) — plain `docker compose run` bypasses that discipline
  and is the headless fallback, not the primary interface.

### macOS capstone — the "Pi Agent Fleet" Dock app (optional)

- Built by `warp/build_fleet_app.sh` into `~/Applications`: one Dock icon
  for the whole fleet (running-dot while agents are up, click-while-running
  convergence via `agents_start.sh`).
- Requires the Xcode Command Line Tools (`xcode-select --install`) for
  `swiftc`; without them it degrades to a basic osacompile launcher without
  the dot or click-while-running behavior.
- Linux/Windows: use the Warp tabs directly; the app is macOS-only.
