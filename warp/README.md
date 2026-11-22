# Warp Tab Configs

Warp [Tab Configs](https://docs.warp.dev/terminal/windows/tab-configs/) (the
successor to Launch Configurations) let you open a preconfigured tab — with a
title, color, directory, and startup command — straight from the `+` menu in
the tab bar.

## What's here

One Tab Config per agent defined in `../compose.yml`:

| File | Tab name | Color | Launches |
|---|---|---|---|
| `tab_configs/pi_configs.toml` | pi-configs | yellow | `agent_run.sh pi-configs` |
| `tab_configs/pi_coding.toml` | pi-coding | blue | `agent_run.sh pi-coding` |
| `tab_configs/pi_research.toml` | pi-research | green | `agent_run.sh pi-research` |
| `tab_configs/pi_personal.toml` | pi-personal | magenta | `agent_run.sh pi-personal` |

Each config opens a terminal in `~/pi-configs` and runs `agent_run.sh` for
that agent, so selecting it from the `+` menu drops you directly into the
agent's sandbox. The compose service `command` includes `--continue`, so
each launch resumes that agent's most recent session (fresh start: `/new`
inside pi).

**One instance per agent:** `agent_run.sh` refuses to start a second copy
if the agent is already up in an open tab. "Up" is detected via the
container **plus a per-tab heartbeat**: closing a Warp tab kills the docker
client but *not* its container, so a live container alone doesn't prove a
tab is open. Each tab keeps a heartbeat file fresh while its docker client
is alive; a stale heartbeat with a live container means the tab is gone —
the orphaned container is removed automatically and a fresh tab opens.
This makes icon clicks idempotent: agents already up in tabs are skipped,
orphans are healed, and everything else gets exactly one tab. Each agent's
container also gets a fixed name + fleet label, so even a double-click
cannot race two copies into existence — Docker rejects the duplicate name.
Docker is looked up beyond `PATH` (Docker Desktop install locations) so the
check also works from Automator launchers with a minimal `PATH`.

Before any launch (or state check), every container for the agent that is
**not** claimed by an open tab is removed first. Unclaimed covers orphans
left by closed tabs, duplicate instances from older versions of this setup
(random names, no fleet label — including any duplicates you currently
have), and manual `docker compose run` sessions. The icon is the single
source of truth: one click converges to exactly one container per agent.
So the first click after upgrading to this version cleans up all existing
duplicates automatically.

`agents_start.sh` (see below) opens one tab per agent in Warp and starts
the agents in their sandboxes. `tabs_install.sh` (see below) copies the
configs into Warp's config directory.

The `issues/` directory holds drafts of feature requests for the Warp repo
(e.g. `issues/issue_file_tree_open_shell.md` — run shell directly from the
File Tree), ready to paste into
[github.com/warpdotdev/warp/issues/new](https://github.com/warpdotdev/warp/issues/new).

## Launch all agents: `agents_start.sh`

Starts every agent in its own Warp tab (installing the tab configs first if
needed):

```bash
~/pi-configs/warp/agents_start.sh
```

The script opens each config via the `warp://tab_config/<name>` URI scheme,
and each tab runs `agent_run.sh`, so the agents boot into their sandboxes
as the tabs open. Every click converges to the same desired state —
**one running instance per agent, in one tab each**:

| Situation on click | Result |
|---|---|
| Nothing running | One tab per agent is opened |
| Some agents up in tabs | Only the missing agents get tabs; the rest are left alone |
| All agents up in tabs | Warp window is brought to the front; nothing is opened |
| Tabs closed, containers left behind (orphans) | Orphans removed automatically, fresh tabs opened |
| A tab fails to boot its agent | Reported as a WARNING after the verification pass |

The script verifies after opening that every requested agent actually came
up (polling briefly), so a failed start is never silent. Agents started
manually (plain `docker compose run`, outside a tab) count as "in use" and
are skipped rather than duplicated.

| Invocation | Behavior |
|---|---|
| `agents_start.sh` | All four agents, as tabs in the focused Warp window |
| `agents_start.sh -w` | All four agents, in a new Warp window |
| `agents_start.sh pi-coding pi-personal` | Only the named agents |
| `agents_start.sh -n` | Skip the install step (configs already installed) |
| (any invocation) | Missing agents are (re)opened, running ones skipped, orphans healed — converges to one tab per agent |

It is cross-platform: `open` on macOS, `xdg-open` on Linux, `start` on
Windows, and the tab-config directory is chosen per platform (override with
`TAB_CONFIGS_DIR`). Agent names may use hyphens or underscores.

## Install: `tabs_install.sh`

Warp loads Tab Configs from `~/.warp/tab_configs/` (macOS stable).
`tabs_install.sh` replicates every `tab_configs/*.toml` from this repo into
that directory:

```bash
~/pi-configs/warp/tabs_install.sh
```

Usage:

| Invocation | Behavior |
|---|---|
| `tabs_install.sh` | Copy configs, skipping files already identical in the destination |
| `tabs_install.sh -f` | Force overwrite, even if the destination copy is identical |
| `TAB_CONFIGS_DIR=... tabs_install.sh` | Install into a custom directory instead of the default |

The script is idempotent — re-running after editing a `.toml` in this repo
only copies the files that changed. Existing configs in the destination
that aren't part of this repo are left untouched.

To target a non-default location, set `TAB_CONFIGS_DIR`:

```bash
TAB_CONFIGS_DIR=~/.warp-preview/tab_configs ~/pi-configs/warp/tabs_install.sh
```

Other locations:

- **Warp Preview (macOS):** `~/.warp-preview/tab_configs/`
- **Windows:** `%APPDATA%\warp\Warp\data\tab_configs\`
- **Linux:** `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/`

Newly added files appear in the `+` menu automatically — no restart needed.

## Open via URI scheme

Any config can also be opened without the menu, e.g. from a script or
Raycast/Alfred launcher:

```bash
open "warp://tab_config/pi_personal"            # new tab in focused window
open "warp://tab_config/pi_personal?new_window=true"  # new window
```

## Editing

- Edit the `.toml` files here, then re-run `tabs_install.sh` to sync the
  changes into Warp's config directory.
- Schema reference: [Tab Configs docs](https://docs.warp.dev/terminal/windows/tab-configs/)
  (panes, splits, parameters, shell overrides, etc.).
- Tip: right-click any tab in Warp and choose **Save as new config** to
  capture its current state as a new `.toml`.
