/**
 * Files, git and the editor — live UI state, never written to keel.json.
 *
 * The project folder comes from the active project in the main store. Buffers
 * live here so typing in the editor does not persist a snapshot of the file.
 */

import { create } from "zustand";
import { toast } from "sonner";

import { diffTabId, editorRefId, fileTabId } from "../lib/editorRefs.ts";
import { revealInEditor } from "../lib/editorViews.ts";
import { fileName, joinRel, parentRel } from "../lib/git.ts";
import { noteRecent, pruneRecent } from "../lib/recentFiles.ts";
import type { EditorRef } from "../lib/types.ts";
import * as api from "../lib/workspace.ts";
import { WorkspaceReads } from "../lib/workspaceReads.ts";
import { sameWatchRoot } from "../lib/workspaceWatch.ts";
import { deckOfPane, useKeel } from "./store.ts";
import type {
  FileContents,
  GitBranches,
  GitDiff,
  GitStatus,
  GrepHit,
  PrList,
  WorkspaceEntry,
} from "@/lib/workspace";

export type InspectorTab = "files" | "git" | "search";
export type GitMetaSection = "branches" | "prs" | "history";

export type EditorKind = "file" | "diff";

export interface EditorTab {
  id: string;
  kind: EditorKind;
  rel: string;
  staged: boolean;
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
  grepRegex: boolean;
  grepHits: GrepHit[] | null;
  grepTruncated: boolean;
  grepLoading: boolean;
  grepError: string | null;

  git: GitStatus | null;
  gitLoading: boolean;
  gitError: string | null;
  branches: GitBranches | null;
  prs: PrList | null;
  commits: api.GitCommit[] | null;
  metaLoading: Partial<Record<GitMetaSection, boolean>>;
  metaErrors: Partial<Record<GitMetaSection, string | null>>;
  commitMessage: string;

  editors: EditorTab[];
  activeEditor: string | null;
  buffers: Record<string, string>;
  originals: Record<string, string>;
  snapshots: Record<string, FileContents>;
  diffs: Record<string, GitDiff>;
  editorLoading: Record<string, boolean>;
  editorErrors: Record<string, string | null>;
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
  setSelected: (rel: string | null) => void;
  toggleExpanded: (rel: string) => void;
  collapseAll: () => void;
  loadDir:(rel: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshGit: (afterPending?: boolean) => Promise<void>;
  refreshMeta: () => Promise<void>;
  refreshBranches: (afterPending?: boolean) => Promise<void>;
  refreshPrs: (afterPending?: boolean) => Promise<void>;
  refreshHistory: (afterPending?: boolean) => Promise<void>;
  search: (query: string) => Promise<void>;
  setGrepQuery: (query: string) => void;
  setGrepRegex: (on: boolean) => void;
  grep: (query: string) => Promise<void>;
  openFileAt: (rel: string, line: number, column?: number) => Promise<void>;

  openFile: (rel: string) => Promise<void>;
  openDiff: (rel: string, staged: boolean) => Promise<void>;
  /** Close a file everywhere it is open, asking first if it has unsaved edits. */
  closeEditor: (id: string) => void;
  /** Load a tab's contents without moving focus or touching the layout. */
  ensureDocument: (ref: EditorRef) => Promise<void>;
  /** Close one tab of an editor pane, asking first if that drops unsaved edits. */
  closeTab: (projectId: string, paneId: string, id: string) => void;
  /** Close any pane from the UI. An editor pane asks before dropping unsaved edits. */
  closePaneSafely: (projectId: string, paneId: string) => void;
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

  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (andPush?: boolean) => Promise<void>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  fetch: () => Promise<void>;
  checkout: (name: string) => Promise<void>;
  createBranch: (name: string, checkout: boolean) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
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
  };
}

/** What to keep when leaving a folder. Reads still in flight are abandoned, so those load again. */
function settledDocs(state: WorkspaceState): EditorDocs {
  const pending = new Set(
    state.editors.filter((tab) => state.editorLoading[tab.id]).map((tab) => tab.id),
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
  };
}

/** Put a tab on screen: in an editor pane on the deck you are looking at. */
function revealInLayout(root: string, tab: EditorTab) {
  const keel = useKeel.getState();
  const project = keel.projects.find((item) => item.id === keel.activeProjectId);
  if (!project || project.path !== root) return;
  keel.openInEditor(project.id, { kind: tab.kind, rel: tab.rel, staged: tab.staged });
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
  const state = get();
  const editors = state.editors.filter((tab) => tab.id !== id);
  const { [id]: _b, ...buffers } = state.buffers;
  const { [id]: _o, ...originals } = state.originals;
  const { [id]: _s, ...snapshots } = state.snapshots;
  const { [id]: _d, ...diffs } = state.diffs;
  const { [id]: _l, ...editorLoading } = state.editorLoading;
  const { [id]: _e, ...editorErrors } = state.editorErrors;
  const activeEditor =
    state.activeEditor === id
      ? (editors[editors.length - 1]?.id ?? null)
      : state.activeEditor;
  set({ editors, buffers, originals, snapshots, diffs, editorLoading, editorErrors, activeEditor });
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
  if (reveal) revealInLayout(root, tab);
  const existing = get().editors.find((item) => item.id === id);
  const focus = reveal
    ? {
        activeEditor: id,
        selectedRel: rel,
        ...(tab.kind === "diff" ? { tab: "git" as const } : {}),
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
  return reads.run(`editor:${++editorReadId}`, async (isCurrent) => {
    // Identity also rejects reads for a tab that was closed and reopened.
    const isOpen = () => isCurrent() && get().editors.includes(tab);
    try {
      if (tab.kind === "diff") {
        const diff = await api.gitDiff(root, rel, tab.staged);
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
  showHidden: false,
  query: "",
  tree: {},
  expanded: {},
  selectedRel: null,
  creating: null,
  renaming: null,
  searchHits: null,
  rowMotion: {},

  grepQuery: "",
  grepRegex: false,
  grepHits: null,
  grepTruncated: false,
  grepLoading: false,
  grepError: null,

  git: null,
  gitLoading: false,
  gitError: null,
  branches: null,
  prs: null,
  commits: null,
  metaLoading: {},
  metaErrors: {},
  commitMessage: "",

  editors: [],
  activeEditor: null,
  buffers: {},
  originals: {},
  snapshots: {},
  diffs: {},
  editorLoading: {},
  editorErrors: {},
  busy: false,
  fsWatch: false,
  recentEpoch: 0,

  setRoot: (root) => {
    const previous = get().root;
    if (previous === root) return;
    projectVersion += 1;
    grepGeneration += 1;
    reads.reset();
    if (previous) stashedDocs.set(previous, settledDocs(get()));
    // No project at all: nothing will come back for what was open.
    if (!root) stashedDocs.clear();
    const docs = (root ? stashedDocs.get(root) : undefined) ?? emptyDocs();
    if (root) stashedDocs.delete(root);
    set({
      root,
      tree: {},
      expanded: {},
      selectedRel: null,
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
    if (!sameWatchRoot(get().root, root)) return;
    const full = rels.some((rel) => rel === "");
    if (full || rels.length > 0) void get().refreshTree();
    if (git || full) void get().refreshGit();
  },
  setShowHidden: async (showHidden) => {
    // The tree stays up while the new listings load — clearing it first blanked
    // the whole panel for a frame and left open folders empty.
    set({ showHidden });
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
    if (query.trim().length < 2) set({ searchHits: null });
  },
  setCommitMessage: (commitMessage) => set({ commitMessage }),
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
    try {
      const entries = await api.workspaceList(root, rel, showHidden);
      if (version !== projectVersion || showHidden !== get().showHidden) return;
      set({ tree: { ...get().tree, [rel]: entries } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  refreshTree: async () => {
    const { root, tree } = get();
    if (!root) return;
    const dirs = Object.keys(tree);
    await Promise.all(dirs.map((rel) => get().loadDir(rel)));
  },

  refreshGit: (afterPending = false) => {
    const root = get().root;
    if (!root) return Promise.resolve();
    return reads.run("status", async (isCurrent) => {
      set({ gitLoading: true });
      try {
        const git = await api.gitStatus(root);
        if (isCurrent()) set({ git, gitError: null, gitLoading: false });
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
    ]);
  },

  refreshBranches: (afterPending) => refreshMetadata(
    "branches", api.gitBranches, (branches) => set({ branches }), set, get, afterPending,
  ),
  refreshPrs: (afterPending) => refreshMetadata(
    "prs", api.prList, (prs) => set({ prs }), set, get, afterPending,
  ),
  refreshHistory: (afterPending) => refreshMetadata(
    "history", (root) => api.gitLog(root, 20), (commits) => set({ commits }), set, get, afterPending,
  ),

  search: async (query) => {
    const root = get().root;
    const needle = query.trim();
    set({ query });
    if (!root || needle.length < 2) {
      set({ searchHits: null });
      return;
    }
    try {
      const searchHits = await api.workspaceSearch(root, needle);
      set({ searchHits });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  },

  setGrepQuery: (query) => {
    set({ grepQuery: query });
    if (query.trim().length < 2) {
      grepGeneration += 1;
      set({
        grepHits: null,
        grepTruncated: false,
        grepLoading: false,
        grepError: null,
      });
    }
  },
  setGrepRegex: (grepRegex) => set({ grepRegex }),
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
      });
      return;
    }
    const generation = ++grepGeneration;
    const version = projectVersion;
    const isRegex = get().grepRegex;
    set({ grepLoading: true, grepError: null });
    try {
      const results = await api.workspaceGrep(root, needle, { regex: isRegex });
      if (generation !== grepGeneration || version !== projectVersion) return;
      set({
        grepHits: results.hits,
        grepTruncated: results.truncated,
        grepLoading: false,
        grepError: null,
      });
    } catch (error) {
      if (generation !== grepGeneration || version !== projectVersion) return;
      const grepError = errorMessage(error);
      toast.error(grepError);
      set({ grepError, grepLoading: false });
    }
  },

  openFileAt: async (rel, line, column) => {
    await get().openFile(rel);
    revealInEditor(fileTabId(rel), line, column);
  },

  openFile: (rel) => openEditor({
    id: fileTabId(rel), kind: "file", rel, staged: false, name: fileName(rel),
  }, set, get),

  openDiff: (rel, staged) => openEditor({
    id: diffTabId(rel, staged), kind: "diff", rel, staged, name: fileName(rel),
  }, set, get),

  closeEditor: (id) => {
    const state = get();
    if (isDirty(state, id)) {
      const tab = state.editors.find((item) => item.id === id);
      const ok = window.confirm(
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
        name: fileName(ref.rel),
      },
      set,
      get,
      false,
    ),

  closeTab: (projectId, paneId, id) => {
    const keel = useKeel.getState();
    const project = keel.projects.find((item) => item.id === projectId);
    if (!project) return;
    const root = get().root;
    // Only the last pane showing a file takes its unsaved edits with it.
    const last = root !== null && project.path === root && !tabShown(root, id, paneId);
    if (last && isDirty(get(), id)) {
      const tab = get().editors.find((item) => item.id === id);
      const ok = window.confirm(
        `Discard unsaved changes to ${tab?.name ?? "this file"}?`,
      );
      if (!ok) return;
    }
    keel.closeEditorTab(projectId, paneId, id);
    if (last && root) releaseLater(root, [id], set, get);
  },

  closePaneSafely: (projectId, paneId) => {
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
        const ok = window.confirm(
          dirty.length === 1
            ? `Discard unsaved changes to ${dirty[0].name}?`
            : `Discard unsaved changes in ${dirty.length} files?`,
        );
        if (!ok) return;
      }
      keel.dismissPane(projectId, paneId);
      releaseLater(root, last, set, get);
      return;
    }
    keel.dismissPane(projectId, paneId);
  },

  setActiveEditor: (id) => set({ activeEditor: id }),
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
    if (!state.snapshots[id] || state.editorLoading[id] || state.editorErrors[id]) return;
    if (state.snapshots[id].binary) return;
    try {
      await api.workspaceWrite(root, tab.rel, state.buffers[id] ?? "");
      set({
        originals: { ...get().originals, [id]: state.buffers[id] ?? "" },
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
        selectedRel: get().selectedRel === rel ? null : get().selectedRel,
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

  stage: (paths) =>
    runGit(set, get, (root) => api.gitStage(root, paths)),
  unstage: (paths) =>
    runGit(set, get, (root) => api.gitUnstage(root, paths)),
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
    const nothingStaged = !git?.files.some((file) => file.staged);
    const hasChanges = (git?.files.length ?? 0) > 0;
    set({ busy: true });
    try {
      if (nothingStaged && hasChanges) {
        await api.gitStage(
          root,
          git!.files.map((file) => file.path),
        );
      }
      const hash = await api.gitCommit(root, message);
      if (version === projectVersion) set({ commitMessage: "" });
      toast.success(`Committed ${hash}`);
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

  push: () =>
    runGit(set, get, (root) => api.gitPush(root, !get().git?.upstream)),
  pull: () => runGit(set, get, (root) => api.gitPull(root)),
  fetch: () => runGit(set, get, (root) => api.gitFetch(root)),
  checkout: (name) =>
    runGit(set, get, async (root) => {
      await api.gitCheckout(root, name);
      return `Checked out ${name}`;
    }),
  createBranch: (name, checkout) =>
    runGit(set, get, async (root) => {
      await api.gitBranchCreate(root, name, checkout);
      return checkout ? `On ${name}` : `Created ${name}`;
    }),
  deleteBranch: (name) =>
    runGit(set, get, async (root) => {
      await api.gitBranchDelete(root, name);
      return `Deleted ${name}`;
    }),
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
