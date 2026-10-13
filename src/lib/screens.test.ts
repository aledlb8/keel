import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deckAfterLeaving,
  displayAt,
  displayFingerprint,
  displayToward,
  mainDeckOf,
  readArrangements,
  readScreens,
  rememberArrangement,
  screenIdOf,
  screenLabel,
  screenOfPane,
  windowOfDeck,
} from "./screens.ts";
import type { Deck, Display, Project, Screen } from "./types.ts";

function deck(id: string, panes: string[] = []): Deck {
  return {
    id,
    name: id,
    tree: null,
    panes: Object.fromEntries(
      panes.map((paneId) => [
        paneId,
        {
          id: paneId,
          agentId: null,
          accountId: null,
          resumeAgent: false,
          sessionId: null,
          sessionReady: false,
          title: paneId,
          cwd: null,
        },
      ]),
    ),
    zoomed: null,
    focused: null,
  };
}

function project(id: string, decks: Deck[], activeDeckId = decks[0]?.id ?? null): Project {
  return { id, name: id, path: `/${id}`, decks, activeDeckId, collapsed: false };
}

function screen(id: string, projectId: string, deckId: string): Screen {
  return { id, projectId, deckId };
}

function display(name: string, x: number, y: number, width = 1920, height = 1080): Display {
  return {
    name,
    x,
    y,
    width,
    height,
    workX: x,
    workY: y,
    workWidth: width,
    workHeight: height - 40,
    scale: 1,
    primary: x === 0 && y === 0,
  };
}

describe("screens", () => {
  it("names windows after their screen and reads the id back", () => {
    assert.equal(screenLabel("abc"), "screen-abc");
    assert.equal(screenIdOf("screen-abc"), "abc");
    assert.equal(screenIdOf("main"), null);
  });

  it("finds the window that draws a deck or a pane", () => {
    const projects = [project("p", [deck("d1", ["a"]), deck("d2", ["b"])])];
    const screens = [screen("s", "p", "d2")];
    assert.equal(windowOfDeck(screens, "d2"), "screen-s");
    assert.equal(windowOfDeck(screens, "d1"), "main");
    assert.equal(screenOfPane(screens, projects, "b")?.id, "s");
    assert.equal(screenOfPane(screens, projects, "a"), null);
  });

  it("keeps the main window off decks a screen has", () => {
    const p = project("p", [deck("d1"), deck("d2"), deck("d3")], "d2");
    assert.equal(mainDeckOf(p, [])?.id, "d2");
    assert.equal(mainDeckOf(p, [screen("s", "p", "d2")])?.id, "d1");
    assert.equal(
      mainDeckOf(p, [screen("a", "p", "d1"), screen("b", "p", "d2"), screen("c", "p", "d3")]),
      null,
    );
  });

  it("moves the main window to a neighbouring deck when its deck leaves", () => {
    const p = project("p", [deck("d1"), deck("d2"), deck("d3")], "d2");
    assert.equal(deckAfterLeaving(p, [], "d2"), "d3");
    assert.equal(deckAfterLeaving(p, [screen("s", "p", "d3")], "d2"), "d1");
    assert.equal(deckAfterLeaving(p, [], "d3"), "d2");
    assert.equal(
      deckAfterLeaving(p, [screen("a", "p", "d1"), screen("b", "p", "d3")], "d2"),
      null,
    );
  });

  it("gives the same fingerprint to the same monitors in any order", () => {
    const left = display("\\.\DISPLAY1", 0, 0);
    const right = display("\\.\DISPLAY2", 1920, 0, 2560, 1440);
    assert.equal(displayFingerprint([right, left]), displayFingerprint([left, right]));
    assert.equal(displayFingerprint([left, right]), "1920x1080@0,0|2560x1440@1920,0");
    assert.notEqual(displayFingerprint([left]), displayFingerprint([left, right]));
  });

  it("finds the monitor a window is on by its middle", () => {
    const displays = [display("A", 0, 0), display("B", 1920, 0)];
    assert.equal(displayAt(displays, { x: 1800, y: 100, width: 800, height: 600 })?.name, "B");
    assert.equal(displayAt(displays, { x: 5000, y: 100, width: 800, height: 600 }), null);
  });

  it("picks the monitor that lies in a direction, nearest and straightest first", () => {
    const middle = display("M", 0, 0);
    const right = display("R", 1920, 0);
    const farRight = display("FR", 3840, 0);
    const above = display("U", 0, -1080);
    const aboveRight = display("UR", 1920, -1080);
    const displays = [middle, right, farRight, above, aboveRight];
    assert.equal(displayToward(displays, middle, "right")?.name, "R");
    assert.equal(displayToward(displays, right, "right")?.name, "FR");
    assert.equal(displayToward(displays, middle, "up")?.name, "U");
    assert.equal(displayToward(displays, right, "left")?.name, "M");
    assert.equal(displayToward(displays, middle, "left"), null);
    assert.equal(displayToward(displays, middle, "down"), null);
  });

  it("drops saved screens whose deck is gone, repeated, or malformed", () => {
    const projects = [project("p", [deck("d1"), deck("d2")])];
    const screens = readScreens(
      [
        { id: "a", projectId: "p", deckId: "d1", bounds: { x: 1, y: 2, width: 3, height: 4 } },
        { id: "b", projectId: "p", deckId: "d1" },
        { id: "c", projectId: "p", deckId: "gone" },
        { id: "../x", projectId: "p", deckId: "d2" },
        { id: "a", projectId: "p", deckId: "d2" },
        "nonsense",
      ],
      projects,
    );
    assert.deepEqual(screens.map((item) => item.id), ["a"]);
    assert.deepEqual(screens[0]?.bounds, {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      maximized: false,
      monitor: null,
    });
    assert.deepEqual(readScreens(undefined, projects), []);
  });

  it("remembers a bounded number of arrangements, newest last", () => {
    let arrangements = {};
    for (let index = 0; index < 12; index++) {
      arrangements = rememberArrangement(arrangements, `fp${index}`, { screens: [] });
    }
    const keys = Object.keys(arrangements);
    assert.equal(keys.length, 8);
    assert.equal(keys.at(-1), "fp11");
    arrangements = rememberArrangement(arrangements, "fp5", { screens: [] });
    assert.equal(Object.keys(arrangements).at(-1), "fp5");
    assert.equal(Object.keys(arrangements).length, 8);
  });

  it("reads saved arrangements and their screens", () => {
    const projects = [project("p", [deck("d1")])];
    const arrangements = readArrangements(
      {
        fp: { main: { x: 0, y: 0, width: 10, height: 10 }, screens: [{ id: "a", projectId: "p", deckId: "d1" }] },
        bad: 4,
      },
      projects,
    );
    assert.deepEqual(Object.keys(arrangements), ["fp"]);
    assert.equal(arrangements.fp?.screens.length, 1);
  });
});
