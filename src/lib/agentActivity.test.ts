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
    // The reader always keeps the bottom 120 rows, so a tall pane still
    // includes the live composer. truncated must not hide it.
    assert.equal(agentSignal("claude", { ...claude, truncated: true }), "ready");
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
    // Full-width box rows wrap-join onto ❯, so the hardware cursor may sit
    // on the answer line while the live composer is still in the footer.
    assert.equal(agentSignal("claude", { ...claude, cursorLine: 0 }), "ready");
    assert.equal(agentSignal("claude", { lines: ["PS C:\\code> ", "finished thinking"], cursorLine: 0 }), "unknown");
    assert.equal(agentSignal("custom", claude), "unknown");
    assert.equal(agentSignal("claude", { lines: ["❯ quoted answer"], cursorLine: 0 }), "unknown");
    assert.equal(agentSignal("claude", { ...claude, lines: ["* a markdown bullet", ...claude.lines] }), "ready");
    assert.equal(agentSignal("claude", { ...claude, lines: ["I am still thinking about the approach.", ...claude.lines] }), "ready");
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

  // Real `readAgentScreen` output from opencode 1.18.31. The reader joins the
  // rows xterm soft-wrapped, so one string can hold many terminal rows and a
  // prompt cannot be anchored with `^` or found through `cursorLine`.
  const opencodeBusy: AgentScreen = {
    lines: [
      "                                                          ┃",
      "  ┃  List the files in this folder.                       ┃                         ▣  Build · DeepSeek V4.1 Flash",
      "",
      "",
      "",
      "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · max   ╹▀▀▀▀▀▀▀▀▀▀▀▀   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                                                                 tab agents  ctrl+p commands",
    ],
    cursorLine: 5,
  };
  const opencodeReady: AgentScreen = {
    lines: [
      "                                                          ┃",
      "  ┃  List the files in this folder.                       ┃     → Read .        The folder is empty.      ▣  Build · DeepSeek V4.1 Flash · 4.4s",
      "",
      "",
      "",
      "  ┃  Build · DeepSeek V4.1 Flash OpenCode Go · max   ╹▀▀▀▀▀▀▀▀▀▀▀▀   C:\\code\\keel                          9.2K (1%) · $0.00  ctrl+p commands",
    ],
    cursorLine: 5,
  };

  it("recognises the opencode composer, its running footer, and both dialogs", () => {
    assert.equal(agentSignal("opencode", opencodeReady), "ready");
    assert.equal(agentSignal("opencode", opencodeBusy), "busy");
    assert.equal(agentSignal("opencode", {
      ...opencodeBusy,
      lines: [...opencodeBusy.lines.slice(0, 5), "  ⬝⬝⬝⬝⬝⬝⬝⬝  esc again to interrupt"],
    }), "busy");

    const permission: AgentScreen = {
      lines: [
        "                                                          ┃",
        "  ┃  Run the shell command pwd and show its output.       ┃     + Thought: 255ms       $ pwd      ▣  Build · DeepSeek V4.1 Flash",
        "",
        "",
        "",
        "  ┃  △ Permission required        ┃    # Shell command        ┃  $ pwd        ┃   Allow once   Allow always   Reject                          ctrl+f fullscreen  ⇆ select  enter confirm",
      ],
      cursorLine: 5,
    };
    assert.equal(agentSignal("opencode", permission), "blocked");

    const question: AgentScreen = {
      lines: [
        "                                                          ┃",
        "  ┃  Use the question tool to ask me whether I prefer tabs or spaces.   + Thought: 191ms   → Asked 1 question   ▣  Build · DeepSeek V4.1 Flash",
        "",
        "",
        "",
        "  ┃  Do you prefer tabs or spaces for indentation?   ┃  1. Tabs   ┃     Use tab characters for indentation   ┃  2. Spaces   ┃  3. Type your own answer   ┃  ↑↓ select  enter submit  esc dismiss",
      ],
      cursorLine: 1,
    };
    assert.equal(agentSignal("opencode", question), "blocked");
  });

  it("treats an opencode turn that ended in an error panel as finished", () => {
    assert.equal(agentSignal("opencode", {
      ...opencodeReady,
      lines: [
        ...opencodeReady.lines.slice(0, 5),
        "  ┃  No endpoints found that support tool use.        ╹▀▀▀▀▀▀▀▀▀▀▀▀   C:\\code\\keel      tab agents  ctrl+p commands",
      ],
    }), "ready");
  });

  it("does not call an opencode conversation or a dialog a finished prompt", () => {
    // No composer on screen: command output, a plain shell, or a clipped read.
    assert.equal(agentSignal("opencode", { lines: ["PS C:\\code> "], cursorLine: 0 }), "unknown");
    assert.equal(agentSignal("opencode", {
      lines: ["  $ pwd".repeat(20), "  C:\\code"],
      cursorLine: 1,
    }), "unknown");
    assert.equal(agentSignal("opencode", { ...opencodeReady, truncated: true }), "ready");
  });

  // Real `readAgentScreen` output from grok 1.0.34, joined the same way.
  const grokBusy: AgentScreen = {
    lines: [
      "  ~/A/L/T/o/grok-capture/project   18K / 500K │ [Dashboard]",
      "     > List the files in this folder.   1:29 PM   ♦ Listing 1 dir   | Run List `.` 0.2s   6.0s ↓18.0k [stop]   ╭────────────────────────────╮  │ >  │  ╰─ Grok 4.6 (low) · always-approve ─╯   Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts",
    ],
    cursorLine: 1,
  };
  const grokReady: AgentScreen = {
    lines: [
      "  ~/A/L/T/o/grok-capture/project   18K / 500K │ [Dashboard]",
      "     > List the files in this folder.   1:29 PM   ♦ Listed 1 dir   ♦ Thought for 0.2s   The workspace folder is empty.   Worked for 16s   ╭────────────────────────────╮  │ >  │  ╰─ Grok 4.6 (low) · always-approve ─╯   Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ],
    cursorLine: 1,
  };

  it("recognises the grok composer, its running footer, and both permission dialogs", () => {
    assert.equal(agentSignal("grok", grokReady), "ready");
    assert.equal(agentSignal("grok", grokBusy), "busy");

    const editApproval: AgentScreen = {
      lines: [
        "  ~/A/L/T/o/grok-capture/project   18K / 500K │ [Dashboard]",
        "     > Create a file called proof.txt containing the word hello.   1:31 PM   ♦ Creating proof.txt   ♦ Run Write `C:\\...\\proof.txt` 0.4s   6.0s ↓18.0k [stop]   │  Allow Edit to C:\\...\\proof.txt?   │  1 (•) Yes, and don't ask again for anything (always-approve mode)   │  2 (○) Yes, allow all edits during this session   │  3 (○) Yes   │  4 (○) No, reject (type to add feedback)   1/4:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback",
      ],
      cursorLine: 1,
    };
    assert.equal(agentSignal("grok", editApproval), "blocked");

    const bashApproval: AgentScreen = {
      lines: [
        "  ~/A/L/T/o/grok-capture/project   18K / 500K │ [Dashboard]",
        "     > Check the Node version with a shell command.   1:32 PM   ♦ Check installed Node.js version… 0.1s   5.9s ↓18.0k [↓][stop]   │  Check installed Node.js version   │  node --version   │  1 (•) Yes, and don't ask again for anything (always-approve mode)   │  2 (○) Always allow: node --version   │  3 (○) Yes, proceed   │  4 (○) No, reject (type to add feedback)   │  5 (○) Never allow: node --version   1/5:select  │  Tab:next option  │  ←/→:scope  │  e:edit pattern  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback",
      ],
      cursorLine: 1,
    };
    assert.equal(agentSignal("grok", bashApproval), "blocked");
  });

  it("does not call a grok screen without its shortcut bar a finished prompt", () => {
    assert.equal(agentSignal("grok", {
      lines: ["  ~/project   [Dashboard]", "     > done!   ╰─ Grok 4.6 (low) ─╯"],
      cursorLine: 1,
    }), "unknown");
    assert.equal(agentSignal("grok", { lines: ["PS C:\\code> "], cursorLine: 0 }), "unknown");
    assert.equal(agentSignal("grok", { ...grokReady, truncated: true }), "ready");
  });

  it("recognises Claude 2.1 fullscreen with a custom status line and wrap-joined box", () => {
    // statusLine hides "? for shortcuts" / "esc to interrupt"; mode badges stay.
    // Full-width ─ rows are wrap-joined onto the prompt, so ❯ is mid-line.
    const screen: AgentScreen = {
      lines: [
        "opus · main · ~/code/keel",
        "────────────────────────❯ ",
        "────────────────────────⏵⏵ auto mode on",
      ],
      cursorLine: 0,
      truncated: true,
    };
    assert.equal(agentSignal("claude", screen), "ready");
    assert.equal(agentSignal("claude", {
      ...screen,
      lines: ["✻ Cogitating… (14s · ↓ 800 tokens · thinking)", ...screen.lines],
    }), "busy");
    assert.equal(agentSignal("claude", {
      ...screen,
      lines: ["deep in thought", ...screen.lines],
    }), "busy");
    assert.equal(agentSignal("claude", {
      lines: [...screen.lines, "Do you want to proceed?", "1. Yes", "2. Yes, and don't ask again for this command"],
      cursorLine: 0,
    }), "blocked");
  });

  it("recognises an opencode composer without the ╹ edge or a nearby cursor", () => {
    const screen: AgentScreen = {
      lines: [
        "  Build · DeepSeek V4.1 Flash",
        "C:\\code\\keel                    tab agents  ctrl+p commands",
      ],
      cursorLine: 0,
      truncated: true,
    };
    assert.equal(agentSignal("opencode", screen), "ready");
    assert.equal(agentSignal("opencode", {
      ...screen,
      lines: [...screen.lines, "  ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt"],
    }), "busy");
    assert.equal(agentSignal("opencode", {
      lines: ["  △ Permission required        Allow once   Allow always   Reject     enter confirm"],
      cursorLine: 0,
    }), "blocked");
  });

  it("recognises Codex 0.154, Gemini 0.38, and the remaining catalogue agents", () => {
    assert.equal(agentSignal("codex", {
      lines: ["Would you like to run the following command?", "git status", "Yes, proceed"],
      cursorLine: 0,
    }), "blocked");
    assert.equal(agentSignal("codex", {
      lines: ["Working (18s • esc to interrupt)", "› ", "92% context left"],
      cursorLine: 1,
    }), "busy");

    const gemini: AgentScreen = {
      lines: ["╭──────────────╮", "│ > Type your message │", "╰──────────────╯"],
      cursorLine: 0,
    };
    assert.equal(agentSignal("gemini", gemini), "ready");
    assert.equal(agentSignal("gemini", {
      ...gemini,
      lines: [...gemini.lines, "Allow once", "Allow for this session"],
    }), "blocked");

    assert.equal(agentSignal("cursor-agent", {
      lines: ["Plan, search, build anything", "Composer 1.5"],
      cursorLine: 0,
    }), "ready");
    assert.equal(agentSignal("cursor-agent", {
      lines: ["Plan, search, build anything", "ctrl+c to stop"],
      cursorLine: 0,
    }), "busy");

    assert.equal(agentSignal("crush", {
      lines: ["Ready!", "enter send  ctrl+p commands"],
      cursorLine: 0,
    }), "ready");
    assert.equal(agentSignal("crush", {
      lines: ["Working...", "esc cancel"],
      cursorLine: 0,
    }), "busy");

    assert.equal(agentSignal("aider", { lines: ["code> "], cursorLine: 0 }), "ready");
    assert.equal(agentSignal("aider", { lines: ["diff multi> "], cursorLine: 0 }), "ready");
    assert.equal(agentSignal("aider", { lines: ["PS C:\\code> "], cursorLine: 0 }), "unknown");

    assert.equal(agentSignal("goose", {
      lines: ["Enter to send · Ctrl+J newline"],
      cursorLine: 0,
    }), "ready");
    assert.equal(agentSignal("goose", { lines: ["Honking thoughtfully"], cursorLine: 0 }), "unknown");
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

  it("announces a Claude turn that used a custom status line and no interrupt hint", () => {
    const activity = new AgentActivity(0);
    activity.input("fix it", 0);
    activity.input("\r", 1);
    activity.screen("busy", 50, "✻ Cogitating… (14s · ↓ 800 tokens)");
    assert.equal(activity.status("idle", 100, false), "working");
    activity.screen("ready", 2_000, "────────❯ \n⏵⏵ auto mode on");
    assert.equal(activity.status("working", 2_500, false), "working");
    assert.equal(activity.status("working", 4_001, false), "done");
  });

  it("announces an opencode turn once its composer settles", () => {
    const activity = new AgentActivity(0);
    assert.equal(activity.input("list the files", 0), "input");
    assert.equal(activity.input("\r", 1), "submit");
    activity.screen("busy", 50, "running");
    assert.equal(activity.status("idle", 100, false), "working");
    activity.output(2_000);
    activity.screen("ready", 2_000, "composer");
    assert.equal(activity.status("working", 2_500, false), "working");
    assert.equal(activity.status("working", 4_001, false), "done");
    assert.equal(activity.status("done", 60_000, false), "done");
  });

  it("keeps an opencode permission or question wait working, never done", () => {
    const activity = new AgentActivity(0);
    activity.input("\r", 1);
    activity.screen("blocked", 100, "permission");
    assert.equal(activity.status("idle", 3_600_000, false), "working");
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

  it("reports the submit that the turn hangs off, but not a paste newline", () => {
    const activity = new AgentActivity(0);
    assert.equal(activity.input("fix it", 0), "input");
    assert.equal(activity.input("\r", 1), "submit");
    activity.input("\x1b[200~pasted\r\nlines", 2);
    assert.equal(activity.input("\r", 3), "input");
    activity.input("\x1b[201~", 4);
    assert.equal(activity.input("\n", 5), "input");
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
