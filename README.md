# pi-configs

Infrastructure for running [Pi](https://github.com/earendil-works/pi-coding-agent)
coding agents in Docker sandboxes, with reproducible GitHub authentication
mirroring the host's setup.

## Contents

| File | Purpose |
|---|---|
| `compose.yml` | Defines the agent service(s). Currently a single agent, `pi-finance`, running the `pi-sandbox` image with its own persistent Pi-home volume and a bind-mounted workspace at `~/pi-agents/pi-finance`. |
| `Dockerfile.pi` | Builds the `pi-sandbox` image: Node 24 base, git + ripgrep, `pi` installed globally, the entrypoint wrapper below, and a non-root `pi` user (least privilege — the agent runs unprivileged). |
| `entrypoint.sh` | Container entrypoint. Before handing off to `pi`, it configures the agent's git environment from env vars passed by Compose: commit identity (`GITHUB_USER_NAME`/`GITHUB_USER_EMAIL`) and a token-based git credential helper (`GITHUB_TOKEN`) — the container has no keyring, so auth must come from the environment. |
| `.env` | Credentials bridge for Compose. Holds **`${VAR}` references only** (e.g. `GITHUB_TOKEN=${GITHUB_TOKEN}`), resolved from the host shell when `docker compose` runs. |
| `.gitignore` | Excludes `.DS_Store` and the legacy agent workspace (`finance-agent/`); agent workspaces now live outside this repo in `~/pi-agents/`. |
| `.githooks/pre-commit` | Secret-leak guard (see below). |

## Usage

```bash
# Build the image (once, from this directory):
docker build -t pi-sandbox -f Dockerfile.pi .

# Run the agent:
docker compose -f ~/pi-configs/compose.yml run --rm pi-finance

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
