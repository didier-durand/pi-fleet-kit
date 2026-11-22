# Warp Tab Configs

Warp [Tab Configs](https://docs.warp.dev/terminal/windows/tab-configs/) (the
successor to Launch Configurations) let you open a preconfigured tab — with a
title, color, directory, and startup command — straight from the `+` menu in
the tab bar.

## What's here

One Tab Config per agent defined in `../compose.yml`:

| File | Tab name | Color | Launches |
|---|---|---|---|
| `tab_configs/pi_finance.toml` | pi-finance | green | `docker compose run --rm pi-finance` |
| `tab_configs/pi_coding.toml` | pi-coding | blue | `docker compose run --rm pi-coding` |
| `tab_configs/pi_research.toml` | pi-research | magenta | `docker compose run --rm pi-research` |
| `tab_configs/pi_tests.toml` | pi-tests | yellow | `docker compose run --rm pi-tests` |

Each config opens a terminal in `~/pi-configs` and runs the agent's
`docker compose` command, so selecting it from the `+` menu drops you
directly into that agent's sandbox.

`tabs_install.sh` (see below) copies these into Warp's config directory.

The `issues/` directory holds drafts of feature requests for the Warp repo
(e.g. `issues/issue_file_tree_open_shell.md` — run shell directly from the
File Tree), ready to paste into
[github.com/warpdotdev/warp/issues/new](https://github.com/warpdotdev/warp/issues/new).

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
open "warp://tab_config/pi_finance"            # new tab in focused window
open "warp://tab_config/pi_finance?new_window=true"  # new window
```

## Editing

- Edit the `.toml` files here, then re-run `tabs_install.sh` to sync the
  changes into Warp's config directory.
- Schema reference: [Tab Configs docs](https://docs.warp.dev/terminal/windows/tab-configs/)
  (panes, splits, parameters, shell overrides, etc.).
- Tip: right-click any tab in Warp and choose **Save as new config** to
  capture its current state as a new `.toml`.
