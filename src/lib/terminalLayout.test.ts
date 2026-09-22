import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { activeDeck, useKeel } from "../state/store.ts";
import { listPanes, relabelPanes } from "./tree.ts";
import type { LayoutNode } from "./types.ts";

const state = useKeel.getState;
const shell = { agentId: null };

beforeEach(() => {
  useKeel.setState(useKeel.getInitialState());
});

function currentDeck() {
  const project = state().projects.find((item) => item.id === state().activeProjectId);
  const deck = activeDeck(project);
  assert.ok(deck);
  return deck;
}

function rowsOf(tree: LayoutNode | null): string[][] {
  if (!tree) return [];
  if (tree.kind === "pane") return [[tree.id]];
  const rows = tree.direction === "column" ? tree.children : [tree];
  if (tree.direction === "column") {
    assert.ok(tree.sizes.every((size) => Math.abs(size - 1 / rows.length) < 1e-12));
  }
  return rows.map((row) => {
    if (row.kind === "pane") return [row.id];
    assert.equal(row.direction, "row");
    assert.ok(row.children.every((child) => child.kind === "pane"));
    assert.ok(row.sizes.every((size) => Math.abs(size - 1 / row.children.length) < 1e-12));
    return listPanes(row);
  });
}

describe("automatic terminal placement", () => {
  for (const method of ["addPane", "addPanes"] as const) {
    it(`${method} balances successive launches instead of extending to the right`, () => {
      const project = state().addProject("C:/code/layout", "Layout");
      const expected = [[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [3, 2, 2], [3, 3, 2], [3, 3, 3], [4, 3, 3]];
      const ids: string[] = [];

      for (const lengths of expected) {
        const previous = currentDeck();
        if (method === "addPane") state().addPane(project.id, shell);
        else state().addPanes(project.id, [shell]);
        const deck = currentDeck();
        const newest = listPanes(deck.tree).filter((id) => !ids.includes(id));
        assert.equal(newest.length, 1);
        ids.push(...newest);
        assert.deepEqual(rowsOf(deck.tree).map((row) => row.length), lengths);
        assert.deepEqual(listPanes(deck.tree), ids);
        assert.equal(deck.focused, newest[0]);
        assert.equal(deck.zoomed, null);
        for (const [id, pane] of Object.entries(previous.panes)) {
          assert.equal(deck.panes[id], pane);
        }
      }
    });
  }

  it("produces the same layout regardless of how launches are batched", () => {
    for (const batches of [[7], [1, 6], [3, 2, 2], [2, 1, 1, 3]]) {
      const project = state().addProject(`C:/code/${batches.join("-")}`);
      let count = 0;
      for (const batch of batches) {
        state().addPanes(project.id, Array.from({ length: batch }, () => ({
          ...shell, title: `Terminal ${++count}`,
        })));
      }
      const deck = currentDeck();
      assert.deepEqual(rowsOf(deck.tree).map((row) => row.map((id) => deck.panes[id]?.title)), [
        ["Terminal 1", "Terminal 2", "Terminal 3"],
        ["Terminal 4", "Terminal 5"],
        ["Terminal 6", "Terminal 7"],
      ]);
    }
  });

  it("preserves reading order after rearrangement and keeps editor state intact", () => {
    const project = state().addProject("C:/code/layout");
    state().addPanes(project.id, [shell, shell]);
    state().openInEditor(project.id, { kind: "file", rel: "src/app.ts", staged: false });
    const previous = currentDeck();
    const reversed = listPanes(previous.tree).reverse();
    const tree = relabelPanes(previous.tree!, reversed);
    useKeel.setState({ projects: state().projects.map((item) => ({
      ...item, decks: item.decks.map((deck) => ({ ...deck, tree })),
    })) });
    state().addPanes(project.id, [shell]);
    const deck = currentDeck();
    assert.deepEqual(listPanes(deck.tree).slice(0, 3), reversed);
    assert.deepEqual(rowsOf(deck.tree).map((row) => row.length), [2, 2]);
    for (const [id, pane] of Object.entries(previous.panes)) {
      assert.equal(deck.panes[id], pane);
    }
  });

  it("honors explicit split directions and only divides the selected pane", () => {
    for (const direction of ["row", "column"] as const) {
      const project = state().addProject(`C:/code/${direction}`);
      state().addPanes(project.id, [shell, shell]);
      const [first, second] = listPanes(currentDeck().tree);
      assert.ok(first && second);
      state().duplicatePane(project.id, first, direction);
      const tree = currentDeck().tree;
      assert.ok(tree?.kind === "split");
      assert.equal(tree.direction, "row");
      if (direction === "row") {
        assert.deepEqual(tree.sizes, [0.25, 0.25, 0.5]);
        assert.equal(tree.children[2]?.id, second);
      } else {
        assert.deepEqual(tree.sizes, [0.5, 0.5]);
        const split = tree.children[0];
        assert.ok(split?.kind === "split");
        assert.equal(split.direction, "column");
        assert.deepEqual(split.sizes, [0.5, 0.5]);
        assert.equal(tree.children[1]?.id, second);
      }
    }
  });

  it("reflows the active deck, reveals new panes, and leaves other decks alone", () => {
    const project = state().addProject("C:/code/layout");
    state().addPanes(project.id, [shell, shell]);
    const original = currentDeck();
    state().addDeck(project.id);
    state().addPanes(project.id, [shell]);
    const focused = currentDeck().focused!;
    state().toggleZoom(project.id, focused);
    state().addPanes(project.id, [shell, shell]);
    assert.deepEqual(rowsOf(currentDeck().tree).map((row) => row.length), [2, 1]);
    assert.equal(currentDeck().zoomed, null);
    assert.equal(currentDeck().focused, listPanes(currentDeck().tree)[1]);
    assert.equal(state().projects[0]?.decks[0], original);
  });

  it("ignores empty batches and missing projects", () => {
    const project = state().addProject("C:/code/layout");
    state().addPanes(project.id, [shell]);
    const previous = currentDeck();
    state().addPanes(project.id, []);
    state().addPanes("missing", [shell]);
    assert.equal(state().addPane("missing", shell), null);
    assert.equal(currentDeck(), previous);
  });

  it("repairs an existing strip of panes on the next normal launch", () => {
    const project = state().addProject("C:/code/layout");
    const first = state().addPane(project.id, shell)!;
    state().duplicatePane(project.id, first, "row");
    state().duplicatePane(project.id, currentDeck().focused!, "row");
    const strip = currentDeck().tree;
    assert.ok(strip?.kind === "split");
    assert.equal(strip.direction, "row");
    assert.equal(strip.children.length, 3);
    assert.ok(strip.children.every((child) => child.kind === "pane"));
    const previous = listPanes(strip);
    state().addPanes(project.id, [shell]);
    assert.deepEqual(rowsOf(currentDeck().tree).map((row) => row.length), [2, 2]);
    assert.deepEqual(listPanes(currentDeck().tree).slice(0, 3), previous);
  });

  it("uses the focused pane when a split direction is explicitly requested", () => {
    const project = state().addProject("C:/code/layout");
    state().addPanes(project.id, [shell, shell]);
    const previous = currentDeck();
    const added = state().addPane(project.id, shell, { direction: "column" });
    const tree = currentDeck().tree;
    assert.ok(tree?.kind === "split");
    const split = tree.children[0];
    assert.ok(split?.kind === "split");
    assert.equal(split.direction, "column");
    assert.deepEqual(listPanes(split), [previous.focused, added]);
  });
});
