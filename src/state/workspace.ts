/**
 * Files, git and the editor — live UI state, never written to keel.json.
 *
 * The project folder comes from the active project in the main store. Buffers
 * live here so typing in the editor does not persist a snapshot of the file.
 * The chosen tab and each project's open folders are session state: they
 * survive switching projects, and a fresh launch starts from files and a
 * folded tree.
 */

import { create } from "zustand";
import { toast } from "sonner";

import { diffTabId, editorRefId, fileTabId } from "../lib/editorRefs.ts";
import { clearEditorReveals, revealInEditor } from "../lib/editorViews.ts";
import { changesTruncated, fileName, joinRel, parentRel } from "../lib/git.ts";
import { noteRecent, pruneRecent } from "../lib/recentFiles.ts";
import type { EditorRef } from "../lib/types.ts";
import * as api from "../lib/workspace.ts";
import { ask } from "../lib/ask.ts";
import { WorkspaceReads } from "../lib/workspaceReads.ts";
import { sameWatchRoot } from "../lib/workspaceWatch.ts";
import { deckOfPane, useKeel } from "./store.ts";
import { DEFAULT_GREP_OPTIONS } from "../lib/workspace.ts";
import type {
  CommitDetails,
  CommitFile,
  CommitOptions,
  FileContents,
  GitBranches,
  GitDiff,
  GitRemote,
  GitStash,
  GitStatus,
  GitTag,
  GrepHit,
  GrepOptions,
  LineAction,
  LineSelection,
  MergeMode,
  OperationAction,
  PrList,
  PullMode,
  ResetMode,
  WorkspaceEntry,
} from "@/lib/workspace";

export type InspectorTab = "files" | "git" | "search";
export type GitMetaSection =
  | "branches"
  | "prs"
  | "history"
  | "stashes"
  | "tags"
  | "remotes";
/** The git panel's pages. */
export type GitView = "changes" | "history" | "branches" | "stashes" | "prs";
export type ChangeLayout = "list" | "tree";

/** Commits fetched at a time; scrolling to the end asks for the next lot. */
export const HISTORY_PAGE = 100;

const CHANGE_LAYOUT_KEY = "keel.git.changeLayout";
const DIFF_LAYOUT_KEY = "keel.diff.layout";
const DIFF_CONTEXT_KEY = "keel.diff.context";

export type DiffLayout = "inline" | "split";

function readDiffLayout(): DiffLayout {
  try {
    return localStorage.getItem(DIFF_LAYOUT_KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
}

function readDiffContext(): number {
  try {
    const saved = Number(localStorage.getItem(DIFF_CONTEXT_KEY));
    return saved > 0 ? saved : 3;
  } catch {
    return 3;
  }
}

const GREP_TOGGLES_KEY = "keel.search.toggles";
const GREP_HISTORY_KEY = "keel.search.history";
/** Recent searches kept for the empty search page. */
const GREP_HISTORY_MAX = 12;

/** How you like to match is a habit, so case, word and regex stick. */
function readGrepOptions(): GrepOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(GREP_TOGGLES_KEY) ?? "{}") as Partial<GrepOptions>;
    return {
      ...DEFAULT_GREP_OPTIONS,
      caseSensitive: saved.caseSensitive === true,
      wholeWord: saved.wholeWord === true,
      regex: saved.regex === true,
    };
  } catch {
    return { ...DEFAULT_GREP_OPTIONS };
  }
}

function readGrepHistory(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(GREP_HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
const COMMIT_PREFS_KEY = "keel.git.commitPrefs";

function readChangeLayout(): ChangeLayout {
  try {
    return localStorage.getItem(CHANGE_LAYOUT_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/** Sign-off and hook skipping are habits, so they stick; amend never does. */
function readCommitPrefs(): CommitOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(COMMIT_PREFS_KEY) ?? "{}") as Partial<CommitOptions>;
    return { amend: false, signoff: saved.signoff === true, noVerify: saved.noVerify === true };
  } catch {
    return { amend: false, signoff: false, noVerify: false };
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice just lasts for this session.
  }
}

/** A view preference, so it lives with the window rather than in the projects. */
const SHOW_HIDDEN_KEY = "keel.showHidden";

/** Shown unless the window remembers they were hidden. */
function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) !== "hidden";
  } catch {
    return true;
  }
}

function writeShowHidden(showHidden: boolean) {
  try {
    localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? "shown" : "hidden");
  } catch {
    // Storage unavailable: the choice just lasts for this session.
  }
}

export type EditorKind = "file" | "diff";

export interface EditorTab {
  id: string;
  kind: EditorKind;
  rel: string;
  staged: boolean;
  /** A diff of this commit rather than of the working tree or index. */
  rev?: string | undefined;
  name: string;
}

export { diffTabId, fileTabId };

interface WorkspaceState {
  root: string | null;
  tab: InspectorTab;
  showHidden: boolean;
  query: string;
  /** Children of a relative folder path. `""` is the project root. */
  tree: Record<string, WorkspaceEntry[]>;
  expanded: Record<string, boolean>;
  selectedRel: string | null;
  creating: { parent: string; kind: "file" | "dir" } | null;
  renaming: string | null;
  searchHits: WorkspaceEntry[] | null;
  /** Tree rows mid-transition, by relative path. Cleared once they settle. */
  rowMotion: Record<string, "enter" | "leave">;

  grepQuery: string;
  grepOptions: GrepOptions;
  /** The replace field is showing; results then preview what it would do. */
  grepReplaceOpen: boolean;
  grepReplace: string;
  grepHits: GrepHit[] | null;
  grepTruncated: boolean;
  grepLoading: boolean;
  grepError: string | null;
  grepStats: { files: number; ms: number } | null;
  /** Results put aside for this search: a file (`rel`) or one line (`rel:line`). */
  grepDismissed: Record<string, true>;
  grepHistory: string[];
  grepReplacing: boolean;

  git: GitStatus | null;
  gitLoading: boolean;
  gitError: string | null;
  branches: GitBranches | null;
  prs: PrList | null;
  commits: api.GitCommit[] | null;
  metaLoading: Partial<Record<GitMetaSection, boolean>>;
  metaErrors: Partial<Record<GitMetaSection, string | null>>;
  commitMessage: string;
  commitOptions: CommitOptions;
  gitView: GitView;
  changeLayout: ChangeLayout;
  stashes: GitStash[] | null;
  tags: GitTag[] | null;
  remotes: GitRemote[] | null;
  /** History across every branch rather than just HEAD's. */
  historyAll: boolean;
  historyQuery: string;
  /** The last page came back full, so there may be more. */
  historyMore: boolean;
  historyPaging: boolean;
  commitDetails: Record<string, CommitDetails>;
  diffLayout: DiffLayout;
  /** Unchanged lines shown around each change; `FULL_CONTEXT` for all of them. */
  diffContext: number;

  editors: EditorTab[];
  activeEditor: string | null;
  buffers: Record<string, string>;
  originals: Record<string, string>;
  snapshots: Record<string, FileContents>;
  diffs: Record<string, GitDiff>;
  editorLoading: Record<string, boolean>;
  editorErrors: Record<string, string | null>;
  /** Dirty file tab whose disk copy changed; save will fail the mtime check. */
  externalChange: Record<string, boolean>;
  busy: boolean;

  /**
   * The current project folder is covered by the native watcher. When false,
   * the inspector falls back to polling.
   */
  fsWatch: boolean;
  /** Bumped when recent-file stamps change so the tree can redraw dots. */
  recentEpoch: number;

  setRoot: (root: string | null) => void;
  setTab: (tab: InspectorTab) => void;
  setShowHidden: (show: boolean) => Promise<void>;
  setQuery: (query: string) => void;
  setCommitMessage: (message: string) => void;
  setCommitOption: (key: keyof CommitOptions, value: boolean) => void;
  setGitView: (view: GitView) => void;
  setChangeLayout: (layout: ChangeLayout) => void;
  setHistoryAll: (all: boolean) => void;
  setHistoryQuery: (query: string) => void;
  loadMoreHistory: () => Promise<void>;
  loadCommitDetails: (hash: string) => Promise<void>;
  refreshStashes: (afterPending?: boolean) => Promise<void>;
  refreshTags: (afterPending?: boolean) => Promise<void>;
  refreshRemotes: (afterPending?: boolean) => Promise<void>;
  openCommitDiff: (rev: string, file: Pick<CommitFile, "path">) => Promise<void>;
  /** Switch to the files tab with this path unfolded and selected. */
  revealInTree: (rel: string) => void;
  setDiffLayout: (layout: DiffLayout) => void;
  setDiffContext: (lines: number) => void;
  /** Re-read an open diff in place, without a loading flash. */
  refreshDiff: (id: string) => Promise<void>;
  /** Stage, unstage or discard some hunks or lines of an open diff. */
  applyLines: (id: string, action: LineAction, selection: LineSelection[]) => Promise<void>;
  initRepo: () => Promise<void>;
  setSelected: (rel: string | null) => void;
  toggleExpanded: (rel: string) => void;
  collapseAll: () => void;
  loadDir:(rel: string) => Promise<void>;
  /** Reloads the listings `rels` touched (each one, and the folder it sits in), or every open folder. */
  refreshTree: (rels?: string[]) => Promise<void>;
  refreshGit: (afterPending?: boolean) => Promise<void>;
  refreshMeta: () => Promise<void>;
  refreshBranches: (afterPending?: boolean) => Promise<void>;
  refreshPrs: (afterPending?: boolean) => Promise<void>;
  refreshHistory: (afterPending?: boolean) => Promise<void>;
  search: (query: string) => Promise<void>;
  setGrepQuery: (query: string) => void;
  setGrepOption: <K extends keyof GrepOptions>(key: K, value: GrepOptions[K]) => void;
  setGrepReplaceOpen: (open: boolean) => void;
  setGrepReplace: (replace: string) => void;
  grep: (query: string) => Promise<void>;
  /** Put a file (`rel`) or a line (`rel:line`) aside for this search. */
  dismissGrep: (key: string) => void;
  /** Bring back everything dismissed for this search. */
  restoreGrep: () => void;
  /** Remember a search worth coming back to. */
  rememberGrep: (query: string) => void;
  forgetGrepHistory: () => void;
  /**
   * Replace what the results show: everything, one file, or one line. Lines
   * and files that were dismissed are left alone.
   */
  replaceGrep: (scope?: { rel: string; line?: number }) => Promise<void>;
  openFileAt: (rel: string, line: number, column?: number, length?: number) => Promise<void>;

  openFile: (rel: string) => Promise<void>;
  openDiff: (rel: string, staged: boolean) => Promise<void>;
  /** Close a file everywhere it is open, asking first if it has unsaved edits. */
  closeEditor: (id: string) => Promise<void>;
  /** Load a tab's contents without moving focus or touching the layout. */
  ensureDocument: (ref: EditorRef) => Promise<void>;
  /** Close one tab of an editor pane, asking first if that drops unsaved edits. */
  closeTab: (projectId: string, paneId: string, id: string) => Promise<void>;
  /** Close any pane from the UI. Asks before dropping unsaved edits or killing an agent. */
  closePaneSafely: (projectId: string, paneId: string) => Promise<void>;
  /** Drop a project after confirming unsaved files in it. */
  removeProjectSafely: (projectId: string) => Promise<void>;
  /** Drop a deck after confirming unsaved files it uniquely holds. */
  removeDeckSafely: (projectId: string, deckId: string) => Promise<void>;
  setActiveEditor: (id: string) => void;
  setBuffer: (id: string, value: string) => void;
  saveActive: () => Promise<void>;
  saveTab: (id: string) => Promise<void>;

  setFsWatch: (on: boolean) => void;
  bumpRecent: () => void;
  /** Watcher event: stamp recent files, refresh this folder if it is on screen. */
  applyFsChange: (root: string, rels: string[], git: boolean) => void;

  startCreate: (parent: string, kind: "file" | "dir") => void;
  cancelCreate: () => void;
  confirmCreate: (name: string) => Promise<void>;
  startRename: (rel: string) => void;
  cancelRename: () => void;
  confirmRename: (name: string) => Promise<void>;
  deleteEntry: (rel: string) => Promise<void>;
  /** Move a file or folder into another folder (`""` is the project root). */
  moveEntry: (rel: string, targetDir: string) => Promise<void>;

  /** `all` covers every change, including any the status list left out. */
  stage: (paths: string[], all?: boolean) => Promise<void>;
  unstage: (paths: string[], all?: boolean) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (andPush?: boolean) => Promise<void>;
  /** Take the last commit back; its message returns to the box. */
  undoCommit: () => Promise<void>;
  push: (force?: boolean) => Promise<void>;
  pull: (mode?: PullMode) => Promise<void>;
  fetch: () => Promise<void>;
  checkout: (name: string) => Promise<void>;
  checkoutRemote: (name: string) => Promise<void>;
  checkoutRev: (rev: string) => Promise<void>;
  createBranch: (name: string, checkout: boolean, start?: string | null) => Promise<void>;
  renameBranch: (from: string, to: string) => Promise<void>;
  /** Asks before forcing when the branch has commits nothing else has. */
  deleteBranch: (name: string) => Promise<void>;
  deleteRemoteBranch: (name: string) => Promise<void>;
  merge: (name: string, mode?: MergeMode) => Promise<void>;
  rebase: (onto: string) => Promise<void>;
  cherryPick: (rev: string) => Promise<void>;
  revert: (rev: string) => Promise<void>;
  reset: (rev: string, mode: ResetMode) => Promise<void>;
  operation: (action: OperationAction) => Promise<void>;
  resolve: (paths: string[], side: "ours" | "theirs") => Promise<void>;
  ignore: (pattern: string) => Promise<void>;
  stashPush: (args: {
    message?: string | null;
    includeUntracked: boolean;
    paths?: string[] | null;
  }) => Promise<void>;
  stashApply: (stash: GitStash, pop: boolean) => Promise<void>;
  stashDrop: (stash: GitStash) => Promise<void>;
  createTag: (name: string, rev: string, message?: string | null) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
  pushTag: (name: string) => Promise<void>;
  createPr: (args: {
    title: string;
    body: string;
    base?: string | null;
    draft: boolean;
  }) => Promise<void>;
  checkoutPr: (number: number) => Promise<void>;
}

function isDirty(state: WorkspaceState, id: string): boolean {
  const tab = state.editors.find((item) => item.id === id);
  if (!tab || tab.kind !== "file") return false;
  return (state.buffers[id] ?? "") !== (state.originals[id] ?? "");
}

const reads = new WorkspaceReads();
let projectVersion = 0;
let grepGeneration = 0;
let searchGeneration = 0;
let editorNavigation = 0;
const editorLoads = new WeakMap<EditorTab, Promise<void>>();
const editorReloads = new WeakMap<EditorTab, Promise<void>>();

type EditorDocs = Pick<
  WorkspaceState,
  | "editors"
  | "activeEditor"
  | "buffers"
  | "originals"
  | "snapshots"
  | "diffs"
  | "editorLoading"
  | "editorErrors"
  | "externalChange"
>;

/**
 * Open files of the folders you are not looking at. Their editor panes are
 * still sitting in those projects' decks, so coming back shows them as you left
 * them — unsaved edits included — instead of an empty editor.
 */
const stashedDocs = new Map<string, EditorDocs>();

function emptyDocs(): EditorDocs {
  return {
    editors: [],
    activeEditor: null,
    buffers: {},
    originals: {},
    snapshots: {},
    diffs: {},
    editorLoading: {},
    editorErrors: {},
    externalChange: {},
  };
}

/**
 * Where you were in a folder you are not looking at: the folders left open, the
 * row under the cursor and the commit message you were writing. Like the open documents beside it, it comes back
 * when you return to the project — and only for this session, because a fresh
 * launch starts every project folded at its root.
 */
interface BrowseState {
  expanded: Record<string, boolean>;
  selectedRel: string | null;
  commitMessage: string;
  amend: boolean;
}

const stashedBrowse = new Map<string, BrowseState>();

function emptyBrowse(): BrowseState {
  return { expanded: {}, selectedRel: null, commitMessage: "", amend: false };
}

/** What to keep when leaving a folder. Reads still in flight are abandoned, so those load again. */
function settledDocs(state: WorkspaceState): EditorDocs {
  const pending = new Set(
    state.editors.filter((tab) => state.editorLoading[tab.id] ||
      (editorReloads.has(tab) && !isDirty(state, tab.id))).map((tab) => tab.id),
  );
  const keep = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !pending.has(id)));
  return {
    editors: state.editors.filter((tab) => !pending.has(tab.id)),
    activeEditor:
      state.activeEditor && !pending.has(state.activeEditor) ? state.activeEditor : null,
    buffers: keep(state.buffers),
    originals: keep(state.originals),
    snapshots: keep(state.snapshots),
    diffs: keep(state.diffs),
    editorLoading: keep(state.editorLoading),
    editorErrors: keep(state.editorErrors),
    externalChange: keep({
      ...state.externalChange,
      ...Object.fromEntries(state.editors
        .filter((tab) => editorReloads.has(tab) && isDirty(state, tab.id))
        .map((tab) => [tab.id, true])),
    }),
  };
}

/** Put a tab on screen: in an editor pane on the deck you are looking at. */
function revealInLayout(root: string, tab: EditorTab) {
  const keel = useKeel.getState();
  const project = keel.projects.find((item) => item.id === keel.activeProjectId);
  if (!project || project.path !== root) return;
  keel.openInEditor(project.id, {
    kind: tab.kind,
    rel: tab.rel,
    staged: tab.staged,
    ...(tab.rev ? { rev: tab.rev } : {}),
  });
}

/** Whether an editor pane in this folder's projects, other than `except`, shows a tab. */
function tabShown(root: string, id: string, except: string | null): boolean {
  for (const project of useKeel.getState().projects) {
    if (project.path !== root) continue;
    for (const deck of project.decks) {
      for (const [paneId, pane] of Object.entries(deck.panes)) {
        if (paneId === except) continue;
        if (pane.editor?.tabs.some((tab) => editorRefId(tab) === id)) return true;
      }
    }
  }
  return false;
}

function dropDocument(
  id: string,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
) {
  editorNavigation += 1;
  clearEditorReveals();
  const state = get();
  const editors = state.editors.filter((tab) => tab.id !== id);
  const { [id]: _b, ...buffers } = state.buffers;
  const { [id]: _o, ...originals } = state.originals;
  const { [id]: _s, ...snapshots } = state.snapshots;
  const { [id]: _d, ...diffs } = state.diffs;
  const { [id]: _l, ...editorLoading } = state.editorLoading;
  const { [id]: _e, ...editorErrors } = state.editorErrors;
  const { [id]: _x, ...externalChange } = state.externalChange;
  const activeEditor =
    state.activeEditor === id
      ? (editors[editors.length - 1]?.id ?? null)
      : state.activeEditor;
  set({
    editors, buffers, originals, snapshots, diffs, editorLoading, editorErrors, externalChange, activeEditor,
  });
}

/** Forget files no pane shows any more, once a closing pane has finished leaving. */
function releaseLater(
  root: string,
  ids: string[],
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
) {
  if (ids.length === 0) return;
  setTimeout(() => {
    if (get().root !== root) return;
    for (const id of ids) {
      if (!tabShown(root, id, null)) dropDocument(id, set, get);
    }
  }, 250);
}
let editorReadId = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where a file a commit renamed came from, so its diff can follow the rename. */
function commitOrigPath(state: WorkspaceState, rev: string, rel: string): string | null {
  return state.commitDetails[rev]?.files.find((file) => file.path === rel)?.origPath ?? null;
}

/**
 * Load a tab's contents. `reveal` is a click on a file or a change: it also puts
 * the tab on screen in the layout and makes it the one you are looking at.
 * Without it, this only fills the cache for a pane that is already showing it.
 */
function openEditor(
  tab: EditorTab,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
  reveal = true,
) {
  const root = get().root;
  if (!root) return Promise.resolve();
  const { id, rel } = tab;
  if (reveal) {
    editorNavigation += 1;
    clearEditorReveals();
    revealInLayout(root, tab);
  }
  const existing = get().editors.find((item) => item.id === id);
  const focus = reveal
    ? {
        activeEditor: id,
        selectedRel: rel,
      }
    : {};
  if (existing && (
    get().editorLoading[id] ||
    (tab.kind === "file" && !get().editorErrors[id])
  )) {
    set(focus);
    return Promise.resolve();
  }
  set({
    ...focus,
    editors: existing
      ? get().editors.map((item) => item.id === id ? tab : item)
      : [...get().editors, tab],
    editorLoading: { ...get().editorLoading, [id]: true },
    editorErrors: { ...get().editorErrors, [id]: null },
  });
  const request = reads.run(`editor:${++editorReadId}`, async (isCurrent) => {
    // Identity also rejects reads for a tab that was closed and reopened.
    const isOpen = () => isCurrent() && get().editors.includes(tab);
    try {
      if (tab.kind === "diff") {
        const context = get().diffContext;
        const diff = tab.rev
          ? await api.gitDiffRev(root, tab.rev, rel, commitOrigPath(get(), tab.rev, rel), context)
          : await api.gitDiff(root, rel, tab.staged, context);
        if (isOpen()) set({ diffs: { ...get().diffs, [id]: diff } });
      } else {
        const contents = await api.workspaceRead(root, rel);
        if (isOpen()) {
          set({
            buffers: { ...get().buffers, [id]: contents.text },
            originals: { ...get().originals, [id]: contents.text },
            snapshots: { ...get().snapshots, [id]: contents },
          });
        }
      }
    } catch (error) {
      if (isOpen()) {
        set({ editorErrors: { ...get().editorErrors, [id]: errorMessage(error) } });
      }
    } finally {
      if (isOpen()) set({ editorLoading: { ...get().editorLoading, [id]: false } });
    }
  });
  editorLoads.set(tab, request);
  return request;
}

function fileRelAffected(tabRel: string, rels: string[]): boolean {
  if (rels.some((rel) => rel === "")) return true;
  const parent = parentRel(tabRel);
  for (const rel of rels) {
    if (rel === tabRel || rel === parent) return true;
    if (rel && tabRel.startsWith(`${rel}/`)) return true;
  }
  return false;
}

/** Re-read a clean open file. Does not remount the editor; the buffer subscription updates it. */
function reloadTab(
  id: string,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
): Promise<void> {
  const state = get();
  const root = state.root;
  const tab = state.editors.find((item) => item.id === id);
  if (!root || !tab || tab.kind !== "file") return Promise.resolve();
  if (state.editorLoading[id]) {
    const loading = editorLoads.get(tab);
    if (!loading) return Promise.resolve();
    return loading.then(() => {
      if (get().root === root && get().editors.includes(tab)) return reloadTab(id, set, get);
    });
  }
  const request = reads.run(`reload:${id}`, async (isCurrent) => {
    try {
      const contents = await api.workspaceRead(root, tab.rel);
      if (!isCurrent() || get().root !== root) return;
      if (!get().editors.includes(tab)) return;
      const now = get();
      if ((now.buffers[id] ?? "") !== (now.originals[id] ?? "")) {
        if (!now.externalChange[id]) {
          set({ externalChange: { ...now.externalChange, [id]: true } });
          toast.error(`${tab.name} changed on disk.`);
        }
        return;
      }
      const { [id]: _cleared, ...externalChange } = get().externalChange;
      set({
        buffers: { ...get().buffers, [id]: contents.text },
        originals: { ...get().originals, [id]: contents.text },
        snapshots: { ...get().snapshots, [id]: contents },
        editorErrors: { ...get().editorErrors, [id]: null },
        externalChange,
      });
    } catch (error) {
      if (isCurrent() && get().editors.includes(tab)) {
        set({ editorErrors: { ...get().editorErrors, [id]: errorMessage(error) } });
      }
    }
  }, true);
  editorReloads.set(tab, request);
  const settled = () => {
    if (editorReloads.get(tab) === request) editorReloads.delete(tab);
  };
  void request.then(settled, settled);
  return request;
}

/** How long rows keep their enter or leave marker. Matches `k-row-in` / `k-row-out`. */
const ROW_ENTER_MS = 240;
const ROW_LEAVE_MS = 180;

let rowMotionTimer: ReturnType<typeof setTimeout> | undefined;

/** Mark rows as arriving, and forget the marks once the animation is over. */
function flashRows(
  rels: string[],
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
) {
  if (rels.length === 0) return;
  const rowMotion = Object.fromEntries(rels.map((rel) => [rel, "enter" as const]));
  set({ rowMotion });
  clearTimeout(rowMotionTimer);
  rowMotionTimer = setTimeout(() => {
    if (get().rowMotion === rowMotion) set({ rowMotion: {} });
  }, ROW_ENTER_MS);
}

/** Every path in a loaded tree. */
function treeRels(tree: Record<string, WorkspaceEntry[]>): Set<string> {
  return new Set(Object.values(tree).flatMap((entries) => entries.map((entry) => entry.rel)));
}

/**
 * Forget a folder that is gone for good: its listing, its fold, and every
 * listing and fold below it. Without this the tree kept a dead key, so each
 * watcher event (or poll) asked for the missing path again and toasted again.
 */
function sameEntries(a: WorkspaceEntry[] | undefined, b: WorkspaceEntry[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return entry.rel === other.rel && entry.name === other.name &&
      entry.kind === other.kind && entry.size === other.size;
  });
}

/** Deep equality for plain data from Rust, whose field order is fixed. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pruneDir(state: WorkspaceState, rel: string): Partial<WorkspaceState> {
  const prefix = `${rel}/`;
  const gone = (path: string) =>
    path === rel || (rel !== "" && path.startsWith(prefix));
  const without = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([path]) => !gone(path)));
  return {
    tree: without(state.tree),
    expanded: without(state.expanded),
    rowMotion: without(state.rowMotion),
    selectedRel: state.selectedRel && gone(state.selectedRel) ? null : state.selectedRel,
    creating: state.creating && gone(state.creating.parent) ? null : state.creating,
    renaming: state.renaming && gone(state.renaming) ? null : state.renaming,
  };
}

/**
 * Everything keyed by a path follows an entry that moved from `fromRel` to
 * `toRel`: open file tabs and their buffers, the selection, open folders.
 */
function retarget(
  state: WorkspaceState,
  fromRel: string,
  toRel: string,
): Partial<WorkspaceState> {
  const prefix = `${fromRel}/`;
  const moved = (rel: string) =>
    rel === fromRel
      ? toRel
      : rel.startsWith(prefix)
        ? toRel + rel.slice(fromRel.length)
        : null;

  const ids: Record<string, string> = {};
  const editors = state.editors.map((tab) => {
    const rel = tab.kind === "file" ? moved(tab.rel) : null;
    if (rel === null) return tab;
    const id = fileTabId(rel);
    ids[tab.id] = id;
    return { ...tab, rel, id, name: fileName(rel) };
  });
  const rekey = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).map(([id, value]) => [ids[id] ?? id, value]));

  const expanded: Record<string, boolean> = {};
  for (const [rel, open] of Object.entries(state.expanded)) {
    expanded[moved(rel) ?? rel] = open;
  }
  // Listings under the old path name entries that are no longer there.
  const tree = Object.fromEntries(
    Object.entries(state.tree).filter(([rel]) => moved(rel) === null),
  );

  return {
    editors,
    buffers: rekey(state.buffers),
    originals: rekey(state.originals),
    snapshots: rekey(state.snapshots),
    editorLoading: rekey(state.editorLoading),
    editorErrors: rekey(state.editorErrors),
    externalChange: rekey(state.externalChange),
    activeEditor: state.activeEditor
      ? (ids[state.activeEditor] ?? state.activeEditor)
      : null,
    selectedRel: state.selectedRel
      ? (moved(state.selectedRel) ?? state.selectedRel)
      : null,
    expanded,
    tree,
  };
}

/** After a rename or a move: follow it, then re-read both folders. */
async function settleMove(
  fromRel: string,
  toRel: string,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
) {
  set(retarget(get(), fromRel, toRel));
  const root = get().root;
  if (root) {
    // Editor panes in the layout follow the file too, on every deck.
    useKeel.getState().rewriteEditorTabs(root, (ref) => {
      if (ref.kind !== "file") return ref;
      if (ref.rel === fromRel) return { ...ref, rel: toRel };
      if (ref.rel.startsWith(`${fromRel}/`)) {
        return { ...ref, rel: toRel + ref.rel.slice(fromRel.length) };
      }
      return ref;
    });
  }
  const prefix = `${toRel}/`;
  const reopen = Object.entries(get().expanded)
    .filter(([rel, open]) => open && (rel === toRel || rel.startsWith(prefix)))
    .map(([rel]) => rel);
  const dirs = new Set([parentRel(fromRel), parentRel(toRel), ...reopen]);
  await Promise.all([...dirs].map((rel) => get().loadDir(rel)));
  flashRows([toRel], set, get);
  void get().refreshGit();
}

function refreshMetadata<T>(
  section: GitMetaSection,
  load: (root: string) => Promise<T>,
  apply: (value: T) => void,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
  afterPending = false,
) {
  const root = get().root;
  if (!root) return Promise.resolve();
  return reads.run(section, async (isCurrent) => {
    set({ metaLoading: { ...get().metaLoading, [section]: true } });
    try {
      const value = await load(root);
      if (!isCurrent()) return;
      apply(value);
      set({ metaErrors: { ...get().metaErrors, [section]: null } });
    } catch (error) {
      if (isCurrent()) {
        set({ metaErrors: { ...get().metaErrors, [section]: errorMessage(error) } });
      }
    } finally {
      if (isCurrent()) {
        set({ metaLoading: { ...get().metaLoading, [section]: false } });
      }
    }
  }, afterPending);
}

async function runGit(
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
  work: (root: string) => Promise<string | void>,
) {
  const root = get().root;
  if (!root || get().busy) return;
  const version = projectVersion;
  set({ busy: true });
  try {
    const message = await work(root);
    if (message) toast.success(message);
    if (version !== projectVersion) return;
    await get().refreshGit(true);
    if (version === projectVersion) void get().refreshMeta();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (version === projectVersion) set({ busy: false });
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  tab: "files",
  showHidden: readShowHidden(),
  query: "",
  tree: {},
  expanded: {},
  selectedRel: null,
  creating: null,
  renaming: null,
  searchHits: null,
  rowMotion: {},

  grepQuery: "",
  grepOptions: readGrepOptions(),
  grepReplaceOpen: false,
  grepReplace: "",
  grepHits: null,
  grepTruncated: false,
  grepLoading: false,
  grepError: null,
  grepStats: null,
  grepDismissed: {},
  grepHistory: readGrepHistory(),
  grepReplacing: false,

  git: null,
  gitLoading: false,
  gitError: null,
  branches: null,
  prs: null,
  commits: null,
  metaLoading: {},
  metaErrors: {},
  commitMessage: "",
  commitOptions: readCommitPrefs(),
  gitView: "changes",
  changeLayout: readChangeLayout(),
  stashes: null,
  tags: null,
  remotes: null,
  historyAll: false,
  historyQuery: "",
  historyMore: false,
  historyPaging: false,
  commitDetails: {},
  diffLayout: readDiffLayout(),
  diffContext: readDiffContext(),

  editors: [],
  activeEditor: null,
  buffers: {},
  originals: {},
  snapshots: {},
  diffs: {},
  editorLoading: {},
  editorErrors: {},
  externalChange: {},
  busy: false,
  fsWatch: false,
  recentEpoch: 0,

  setRoot: (root) => {
    const previous = get().root;
    if (previous === root) return;
    projectVersion += 1;
    editorNavigation += 1;
    clearEditorReveals();
    grepGeneration += 1;
    searchGeneration += 1;
    reads.reset();
    if (previous) {
      stashedDocs.set(previous, settledDocs(get()));
      const { expanded, selectedRel, commitMessage, commitOptions } = get();
      stashedBrowse.set(previous, {
        expanded: { ...expanded },
        selectedRel,
        commitMessage,
        amend: commitOptions.amend,
      });
    }
    // No project at all: nothing will come back for what was open.
    if (!root) {
      stashedDocs.clear();
      stashedBrowse.clear();
    }
    const docs = (root ? stashedDocs.get(root) : undefined) ?? emptyDocs();
    const browse = (root ? stashedBrowse.get(root) : undefined) ?? emptyBrowse();
    if (root) {
      stashedDocs.delete(root);
      stashedBrowse.delete(root);
    }
    set({
      root,
      // `tab` is deliberately left as it is: the panel you picked follows you
      // from project to project, and only a fresh launch starts on files.
      tree: {},
      expanded: browse.expanded,
      selectedRel: browse.selectedRel,
      commitMessage: browse.commitMessage,
      commitOptions: { ...get().commitOptions, amend: browse.amend },
      stashes: null,
      tags: null,
      remotes: null,
      historyQuery: "",
      historyMore: false,
      historyPaging: false,
      commitDetails: {},
      creating: null,
      renaming: null,
      searchHits: null,
      rowMotion: {},
      query: "",
      grepQuery: "",
      grepHits: null,
      grepTruncated: false,
      grepLoading: false,
      grepError: null,
      grepStats: null,
      grepDismissed: {},
      grepReplacing: false,
      git: null,
      ...docs,
      gitLoading: false,
      gitError: null,
      branches: null,
      prs: null,
      commits: null,
      metaLoading: {},
      metaErrors: {},
      busy: false,
      fsWatch: false,
    });
    if (root) {
      void get().loadDir("");
      // Refill every folder that was open, so the tree comes back whole. One
      // deleted meanwhile returns a missing listing and is pruned then.
      for (const [rel, open] of Object.entries(browse.expanded)) {
        if (open && rel) void get().loadDir(rel);
      }
      void get().refreshGit();
    }
  },

  setTab: (tab) => {
    set({ tab });
  },
  setFsWatch: (fsWatch) => set({ fsWatch }),
  bumpRecent: () => set({ recentEpoch: get().recentEpoch + 1 }),
  applyFsChange: (root, rels, git) => {
    pruneRecent();
    noteRecent(root, rels);
    set({ recentEpoch: get().recentEpoch + 1 });
    if (!sameWatchRoot(get().root, root)) {
      for (const [path, docs] of stashedDocs) {
        if (!sameWatchRoot(path, root)) continue;
        const invalid = new Set<string>();
        const externalChange = { ...docs.externalChange };
        for (const tab of docs.editors) {
          if (!fileRelAffected(tab.rel, rels)) continue;
          if (tab.kind === "file" && (docs.buffers[tab.id] ?? "") !== (docs.originals[tab.id] ?? "")) {
            externalChange[tab.id] = true;
          } else {
            invalid.add(tab.id);
          }
        }
        const keep = <T,>(record: Record<string, T>): Record<string, T> =>
          Object.fromEntries(Object.entries(record).filter(([id]) => !invalid.has(id)));
        stashedDocs.set(path, {
          ...docs,
          editors: docs.editors.filter((tab) => !invalid.has(tab.id)),
          buffers: keep(docs.buffers), originals: keep(docs.originals),
          snapshots: keep(docs.snapshots), diffs: keep(docs.diffs),
          editorLoading: keep(docs.editorLoading), editorErrors: keep(docs.editorErrors),
          externalChange: keep(externalChange),
        });
      }
      return;
    }
    const full = rels.some((rel) => rel === "");
    // Only the folders a change landed in. Reloading every open folder on each
    // write kept the tree busy the whole time an agent was editing.
    if (full) void get().refreshTree();
    else if (rels.length > 0) void get().refreshTree(rels);
    if (git || full) void get().refreshGit(true);
    const open = get();
    for (const tab of open.editors) {
      if (tab.kind !== "file") continue;
      if (!fileRelAffected(tab.rel, rels)) continue;
      const dirty = (open.buffers[tab.id] ?? "") !== (open.originals[tab.id] ?? "");
      if (dirty) {
        if (!get().externalChange[tab.id]) {
          set({ externalChange: { ...get().externalChange, [tab.id]: true } });
          toast.error(`${tab.name} changed on disk.`);
        }
      } else {
        void reloadTab(tab.id, set, get);
      }
    }
  },
  setShowHidden: async (showHidden) => {
    // The tree stays up while the new listings load — clearing it first blanked
    // the whole panel for a frame and left open folders empty.
    set({ showHidden });
    writeShowHidden(showHidden);
    const root = get().root;
    if (!root) return;
    const version = projectVersion;
    const dirs = Object.keys(get().tree);
    const listed = await Promise.all(
      (dirs.length ? dirs : [""]).map(async (rel) => {
        try {
          return [rel, await api.workspaceList(root, rel, showHidden)] as const;
        } catch {
          return [rel, null] as const;
        }
      }),
    );
    const current = () =>
      version === projectVersion && get().showHidden === showHidden;
    if (!current()) return;

    const next = { ...get().tree };
    for (const [rel, entries] of listed) {
      if (entries) next[rel] = entries;
      else delete next[rel];
    }
    const before = treeRels(get().tree);
    const after = treeRels(next);

    if (showHidden) {
      set({ tree: next });
      flashRows([...after].filter((rel) => !before.has(rel)), set, get);
      return;
    }

    // Hiding: the rows fold away first, then the tree loses them.
    const rowMotion = Object.fromEntries(
      [...before].filter((rel) => !after.has(rel)).map((rel) => [rel, "leave" as const]),
    );
    if (Object.keys(rowMotion).length === 0) {
      set({ tree: next });
      return;
    }
    clearTimeout(rowMotionTimer);
    set({ rowMotion });
    rowMotionTimer = setTimeout(() => {
      if (current()) set({ tree: next, rowMotion: {} });
    }, ROW_LEAVE_MS);
  },
  setQuery: (query) => {
    set({ query });
    if (query.trim().length < 2) {
      searchGeneration += 1;
      set({ searchHits: null });
    }
  },
  setCommitMessage: (commitMessage) => set({ commitMessage }),
  setCommitOption: (key, value) => {
    const commitOptions = { ...get().commitOptions, [key]: value };
    set({ commitOptions });
    if (key !== "amend") {
      remember(
        COMMIT_PREFS_KEY,
        JSON.stringify({ signoff: commitOptions.signoff, noVerify: commitOptions.noVerify }),
      );
      return;
    }
    // Amending starts from the message being amended, unless one is already written.
    const root = get().root;
    if (!value || !root || get().commitMessage.trim()) return;
    const version = projectVersion;
    void api.gitHeadMessage(root).then(
      (message) => {
        if (version === projectVersion && get().commitOptions.amend && !get().commitMessage.trim()) {
          set({ commitMessage: message });
        }
      },
      () => {},
    );
  },
  setGitView: (gitView) => set({ gitView }),
  setChangeLayout: (changeLayout) => {
    set({ changeLayout });
    remember(CHANGE_LAYOUT_KEY, changeLayout);
  },
  setHistoryAll: (historyAll) => {
    if (historyAll === get().historyAll) return;
    set({ historyAll, commits: null, historyMore: false });
    void get().refreshHistory();
  },
  setHistoryQuery: (historyQuery) => {
    if (historyQuery === get().historyQuery) return;
    set({ historyQuery, commits: null, historyMore: false });
    void get().refreshHistory();
  },
  loadMoreHistory: async () => {
    const root = get().root;
    const loaded = get().commits;
    if (!root || !loaded || !get().historyMore || get().historyPaging) return;
    const version = projectVersion;
    const { historyAll, historyQuery } = get();
    set({ historyPaging: true });
    try {
      const page = await api.gitLog(root, HISTORY_PAGE, {
        skip: loaded.length,
        all: historyAll,
        query: historyQuery,
      });
      const same = () =>
        version === projectVersion &&
        get().commits === loaded &&
        get().historyAll === historyAll &&
        get().historyQuery === historyQuery;
      if (!same()) return;
      set({ commits: [...loaded, ...page], historyMore: page.length === HISTORY_PAGE });
    } catch (error) {
      if (version === projectVersion) toast.error(errorMessage(error));
    } finally {
      if (version === projectVersion) set({ historyPaging: false });
    }
  },
  loadCommitDetails: async (hash) => {
    const root = get().root;
    if (!root || get().commitDetails[hash]) return;
    const version = projectVersion;
    try {
      const details = await api.gitCommitDetails(root, hash);
      if (version === projectVersion) {
        set({ commitDetails: { ...get().commitDetails, [hash]: details } });
      }
    } catch (error) {
      if (version === projectVersion) toast.error(errorMessage(error));
    }
  },
  setDiffLayout: (diffLayout) => {
    set({ diffLayout });
    remember(DIFF_LAYOUT_KEY, diffLayout);
  },
  setDiffContext: (diffContext) => {
    if (diffContext === get().diffContext) return;
    set({ diffContext });
    remember(DIFF_CONTEXT_KEY, String(diffContext));
    for (const tab of get().editors) {
      if (tab.kind === "diff") void get().refreshDiff(tab.id);
    }
  },
  refreshDiff: async (id) => {
    const root = get().root;
    const tab = get().editors.find((item) => item.id === id);
    if (!root || !tab || tab.kind !== "diff") return;
    const version = projectVersion;
    const context = get().diffContext;
    try {
      const diff = tab.rev
        ? await api.gitDiffRev(root, tab.rev, tab.rel, commitOrigPath(get(), tab.rev, tab.rel), context)
        : await api.gitDiff(root, tab.rel, tab.staged, context);
      if (version !== projectVersion || !get().editors.includes(tab)) return;
      // An unchanged diff keeps its identity, so what was picked in it survives.
      const shown = get().diffs[id];
      if (shown && JSON.stringify(shown) === JSON.stringify(diff)) return;
      set({ diffs: { ...get().diffs, [id]: diff } });
    } catch {
      // The diff on screen stays; the next change on disk tries again.
    }
  },
  applyLines: async (id, action, selection) => {
    const tab = get().editors.find((item) => item.id === id);
    const diff = get().diffs[id];
    if (!tab || !diff || tab.kind !== "diff" || tab.rev) return;
    const headers = diff.hunks.map((hunk) => hunk.header);
    const context = get().diffContext;
    await runGit(set, get, (root) =>
      api.gitApplyLines(root, tab.rel, action, selection, headers, context),
    );
    // Both sides of this file move: what left one diff arrives in the other.
    for (const other of get().editors) {
      if (other.kind === "diff" && !other.rev && other.rel === tab.rel) {
        void get().refreshDiff(other.id);
      }
    }
  },
  revealInTree: (rel) => {
    const parents: string[] = [];
    for (let dir = parentRel(rel); dir; dir = parentRel(dir)) parents.unshift(dir);
    const expanded = { ...get().expanded };
    for (const dir of parents) expanded[dir] = true;
    set({ tab: "files", expanded, selectedRel: rel });
    for (const dir of parents) void get().loadDir(dir);
  },
  initRepo: () =>
    runGit(set, get, async (root) => {
      await api.gitInit(root);
      return "Initialized a git repository";
    }),
  openCommitDiff: (rev, file) => openEditor({
    id: diffTabId(file.path, false, rev),
    kind: "diff",
    rel: file.path,
    staged: false,
    rev,
    name: fileName(file.path),
  }, set, get),
  setSelected: (selectedRel) => set({ selectedRel }),

  toggleExpanded: (rel) => {
    const open = !get().expanded[rel];
    set({ expanded: { ...get().expanded, [rel]: open } });
    if (open) void get().loadDir(rel);
  },

  collapseAll: () => set({ expanded: {} }),

  loadDir: async (rel) => {
    const root = get().root;
    if (!root) return;
    const version = projectVersion;
    const showHidden = get().showHidden;
    await reads.run(`tree:${showHidden}:${rel}`, async (isCurrent) => {
      try {
        const entries = await api.workspaceList(root, rel, showHidden);
        if (!isCurrent() || version !== projectVersion || showHidden !== get().showHidden) return;
        if (entries === null) set(pruneDir(get(), rel));
        // An unchanged listing keeps its identity, so the tree doesn't redraw.
        else if (!sameEntries(get().tree[rel], entries)) set({ tree: { ...get().tree, [rel]: entries } });
      } catch (error) {
        if (isCurrent()) toast.error(error instanceof Error ? error.message : String(error));
      }
    }, true);
  },

  refreshTree: async (rels) => {
    const { root, tree } = get();
    if (!root) return;
    let dirs = Object.keys(tree);
    if (dirs.length === 0) dirs.push("");
    else if (rels) {
      const touched = new Set(rels.flatMap((rel) => [rel, parentRel(rel)]));
      dirs = dirs.filter((dir) => touched.has(dir));
    }
    await Promise.all(dirs.map((rel) => get().loadDir(rel)));
  },

  refreshGit: (afterPending = false) => {
    const root = get().root;
    if (!root) return Promise.resolve();
    return reads.run("status", async (isCurrent) => {
      set({ gitLoading: true });
      try {
        const fresh = await api.gitStatus(root);
        if (!isCurrent()) return;
        // Every file write asks for a status. When nothing changed, keep the old
        // object: the tree, the Changes panel and each open editor's gutter all
        // redo their work (the gutter re-reads git) when it changes identity.
        const previous = get().git;
        const git = previous && sameJson(previous, fresh) ? previous : fresh;
        set({ git, gitError: null, gitLoading: false });
      } catch (error) {
        if (isCurrent()) set({ gitError: errorMessage(error), gitLoading: false });
      }
    }, afterPending);
  },

  refreshMeta: async () => {
    // Refresh only sections the user has requested during this project visit.
    const requested = get().metaLoading;
    await Promise.all([
      requested.branches !== undefined ? get().refreshBranches(true) : undefined,
      requested.prs !== undefined ? get().refreshPrs(true) : undefined,
      requested.history !== undefined ? get().refreshHistory(true) : undefined,
      requested.stashes !== undefined ? get().refreshStashes(true) : undefined,
      requested.tags !== undefined ? get().refreshTags(true) : undefined,
    ]);
  },

  refreshBranches: (afterPending) => refreshMetadata(
    "branches", api.gitBranches, (branches) => set({ branches }), set, get, afterPending,
  ),
  refreshPrs: (afterPending) => refreshMetadata(
    "prs", api.prList, (prs) => set({ prs }), set, get, afterPending,
  ),
  refreshHistory: (afterPending) => {
    const { historyAll, historyQuery } = get();
    // A refresh after a commit or checkout keeps however much was scrolled in.
    const shown = Math.max(HISTORY_PAGE, get().commits?.length ?? 0);
    return refreshMetadata(
      "history",
      (root) => api.gitLog(root, shown, { all: historyAll, query: historyQuery }),
      (commits) => {
        if (get().historyAll !== historyAll || get().historyQuery !== historyQuery) return;
        set({ commits, historyMore: commits.length === shown });
      },
      set,
      get,
      afterPending,
    );
  },
  refreshStashes: (afterPending) => refreshMetadata(
    "stashes", api.gitStashList, (stashes) => set({ stashes }), set, get, afterPending,
  ),
  refreshTags: (afterPending) => refreshMetadata(
    "tags", api.gitTags, (tags) => set({ tags }), set, get, afterPending,
  ),
  refreshRemotes: (afterPending) => refreshMetadata(
    "remotes", api.gitRemotes, (remotes) => set({ remotes }), set, get, afterPending,
  ),

  search: async (query) => {
    const root = get().root;
    const needle = query.trim();
    set({ query });
    if (!root || needle.length < 2) {
      searchGeneration += 1;
      set({ searchHits: null });
      return;
    }
    const generation = ++searchGeneration;
    const version = projectVersion;
    try {
      const searchHits = await api.workspaceSearch(root, needle);
      if (generation !== searchGeneration || version !== projectVersion) return;
      set({ searchHits });
    } catch (error) {
      if (generation !== searchGeneration || version !== projectVersion) return;
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  setGrepQuery: (query) => {
    grepGeneration += 1;
    set({
      grepQuery: query,
      grepHits: null,
      grepTruncated: false,
      grepLoading: false,
      grepError: null,
      grepStats: null,
      grepDismissed: {},
    });
  },
  setGrepOption: (key, value) => {
    grepGeneration += 1;
    const grepOptions = { ...get().grepOptions, [key]: value };
    set({
      grepOptions,
      grepHits: null,
      grepTruncated: false,
      grepLoading: false,
      grepError: null,
      grepStats: null,
      grepDismissed: {},
    });
    remember(
      GREP_TOGGLES_KEY,
      JSON.stringify({
        caseSensitive: grepOptions.caseSensitive,
        wholeWord: grepOptions.wholeWord,
        regex: grepOptions.regex,
      }),
    );
  },
  setGrepReplaceOpen: (grepReplaceOpen) => {
    if (grepReplaceOpen === get().grepReplaceOpen) return;
    set({ grepReplaceOpen });
    // Opening or closing replace changes what the results preview.
    if (get().grepQuery.trim().length >= 2) void get().grep(get().grepQuery);
  },
  setGrepReplace: (grepReplace) => set({ grepReplace }),
  grep: async (query) => {
    const root = get().root;
    const needle = query.trim();
    set({ grepQuery: query });
    if (!root || needle.length < 2) {
      grepGeneration += 1;
      set({
        grepHits: null,
        grepTruncated: false,
        grepLoading: false,
        grepError: null,
        grepStats: null,
      });
      return;
    }
    const generation = ++grepGeneration;
    const version = projectVersion;
    const { grepOptions, grepReplaceOpen, grepReplace } = get();
    // Results already on screen for this exact search stay while it refreshes.
    set({ grepLoading: true, grepError: null });
    try {
      const results = await api.workspaceGrep(
        root,
        query,
        grepOptions,
        grepReplaceOpen ? grepReplace : null,
      );
      if (generation !== grepGeneration || version !== projectVersion) return;
      if (results.cancelled) return;
      set({
        grepHits: results.hits,
        grepTruncated: results.truncated,
        grepLoading: false,
        grepError: null,
        grepStats: { files: results.filesSearched ?? 0, ms: results.elapsedMs ?? 0 },
      });
    } catch (error) {
      if (generation !== grepGeneration || version !== projectVersion) return;
      const grepError = errorMessage(error);
      set({ grepError, grepLoading: false, grepHits: null, grepStats: null });
    }
  },
  dismissGrep: (key) => set({ grepDismissed: { ...get().grepDismissed, [key]: true } }),
  restoreGrep: () => set({ grepDismissed: {} }),
  rememberGrep: (query) => {
    const needle = query.trim();
    if (needle.length < 2) return;
    const grepHistory = [needle, ...get().grepHistory.filter((item) => item !== needle)].slice(
      0,
      GREP_HISTORY_MAX,
    );
    set({ grepHistory });
    remember(GREP_HISTORY_KEY, JSON.stringify(grepHistory));
  },
  forgetGrepHistory: () => {
    set({ grepHistory: [] });
    remember(GREP_HISTORY_KEY, "[]");
  },
  replaceGrep: async (scope) => {
    const state = get();
    const root = state.root;
    const hits = state.grepHits;
    if (!root || !hits || state.grepReplacing) return;
    const dismissed = state.grepDismissed;
    // Group what is still showing by file, keeping only the lines asked for.
    const byFile = new Map<string, number[]>();
    for (const hit of hits) {
      if (dismissed[hit.rel] || dismissed[`${hit.rel}:${hit.line}`]) continue;
      if (scope && (hit.rel !== scope.rel || (scope.line !== undefined && hit.line !== scope.line))) {
        continue;
      }
      const lines = byFile.get(hit.rel) ?? [];
      lines.push(hit.line);
      byFile.set(hit.rel, lines);
    }
    if (byFile.size === 0) return;
    const query = state.grepQuery;
    const version = projectVersion;
    get().rememberGrep(query);
    set({ grepReplacing: true });
    try {
      const summary = await api.workspaceReplace(
        root,
        query,
        state.grepOptions,
        state.grepReplace,
        [...byFile].map(([rel, lines]) => ({ rel, lines })),
      );
      if (version !== projectVersion) return;
      const files = summary.files === 1 ? "1 file" : `${summary.files} files`;
      const count = summary.replacements === 1 ? "1 match" : `${summary.replacements} matches`;
      if (summary.replacements > 0) toast.success(`Replaced ${count} in ${files}`);
      for (const skipped of summary.skipped) toast.error(`Skipped ${skipped}`);
      await get().grep(query);
    } catch (error) {
      if (version === projectVersion) toast.error(errorMessage(error));
    } finally {
      if (version === projectVersion) set({ grepReplacing: false });
    }
  },

  openFileAt: async (rel, line, column, length) => {
    const version = projectVersion;
    const loading = get().openFile(rel);
    const navigation = editorNavigation;
    const tab = get().editors.find((item) => item.id === fileTabId(rel));
    await (tab ? editorLoads.get(tab) ?? loading : loading);
    if (version !== projectVersion || navigation !== editorNavigation ||
      get().activeEditor !== fileTabId(rel) || get().editorErrors[fileTabId(rel)]) return;
    revealInEditor(fileTabId(rel), line, column, length);
  },

  openFile: (rel) => openEditor({
    id: fileTabId(rel), kind: "file", rel, staged: false, name: fileName(rel),
  }, set, get),

  openDiff: (rel, staged) => openEditor({
    id: diffTabId(rel, staged), kind: "diff", rel, staged, name: fileName(rel),
  }, set, get),

  closeEditor: async (id) => {
    const state = get();
    if (isDirty(state, id)) {
      const tab = state.editors.find((item) => item.id === id);
      const ok = await ask(
        `Discard unsaved changes to ${tab?.name ?? "this file"}?`,
      );
      if (!ok) return;
    }
    dropDocument(id, set, get);
    if (state.root) {
      useKeel
        .getState()
        .rewriteEditorTabs(state.root, (ref) => (editorRefId(ref) === id ? null : ref));
    }
  },

  ensureDocument: (ref) =>
    openEditor(
      {
        id: editorRefId(ref),
        kind: ref.kind,
        rel: ref.rel,
        staged: ref.staged,
        ...(ref.rev ? { rev: ref.rev } : {}),
        name: fileName(ref.rel),
      },
      set,
      get,
      false,
    ),

  closeTab: async (projectId, paneId, id) => {
    const keel = useKeel.getState();
    const project = keel.projects.find((item) => item.id === projectId);
    if (!project) return;
    const root = get().root;
    // Only the last pane showing a file takes its unsaved edits with it.
    const last = root !== null && project.path === root && !tabShown(root, id, paneId);
    if (last && isDirty(get(), id)) {
      const tab = get().editors.find((item) => item.id === id);
      const ok = await ask(
        `Discard unsaved changes to ${tab?.name ?? "this file"}?`,
      );
      if (!ok) return;
    }
    keel.closeEditorTab(projectId, paneId, id);
    if (last && root) releaseLater(root, [id], set, get);
  },

  closePaneSafely: async (projectId, paneId) => {
    const keel = useKeel.getState();
    const project = keel.projects.find((item) => item.id === projectId);
    const pane = project ? deckOfPane(project, paneId)?.panes[paneId] : undefined;
    if (!project || !pane) return;
    const root = get().root;
    if (pane.editor && root !== null && project.path === root) {
      const last = pane.editor.tabs
        .map(editorRefId)
        .filter((id) => !tabShown(root, id, paneId));
      const dirty = get().editors.filter(
        (tab) => last.includes(tab.id) && isDirty(get(), tab.id),
      );
      if (dirty.length) {
        const first = dirty[0];
        const ok = await ask(
          dirty.length === 1 && first
            ? `Discard unsaved changes to ${first.name}?`
            : `Discard unsaved changes in ${dirty.length} files?`,
        );
        if (!ok) return;
      }
      keel.dismissPane(projectId, paneId);
      releaseLater(root, last, set, get);
      return;
    }
    if (
      pane.agentId &&
      !(paneId in keel.exited) &&
      !(paneId in keel.closing)
    ) {
      const ok = await ask(
        `Closing ${pane.title || "this terminal"} stops the agent. There is no undo.`,
      );
      if (!ok) return;
    }
    keel.dismissPane(projectId, paneId);
  },

  removeProjectSafely: async (projectId) => {
    const keel = useKeel.getState();
    const project = keel.projects.find((item) => item.id === projectId);
    if (!project) return;
    const state = get();
    const dirty =
      state.root === project.path
        ? state.editors.filter((tab) => isDirty(state, tab.id))
        : [];
    if (dirty.length) {
      const first = dirty[0];
      const ok = await ask(
        dirty.length === 1 && first
          ? `Remove this project and discard unsaved changes to ${first.name}?`
          : `Remove this project and discard unsaved changes in ${dirty.length} files?`,
      );
      if (!ok) return;
    }
    keel.removeProject(projectId);
  },

  removeDeckSafely: async (projectId, deckId) => {
    const keel = useKeel.getState();
    const project = keel.projects.find((item) => item.id === projectId);
    const deck = project?.decks.find((item) => item.id === deckId);
    if (!project || !deck) return;
    const state = get();
    const dirty =
      state.root === project.path
        ? state.editors.filter((tab) => {
            if (!isDirty(state, tab.id)) return false;
            return Object.values(deck.panes).some((pane) =>
              pane.editor?.tabs.some((ref) => editorRefId(ref) === tab.id),
            );
          })
        : [];
    if (dirty.length) {
      const first = dirty[0];
      const ok = await ask(
        dirty.length === 1 && first
          ? `Remove this deck and discard unsaved changes to ${first.name}?`
          : `Remove this deck and discard unsaved changes in ${dirty.length} files?`,
      );
      if (!ok) return;
    }
    keel.removeDeck(projectId, deckId);
  },

  setActiveEditor: (id) => {
    editorNavigation += 1;
    clearEditorReveals();
    set({ activeEditor: id });
  },
  setBuffer: (id, value) =>
    set({ buffers: { ...get().buffers, [id]: value } }),

  saveActive: async () => {
    const id = get().activeEditor;
    if (id) await get().saveTab(id);
  },

  saveTab: async (id) => {
    const state = get();
    const root = state.root;
    const tab = state.editors.find((item) => item.id === id);
    if (!root || !tab || tab.kind !== "file") return;
    const snapshot = state.snapshots[id];
    if (!snapshot || state.editorLoading[id] || state.editorErrors[id]) return;
    if (snapshot.binary || snapshot.truncated) return;
    const written = state.buffers[id] ?? "";
    try {
      const mtimeMs = await api.workspaceWrite(root, tab.rel, written, snapshot.mtimeMs);
      const { [id]: _cleared, ...externalChange } = get().externalChange;
      const nextSnapshot: FileContents = {
        ...snapshot,
        text: written,
        mtimeMs,
        size: new TextEncoder().encode(written).length,
      };
      set({
        originals: { ...get().originals, [id]: written },
        snapshots: { ...get().snapshots, [id]: nextSnapshot },
        externalChange,
      });
      void get().refreshGit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  startCreate: (parent, kind) => {
    set({ creating: { parent, kind }, renaming: null });
    if (parent && !get().expanded[parent]) {
      set({ expanded: { ...get().expanded, [parent]: true } });
      void get().loadDir(parent);
    }
  },
  cancelCreate: () => set({ creating: null }),
  confirmCreate: async (name) => {
    const root = get().root;
    const creating = get().creating;
    const trimmed = name.trim();
    if (!root || !creating || !trimmed) {
      set({ creating: null });
      return;
    }
    const rel = joinRel(creating.parent, trimmed);
    try {
      await api.workspaceCreate(root, rel, creating.kind);
      set({ creating: null });
      await get().loadDir(creating.parent);
      if (creating.kind === "file") await get().openFile(rel);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  startRename: (rel) => set({ renaming: rel, creating: null }),
  cancelRename: () => set({ renaming: null }),
  confirmRename: async (name) => {
    const root = get().root;
    const rel = get().renaming;
    const trimmed = name.trim();
    if (!root || !rel || !trimmed) {
      set({ renaming: null });
      return;
    }
    const toRel = joinRel(parentRel(rel), trimmed);
    if (toRel === rel) {
      set({ renaming: null });
      return;
    }
    try {
      await api.workspaceRename(root, rel, toRel);
      set({ renaming: null });
      await settleMove(rel, toRel, set, get);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  deleteEntry: async (rel) => {
    const root = get().root;
    if (!root) return;
    try {
      await api.workspaceDelete(root, rel);
      const prefix = rel + "/";
      useKeel
        .getState()
        .rewriteEditorTabs(root, (ref) =>
          ref.rel === rel || ref.rel.startsWith(prefix) ? null : ref,
        );
      set({
        editors: get().editors.filter(
          (tab) => tab.rel !== rel && !tab.rel.startsWith(prefix),
        ),
        ...pruneDir(get(), rel),
      });
      await get().loadDir(parentRel(rel));
      void get().refreshGit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  moveEntry: async (rel, targetDir) => {
    const root = get().root;
    if (!root || !canMoveInto(rel, targetDir)) return;
    const toRel = joinRel(targetDir, fileName(rel));
    try {
      await api.workspaceRename(root, rel, toRel);
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    // Open the folder it went into, so you can see where it landed.
    if (targetDir && !get().expanded[targetDir]) {
      set({ expanded: { ...get().expanded, [targetDir]: true } });
    }
    await settleMove(rel, toRel, set, get);
  },

  stage: (paths, all = false) =>
    runGit(set, get, (root) => api.gitStage(root, paths, all)),
  unstage: (paths, all = false) =>
    runGit(set, get, (root) => api.gitUnstage(root, paths, all)),
  discard: (paths) =>
    runGit(set, get, (root) => api.gitDiscard(root, paths)),

  commit: async (andPush = false) => {
    const root = get().root;
    const message = get().commitMessage.trim();
    if (!root || get().busy) return;
    const version = projectVersion;
    if (!message) {
      toast.error("Write a commit message first.");
      return;
    }
    const git = get().git;
    const options = get().commitOptions;
    const nothingStaged = !git?.files.some((file) => file.staged);
    // Conflicts are never swept into a commit-all; they have to be resolved.
    const sweep = (git?.files ?? []).filter((file) => !file.conflict);
    set({ busy: true });
    try {
      // Amending with nothing staged rewords the last commit, so leave it be.
      if (nothingStaged && sweep.length > 0 && !options.amend) {
        // A cut-short list can't name every file, so sweep the whole tree.
        // Conflicts block the commit button, so there are none to sweep in.
        if (git && changesTruncated(git)) await api.gitStage(root, [], true);
        else await api.gitStage(root, sweep.map((file) => file.path));
      }
      const hash = await api.gitCommit(root, message, options);
      // Clear it in whichever project made the commit, even if you left it meanwhile.
      if (get().root === root) {
        set({ commitMessage: "", commitOptions: { ...get().commitOptions, amend: false } });
      } else {
        const stashed = stashedBrowse.get(root);
        if (stashed) {
          stashed.commitMessage = "";
          stashed.amend = false;
        }
      }
      toast.success(options.amend ? `Amended ${hash}` : `Committed ${hash}`, andPush ? {} : {
        action: {
          label: "Undo",
          onClick: () => {
            if (get().root === root) void get().undoCommit();
          },
        },
      });
      if (andPush) {
        const pushed = await api.gitPush(root, !git?.upstream);
        toast.success(pushed);
      }
      if (version !== projectVersion) return;
      await get().refreshGit(true);
      if (version === projectVersion) void get().refreshMeta();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === projectVersion) set({ busy: false });
    }
  },

  undoCommit: () => {
    const version = projectVersion;
    return runGit(set, get, async (root) => {
      const message = await api.gitUndoCommit(root);
      if (version === projectVersion && !get().commitMessage.trim()) {
        set({ commitMessage: message, gitView: "changes" });
      }
      return "Undid the last commit. Its changes are staged.";
    });
  },
  push: (force = false) =>
    runGit(set, get, (root) => api.gitPush(root, !get().git?.upstream, force)),
  pull: (mode = "ff-only") => runGit(set, get, (root) => api.gitPull(root, mode)),
  fetch: () => runGit(set, get, (root) => api.gitFetch(root)),
  checkout: (name) =>
    runGit(set, get, async (root) => {
      await api.gitCheckout(root, name);
      return `Checked out ${name}`;
    }),
  checkoutRemote: (name) => runGit(set, get, (root) => api.gitCheckoutRemote(root, name)),
  checkoutRev: (rev) => runGit(set, get, (root) => api.gitCheckoutRev(root, rev)),
  createBranch: (name, checkout, start = null) =>
    runGit(set, get, async (root) => {
      await api.gitBranchCreate(root, name, checkout, start);
      return checkout ? `On ${name}` : `Created ${name}`;
    }),
  renameBranch: (from, to) => runGit(set, get, (root) => api.gitBranchRename(root, from, to)),
  deleteBranch: (name) =>
    runGit(set, get, async (root) => {
      try {
        await api.gitBranchDelete(root, name);
      } catch (error) {
        if (!/not fully merged/i.test(errorMessage(error))) throw error;
        const ok = await ask(
          `${name} has commits that no other branch has. Delete it anyway? Those commits will be lost.`,
        );
        if (!ok) return;
        await api.gitBranchDelete(root, name, true);
      }
      return `Deleted ${name}`;
    }),
  deleteRemoteBranch: (name) =>
    runGit(set, get, (root) => api.gitBranchDeleteRemote(root, name)),
  merge: (name, mode = "default") => runGit(set, get, (root) => api.gitMerge(root, name, mode)),
  rebase: (onto) => runGit(set, get, (root) => api.gitRebase(root, onto)),
  cherryPick: (rev) => runGit(set, get, (root) => api.gitCherryPick(root, rev)),
  revert: (rev) => runGit(set, get, (root) => api.gitRevert(root, rev)),
  reset: (rev, mode) => runGit(set, get, (root) => api.gitReset(root, rev, mode)),
  operation: (action) => runGit(set, get, (root) => api.gitOperation(root, action)),
  resolve: (paths, side) =>
    runGit(set, get, async (root) => {
      await api.gitResolve(root, paths, side);
      const count = paths.length === 1 ? "1 file" : `${paths.length} files`;
      return `Took ${side === "ours" ? "ours" : "theirs"} for ${count}`;
    }),
  ignore: (pattern) =>
    runGit(set, get, async (root) => {
      await api.gitIgnore(root, pattern);
      return `Ignoring ${pattern}`;
    }),
  stashPush: (args) => runGit(set, get, (root) => api.gitStashPush(root, args)),
  stashApply: (stash, pop) => runGit(set, get, (root) => api.gitStashApply(root, stash, pop)),
  stashDrop: (stash) => runGit(set, get, (root) => api.gitStashDrop(root, stash)),
  createTag: (name, rev, message = null) =>
    runGit(set, get, (root) => api.gitTagCreate(root, name, rev, message)),
  deleteTag: (name) => runGit(set, get, (root) => api.gitTagDelete(root, name)),
  pushTag: (name) => runGit(set, get, (root) => api.gitTagPush(root, name)),
  createPr: (args) =>
    runGit(set, get, async (root) => {
      const pr = await api.prCreate(root, args);
      return `Opened #${pr.number}`;
    }),
  checkoutPr: (number) =>
    runGit(set, get, async (root) => {
      await api.prCheckout(root, number);
      return `Checked out #${number}`;
    }),
}));

/**
 * Whether `rel` can be dropped into `targetDir`: not where it already is, and
 * never into itself or anything inside it.
 */
export function canMoveInto(rel: string, targetDir: string): boolean {
  return (
    parentRel(rel) !== targetDir &&
    targetDir !== rel &&
    !targetDir.startsWith(`${rel}/`)
  );
}

export function editorDirty(state: WorkspaceState, id: string | null): boolean {
  if (!id) return false;
  return isDirty(state, id);
}

export function unsavedFiles(): { id: string; name: string }[] {
  const state = useWorkspace.getState();
  return state.editors
    .filter((tab) => tab.kind === "file" && isDirty(state, tab.id))
    .map((tab) => ({ id: tab.id, name: tab.name }));
}

/** Stashed docs in other projects are also unsaved. */
export function unsavedFilesAll(): { name: string }[] {
  const current = unsavedFiles().map(({ name }) => ({ name }));
  const stashed: { name: string }[] = [];
  for (const docs of stashedDocs.values()) {
    for (const tab of docs.editors) {
      if (tab.kind !== "file") continue;
      if ((docs.buffers[tab.id] ?? "") !== (docs.originals[tab.id] ?? "")) {
        stashed.push({ name: tab.name });
      }
    }
  }
  return [...current, ...stashed];
}
