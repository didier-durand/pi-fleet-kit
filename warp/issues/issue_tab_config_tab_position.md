# Feature request: control tab position when opening a Tab Config via URI

**Repo context:** we launch a fleet of four AI agents as Warp tabs via
`warp://tab_config/<name>` URIs (see `tab_configs/` and `agents_start.sh` in
this repo). Tabs may be closed individually and reopened later.

## Problem

- A tab config opened via the `warp://` URI scheme (or the `+` menu) is
  always **appended at the end** of the tab bar.
- There is no way to position it — neither in the `.toml` schema nor in the
  URI — and no way to move existing tabs programmatically.

When one agent's tab is closed and reopened later, it lands at the far
right, breaking an intentional left-to-right order (our compose.yml order:
pi-fleet-kit, pi-coding-1, pi-review, pi-research, pi-personal). We currently work around
this by stopping the whole fleet and reopening all tabs in order
(`agents_start.sh -R`) — heavy-handed for what should be a one-tab reopen.

## Request

Any of the following would fix it:

1. **URI parameter:** `warp://tab_config/<name>?position=<index>` (or
   `?position=left|right|end`, or an `after=<tab-title>` variant).
2. **Tab Config schema key:** an optional `position = <index>` (or
   `position = "left"|"end"`) in the `.toml`.
3. **URI to move an existing tab:** e.g.
   `warp://tab/move?title=<title>&to=<index>` — so a script can reorder
   already-open tabs without closing them.
4. **AppleScript/JXA support for tab ordering** (Warp currently has no
   scripting dictionary for tab management).

Use case: launcher scripts and Dock apps that keep a multi-agent workspace
tidy; users who keep tab order as a mental map of their fleet.
