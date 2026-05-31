# git-changed-files-explorer

Fresh editor plugin that marks Git changed files in Fresh's native
`file-explorer` and provides a dedicated changed-files panel/picker for opening
changes side by side.

See [DESIGN.md](./DESIGN.md) for the design goals, user flow, constraints, and
acceptance criteria.

## Features

- Adds Git status badges to Fresh's native `file-explorer`.
- Shows a dedicated `Git Changed Files` side panel grouped by change type when
  possible.
- Opens the selected changed file in a side-by-side editor split.
- Includes modified, added, deleted, renamed, and untracked files when Git
  reports them.
- Refreshes on file open, save, file-explorer filesystem changes, focus gain, and editor init.

## Design Constraints

Fresh currently exposes file-explorer decorations through
`setFileExplorerDecorations`, but it does not expose a hook for overriding
native file-explorer item activation. For that reason, this plugin uses native
`file-explorer` badges for visibility and its own changed-files panel or picker
for guaranteed side-by-side opening.

## Commands

- `Git Changed Files: Show`
  Opens the changed-files panel. By default, the plugin binds this command to
  `F8` when that key is available.
- `Git Changed Files: Open Side By Side`
  Opens a picker for changed files and opens the selected file in a side split.
- `Git Changed Files: Refresh`
  Refreshes Git status badges and the changed-files panel.

## Behavior

- Files are resolved relative to the active Fresh workspace Git repository.
- Deleted files are listed but are not opened as normal file buffers.
- When no Git repository is available, the plugin shows an empty state instead
  of offering file actions.
- If a selected file is already open, the plugin focuses the existing side-by-side
  editor instead of duplicating tabs when Fresh can provide that behavior.

## Installation

### Install from GitHub

On another machine, install the plugin directly from this repository:

1. Open the Fresh command palette with `Ctrl+P`, then type `>`.
2. Run `pkg: Install from URL`.
3. Paste:
   `https://github.com/xxbern/fresh-plugin-git-changed-file-explorer`
4. Restart Fresh.

### Manual install

Copy this repository into Fresh's plugin packages directory:

```sh
mkdir -p ~/.config/fresh/plugins/packages
git clone https://github.com/xxbern/fresh-plugin-git-changed-file-explorer \
  ~/.config/fresh/plugins/packages/git-changed-files-explorer
```

Then restart Fresh.

## Development

Run the validation script before packaging or installing locally:

```sh
./validate.sh
```

For local development, copy `plugin.ts` into the installed package directory:

```sh
cp plugin.ts ~/.config/fresh/plugins/packages/git-changed-files-explorer/plugin.ts
```

The plugin entry point is `plugin.ts`, as declared in `package.json`.
