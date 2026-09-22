import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { registerEditorView } from "./editorViews.ts";
import { diffTabId, fileTabId, unsavedFiles, unsavedFilesAll, useWorkspace } from "../state/workspace.ts";
import type { GitDiff, GitStatus, PrList, WorkspaceEntry } from "./workspace.ts";

const state = useWorkspace.getState;
const status: GitStatus = {
  git: true, repo: true, branch: "main", detached: false,
  upstream: null, ahead: 0, behind: 0, files: [],
};
const branches = { current: "main", detached: false, items: [] };
const prs: PrList = { available: true, items: [], error: null };
const diff: GitDiff = { path: "a.ts", binary: false, hunks: [] };
const contents = { text: "hello", size: 5, binary: false, truncated: false, mtimeMs: 1 };

const entry = (rel: string, kind: "file" | "dir"): WorkspaceEntry => ({
  name: rel.slice(rel.lastIndexOf("/") + 1),
  rel,
  kind,
  size: kind === "file" ? 1 : null,
});
const file = (rel: string) => entry(rel, "file");
const dir = (rel: string) => entry(rel, "dir");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  Object.assign(globalThis, { window: {} });
  state().setRoot(null);
  mockIPC((cmd) => cmd === "git_status" ? status : []);
  state().setRoot("project-a");
  await state().refreshGit();
});

it("coalesces repeated status polls while Git is slow", async () => {
  const pending = deferred<GitStatus>();
  let calls = 0;
  mockIPC(() => { calls++; return pending.promise; });
  const requests = Array.from({ length: 10 }, () => state().refreshGit());
  await tick();
  assert.equal(calls, 1);
  assert.equal(state().gitLoading, true);
  pending.resolve(status);
  await Promise.all(requests);
  assert.equal(state().gitLoading, false);
});

it("does not request folded metadata when selecting Git", async () => {
  const calls: string[] = [];
  mockIPC((cmd) => { calls.push(cmd); return status; });
  state().setTab("git");
  await state().refreshMeta();
  assert.deepEqual(calls, []);
});

it("publishes branches and history while pull requests are still pending", async () => {
  const pending = deferred<PrList>();
  mockIPC((cmd) => {
    if (cmd === "git_branches") return branches;
    if (cmd === "git_log") return [];
    if (cmd === "pr_list") return pending.promise;
    throw new Error(cmd);
  });
  const request = state().refreshPrs();
  await Promise.all([state().refreshBranches(), state().refreshHistory()]);
  assert.deepEqual(state().branches, branches);
  assert.deepEqual(state().commits, []);
  assert.equal(state().prs, null);
  assert.equal(state().metaLoading.prs, true);
  pending.resolve(prs);
  await request;
});

it("ignores old status and metadata even when returning to the same project", async () => {
  const oldStatus = deferred<GitStatus>();
  const oldBranches = deferred<typeof branches>();
  mockIPC((cmd) => cmd === "git_status" ? oldStatus.promise : oldBranches.promise);
  const statusRequest = state().refreshGit();
  const branchRequest = state().refreshBranches();
  await tick();
  mockIPC((cmd) => cmd === "git_status" ? status : []);
  state().setRoot("project-b");
  state().setRoot("project-a");
  await state().refreshGit();
  oldStatus.resolve({ ...status, branch: "stale" });
  oldBranches.resolve(branches);
  await Promise.all([statusRequest, branchRequest]);
  assert.equal(state().git?.branch, "main");
  assert.equal(state().branches, null);
  assert.deepEqual(state().metaLoading, {});
});

it("reports a metadata failure and clears it on retry", async () => {
  mockIPC(() => Promise.reject("Unable to read history"));
  await state().refreshHistory();
  assert.equal(state().metaErrors.history, "Unable to read history");
  assert.equal(state().metaLoading.history, false);
  assert.equal(state().commits, null);
  mockIPC(() => []);
  await state().refreshHistory();
  assert.equal(state().metaErrors.history, null);
  assert.deepEqual(state().commits, []);
});

it("opens a diff immediately, coalesces clicks, and never steals focus on completion", async () => {
  const pending = deferred<GitDiff>();
  let diffCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "git_diff") { diffCalls++; return pending.promise; }
    return contents;
  });
  const request = state().openDiff("a.ts", false);
  assert.equal(state().activeEditor, diffTabId("a.ts", false));
  assert.equal(state().editorLoading[diffTabId("a.ts", false)], true);
  await state().openDiff("a.ts", false);
  await state().openFile("b.ts");
  pending.resolve(diff);
  await request;
  assert.equal(diffCalls, 1);
  assert.equal(state().editors.length, 2);
  assert.equal(state().activeEditor, fileTabId("b.ts"));
  assert.equal(state().editorLoading[diffTabId("a.ts", false)], false);
});

it("ignores a file read completed after its tab was closed and reopened", async () => {
  const pending = deferred<typeof contents>();
  mockIPC(() => pending.promise);
  const request = state().openFile("a.ts");
  await tick();
  state().closeEditor(fileTabId("a.ts"));
  mockIPC(() => ({ ...contents, text: "new" }));
  await state().openFile("a.ts");
  pending.resolve(contents);
  await request;
  assert.equal(state().buffers[fileTabId("a.ts")], "new");
  assert.equal(state().editors.length, 1);
});

it("cannot save an empty buffer while its file is still loading", async () => {
  const pending = deferred<typeof contents>();
  const writes: string[] = [];
  mockIPC((cmd) => {
    if (cmd === "workspace_read") return pending.promise;
    writes.push(cmd);
  });
  const request = state().openFile("a.ts");
  await state().saveActive();
  assert.deepEqual(writes, []);
  pending.resolve(contents);
  await request;
});

it("keeps failed editors retryable and ignores diffs from an old project", async () => {
  mockIPC(() => Promise.reject("Cannot read file"));
  await state().openFile("a.ts");
  assert.equal(state().editorLoading[fileTabId("a.ts")], false);
  assert.equal(state().editorErrors[fileTabId("a.ts")], "Cannot read file");
  mockIPC(() => contents);
  await state().openFile("a.ts");
  assert.equal(state().editorErrors[fileTabId("a.ts")], null);
  const pending = deferred<GitDiff>();
  mockIPC(() => pending.promise);
  const request = state().openDiff("a.ts", false);
  await tick();
  mockIPC((cmd) => cmd === "git_status" ? status : []);
  state().setRoot("project-b");
  pending.resolve(diff);
  await request;
  assert.deepEqual(state().editors, []);
  assert.deepEqual(state().diffs, {});
});

it("reads fresh status after a mutation and releases busy without waiting for GitHub", async () => {
  const oldStatus = deferred<GitStatus>();
  const pendingPrs = deferred<PrList>();
  let statusCalls = 0;
  let stageCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "git_status") return ++statusCalls === 1 ? oldStatus.promise : status;
    if (cmd === "pr_list") return pendingPrs.promise;
    if (cmd === "git_stage") { stageCalls++; return; }
    throw new Error(cmd);
  });
  const poll = state().refreshGit();
  const prRequest = state().refreshPrs();
  await tick();
  const stage = state().stage(["a.ts"]);
  await state().stage(["a.ts"]);
  await tick();
  assert.equal(stageCalls, 1);
  oldStatus.resolve({ ...status, branch: "old" });
  await Promise.all([poll, stage]);
  assert.equal(statusCalls, 2);
  assert.equal(state().git?.branch, "main");
  assert.equal(state().busy, false);
  pendingPrs.resolve(prs);
  await prRequest;
  await tick();
});

function ipc(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  mockIPC((cmd, args) => {
    const handler = handlers[cmd];
    if (handler) return handler(args as Record<string, unknown>);
    if (cmd === "git_status") return status;
    return [];
  });
}

it("does not write a truncated file and skips a generic save error", async () => {
  const writes: string[] = [];
  ipc({
    workspace_read: () => ({ ...contents, truncated: true, text: "partial" }),
    workspace_write: () => {
      writes.push("workspace_write");
    },
  });
  await state().openFile("big.ts");
  await state().saveTab(fileTabId("big.ts"));
  assert.deepEqual(writes, []);
});

it("passes the snapshot mtime when saving and stores the new one", async () => {
  const writes: Record<string, unknown>[] = [];
  ipc({
    workspace_read: () => ({ ...contents, mtimeMs: 42 }),
    workspace_write: (args) => {
      writes.push(args);
      return 99;
    },
  });
  await state().openFile("a.ts");
  await state().saveTab(fileTabId("a.ts"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.expectedMtimeMs, 42);
  assert.equal(state().snapshots[fileTabId("a.ts")]?.mtimeMs, 99);
  assert.equal(state().originals[fileTabId("a.ts")], "hello");
});

it("reloads a clean tab when the file changes on disk", async () => {
  let text = "hello";
  ipc({
    workspace_read: () => ({
      ...contents,
      text,
      mtimeMs: text === "hello" ? 1 : 2,
    }),
  });
  await state().openFile("a.ts");
  text = "there";
  state().applyFsChange("project-a", ["a.ts"], false);
  await tick();
  await tick();
  const id = fileTabId("a.ts");
  assert.equal(state().buffers[id], "there");
  assert.equal(state().originals[id], "there");
  assert.equal(state().snapshots[id]?.mtimeMs, 2);
});

it("marks a dirty tab when the file changes on disk and does not clobber it", async () => {
  ipc({ workspace_read: () => contents });
  await state().openFile("a.ts");
  const id = fileTabId("a.ts");
  state().setBuffer(id, "mine");
  state().applyFsChange("project-a", ["a.ts"], false);
  assert.equal(state().externalChange[id], true);
  assert.equal(state().buffers[id], "mine");
  assert.equal(state().originals[id], "hello");
});

it("lists unsaved files in this project and in stashed ones", async () => {
  ipc({ workspace_read: () => contents });
  await state().openFile("a.ts");
  state().setBuffer(fileTabId("a.ts"), "dirty");
  assert.deepEqual(unsavedFiles(), [{ id: fileTabId("a.ts"), name: "a.ts" }]);
  state().setRoot("project-b");
  assert.deepEqual(unsavedFiles(), []);
  assert.deepEqual(unsavedFilesAll(), [{ name: "a.ts" }]);
});

it("queues one fresh git read for changes received during an older read", async () => {
  const pending = deferred<GitStatus>();
  let calls = 0;
  ipc({ git_status: () => ++calls === 1 ? pending.promise : { ...status, branch: "fresh" } });
  const first = state().refreshGit();
  await tick();
  for (let i = 0; i < 5; i++) state().applyFsChange("project-a", [], true);
  pending.resolve({ ...status, branch: "stale" });
  await first;
  await tick();
  assert.equal(calls, 2);
  assert.equal(state().git?.branch, "fresh");
});

it("queues a final editor reload for changes arriving during the first reload", async () => {
  ipc({ workspace_read: () => contents });
  await state().openFile("a.ts");
  const pending = deferred<typeof contents>();
  let calls = 0;
  ipc({ workspace_read: () => ++calls === 1 ? pending.promise : { ...contents, text: "latest", mtimeMs: 3 } });
  state().applyFsChange("project-a", ["a.ts"], false);
  await tick();
  state().applyFsChange("project-a", ["a.ts"], false);
  pending.resolve({ ...contents, text: "older", mtimeMs: 2 });
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(state().buffers[fileTabId("a.ts")], "latest");
});

it("reloads a file changed while its initial load was still pending", async () => {
  const pending = deferred<typeof contents>();
  let calls = 0;
  ipc({ workspace_read: () => ++calls === 1 ? pending.promise : { ...contents, text: "latest" } });
  const loading = state().openFile("a.ts");
  await tick();
  state().applyFsChange("project-a", ["a.ts"], false);
  pending.resolve(contents);
  await loading;
  await tick();
  assert.equal(calls, 2);
  assert.equal(state().buffers[fileTabId("a.ts")], "latest");
});

it("refreshes the root tree again if an event arrives during its first listing", async () => {
  const pending = deferred<[]>();
  let calls = 0;
  ipc({ workspace_list: () => ++calls === 1 ? pending.promise : [{ name: "new.ts", rel: "new.ts", kind: "file", size: 0 }] });
  state().setRoot("new-project");
  await tick();
  state().applyFsChange("new-project", ["new.ts"], false);
  pending.resolve([]);
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(state().tree[""]?.[0]?.rel, "new.ts");
});

it("forgets a folder a refresh finds gone instead of asking for it forever", async () => {
  const lists = new Map<string, WorkspaceEntry[] | null>([
    ["", [dir("src")]],
    ["src", [file("src/a.ts")]],
  ]);
  const asked: string[] = [];
  ipc({
    workspace_list: (args) => {
      const rel = String(args.rel);
      asked.push(rel);
      return lists.has(rel) ? (lists.get(rel) as WorkspaceEntry[] | null) : [];
    },
  });
  state().setRoot("gone-project");
  await tick();
  state().toggleExpanded("src");
  await tick();
  assert.deepEqual(state().tree.src?.map((item) => item.rel), ["src/a.ts"]);

  lists.set("src", null);
  state().applyFsChange("gone-project", ["src"], false);
  await tick();
  await tick();
  assert.equal("src" in state().tree, false);
  assert.equal("src" in state().expanded, false);

  const before = asked.length;
  state().applyFsChange("gone-project", ["other.ts"], false);
  await tick();
  await tick();
  assert.ok(!asked.slice(before).includes("src"), "a gone folder is never listed again");
});

it("takes a deleted folder's listing and fold away at once", async () => {
  ipc({
    workspace_list: (args) => {
      const rel = String(args.rel);
      if (rel === "") return [dir("src")];
      if (rel === "src") return [file("src/a.ts")];
      return [];
    },
    workspace_delete: () => null,
  });
  state().setRoot("delete-project");
  await tick();
  state().toggleExpanded("src");
  await tick();
  state().setSelected("src/a.ts");
  assert.ok(state().tree.src);

  await state().deleteEntry("src");
  assert.equal("src" in state().tree, false);
  assert.equal("src" in state().expanded, false);
  assert.equal(state().selectedRel, null);
});

it("reloads a stashed clean document changed by an agent in a background project", async () => {
  ipc({ workspace_read: () => contents });
  await state().openFile("a.ts");
  state().setRoot("project-b");
  state().applyFsChange("project-a", ["a.ts"], false);
  let calls = 0;
  ipc({ workspace_read: () => { calls++; return { ...contents, text: "fresh" }; } });
  state().setRoot("project-a");
  await state().ensureDocument({ kind: "file", rel: "a.ts", staged: false });
  assert.equal(calls, 1);
  assert.equal(state().buffers[fileTabId("a.ts")], "fresh");
});

it("preserves dirty background documents and marks their external changes", async () => {
  ipc({ workspace_read: () => contents });
  await state().openFile("a.ts");
  state().setBuffer(fileTabId("a.ts"), "my unsaved edits");
  state().setRoot("project-b");
  state().applyFsChange("project-a", ["a.ts"], false);
  state().setRoot("project-a");
  assert.equal(state().buffers[fileTabId("a.ts")], "my unsaved edits");
  assert.equal(state().externalChange[fileTabId("a.ts")], true);
});

it("does not stash a stale clean buffer when leaving during its reload", async () => {
  ipc({ workspace_read: () => contents });
  await state().openFile("a.ts");
  const pending = deferred<typeof contents>();
  ipc({ workspace_read: () => pending.promise });
  state().applyFsChange("project-a", ["a.ts"], false);
  await tick();
  state().setRoot("project-b");
  pending.resolve({ ...contents, text: "fresh" });
  await tick();
  ipc({ workspace_read: () => ({ ...contents, text: "fresh" }) });
  state().setRoot("project-a");
  await state().ensureDocument({ kind: "file", rel: "a.ts", staged: false });
  assert.equal(state().buffers[fileTabId("a.ts")], "fresh");
});

function fakeEditor(text: string) {
  return {
    state: EditorState.create({ doc: text }),
    focused: false,
    hasFocus: false,
    dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state; },
    focus() { this.focused = true; },
  };
}

it("the latest search click wins even when the file has not loaded yet", async () => {
  const pending = deferred<typeof contents>();
  ipc({ workspace_read: () => pending.promise });
  const first = state().openFileAt("a.ts", 2, 1);
  const latest = state().openFileAt("a.ts", 4, 1);
  const text = "one\ntwo\nthree\nfour";
  pending.resolve({ ...contents, text });
  await Promise.all([first, latest]);
  const view = fakeEditor(text);
  const unregister = registerEditorView(fileTabId("a.ts"), view as unknown as EditorView);
  try {
    assert.equal(view.state.doc.lineAt(view.state.selection.main.head).number, 4);
  } finally { unregister(); }
});

it("a late search navigation cannot focus the same filename in another project", async () => {
  const pending = deferred<typeof contents>();
  ipc({ workspace_read: () => pending.promise });
  const navigating = state().openFileAt("a.ts", 2, 1);
  await tick();
  state().setRoot("project-b");
  const view = fakeEditor("one\ntwo");
  const unregister = registerEditorView(fileTabId("a.ts"), view as unknown as EditorView);
  try {
    pending.resolve(contents);
    await navigating;
    assert.equal(view.focused, false);
    assert.equal(view.state.selection.main.head, 0);
  } finally { unregister(); }
});

it("clears old search hits when a new query fails", async () => {
  ipc({ workspace_grep: () => ({ hits: [{ rel: "a.ts", line: 1, column: 1, text: "old" }], truncated: false }) });
  await state().grep("old");
  ipc({ workspace_grep: () => Promise.reject("Invalid search pattern") });
  state().setGrepRegex(true);
  await state().grep("[broken");
  assert.equal(state().grepHits, null);
  assert.equal(state().grepError, "Invalid search pattern");
});

it("invalidates a pending search immediately when the query or regex mode changes", async () => {
  for (const change of [() => state().setGrepQuery("new"), () => state().setGrepRegex(!state().grepRegex)]) {
    const pending = deferred<{ hits: []; truncated: boolean }>();
    ipc({ workspace_grep: () => pending.promise });
    const search = state().grep("old");
    await tick();
    change();
    pending.resolve({ hits: [], truncated: false });
    await search;
    assert.equal(state().grepHits, null);
    assert.equal(state().grepLoading, false);
  }
});
