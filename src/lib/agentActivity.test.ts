import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentActivity, agentSignal, readAgentScreen, type AgentScreen } from "./agentActivity.ts";

const claude: AgentScreen = {
  lines: ["The changes are ready.", "──────────────────", "❯ ", "──────────────────", "  ? for shortcuts"],
  cursorLine: 2,
};

function live() {
  const activity = new AgentActivity(123);
  activity.screen("ready", 0, "prompt");
  activity.input("fix it", 10);
  activity.input("\r", 20);
  activity.output(30);
  activity.screen("busy", 40, "spinner");
  return activity;
}

describe("parsed agent screen", () => {
  it("reads live cells, ignoring the scrollback viewport, and caps work for tall panes", () => {
    const reads: number[] = [];
    const buffer = {
      baseY: 1_000, viewportY: 0, cursorY: 198,
      getLine(index: number) {
        reads.push(index);
        return { translateToString: () => `line ${index}` };
      },
    };
    const screen = readAgentScreen(buffer, 200);
    assert.equal(reads.length, 120);
    assert.equal(reads[0], 1_080);
    assert.equal(reads[119], 1_199);
    assert.equal(screen.cursorLine, 118);
    assert.equal(screen.truncated, true);
  });

  it("reassembles wrapped interrupt hints in narrow terminals", () => {
    const cells = ["Working (esc to ", "interrupt)", "› ", "92% context left"];
    const screen = readAgentScreen({
      baseY: 0, cursorY: 2,
      getLine(index) {
        return { isWrapped: index === 1, translateToString: () => cells[index] ?? "" };
      },
    }, 4);
    assert.equal(screen.cursorLine, 1);
    assert.equal(agentSignal("codex", screen), "busy");
    assert.equal(agentSignal("claude", { ...claude, truncated: true }), "unknown");
  });

  it("handles Claude custom footers and spinners without the interrupt hint", () => {
    const screen = { ...claude, lines: [...claude.lines.slice(0, -1), "custom status line"] };
    assert.equal(agentSignal("claude", screen), "ready");
    assert.equal(agentSignal("claude", { ...screen, lines: ["✻ Cogitating… (14s · ↓ 800 tokens)", ...screen.lines], cursorLine: 3 }), "busy");
  });

  it("does not mistake reconnect backoff for an idle prompt", () => {
    assert.equal(agentSignal("claude", { ...claude, lines: [...claude.lines, "Reconnecting… 2/5"] }), "busy");
  });

  it("recognises the live Claude composer with a footer and blank viewport rows", () => {
    assert.equal(agentSignal("claude", { ...claude, lines: [...claude.lines, ...Array<string>(30).fill("")] }), "ready");
  });

  for (const text of ["✻ Thinking… (esc to interrupt)", "✶ Compacting conversation… (escape to interrupt)", "Working (ctrl+c to stop)"]) {
    it(`keeps the composer busy while ${text}`, () => {
      assert.equal(agentSignal("claude", { ...claude, lines: [text, ...claude.lines], cursorLine: 3 }), "busy");
    });
  }

  it("does not confuse response prose, historical prompts, or a shell with readiness", () => {
    assert.equal(agentSignal("claude", { ...claude, cursorLine: 0 }), "unknown");
    assert.equal(agentSignal("claude", { lines: ["PS C:\\code> ", "finished thinking"], cursorLine: 0 }), "unknown");
    assert.equal(agentSignal("custom", claude), "unknown");
    assert.equal(agentSignal("claude", { lines: ["❯ quoted answer"], cursorLine: 0 }), "unknown");
  });

  it("does not finish at an approval dialog over a stale composer", () => {
    assert.equal(agentSignal("claude", { ...claude, lines: [...claude.lines, "Do you want to proceed?", "1. Yes, allow once"] }), "blocked");
  });

  it("recognises Codex prompt variants and lets a running indicator override them", () => {
    for (const prompt of ["› Write tests", "▌ Write tests"]) {
      const screen = { lines: [prompt, "gpt · 92% left · /code"], cursorLine: 0 };
      assert.equal(agentSignal("codex", screen), "ready");
      assert.equal(agentSignal("codex", { ...screen, lines: [...screen.lines, "• Working (18s • Esc to interrupt)"] }), "busy");
    }
  });

  it("recognises the Gemini composer without treating its busy placeholder as idle", () => {
    const screen = { lines: ["╭──────────────╮", "│ > Type your message │", "╰──────────────╯"], cursorLine: 1 };
    assert.equal(agentSignal("gemini", screen), "ready");
    assert.equal(agentSignal("gemini", { ...screen, lines: [...screen.lines, "⠇ Addressing query (esc to cancel, 15s)"] }), "busy");
  });
});

describe("agent turn lifecycle", () => {
  it("never announces startup or restoration, however long the replay lasts", () => {
    const activity = new AgentActivity(123);
    for (let time = 0; time < 120_000; time += 500) {
      activity.output(time);
      activity.screen(time % 1500 ? "busy" : "ready", time);
      assert.equal(activity.status("idle", time + 10_000, false), "idle");
    }
  });

  it("keeps working through arbitrarily long thinking and tool pauses", () => {
    const activity = live();
    assert.equal(activity.status("idle", 3_500, false), "working");
    assert.equal(activity.status("working", 3_600_000, false), "working");
    activity.screen("unknown", 3_600_001, "tool output");
    assert.equal(activity.status("working", 7_200_000, false), "working");
  });

  it("requires a stable prompt, cancelling an intermediate ready frame", () => {
    const activity = live();
    activity.screen("ready", 100, "prompt");
    assert.equal(activity.status("working", 1_000, false), "working");
    activity.screen("busy", 1_500, "tool");
    assert.equal(activity.status("working", 10_000, false), "working");
    activity.screen("ready", 10_010, "answer and prompt");
    assert.equal(activity.status("working", 12_009, false), "working");
    assert.equal(activity.status("working", 12_010, false), "done");
    assert.equal(activity.status("done", 20_000, false), "done");
    assert.equal(activity.status("idle", 20_001, false), "idle");
  });

  it("blocks completion while bytes are waiting to be parsed", () => {
    const activity = live();
    activity.screen("ready", 100, "prompt");
    activity.output(2_000);
    assert.equal(activity.status("working", 20_000, false), "working");
    activity.screen("busy", 20_001, "still running");
    assert.equal(activity.status("working", 40_000, false), "working");
  });

  it("ignores identical redraws but waits for changing answer text to settle", () => {
    const activity = live();
    activity.screen("ready", 100, "answer 1");
    activity.output(2_000);
    activity.screen("ready", 2_000, "answer 2");
    assert.equal(activity.status("working", 2_100, false), "working");
    activity.output(2_900);
    activity.screen("ready", 2_900, "answer 2");
    assert.equal(activity.status("working", 3_000, false), "done");
  });

  it("never reports an approval wait as finished", () => {
    const activity = live();
    activity.screen("blocked", 100, "approval");
    assert.equal(activity.status("working", 3_600_000, false), "working");
  });

  it("suppresses notifications for watched panes", () => {
    const activity = live();
    activity.screen("ready", 100, "prompt");
    assert.equal(activity.status("working", 3_000, true), "idle");
    assert.equal(activity.status("idle", 4_000, false), "idle");
  });

  it("retracts done as soon as a queued or continued turn is observed", () => {
    const activity = live();
    activity.screen("ready", 100, "prompt");
    assert.equal(activity.status("working", 3_000, false), "done");
    activity.screen("busy", 4_000, "follow-up");
    assert.equal(activity.status("done", 4_001, false), "working");
  });

  for (const interrupt of ["\x03", "\x1b"]) {
    it(`does not announce cancellation via ${JSON.stringify(interrupt)}`, () => {
      const activity = live();
      activity.input(interrupt, 100);
      activity.screen("busy", 101, "late spinner");
      assert.equal(activity.status("working", 102, false), "working");
      activity.screen("ready", 200, "prompt");
      assert.equal(activity.status("working", 10_000, false), "idle");
    });
  }

  it("does not let focus/mouse/query reports or bracketed paste arm a turn", () => {
    const activity = new AgentActivity(0);
    for (const report of ["\x1b[I", "\x1b[O", "\x1b[<0;5;5M", "\x1b[10;20R", "\x1b[?1;2c"]) {
      assert.equal(activity.input(report, 0), "report");
    }
    activity.input("\x1b[200~hello\r\nworld", 0);
    activity.input("\r", 1);
    activity.input("\x1b[201~", 2);
    activity.input("\n", 2);
    activity.screen("busy", 3);
    activity.screen("ready", 4);
    assert.equal(activity.status("idle", 10_000, false), "idle");
    activity.input("\r", 10_001);
    activity.screen("busy", 10_010);
    assert.equal(activity.status("idle", 10_011, false), "working");
  });

  it("does not manufacture completions for empty submissions, slash menus or unknown layouts", () => {
    for (const signal of ["ready", "unknown"] as const) {
      const activity = new AgentActivity(0);
      activity.input("\r", 1);
      activity.screen(signal, 10, "screen");
      assert.equal(activity.status("working", 31_000, false), "idle");
    }
  });

  it("a new submission invalidates an already settling completion", () => {
    const activity = live();
    activity.screen("ready", 100, "prompt");
    activity.input("\r", 2_000);
    assert.equal(activity.status("working", 2_100, false), "working");
    activity.screen("ready", 2_200, "old prompt");
    assert.equal(activity.status("working", 4_500, false), "working");
    activity.screen("busy", 5_000, "new turn");
    assert.equal(activity.status("working", 50_000, false), "working");
  });

  it("invalidates prompt evidence on resize and starts a restart from scratch", () => {
    const activity = live();
    activity.screen("ready", 100);
    activity.resize();
    assert.equal(activity.status("working", 10_000, false), "working");
    const restarted = new AgentActivity(200);
    restarted.screen("ready", 20_000);
    assert.equal(restarted.status("idle", 30_000, false), "idle");
  });
});
