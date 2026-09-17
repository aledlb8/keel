import type { PaneStatus } from "./types.ts";

/** Parsed cells, never raw ANSI bytes or the user's scrollback viewport. */
export interface AgentScreen {
  lines: string[];
  cursorLine: number;
  truncated?: boolean;
}

/** The public xterm buffer subset we need; independent of its DOM renderer. */
export function readAgentScreen(buffer: {
  baseY: number;
  cursorY: number;
  getLine(index: number): {
    isWrapped?: boolean;
    translateToString(trim: boolean): string;
  } | undefined;
}, rows: number): AgentScreen {
  // baseY follows live output; viewportY follows scrolling through history.
  // Bound work even when a user has configured an unusually tall terminal.
  const first = Math.max(0, rows - 120);
  const lines: string[] = [];
  let cursorLine = -1;
  for (let row = first; row < rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    const text = line?.translateToString(false) ?? "";
    // Join xterm's soft wraps before matching hints. A narrow pane may wrap
    // "esc to interrupt" in the middle of a word or at a significant space.
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
    if (row === buffer.cursorY) cursorLine = lines.length - 1;
  }
  return { lines: lines.map((line) => line.trimEnd()), cursorLine, truncated: first > 0 };
}

export type AgentSignal = "busy" | "ready" | "blocked" | "unknown";

/**
 * Keep these deliberately narrow. A new/unrecognised CLI layout must not turn
 * silence into a successful completion. Ordinary prose saying "thinking" or
 * "finished" is not a lifecycle event.
 */
export function agentSignal(agentId: string, screen: AgentScreen): AgentSignal {
  const lines = screen.lines.map((line) => line.trim());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const footer = lines.slice(-12).join("\n");
  if (/\b(?:esc|escape|ctrl\+c)\s+(?:again\s+)?(?:to\s+)?(?:interrupt|cancel|stop)\b/i.test(lines.join("\n"))) {
    return "busy";
  }
  if (agentId === "claude" && lines.some((line) => /^[✻✽✶✳✢·*]\s+\S.*(?:…|\.{3})/u.test(line))) {
    return "busy";
  }
  if (/\b(?:reconnecting|retrying|waiting for (?:connection|response))\b/i.test(footer)) {
    return "busy";
  }
  if (/\b(?:do you want to (?:proceed|allow)|allow (?:once|always)|approve (?:this|once)|waiting for (?:approval|permission)|yes, (?:allow|proceed))\b/i.test(footer)) {
    return "blocked";
  }
  // opencode's own dialogs: a tool approval, or the question tool waiting
  // for an answer. Both sit above the composer, where the cursor rule below
  // cannot reach them.
  if (agentId === "opencode" && /\b(?:permission required|esc dismiss)\b/i.test(footer)) {
    return "blocked";
  }
  // grok's permission dialogs also sit where the cursor rule cannot reach
  // them. Its cancel hint uses a colon, so the generic busy rule above never
  // mistakes a waiting dialog for a running turn — check the dialog first.
  if (agentId === "grok") {
    if (/(?:\btab:next option\b|\b[1-9]\/\d+:select\b)/i.test(footer)) {
      return "blocked";
    }
    if (/\bctrl\+c\s*:\s*cancel\b/i.test(footer) || /\[stop\]/i.test(footer)) {
      return "busy";
    }
    // The composer's shortcut bar is what a turn running and a turn finished
    // share; the cancel hint above is what separates them. Dialogs replace
    // this bar with their own option hints.
    if (!screen.truncated && /\bctrl\+x\s*:\s*shortcuts\b/i.test(footer)) {
      return "ready";
    }
  }
  const cursor = lines[screen.cursorLine] ?? "";
  if (screen.truncated || screen.cursorLine < lines.length - 12) return "unknown";
  switch (agentId) {
    case "claude":
      // Claude leaves the composer visible during thinking. The interrupt
      // footer above must always win, even when the cursor is in the composer.
      return /^❯(?:\s|$)/u.test(cursor) &&
        (/\?\s+for shortcuts|shift\+tab to cycle/i.test(footer) ||
          (/^─{3,}/u.test(lines[screen.cursorLine - 1] ?? "") &&
            /^─{3,}/u.test(lines[screen.cursorLine + 1] ?? "")))
        ? "ready" : "unknown";
    case "codex":
      return /^[›▌](?:\s|$)/u.test(cursor) &&
        /(?:\?\s+for shortcuts|\d+%\s+(?:context\s+)?left)/i.test(footer)
        ? "ready" : "unknown";
    case "gemini":
      return /^│\s*>\s.*│$/u.test(cursor) && /╰─+╯/u.test(footer)
        ? "ready" : "unknown";
    case "opencode":
      // The composer's bottom edge (`╹▀▀▀…`) stays on screen whenever the TUI
      // is back at the prompt. A running turn shows the interrupt hint instead
      // (handled above), and both dialogs replace the composer entirely.
      // Anchoring on the cursor is not possible: the reader joins soft-wrapped
      // rows, so the cursor's line is many rows of text in one string.
      return lines.some((line) => /╹(?:▀{3,}| {3,})/u.test(line))
        ? "ready" : "unknown";
    default:
      return "unknown";
  }
}

const READY_MS = 2_000;
const QUIET_MS = 1_000;

/** One process lifetime. Durations use a monotonic clock supplied by the caller. */
export class AgentActivity {
  /** Wall time is used only by conversation capture, not detection. */
  readonly spawnedAt: number;
  private submitted = false;
  private running = false;
  private sawBusy = false;
  private cancelRequested = false;
  private signal: AgentSignal = "unknown";
  private readySince: number | null = null;
  private lastOutput = -Infinity;
  private pendingOutput = false;
  private fingerprint: string | undefined;
  private lastSubmit = -Infinity;
  private pasting = false;

  constructor(spawnedAt: number) {
    this.spawnedAt = spawnedAt;
  }

  input(data: string, now: number): "submit" | "input" | "report" {
    // xterm also sends focus, mouse and terminal-query replies through onData.
    // They must neither acknowledge a notification nor submit/cancel a turn.
    if (data.startsWith("\x1b[200~")) this.pasting = true;
    if (this.pasting) {
      if (data.includes("\x1b[201~")) this.pasting = false;
      return "input";
    }
    if (data === "\x03" || data === "\x1b") {
      // An interrupt is only a request; tools may still be winding down, or
      // the key may have dismissed a menu. Keep working until the UI settles,
      // but do not celebrate a cancelled turn as completed work.
      this.cancelRequested = this.running;
      if (!this.running) this.submitted = false;
      this.signal = "unknown";
      this.readySince = null;
      return "input";
    }
    if (data.startsWith("\x1b")) return "report";
    // LF is commonly Ctrl+J/Shift+Enter (a multiline composer newline).
    if (data === "\r" || data === "\r\n") {
      this.submitted = true;
      this.running = true;
      this.sawBusy = false;
      this.cancelRequested = false;
      this.signal = "unknown";
      this.readySince = null;
      this.lastSubmit = now;
      return "submit";
    }
    return "input";
  }

  output(now: number): void {
    if (this.fingerprint === undefined) this.lastOutput = now;
    // An incomplete repaint must not leave a previously ready screen eligible.
    this.pendingOutput = true;
  }

  screen(signal: AgentSignal, now: number, fingerprint?: string): void {
    this.pendingOutput = false;
    // Cursor blinking, title changes and identical redraws are not progress.
    if (fingerprint === undefined || fingerprint !== this.fingerprint) this.lastOutput = now;
    this.fingerprint = fingerprint;
    this.signal = signal;
    if (signal !== "ready") this.readySince = null;
    else this.readySince ??= now;
    // Launch banners and restored conversations can contain arbitrarily many
    // historical spinners/prompts. Only a local submission arms notifications.
    if (signal === "busy" && this.submitted) {
      this.running = true;
      this.sawBusy = true;
    }
  }

  resize(): void {
    this.signal = "unknown";
    this.readySince = null;
  }

  status(previous: PaneStatus, now: number, watching: boolean): PaneStatus {
    if (!this.running) return previous === "done" ? "done" : "idle";
    const ready = !this.pendingOutput && this.signal === "ready" && this.readySince !== null &&
      now - this.readySince >= READY_MS && now - this.lastOutput >= QUIET_MS;
    if (ready && (this.sawBusy || this.cancelRequested)) {
      this.running = false;
      // Continue observing this live session: a queued follow-up or another
      // busy frame must retract done without needing another local keystroke.
      this.sawBusy = false;
      const cancelled = this.cancelRequested;
      this.cancelRequested = false;
      if (cancelled) this.submitted = false;
      return watching || cancelled ? "idle" : "done";
    }
    // Empty Enter, slash menus and very fast turns need not show a spinner.
    // Without that evidence they can settle to idle, but never announce done.
    if (!this.sawBusy && ((ready && now - this.lastSubmit >= 10_000) ||
      (this.signal === "unknown" && now - this.lastSubmit >= 30_000))) {
      this.running = false;
      return "idle";
    }
    return "working";
  }
}
