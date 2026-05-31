# Design: Fresh Editor Git Changed Files Plugin

## Goal

Build a Fresh editor plugin that surfaces Git changed files inside Fresh's `file-explorer` and opens a selected file in Fresh's side-by-side editor mode.

## Target Platform

- Plugin host: Fresh editor.
- Primary integration point: Fresh `file-explorer`.
- Primary editor action: open selected file using Fresh side-by-side mode.
- Repository source: the Git repository for the active Fresh workspace.
- Fresh API constraint: native `file-explorer` decoration is supported, but overriding native file activation is not exposed. The implementation uses native `file-explorer` Git badges plus a plugin-owned changed-files panel/picker for the side-by-side open action.

## User Flow

1. The plugin reads the current Git repository status.
2. Changed files are marked inside Fresh `file-explorer`.
3. The user opens the plugin's changed-files panel or picker and selects a file. In the panel, clicking a changed-file row opens it directly.
4. The plugin asks Fresh to open that file beside the current editor, using side-by-side mode.

## Scope

- Show tracked file changes from Git inside Fresh `file-explorer` as status decorations.
- Include modified, added, deleted, renamed, and untracked files when available.
- Keep the explorer list in sync with repository state.
- Open files through Fresh's side-by-side editor API from the plugin's changed-files panel or picker.

## UI Behavior

- Use compact Fresh `file-explorer` badges and a changed-files panel grouped by change type when possible.
- Show the relative path for each file.
- Reflect file state with a small status label or icon.
- Keep selection and refresh behavior predictable.

## Interaction Rules

- Single click in the plugin changed-files panel or picker selection triggers open behavior.
- If the file is already open, focus the Fresh side-by-side editor instead of duplicating tabs.
- If the selected item is deleted, do not try to open the file content; show a clear failure state.
- If no Git repository is available, show an empty state with no actions.

## Data Flow

- Detect repository root.
- Run Git status lookup for changed files.
- Normalize file paths to workspace-relative paths.
- Feed the explorer view from the derived change list.

## Edge Cases

- Nested repositories.
- Files outside the current workspace.
- Large change sets.
- Renamed files with old and new paths.
- Binary or deleted files.

## Acceptance Criteria

- Changed files are visible in the explorer.
- Clicking a changed file opens it side by side.
- The list updates when Git changes.
- Empty and error states are handled cleanly.
