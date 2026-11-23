# Warp Tab Configs

Warp [Tab Configs](https://docs.warp.dev/terminal/windows/tab-configs/) (the
successor to Launch Configurations) let you open a preconfigured tab — with a
title, color, directory, and startup command — straight from the `+` menu in
the tab bar.

## What's here

One Tab Config per agent defined in `../compose.yml`:

| File | Tab name | Color | Launches |
|---|---|---|---|
| `tab_configs/pi_fleet_kit.toml` | pi-fleet-kit | yellow | `agent_run.sh pi-fleet-kit` |
| `tab_configs/pi_coding.toml` | pi-coding | blue | `agent_run.sh pi-coding` |
| `tab_configs/pi_review.toml` | pi-review | cyan | `agent_run.sh pi-review` |
| `tab_configs/pi_research.toml` | pi-research | green | `agent_run.sh pi-research` |
| `tab_configs/pi_personal.toml` | pi-personal | magenta | `agent_run.sh pi-personal` |

Each config opens a terminal in `~/pi-fleet-kit` and runs `agent_run.sh` for
that agent, so selecting it from the `+` menu drops you directly into the
agent's sandbox. The compose service `command` includes `--continue`, so
each launch resumes that agent's most recent session (fresh start: `/new`
inside pi).

**One instance per agent:** `agent_run.sh` refuses to start a second copy
if the agent is already up in an open tab. "Up" is detected via the
container **plus a per-tab heartbeat**: closing a Warp tab kills the docker
client but *not* its container, so a live container alone doesn't prove a
tab is open. Each tab's heartbeat file records its docker client's PID;
the agent counts as claimed only while that PID is alive. Closing the tab
kills the client, so the claim lapses **immediately** (no time window) —
the next click removes the orphaned container and opens a fresh tab.
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
~/pi-fleet-kit/warp/agents_start.sh
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
| `agents_start.sh` | All five agents, as tabs in the focused Warp window |
| `agents_start.sh -w` | All five agents, in a new Warp window |
| `agents_start.sh pi-coding pi-personal` | Only the named agents |
| `agents_start.sh -n` | Skip the install step (configs already installed) |
| `agents_start.sh -R` | Reorder: stop the fleet, reopen all tabs in `compose.yml` order |
| (any invocation) | Missing agents are (re)opened, running ones skipped, orphans healed — converges to one tab per agent |

**Tab order:** Warp appends newly opened tabs at the end of the tab bar and
provides no way to reposition them (there is no position parameter in the
URI scheme). Tabs opened one at a time therefore accumulate in "reopened
last = far right" order. To restore the canonical order (pi-fleet-kit,
pi-coding, pi-research, pi-personal), run `agents_start.sh -R`: it stops all
agent containers (sessions are kept on disk and resumed via `--continue`),
then reopens every tab in compose order (pi-fleet-kit, pi-coding,
pi-review, pi-research, pi-personal) — close the leftover old tabs
afterwards. A Warp feature request for proper tab-position control is
drafted in `issues/issue_tab_config_tab_position.md`.

It is cross-platform: `open` on macOS, `xdg-open` on Linux, `start` on
Windows, and the tab-config directory is chosen per platform (override with
`TAB_CONFIGS_DIR`). Agent names may use hyphens or underscores.

## Install: `tabs_install.sh`

Warp loads Tab Configs from a per-platform directory. `tabs_install.sh`
detects the platform (same logic as `agents_start.sh`) and installs every
`tab_configs/*.toml` from this repo into the right one:

| Platform | Default destination |
|---|---|
| macOS (stable) | `~/.warp/tab_configs/` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/` |
| Windows (Git Bash/MSYS) | `%APPDATA%\warp\Warp\data\tab_configs\` |
| (any) override | `TAB_CONFIGS_DIR=...` |

```bash
~/pi-fleet-kit/warp/tabs_install.sh
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
TAB_CONFIGS_DIR=~/.warp-preview/tab_configs ~/pi-fleet-kit/warp/tabs_install.sh
```

Warp Preview (macOS) reads `~/.warp-preview/tab_configs/` — the same
override covers it.

Newly added files appear in the `+` menu automatically — no restart needed.

## Fleet app: Dock icon with running dot (`build_fleet_app.sh`)

A plain one-shot launcher (e.g. an Automator app) exits immediately after the
click — so the Dock never shows the standard black dot for a running
application, and a click while it "runs" cannot be handled. osacompile
applets have the same flaw: they are not stay-open by default and quit as
soon as the run handler returns. The builder therefore compiles a tiny
**native Swift app** (using `swiftc` from the Xcode Command Line Tools):

```bash
~/pi-fleet-kit/warp/build_fleet_app.sh            # builds into ~/Applications
~/pi-fleet-kit/warp/build_fleet_app.sh /Applications
```

Behavior:

- **Every click converges the fleet** — launch and Dock-click-while-running
  (`applicationShouldHandleReopen`) both run `agents_start.sh` (missing
  agents added, running ones skipped, orphans healed).
- **Black dot while the fleet runs** — the app stays open as long as any
  agent container is up.
- **Dot disappears when the fleet stops** — the app auto-quits ~60s after
  the last agent stops (grace period, also covering slow container boot).

If `swiftc` is missing the builder falls back to an osacompile applet that
can launch the fleet but will not stay running (no dot, no click-while-
running). Install the Command Line Tools (`xcode-select --install`) and
rebuild for the full behavior.

After building, remove any previous launcher app from the Dock and drag
`Pi Agent Fleet.app` in. The icon is generated from
`AI-agent-fleet-Icon-rounded.png` (the artwork with proper macOS-style
transparent rounded corners; falls back to `AI-agent-fleet-Icon.png` if
absent) — re-run the builder to refresh it after changing the artwork.
If Finder shows a stale icon, rebuild and run `killall Dock`.

## Open via URI scheme

Any config can also be opened without the menu, e.g. from a script or
Raycast/Alfred launcher:

```bash
open "warp://tab_config/pi_personal"            # new tab in focused window
open "warp://tab_config/pi_personal?new_window=true"  # new window
```

## Diagnose: `fleet_doctor.sh`

When a closed tab's agent does not come back up, this read-only diagnostic
prints the full state chain — docker binary used, heartbeat file and its
recorded PID (alive/dead/zombie), `agent_run.sh --check` result, containers
for the agent, docker reachability, compose file presence, and all
heartbeats. It never modifies anything:

```bash
~/pi-fleet-kit/warp/fleet_doctor.sh pi-coding
```

Newly added files appear in the `+` menu automatically — no restart needed.

## Editing

- Edit the `.toml` files here, then re-run `tabs_install.sh` to sync the
  changes into Warp's config directory.
- Schema reference: [Tab Configs docs](https://docs.warp.dev/terminal/windows/tab-configs/)
  (panes, splits, parameters, shell overrides, etc.).
- Tip: right-click any tab in Warp and choose **Save as new config** to
  capture its current state as a new `.toml`.
