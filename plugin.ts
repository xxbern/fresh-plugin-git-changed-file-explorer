/// <reference path="./lib/fresh.d.ts" />

const editor = getEditor();

const NAMESPACE = "git-changed-files-explorer";
const PANEL_NAME = "*Git Changed Files*";
const PANEL_MODE = "git-changed-files-explorer";
const PANEL_ID = "git-changed-files-panel";
const DIFF_BUFFER_NAME = "*Git Changed Diff*";
const TARGET_SPLIT_ID = "git-changed-files-target";
const TOGGLE_FILE_EXPLORER_ACTION = "ToggleFileExplorer";
const DEFAULT_SHOW_KEYS = ["F8", "F9", "F10", "F12"];

type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

interface GitChange {
  path: string;
  relativePath: string;
  oldRelativePath: string | null;
  kind: ChangeKind;
  symbol: string;
  color: string;
  priority: number;
  deleted: boolean;
}

interface PluginState {
  repoRoot: string | null;
  changes: GitChange[];
  refreshInFlight: boolean;
  panelBufferId: number | null;
  panelSplitId: number | null;
  targetSplitId: number | null;
  compositeBufferId: number | null;
  oldDiffBufferId: number | null;
  newDiffBufferId: number | null;
  sourceSplitId: number | null;
  suppressNextFileExplorerToggle: boolean;
  suppressPanelClosedSideEffects: boolean;
  suppressLayoutCloseUntil: number;
  fileExplorerVisible: boolean | null;
  promptChanges: GitChange[];
}

const state: PluginState = {
  repoRoot: null,
  changes: [],
  refreshInFlight: false,
  panelBufferId: null,
  panelSplitId: null,
  targetSplitId: null,
  compositeBufferId: null,
  oldDiffBufferId: null,
  newDiffBufferId: null,
  sourceSplitId: null,
  suppressNextFileExplorerToggle: false,
  suppressPanelClosedSideEffects: false,
  suppressLayoutCloseUntil: 0,
  fileExplorerVisible: null,
  promptChanges: [],
};

type KeybindingConfigEntry = {
  key?: string;
  modifiers?: string[];
  action?: string;
  when?: string | null;
};

const COLORS: Record<ChangeKind, string> = {
  added: "ui.file_status_added_fg",
  modified: "ui.file_status_modified_fg",
  deleted: "ui.file_status_deleted_fg",
  renamed: "ui.file_status_renamed_fg",
  copied: "ui.file_status_renamed_fg",
  untracked: "ui.file_status_untracked_fg",
  conflicted: "ui.file_status_conflicted_fg",
};

const PRIORITY: Record<ChangeKind, number> = {
  conflicted: 90,
  deleted: 80,
  added: 60,
  modified: 50,
  renamed: 40,
  copied: 40,
  untracked: 30,
};

function kindFromStatus(status: string): ChangeKind | null {
  switch (status) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    default:
      return null;
  }
}

function symbolForKind(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
  }
}

function labelForKind(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflicted";
  }
}

function makeChange(
  repoRoot: string,
  relativePath: string,
  kind: ChangeKind,
  oldRelativePath: string | null = null,
): GitChange {
  const absolutePath = editor.pathJoin(repoRoot, relativePath);
  return {
    path: absolutePath,
    relativePath,
    oldRelativePath,
    kind,
    symbol: symbolForKind(kind),
    color: COLORS[kind],
    priority: PRIORITY[kind],
    deleted: kind === "deleted",
  };
}

function chooseStatusKind(x: string, y: string): ChangeKind | null {
  if (x === "?" && y === "?") {
    return "untracked";
  }
  if (x === "U" || y === "U") {
    return "conflicted";
  }
  if (x !== " " && x !== "?") {
    return kindFromStatus(x);
  }
  if (y !== " ") {
    return kindFromStatus(y);
  }
  return null;
}

function parseGitStatus(output: string, repoRoot: string): GitChange[] {
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const byPath = new Map<string, GitChange>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 3) {
      continue;
    }

    const x = entry[0];
    const y = entry[1];
    const kind = chooseStatusKind(x, y);
    if (kind === null) {
      continue;
    }

    let relativePath = entry.slice(3);
    let oldRelativePath: string | null = null;

    if ((x === "R" || x === "C" || y === "R" || y === "C") && i + 1 < entries.length) {
      oldRelativePath = relativePath;
      i += 1;
      relativePath = entries[i];
    }

    const change = makeChange(repoRoot, relativePath, kind, oldRelativePath);
    const existing = byPath.get(change.path);
    if (!existing || change.priority >= existing.priority) {
      byPath.set(change.path, change);
    }
  }

  return Array.from(byPath.values()).sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });
}

async function loadGitChanges(): Promise<GitChange[]> {
  const cwd = editor.getCwd();
  const rootResult = await editor.spawnProcess("git", ["rev-parse", "--show-toplevel"], cwd);
  if (rootResult.exit_code !== 0) {
    state.repoRoot = null;
    return [];
  }

  const repoRoot = rootResult.stdout.trim();
  if (repoRoot.length === 0) {
    state.repoRoot = null;
    return [];
  }

  state.repoRoot = repoRoot;

  const statusResult = await editor.spawnProcess(
    "git",
    ["status", "--porcelain", "-z"],
    repoRoot,
  );
  if (statusResult.exit_code !== 0) {
    editor.debug(`Git Changed Files: git status failed: ${statusResult.stderr}`);
    return [];
  }

  return parseGitStatus(statusResult.stdout, repoRoot);
}

function applyFileExplorerDecorations(changes: GitChange[]): void {
  if (changes.length === 0) {
    editor.clearFileExplorerDecorations(NAMESPACE);
    return;
  }

  editor.setFileExplorerDecorations(
    NAMESPACE,
    changes.map((change) => ({
      path: change.path,
      symbol: change.symbol,
      color: change.color,
      priority: change.priority,
    })),
  );
}

function renderEntries(changes: GitChange[]): TextPropertyEntry[] {
  if (state.repoRoot === null) {
    return [
      {
        text: "Git Changed Files\nNo Git repository found for this Fresh workspace.\n",
      },
    ];
  }

  if (changes.length === 0) {
    return [
      {
        text: "Git Changed Files\nNo changed files.\n",
      },
    ];
  }

  const entries: TextPropertyEntry[] = [
    {
      text: `Git Changed Files (${changes.length})\n`,
      style: { bold: true },
    },
  ];

  for (const change of changes) {
    const label = labelForKind(change.kind).padEnd(10, " ");
    const renameSuffix = change.oldRelativePath
      ? `  <- ${change.oldRelativePath}`
      : "";
    entries.push({
      text: `${change.symbol}  ${label} ${change.relativePath}${renameSuffix}\n`,
      properties: {
        gitChangedFilePath: change.path,
        gitChangedFileDeleted: change.deleted,
        gitChangedFileRelativePath: change.relativePath,
      },
      style: {
        fg: change.color,
      },
    });
  }

  return entries;
}

function updatePanel(): void {
  if (state.panelBufferId === null) {
    return;
  }
  editor.setVirtualBufferContent(state.panelBufferId, renderEntries(state.changes));
}

function splitExists(splitId: number): boolean {
  return editor.listSplits().some((split) => split.splitId === splitId);
}

function splitIdForBuffer(bufferId: number): number | null {
  const bufferInfo = editor.getBufferInfo(bufferId);
  if (bufferInfo !== null && bufferInfo.splits.length > 0) {
    return bufferInfo.splits[0];
  }

  const split = editor.listSplits().find((candidate) => candidate.bufferId === bufferId);
  return split === undefined ? null : split.splitId;
}

function isPanelSplit(splitId: number): boolean {
  if (state.panelBufferId !== null) {
    const bufferInfo = editor.getBufferInfo(state.panelBufferId);
    if (bufferInfo !== null && bufferInfo.splits.includes(splitId)) {
      return true;
    }
  }

  return editor
    .listSplits()
    .some(
      (split) =>
        split.splitId === splitId &&
        state.panelBufferId !== null &&
        split.bufferId === state.panelBufferId,
    );
}

function isKnownPanelSplit(splitId: number): boolean {
  return splitId === state.panelSplitId || isPanelSplit(splitId);
}

function refreshPanelSplitId(): void {
  if (state.panelBufferId === null) {
    return;
  }

  const splitId = splitIdForBuffer(state.panelBufferId);
  if (splitId !== null) {
    state.panelSplitId = splitId;
  } else {
    state.panelSplitId = null;
  }
}

function reconcilePanelState(): void {
  if (
    state.panelBufferId !== null &&
    !editor.listBuffers().some((buffer) => buffer.id === state.panelBufferId)
  ) {
    state.panelBufferId = null;
    state.panelSplitId = null;
    return;
  }

  if (state.panelSplitId !== null && !splitExists(state.panelSplitId)) {
    state.panelSplitId = null;
  }

  refreshPanelSplitId();
}

function isPanelVisible(): boolean {
  if (state.panelBufferId === null) {
    return false;
  }

  const splitId = splitIdForBuffer(state.panelBufferId);
  return splitId !== null && splitExists(splitId);
}

function handlePanelNoLongerVisible(): void {
  if (
    state.panelBufferId !== null &&
    !state.suppressPanelClosedSideEffects &&
    !isPanelVisible()
  ) {
    state.panelBufferId = null;
    state.panelSplitId = null;
    closeActiveDiffView();
    openFileExplorerIfClosed();
  }
}

function fileExplorerWidthFraction(): number {
  const config = editor.getConfig() as {
    file_explorer?: {
      width?: unknown;
    };
  };
  const width = config.file_explorer?.width ?? "30%";

  if (typeof width === "string") {
    const trimmed = width.trim();
    if (trimmed.endsWith("%")) {
      const percent = parseFloat(trimmed.slice(0, -1));
      if (Number.isFinite(percent)) {
        return Math.min(0.9, Math.max(0.05, percent / 100));
      }
    }

    const columns = parseFloat(trimmed);
    if (Number.isFinite(columns) && columns > 0) {
      return Math.min(0.9, Math.max(0.05, columns / editor.getScreenSize().width));
    }
  }

  if (typeof width === "number" && Number.isFinite(width)) {
    if (width > 0 && width <= 1) {
      return Math.min(0.9, Math.max(0.05, width));
    }
    return Math.min(0.9, Math.max(0.05, width / 100));
  }

  return 0.3;
}

function fileExplorerSplitRatio(): number {
  return 0.2;
}

function isChangedFilesBuffer(buffer: BufferInfo): boolean {
  if (state.panelBufferId !== null && buffer.id === state.panelBufferId) {
    return true;
  }

  const raw = buffer as BufferInfo & Record<string, unknown>;
  const title =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.title === "string"
        ? raw.title
        : typeof raw.display_name === "string"
          ? raw.display_name
          : "";

  return title.startsWith("*Git Changed Files");
}

function closeChangedFilesBuffers(suppressClosedSideEffects = false): void {
  const previousSuppress = state.suppressPanelClosedSideEffects;
  state.suppressPanelClosedSideEffects = suppressClosedSideEffects;
  try {
    for (const buffer of editor.listBuffers()) {
      if (isChangedFilesBuffer(buffer)) {
        const splitIds = new Set<number>(buffer.splits);
        const splitId = splitIdForBuffer(buffer.id);
        if (splitId !== null) {
          splitIds.add(splitId);
        }
        editor.closeBuffer(buffer.id);
        for (const id of splitIds) {
          if (splitExists(id)) {
            editor.closeSplit(id);
          }
        }
      }
    }
  } finally {
    state.suppressPanelClosedSideEffects = previousSuppress;
  }

  state.panelBufferId = null;
  state.panelSplitId = null;
}

function debugSplitState(context: string, targetSplitId: number | null = null): void {
  const summary = splitStateSummary(context, targetSplitId);
  editor.debug(summary);
  editor.setStatus(summary);
}

function splitStateSummary(context: string, targetSplitId: number | null = null): string {
  const splits = editor
    .listSplits()
    .map((split) => `${split.splitId}:${split.bufferId}:${split.viewport.width}x${split.viewport.height}`)
    .join(",");
  const panelInfo =
    state.panelBufferId === null ? null : editor.getBufferInfo(state.panelBufferId)?.splits ?? null;
  return `Git Changed Files: ${context} active=${editor.getActiveSplitId()} source=${state.sourceSplitId} target=${state.targetSplitId} panelSplit=${state.panelSplitId} panelBuffer=${state.panelBufferId} panelInfo=${JSON.stringify(panelInfo)} targetArg=${targetSplitId} splits=[${splits}]`;
}

function debugListBuffers(): void {
  for (const buffer of editor.listBuffers()) {
    const raw = buffer as BufferInfo & Record<string, unknown>;
    const title =
      typeof raw.name === "string"
        ? raw.name
        : typeof raw.title === "string"
          ? raw.title
          : typeof raw.display_name === "string"
            ? raw.display_name
            : "";
    editor.debug(
      `Git Changed Files: buffer id=${buffer.id} title=${JSON.stringify(title)} path=${JSON.stringify(buffer.path)} virtual=${buffer.is_virtual} splits=${JSON.stringify(buffer.splits)} keys=${JSON.stringify(Object.keys(raw))}`,
    );
  }
}

function installDefaultShowKeybinding(): void {
  const config = editor.getConfig() as { keybindings?: unknown };
  const keybindings: KeybindingConfigEntry[] = Array.isArray(config.keybindings)
    ? (config.keybindings as KeybindingConfigEntry[])
    : [];

  const existingIndex = keybindings.findIndex((binding) => binding.action === "git_changed_files_show");
  if (existingIndex >= 0) {
    const nextKeybindings = [...keybindings];
    nextKeybindings[existingIndex] = {
      ...nextKeybindings[existingIndex],
      when: null,
    };
    editor.setSetting("keybindings", nextKeybindings);
    return;
  }

  const usedKeys = new Set(
    keybindings
      .filter((binding) => (binding.modifiers ?? []).length === 0)
      .map((binding) => binding.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const key = DEFAULT_SHOW_KEYS.find((candidate) => !usedKeys.has(candidate));
  if (key === undefined) {
    editor.setStatus("No free default key found for Git Changed Files");
    return;
  }

  const nextKeybindings = [
    ...keybindings,
    {
      key,
      modifiers: [],
      action: "git_changed_files_show",
      when: null,
    },
  ];
  if (editor.setSetting("keybindings", nextKeybindings)) {
    editor.setStatus(`Git Changed Files: bound ${key}`);
  }
}

function widestNonPanelSplit(): number | null {
  const splits = editor
    .listSplits()
    .filter(
      (split) =>
        !isKnownPanelSplit(split.splitId) &&
        (state.panelBufferId === null || split.bufferId !== state.panelBufferId),
    );
  if (splits.length === 0) {
    return null;
  }

  let widest = splits[0];
  for (const split of splits) {
    if (split.viewport.width > widest.viewport.width) {
      widest = split;
    }
  }
  return widest.splitId;
}

function visibleFileBufferSplit(): number | null {
  const candidateSplitIds = new Set<number>();
  for (const buffer of editor.listBuffers()) {
    if (buffer.path.length === 0) {
      continue;
    }
    for (const splitId of buffer.splits) {
      if (!isKnownPanelSplit(splitId) && splitExists(splitId)) {
        candidateSplitIds.add(splitId);
      }
    }
  }

  let bestSplitId: number | null = null;
  let bestWidth = -1;
  for (const split of editor.listSplits()) {
    if (candidateSplitIds.has(split.splitId) && split.viewport.width > bestWidth) {
      bestSplitId = split.splitId;
      bestWidth = split.viewport.width;
    }
  }
  return bestSplitId;
}

function hasLikelyFileExplorerSplit(): boolean {
  const splits = editor.listSplits();
  if (splits.length <= 1) {
    return false;
  }

  const screenWidth = editor.getScreenSize().width;
  return splits.some(
    (split) =>
      !isKnownPanelSplit(split.splitId) &&
      split.viewport.width <= screenWidth * 0.5,
  );
}

function rememberTargetSplit(): void {
  refreshPanelSplitId();
  const activeSplitId = editor.getActiveSplitId();
  if (isKnownPanelSplit(activeSplitId)) {
    return;
  }

  const activeSplit = editor
    .listSplits()
    .find((split) => split.splitId === activeSplitId);
  const widestSplitId = widestNonPanelSplit();
  const targetSplitId =
    activeSplit !== undefined &&
    widestSplitId !== null &&
    activeSplit.viewport.width < editor.getScreenSize().width / 2
      ? widestSplitId
      : activeSplitId;

  state.targetSplitId = targetSplitId;
  state.sourceSplitId = targetSplitId;
  editor.setSplitLabel(targetSplitId, TARGET_SPLIT_ID);
}

async function hideFileExplorerForPanel(): Promise<void> {
  rememberTargetSplit();
  if (state.fileExplorerVisible === true || hasLikelyFileExplorerSplit()) {
    debugSplitState("toggle-file-explorer-for-changed-panel");
    state.suppressNextFileExplorerToggle = true;
    if (!editor.executeAction("toggle_file_explorer")) {
      state.suppressNextFileExplorerToggle = false;
    } else {
      state.fileExplorerVisible = false;
    }
  } else {
    debugSplitState("skip-file-explorer-toggle-for-changed-panel");
  }
}

async function refreshGitChangedFiles(): Promise<void> {
  if (state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    state.changes = await loadGitChanges();
    applyFileExplorerDecorations(state.changes);
    updatePanel();
    editor.setStatus(`Git changed files: ${state.changes.length}`);
  } catch (error) {
    editor.clearFileExplorerDecorations(NAMESPACE);
    editor.debug(`Git Changed Files refresh failed: ${String(error)}`);
  } finally {
    state.refreshInFlight = false;
  }
}

async function showGitChangedFilesPanel(): Promise<void> {
  await refreshGitChangedFiles();
  suppressLayoutClose(500);
  closeChangedFilesBuffers(true);
  reconcilePanelState();

  state.sourceSplitId = editor.getActiveSplitId();
  await hideFileExplorerForPanel();
  if (state.sourceSplitId !== null && splitExists(state.sourceSplitId)) {
    editor.focusSplit(state.sourceSplitId);
  }

  const result = await editor.createVirtualBufferInSplit({
    name: PANEL_NAME,
    mode: PANEL_MODE,
    readOnly: true,
    editingDisabled: true,
    showLineNumbers: false,
    showCursors: true,
    lineWrap: false,
    direction: "vertical",
    ratio: fileExplorerSplitRatio(),
    before: true,
    panelId: PANEL_ID,
    entries: renderEntries(state.changes),
  });

  state.panelBufferId = result.bufferId;
  await editor.delay(20);
  state.panelSplitId = splitIdForBuffer(result.bufferId) ?? result.splitId;
  if (state.panelSplitId !== null) {
    editor.setSplitLabel(state.panelSplitId, PANEL_ID);
    editor.focusSplit(state.panelSplitId);
  }
}

async function toggleGitChangedFilesPanel(): Promise<void> {
  reconcilePanelState();
  if (isPanelVisible()) {
    closePanel(true, true);
    return;
  }

  await showGitChangedFilesPanel();
}

async function targetSplitForOpen(): Promise<{ splitId: number; placeholderBufferId: number | null } | null> {
  refreshPanelSplitId();

  const fileSplitId = visibleFileBufferSplit();
  if (fileSplitId !== null) {
    state.sourceSplitId = fileSplitId;
    state.targetSplitId = fileSplitId;
    editor.setSplitLabel(fileSplitId, TARGET_SPLIT_ID);
    return { splitId: fileSplitId, placeholderBufferId: null };
  }

  if (
    state.sourceSplitId !== null &&
    splitExists(state.sourceSplitId) &&
    !isKnownPanelSplit(state.sourceSplitId)
  ) {
    state.targetSplitId = state.sourceSplitId;
    editor.setSplitLabel(state.sourceSplitId, TARGET_SPLIT_ID);
    return { splitId: state.sourceSplitId, placeholderBufferId: null };
  }

  const fallbackSplitId = widestNonPanelSplit();
  if (fallbackSplitId !== null && !isKnownPanelSplit(fallbackSplitId)) {
    state.sourceSplitId = fallbackSplitId;
    state.targetSplitId = fallbackSplitId;
    editor.setSplitLabel(fallbackSplitId, TARGET_SPLIT_ID);
    return { splitId: fallbackSplitId, placeholderBufferId: null };
  }

  if (
    state.targetSplitId !== null &&
    splitExists(state.targetSplitId) &&
    !isKnownPanelSplit(state.targetSplitId)
  ) {
    return { splitId: state.targetSplitId, placeholderBufferId: null };
  }

  const result = await editor.createVirtualBufferInSplit({
    name: "*Git Changed Preview*",
    mode: PANEL_MODE,
    readOnly: true,
    editingDisabled: true,
    showLineNumbers: false,
    showCursors: false,
    lineWrap: false,
    direction: "vertical",
    ratio: 0.5,
    before: false,
    entries: [{ text: "Opening changed file...\n" }],
  });

  await editor.delay(20);
  const splitId = splitIdForBuffer(result.bufferId) ?? result.splitId;
  if (splitId === null) {
    editor.closeBuffer(result.bufferId);
    editor.setStatus("Failed to locate editor split for changed file diff");
    return null;
  }

  state.targetSplitId = splitId;
  editor.setSplitLabel(splitId, TARGET_SPLIT_ID);
  return { splitId, placeholderBufferId: result.bufferId };
}

function entriesFromText(text: string): TextPropertyEntry[] {
  const lines = text.length === 0 ? [""] : text.split("\n");
  return lines.map((line, index) => ({
    text: `${line}\n`,
    properties: { lineNum: index + 1 },
  }));
}

function parseCompositeHunks(diffOutput: string): TsCompositeHunk[] {
  const hunks: TsCompositeHunk[] = [];
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of diffOutput.split("\n")) {
    const match = line.match(hunkRegex);
    if (!match) {
      continue;
    }

    const oldStart = parseInt(match[1], 10);
    const oldCount = match[2] === undefined ? 1 : parseInt(match[2], 10);
    const newStart = parseInt(match[3], 10);
    const newCount = match[4] === undefined ? 1 : parseInt(match[4], 10);

    hunks.push({
      oldStart: Math.max(0, oldStart - 1),
      oldCount: oldCount || 1,
      newStart: Math.max(0, newStart - 1),
      newCount: newCount || 1,
    });
  }

  return hunks;
}

function lineCountForContent(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  const lines = text.split("\n").length;
  return text.endsWith("\n") ? Math.max(1, lines - 1) : lines;
}

function wholeFileHunk(content: string): TsCompositeHunk[] {
  return [
    {
      oldStart: 0,
      oldCount: 1,
      newStart: 0,
      newCount: lineCountForContent(content),
    },
  ];
}

function closeActiveDiffView(): void {
  if (state.compositeBufferId !== null) {
    try {
      editor.closeCompositeBuffer(state.compositeBufferId);
    } catch {}
    editor.closeBuffer(state.compositeBufferId);
  }
  if (state.oldDiffBufferId !== null) {
    editor.closeBuffer(state.oldDiffBufferId);
  }
  if (state.newDiffBufferId !== null) {
    editor.closeBuffer(state.newDiffBufferId);
  }

  state.compositeBufferId = null;
  state.oldDiffBufferId = null;
  state.newDiffBufferId = null;
}

function closePlaceholderBuffer(bufferId: number | null): void {
  if (bufferId !== null) {
    editor.closeBuffer(bufferId);
  }
}

async function openChangeSideBySide(change: GitChange): Promise<void> {
  if (state.repoRoot === null) {
    editor.setStatus("No Git repository found");
    return;
  }

  editor.setStatus(`Loading side-by-side diff: ${change.relativePath}`);
  suppressLayoutClose(500);

  const oldPath = change.oldRelativePath ?? change.relativePath;
  let oldContent = "";
  if (change.kind !== "untracked") {
    const oldResult = await editor.spawnProcess("git", ["show", `HEAD:${oldPath}`], state.repoRoot);
    oldContent = oldResult.exit_code === 0 ? oldResult.stdout : "";
  }

  let newContent = "";
  if (!change.deleted) {
    const readResult = editor.readFile(change.path);
    if (readResult === null) {
      editor.setStatus(`Failed to read ${change.relativePath}`);
      return;
    }
    newContent = readResult;
  }

  let hunks: TsCompositeHunk[] = [];
  if (change.kind === "untracked") {
    hunks = wholeFileHunk(newContent);
  } else {
    const diffResult = await editor.spawnProcess(
      "git",
      ["diff", "HEAD", "--no-color", "--unified=0", "--", change.relativePath],
      state.repoRoot,
    );
    hunks = diffResult.exit_code <= 1 ? parseCompositeHunks(diffResult.stdout) : [];
  }

  let target = await targetSplitForOpen();
  if (target === null) {
    return;
  }
  if (isKnownPanelSplit(target.splitId)) {
    debugSplitState("target-was-panel", target.splitId);
    closePlaceholderBuffer(target.placeholderBufferId);
    const fallbackSplitId = widestNonPanelSplit();
    if (fallbackSplitId === null) {
      editor.setStatus("No editor split available for changed file diff");
      return;
    }
    state.sourceSplitId = fallbackSplitId;
    state.targetSplitId = fallbackSplitId;
    editor.setSplitLabel(fallbackSplitId, TARGET_SPLIT_ID);
    target = { splitId: fallbackSplitId, placeholderBufferId: null };
  }
  closeActiveDiffView();

  if (!editor.focusSplit(target.splitId)) {
    closePlaceholderBuffer(target.placeholderBufferId);
    debugSplitState("failed-focus-target", target.splitId);
    return;
  }

  const oldBuffer = await editor.createVirtualBuffer({
    name: `*HEAD:${change.relativePath}*`,
    mode: "normal",
    readOnly: true,
    editingDisabled: true,
    showLineNumbers: true,
    hiddenFromTabs: true,
    entries: entriesFromText(oldContent),
  });

  const newBuffer = await editor.createVirtualBuffer({
    name: `*WORKTREE:${change.relativePath}*`,
    mode: "normal",
    readOnly: true,
    editingDisabled: true,
    showLineNumbers: true,
    hiddenFromTabs: true,
    entries: entriesFromText(newContent),
  });

  const compositeBufferId = await editor.createCompositeBuffer({
    name: DIFF_BUFFER_NAME,
    mode: "git-changed-files-diff",
    layout: {
      type: "side-by-side",
      ratios: [0.5, 0.5],
      showSeparator: true,
    },
    sources: [
      {
        bufferId: oldBuffer.bufferId,
        label: "HEAD",
        editable: false,
        style: { gutterStyle: "diff-markers" },
      },
      {
        bufferId: newBuffer.bufferId,
        label: "WORKTREE",
        editable: false,
        style: { gutterStyle: "diff-markers" },
      },
    ],
    hunks: hunks.length > 0 ? hunks : null,
    initialFocusHunk: hunks.length > 0 ? 0 : undefined,
  });

  state.compositeBufferId = compositeBufferId;
  state.oldDiffBufferId = oldBuffer.bufferId;
  state.newDiffBufferId = newBuffer.bufferId;

  const setResult = editor.setSplitBuffer(target.splitId, compositeBufferId);
  let showResult = false;
  if (!setResult) {
    editor.focusSplit(target.splitId);
    await editor.delay(20);
    if (editor.getActiveSplitId() === target.splitId) {
      showResult = editor.showBuffer(compositeBufferId);
    }
  }
  closePlaceholderBuffer(target.placeholderBufferId);
  editor.debug(
    `Git Changed Files: open diff target=${target.splitId} composite=${compositeBufferId} setSplitBuffer=${setResult} showBuffer=${showResult}`,
  );
  editor.setStatus(
    setResult || showResult
      ? `Opened side-by-side diff: ${change.relativePath}`
      : `Failed to show side-by-side diff: ${change.relativePath}`,
  );
}

function changeForPath(path: string): GitChange | null {
  for (const change of state.changes) {
    if (change.path === path) {
      return change;
    }
  }
  return null;
}

async function openSelectedChangedFile(): Promise<void> {
  if (state.changes.length === 0) {
    await refreshGitChangedFiles();
  }

  const bufferId = editor.getActiveBufferId();
  const props = editor.getTextPropertiesAtCursor(bufferId);
  for (const prop of props) {
    const path = prop.gitChangedFilePath;
    if (typeof path === "string") {
      const change = changeForPath(path);
      if (change !== null) {
        await openChangeSideBySide(change);
        return;
      }
    }
  }

  editor.setStatus("No changed file selected");
}

async function openClickedChangedFile(args: MouseClickHookArgs): Promise<void> {
  if (args.button !== "left") {
    return;
  }
  if (state.panelBufferId === null || args.buffer_id !== state.panelBufferId) {
    return;
  }
  if (args.buffer_row === null) {
    return;
  }

  const changeIndex = args.buffer_row - 1;
  if (changeIndex >= 0 && changeIndex < state.changes.length) {
    await openChangeSideBySide(state.changes[changeIndex]);
    return;
  }

  // Mouse hooks can fire before Fresh has moved the buffer cursor.
  // Yield once and fall back to the cursor's text properties.
  await editor.delay(20);
  await openSelectedChangedFile();
}

async function promptOpenChangedFile(): Promise<void> {
  await refreshGitChangedFiles();
  if (state.changes.length === 0) {
    editor.setStatus(state.repoRoot === null ? "No Git repository found" : "No changed files");
    return;
  }

  state.promptChanges = state.changes.filter((change) => !change.deleted);
  const suggestions: PromptSuggestion[] = state.promptChanges.map((change) => ({
    text: `${change.symbol} ${change.relativePath}`,
    description: labelForKind(change.kind),
    value: change.relativePath,
    disabled: false,
  }));

  editor.startPrompt("Open changed file side by side: ", "git-changed-file-open");
  editor.setPromptSuggestions(suggestions);
}

function openFileExplorerIfClosed(): void {
  if (state.fileExplorerVisible === true || hasLikelyFileExplorerSplit()) {
    state.fileExplorerVisible = true;
    return;
  }

  if (editor.executeAction("toggle_file_explorer")) {
    state.fileExplorerVisible = true;
  }
}

function closePanel(focusSource = true, openFileExplorer = true): void {
  refreshPanelSplitId();
  closeChangedFilesBuffers(true);
  closeActiveDiffView();
  if (openFileExplorer) {
    openFileExplorerIfClosed();
  }
  if (focusSource && state.sourceSplitId !== null && splitExists(state.sourceSplitId)) {
    editor.focusSplit(state.sourceSplitId);
  }
}

function handlePanelClosed(args: { buffer_id: number }): void {
  if (state.panelBufferId === args.buffer_id) {
    state.panelBufferId = null;
    state.panelSplitId = null;
    if (!state.suppressPanelClosedSideEffects) {
      closeActiveDiffView();
      openFileExplorerIfClosed();
    }
  }
}

function isToggleFileExplorerAction(action: string | Record<string, unknown>): boolean {
  if (typeof action === "string") {
    return action === TOGGLE_FILE_EXPLORER_ACTION || action === "toggle_file_explorer";
  }

  return (
    Object.prototype.hasOwnProperty.call(action, TOGGLE_FILE_EXPLORER_ACTION) ||
    Object.prototype.hasOwnProperty.call(action, "toggle_file_explorer")
  );
}

function handlePreCommand(args: { action: string | Record<string, unknown> }): void {
  if (!isToggleFileExplorerAction(args.action)) {
    return;
  }

  if (state.suppressNextFileExplorerToggle) {
    return;
  }

  if (state.panelBufferId !== null || state.panelSplitId !== null) {
    closePanel(false, false);
  }
}

function handlePostCommand(args: { action: string | Record<string, unknown> }): void {
  if (state.panelBufferId !== null || state.compositeBufferId !== null) {
    editor.setStatus(`Git Changed Files: post-command action=${JSON.stringify(args.action)}`);
  }

  if (!isToggleFileExplorerAction(args.action)) {
    handlePanelNoLongerVisible();
    return;
  }

  if (state.suppressNextFileExplorerToggle) {
    state.suppressNextFileExplorerToggle = false;
    state.fileExplorerVisible = false;
  } else {
    state.fileExplorerVisible = state.fileExplorerVisible === true ? false : true;
  }
  if (state.fileExplorerVisible === true) {
    closePanel(false, false);
    closeActiveDiffView();
  }
  handlePanelNoLongerVisible();
}

function handleIdle(): void {
  if (state.panelBufferId === null && state.compositeBufferId === null) {
    return;
  }

  debugSplitState("idle-check");
  if (hasLikelyFileExplorerSplit()) {
    state.fileExplorerVisible = true;
    closePanel(false, false);
    closeActiveDiffView();
    editor.setStatus("File explorer opened; closed changed files and diff");
  }
}

function suppressLayoutClose(durationMs: number): void {
  state.suppressLayoutCloseUntil = Date.now() + durationMs;
}

function handleLayoutChanged(): void {
  if (Date.now() < state.suppressLayoutCloseUntil) {
    return;
  }
  if (state.panelBufferId === null && state.compositeBufferId === null) {
    return;
  }

  closePanel(false, false);
  closeActiveDiffView();
  state.fileExplorerVisible = true;
  editor.setStatus("Layout changed; closed changed files and diff");
}

registerHandler("git_changed_files_show", () => {
  void showGitChangedFilesPanel();
});
registerHandler("git_changed_files_refresh", () => {
  void refreshGitChangedFiles();
});
registerHandler("git_changed_files_open_selected", () => {
  void openSelectedChangedFile();
});
registerHandler("git_changed_files_mouse_click", (args: MouseClickHookArgs) => {
  void openClickedChangedFile(args);
});
registerHandler("git_changed_files_prompt_open", () => {
  void promptOpenChangedFile();
});
registerHandler("git_changed_files_close_panel", closePanel);
registerHandler("git_changed_files_panel_closed", handlePanelClosed);
registerHandler("git_changed_files_close_diff", closeActiveDiffView);
registerHandler("git_changed_files_pre_command", handlePreCommand);
registerHandler("git_changed_files_post_command", handlePostCommand);
registerHandler("git_changed_files_debug_buffers", debugListBuffers);
registerHandler("git_changed_files_idle", handleIdle);
registerHandler("git_changed_files_layout_changed", handleLayoutChanged);

editor.defineMode(
  PANEL_MODE,
  [
    ["Return", "git_changed_files_open_selected"],
    ["r", "git_changed_files_refresh"],
    ["q", "git_changed_files_close_panel"],
  ],
  true,
  false,
  true,
);

editor.defineMode(
  "git-changed-files-diff",
  [["q", "git_changed_files_close_diff"]],
  true,
  false,
  true,
);

editor.registerCommand(
  "Git Changed Files: Show",
  "Show Git changed files in a Fresh side panel",
  "git_changed_files_show",
);

editor.registerCommand(
  "Git Changed Files: Open Side By Side",
  "Pick a changed file and open it beside the current editor",
  "git_changed_files_prompt_open",
);

editor.registerCommand(
  "Git Changed Files: Refresh",
  "Refresh Git changed file explorer decorations",
  "git_changed_files_refresh",
);

editor.registerCommand(
  "Git Changed Files: Debug Buffers",
  "Log all open buffer metadata for debugging",
  "git_changed_files_debug_buffers",
);

editor.on("after_file_open", () => {
  void refreshGitChangedFiles();
});
editor.on("after_file_save", () => {
  void refreshGitChangedFiles();
});
editor.on("after_file_explorer_change", () => {
  void refreshGitChangedFiles();
});
editor.on("focus_gained", () => {
  void refreshGitChangedFiles();
});
editor.on("editor_initialized", () => {
  void refreshGitChangedFiles();
});
editor.on("buffer_closed", "git_changed_files_panel_closed");
editor.on("mouse_click", (args) => {
  void openClickedChangedFile(args);
  return true;
});

editor.on("prompt_confirmed", (args) => {
  if (args.prompt_type !== "git-changed-file-open") {
    return true;
  }

  if (args.selected_index !== null && state.promptChanges[args.selected_index] !== undefined) {
    void openChangeSideBySide(state.promptChanges[args.selected_index]);
    return true;
  }

  const selected = state.promptChanges.find((change) => change.relativePath === args.input);
  if (selected !== undefined) {
    void openChangeSideBySide(selected);
  } else {
    editor.setStatus("No changed file selected");
  }
  return true;
});
editor.on("pre_command", "git_changed_files_pre_command");
editor.on("post_command", "git_changed_files_post_command");
editor.on("idle", "git_changed_files_idle");
editor.on("viewport_changed", "git_changed_files_layout_changed");
editor.on("resize", "git_changed_files_layout_changed");

installDefaultShowKeybinding();
void refreshGitChangedFiles();
editor.debug("Git Changed Files Explorer plugin loaded");
