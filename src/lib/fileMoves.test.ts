import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { canMoveInto, fileTabId, useWorkspace } from "../state/workspace.ts";
import type { GitStatus, WorkspaceEntry } from "./workspace.ts";

const state = useWorkspace.getState;
const status: GitStatus = {
  git: true, repo: true, branch: "main", detached: false,
  upstream: null, ahead: 0, behind: 0, files: [],
};
const contents = { text: "hello", size: 5, binary: false, truncated: false, mtimeMs: 1 };

const file = (rel: string): WorkspaceEntry => ({
  name: rel.slice(rel.lastIndexOf("/") + 1), rel, kind: "file", size: 1,
});
const dir = (rel: string): WorkspaceEntry => ({
  name: rel.slice(rel.lastIndexOf("/") + 1), rel, kind: "dir", size: null,
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  Object.assign(globalThis, { window: {} });
  state().setRoot(null);
  mockIPC((cmd) => cmd === "git_status" ? status : []);
  state().setRoot("project-a");
});

it("only moves an entry somewhere new, and never into itself", () => {
  assert.equal(canMoveInto("src/a.ts", "lib"), true);
  assert.equal(canMoveInto("src/a.ts", ""), true);
  assert.equal(canMoveInto("src/a.ts", "src"), false);
  assert.equal(canMoveInto("a.ts", ""), false);
  assert.equal(canMoveInto("src", "src"), false);
  assert.equal(canMoveInto("src", "src/lib"), false);
  // A sibling that merely starts with the same letters is not inside it.
  assert.equal(canMoveInto("src", "src-old"), true);
});

it("moves a folder and carries open tabs, the selection and open folders with it", async () => {
  const renames: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "workspace_rename") {
      renames.push(args as Record<string, unknown>);
      return null;
    }
    if (cmd === "workspace_read") return contents;
    if (cmd === "git_status") return status;
    return [];
  });

  await state().openFile("src/lib/a.ts");
  state().toggleExpanded("src/lib");
  state().setSelected("src/lib/a.ts");
  await state().moveEntry("src/lib", "pkg");

  assert.equal(renames.length, 1);
  assert.equal(renames[0]?.fromRel, "src/lib");
  assert.equal(renames[0]?.toRel, "pkg/lib");
  assert.equal(state().activeEditor, fileTabId("pkg/lib/a.ts"));
  assert.equal(state().buffers[fileTabId("pkg/lib/a.ts")], "hello");
  assert.equal(state().buffers[fileTabId("src/lib/a.ts")], undefined);
  assert.equal(state().selectedRel, "pkg/lib/a.ts");
  assert.equal(state().expanded["pkg/lib"], true);
  assert.equal(state().expanded.pkg, true, "the destination opens");
});

it("does not call the backend for a move that goes nowhere", async () => {
  let renames = 0;
  mockIPC((cmd) => {
    if (cmd === "workspace_rename") renames++;
    return cmd === "git_status" ? status : [];
  });
  await state().moveEntry("src", "src/lib");
  await state().moveEntry("src/a.ts", "src");
  assert.equal(renames, 0);
});

it("swaps hidden files in place instead of clearing the tree", async () => {
  mockIPC((cmd, args) => {
    if (cmd !== "workspace_list") return status;
    const { rel, showHidden } = args as { rel: string; showHidden: boolean };
    if (rel === "src") return [file("src/a.ts")];
    return showHidden ? [dir("src"), file(".env")] : [dir("src")];
  });
  await state().loadDir("");
  state().toggleExpanded("src");
  await state().loadDir("src");

  const showing = state().setShowHidden(true);
  assert.ok(state().tree.src, "open folders keep their rows while reloading");
  await showing;
  assert.equal(state().rowMotion[".env"], "enter");
  assert.deepEqual(state().tree.src?.map((entry) => entry.rel), ["src/a.ts"]);

  await state().setShowHidden(false);
  assert.equal(state().rowMotion[".env"], "leave");
  assert.ok(
    state().tree[""]?.some((entry) => entry.rel === ".env"),
    "leaving rows stay until they have folded away",
  );
  await wait(250);
  assert.ok(!state().tree[""]?.some((entry) => entry.rel === ".env"));
  assert.deepEqual(state().rowMotion, {});
});
