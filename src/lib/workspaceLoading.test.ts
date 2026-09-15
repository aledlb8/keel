import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { diffTabId, fileTabId, useWorkspace } from "../state/workspace.ts";
import type { GitDiff, GitStatus, PrList } from "./workspace.ts";

const state = useWorkspace.getState;
const status: GitStatus = {
  git: true, repo: true, branch: "main", detached: false,
  upstream: null, ahead: 0, behind: 0, files: [],
};
const branches = { current: "main", detached: false, items: [] };
const prs: PrList = { available: true, items: [], error: null };
const diff: GitDiff = { path: "a.ts", binary: false, hunks: [] };
const contents = { text: "hello", size: 5, binary: false, truncated: false };

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
