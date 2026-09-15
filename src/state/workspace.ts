/**
 * Files, git and the editor — live UI state, never written to keel.json.
 *
 * The project folder comes from the active project in the main store. Buffers
 * live here so typing in the editor does not persist a snapshot of the file.
 */

import { create } from "zustand";
import { toast } from "sonner";

import { fileName, joinRel, parentRel } from "../lib/git.ts";
import * as api from "../lib/workspace.ts";
import { WorkspaceReads } from "../lib/workspaceReads.ts";
import type {
  FileContents,
  GitBranches,
  GitDiff,
  GitStatus,
  PrList,
  WorkspaceEntry,
} from "@/lib/workspace";

export type InspectorTab = "files" | "git";
export type GitMetaSection = "branches" | "prs" | "history";

export type EditorKind = "file" | "diff";

export interface EditorTab {
  id: string;
  kind: EditorKind;
  rel: string;
  staged: boolean;
  name: string;
}

export function fileTabId(rel: string): string {
  return `file:${rel}`;
}

export function diffTabId(rel: string, staged: boolean): string {
  return `diff:${staged ? "staged" : "work"}:${rel}`;
}

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

  setRoot: (root: string | null) => void;
  setTab: (tab: InspectorTab) => void;
  setShowHidden: (show: boolean) => void;
  setQuery: (query: string) => void;
  setCommitMessage: (message: string) => void;
  setSelected: (rel: string | null) => void;
  toggleExpanded: (rel: string) => void;
  loadDir: (rel: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshGit: (afterPending?: boolean) => Promise<void>;
  refreshMeta: () => Promise<void>;
  refreshBranches: (afterPending?: boolean) => Promise<void>;
  refreshPrs: (afterPending?: boolean) => Promise<void>;
  refreshHistory: (afterPending?: boolean) => Promise<void>;
  search: (query: string) => Promise<void>;

  openFile: (rel: string) => Promise<void>;
  openDiff: (rel: string, staged: boolean) => Promise<void>;
  closeEditor: (id: string) => void;
  closeAllEditors: () => void;
  setActiveEditor: (id: string) => void;
  setBuffer: (id: string, value: string) => void;
  saveActive: () => Promise<void>;
  saveTab: (id: string) => Promise<void>;

  startCreate: (parent: string, kind: "file" | "dir") => void;
  cancelCreate: () => void;
  confirmCreate: (name: string) => Promise<void>;
  startRename: (rel: string) => void;
  cancelRename: () => void;
  confirmRename: (name: string) => Promise<void>;
  deleteEntry: (rel: string) => Promise<void>;

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
let editorReadId = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openEditor(
  tab: EditorTab,
  set: (partial: Partial<WorkspaceState>) => void,
  get: () => WorkspaceState,
) {
  const root = get().root;
  if (!root) return Promise.resolve();
  const { id, rel } = tab;
  const existing = get().editors.find((item) => item.id === id);
  const focus = {
    activeEditor: id,
    selectedRel: rel,
    ...(tab.kind === "diff" ? { tab: "git" as const } : {}),
  };
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

  setRoot: (root) => {
    const previous = get().root;
    if (previous === root) return;
    projectVersion += 1;
    reads.reset();
    set({
      root,
      tree: {},
      expanded: {},
      selectedRel: null,
      creating: null,
      renaming: null,
      searchHits: null,
      query: "",
      git: null,
      gitLoading: false,
      gitError: null,
      branches: null,
      prs: null,
      commits: null,
      metaLoading: {},
      metaErrors: {},
      editors: [],
      activeEditor: null,
      buffers: {},
      originals: {},
      snapshots: {},
      diffs: {},
      editorLoading: {},
      editorErrors: {},
      busy: false,
    });
    if (root) {
      void get().loadDir("");
      void get().refreshGit();
    }
  },

  setTab: (tab) => {
    set({ tab });
  },
  setShowHidden: (showHidden) => {
    set({ showHidden, tree: {} });
    void get().loadDir("");
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
  },

  closeAllEditors: () => {
    const dirty = get().editors.filter((tab) => isDirty(get(), tab.id));
    if (dirty.length) {
      const ok = window.confirm(
        dirty.length === 1
          ? `Discard unsaved changes to ${dirty[0].name}?`
          : `Discard unsaved changes in ${dirty.length} files?`,
      );
      if (!ok) return;
    }
    set({
      editors: [],
      activeEditor: null,
      buffers: {},
      originals: {},
      snapshots: {},
      diffs: {},
      editorLoading: {},
      editorErrors: {},
    });
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
      await get().loadDir(parentRel(rel));
      const fromId = fileTabId(rel);
      const editors = get().editors.map((tab) =>
        tab.rel === rel ? { ...tab, rel: toRel, name: trimmed, id: fileTabId(toRel) } : tab,
      );
      // Buffers keyed by tab id follow the rename.
      const state = get();
      const nextBuffers = { ...state.buffers };
      const nextOriginals = { ...state.originals };
      const nextSnapshots = { ...state.snapshots };
      if (nextBuffers[fromId] !== undefined) {
        const toId = fileTabId(toRel);
        nextBuffers[toId] = nextBuffers[fromId];
        nextOriginals[toId] = nextOriginals[fromId];
        if (nextSnapshots[fromId]) nextSnapshots[toId] = nextSnapshots[fromId];
        delete nextBuffers[fromId];
        delete nextOriginals[fromId];
        delete nextSnapshots[fromId];
      }
      set({
        editors,
        buffers: nextBuffers,
        originals: nextOriginals,
        snapshots: nextSnapshots,
        activeEditor:
          state.activeEditor === fromId ? fileTabId(toRel) : state.activeEditor,
      });
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

export function editorDirty(state: WorkspaceState, id: string | null): boolean {
  if (!id) return false;
  return isDirty(state, id);
}
