import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { editorRefId } from "./editorRefs.ts";
import { dockAtEdge, listPanes } from "./tree.ts";
import type { EditorRef, LayoutNode, Pane, Project } from "./types.ts";
import { activeDeck, emptyDeck, useKeel } from "../state/store.ts";

const keel = useKeel.getState;
const file = (rel: string): EditorRef => ({ kind: "file", rel, staged: false });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const terminal: Pane = {
  id: "term", agentId: null, accountId: null, resumeAgent: false,
  sessionId: null, sessionReady: false, title: "Shell", cwd: null,
};

beforeEach(() => {
  const deck = emptyDeck("Deck 1");
  deck.tree = { kind: "pane", id: "term" };
  deck.panes = { term: terminal };
  deck.focused = "term";
  const project: Project = {
    id: "p", name: "p", path: "C:/p", decks: [deck],
    activeDeckId: deck.id, collapsed: false,
  };
  // Not ready: nothing is written to disk.
  useKeel.setState({ projects: [project], activeProjectId: "p", ready: false, closing: {} });
});

const deck = () => activeDeck(keel().projects[0])!;
const editorIds = () => listPanes(deck().tree).filter((id) => deck().panes[id].editor);
const editorOf = (paneId: string) => deck().panes[paneId].editor!;

it("opens files as tabs of one editor pane standing beside the terminals", () => {
  keel().openInEditor("p", file("a.ts"));
  keel().openInEditor("p", file("src/b.ts"));
  keel().openInEditor("p", file("a.ts"));

  const [paneId] = editorIds();
  assert.equal(editorIds().length, 1);
  assert.deepEqual(editorOf(paneId).tabs.map((tab) => tab.rel), ["a.ts", "src/b.ts"]);
  assert.equal(editorOf(paneId).active, editorRefId(file("a.ts")));
  assert.equal(deck().panes[paneId].title, "a.ts");
  assert.equal(deck().focused, paneId);
  const tree = deck().tree as Extract<LayoutNode, { kind: "split" }>;
  assert.equal(tree.direction, "row");
  assert.deepEqual(listPanes(tree), ["term", paneId]);
});

it("splitting an editor opens what it shows in a second pane", () => {
  keel().openInEditor("p", file("a.ts"));
  keel().openInEditor("p", file("b.ts"));
  const [first] = editorIds();
  keel().duplicatePane("p", first, "column");

  assert.equal(editorIds().length, 2);
  const second = editorIds().find((id) => id !== first)!;
  assert.deepEqual(editorOf(second).tabs, [file("b.ts")]);
  assert.equal(deck().focused, second);
  // The next file goes to the editor you are in.
  keel().openInEditor("p", file("c.ts"));
  assert.deepEqual(editorOf(second).tabs.map((tab) => tab.rel), ["b.ts", "c.ts"]);
});

it("closing the tab on screen shows its neighbour, and the last tab closes the pane", async () => {
  keel().openInEditor("p", file("a.ts"));
  keel().openInEditor("p", file("b.ts"));
  const [paneId] = editorIds();

  keel().closeEditorTab("p", paneId, editorRefId(file("b.ts")));
  assert.equal(editorOf(paneId).active, editorRefId(file("a.ts")));

  keel().closeEditorTab("p", paneId, editorRefId(file("a.ts")));
  await wait(220);
  assert.deepEqual(editorIds(), []);
  assert.deepEqual(listPanes(deck().tree), ["term"]);
});

it("moved files follow into editor panes, and deleted ones take their tabs away", async () => {
  keel().openInEditor("p", file("a.ts"));
  const [paneId] = editorIds();

  keel().rewriteEditorTabs("C:/p", (ref) =>
    ref.rel === "a.ts" ? { ...ref, rel: "src/a.ts" } : ref,
  );
  assert.deepEqual(editorOf(paneId).tabs, [file("src/a.ts")]);
  assert.equal(editorOf(paneId).active, editorRefId(file("src/a.ts")));

  // Another folder's projects are left alone.
  keel().rewriteEditorTabs("C:/other", () => null);
  assert.equal(editorIds().length, 1);

  keel().rewriteEditorTabs("C:/p", () => null);
  await wait(220);
  assert.deepEqual(editorIds(), []);
});

it("docks along the right edge of a row without nesting it", () => {
  const row: LayoutNode = {
    kind: "split", id: "s", direction: "row",
    children: [{ kind: "pane", id: "a" }, { kind: "pane", id: "b" }],
    sizes: [0.5, 0.5],
  };
  const docked = dockAtEdge(row, "e") as Extract<LayoutNode, { kind: "split" }>;
  assert.equal(docked.id, "s");
  assert.deepEqual(listPanes(docked), ["a", "b", "e"]);
  assert.deepEqual(docked.sizes, [0.25, 0.25, 0.5]);
  assert.deepEqual(dockAtEdge(null, "e"), { kind: "pane", id: "e" });
});
