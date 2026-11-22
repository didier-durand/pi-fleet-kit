# Feature Request: Run shell directly from the File Tree (Project Explorer) — "Open shell here" + embedded execution

<!--
Submit at: https://github.com/warpdotdev/warp/issues/new?template=feature_request.yml
-->

### Pre-submit Checks

- [x] I have searched Warp feature requests and there are no duplicates
- [x] I have searched Warp docs and my feature is not there

### Describe the solution you'd like?

I'd like the File Tree (Project Explorer) to support **running a shell at the
browsed location**, in two complementary forms:

**1. "Open shell here" — launch a terminal anchored to the folder**

- Right-click a folder → **Open shell here** → opens a new terminal pane
  (or tab, per a setting) whose `cwd` is that folder.
- Right-click a file → **Open shell in enclosing folder**.
- Optional niceties:
  - A modifier-key variant (e.g. ⌥-click) to open it as a **split pane** in
    the current tab, matching the existing "Open in new pane" behavior for
    files.
  - A per-session option to reuse the pane's configured shell (e.g. `pwsh`,
    `fish`) and to respect the pane's working-directory setting.

**2. "Run shell here" — execute directly inside the file tree panel**

In addition to opening a terminal pane, it would be very useful to be able to
run the shell **directly within the File Tree panel** (or a bottom strip of
it), so execution results are visible right next to the files being acted
on:

- Right-click a folder → **Run shell here** → an embedded shell (or command
  input) opens inline within the File Tree panel, `cwd` set to that folder.
- Commands run there render their output **in place** — e.g. `git status`,
  `ls`, `npm test`, `make` — with the file tree auto-refreshing as files are
  added/removed/changed (which the tree already does).
- An optional **command input field** (like a mini prompt) at the bottom of
  the panel would let users type one-off commands against the selected
  folder without spawning a full pane — results appear as blocks, matching
  Warp's existing block model.
- A toggle to switch the embedded view between the file tree and the
  embedded shell (similar to how VS Code's panel hosts Terminal / Problems /
  Output tabs in the same region).

The key difference from option 1: the shell/execution lives **in the same
surface as the file tree**, so the user stays in the browsing context — open
a folder, run a command, immediately see the resulting files appear in the
tree — rather than context-switching to a separate terminal pane.

### Is your feature request related to a problem? Please describe.

Warp's built-in File Tree is a full project explorer, but it currently has no
way to jump into a shell at a browsed location. Today the only ways to get a
shell in a specific directory are:

1. Type a `cd` command manually (copying the path first via "Copy path").
2. Pre-configure a Tab Config with a hardcoded `directory`.
3. Use the OS file manager's "Open terminal here" (outside Warp entirely).

This is friction compared to IDEs (VS Code, JetBrains) where "Open in
Terminal" is available directly from the Explorer's context menu. Since Warp
is an agentic development environment where the file tree, editor, and
terminal live side by side, browsing to a folder and immediately running
commands there (git operations, builds, tests, scripts) is a very common
workflow.

The embedded form (option 2) closes the loop further: after running a
command that produces files (scaffolding, builds, `git checkout`, etc.), the
user sees the results appear in the same tree without moving focus — today
that requires bouncing between the tree and a terminal pane.

### Describe alternatives you've considered

- **Copy path → split pane → `cd $(pbpaste)`**: works, but is 4 manual steps
  and platform-specific.
- **Tab Configs with `directory`**: great for fixed, known locations, but
  doesn't help when browsing/discovering a folder in a large repo.
- **`warp://` URI scheme**: requires a pre-created config per directory.
- **Editor pane + preview**: files can be opened and edited in place, but
  there is no way to execute commands against their directory from the
  browsing surface itself.

### Additional context

- Related issues: #7488 (VS Code-like layout — explorer + editor + terminal),
  #12511 and #10558 (Project Explorer root scoping), #6357 (launching Warp in
  a specified working directory from the OS side).
- Docs: the File Tree context menu currently only offers *Open in new
  pane/tab*, *Attach as context*, *Create new file* (folders), and *Copy
  path* — no shell action: https://docs.warp.dev/code/code-editor/file-tree/

### Environment

- Warp version: (your version — Settings → About)
- OS: macOS
- Shell: zsh
