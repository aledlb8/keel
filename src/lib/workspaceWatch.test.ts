import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { isWatching, reconcileWorkspaceWatches } from "./workspaceWatch.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(async () => {
  Object.assign(globalThis, { window: {} });
  mockIPC(() => null);
  await reconcileWorkspaceWatches([]);
});

it("retains existing watchers when another project is added or removed", async () => {
  const calls: string[] = [];
  mockIPC((cmd, args) => { calls.push(`${cmd}:${(args as Record<string, unknown>).root}`); return null; });
  await reconcileWorkspaceWatches(["A"]);
  await reconcileWorkspaceWatches(["A", "B"]);
  await reconcileWorkspaceWatches(["A"]);
  assert.deepEqual(calls, ["workspace_watch:A", "workspace_watch:B", "workspace_unwatch:B"]);
  assert.equal(isWatching("A"), true);
  assert.equal(isWatching("B"), false);
});

it("waits for old teardown before restoring a root requested again", async () => {
  const pending = deferred();
  const native = new Set<string>();
  mockIPC(async (cmd, args) => {
    const root = String((args as Record<string, unknown>).root);
    if (cmd === "workspace_watch") native.add(root);
    if (cmd === "workspace_unwatch") { await pending.promise; native.delete(root); }
  });
  await reconcileWorkspaceWatches(["A"]);
  const removing = reconcileWorkspaceWatches([]);
  await tick();
  const restoring = reconcileWorkspaceWatches(["A", "B"]);
  pending.resolve();
  await Promise.all([removing, restoring]);
  assert.deepEqual([...native].sort(), ["A", "B"]);
  assert.equal(isWatching("A"), true);
});

it("removes a registration that finishes after the project was closed", async () => {
  const pending = deferred();
  const native = new Set<string>();
  mockIPC(async (cmd, args) => {
    const root = String((args as Record<string, unknown>).root);
    if (cmd === "workspace_watch") { await pending.promise; native.add(root); }
    if (cmd === "workspace_unwatch") native.delete(root);
  });
  const starting = reconcileWorkspaceWatches(["A"]);
  await tick();
  const stopping = reconcileWorkspaceWatches([]);
  pending.resolve();
  await Promise.all([starting, stopping]);
  assert.equal(native.size, 0);
  assert.equal(isWatching("A"), false);
});

it("keeps failed roots eligible for polling and retries on reconciliation", async () => {
  mockIPC(() => Promise.reject("watch unavailable"));
  await reconcileWorkspaceWatches(["A"]);
  assert.equal(isWatching("A"), false);
  mockIPC(() => null);
  await reconcileWorkspaceWatches(["A"]);
  assert.equal(isWatching("A"), true);
});
