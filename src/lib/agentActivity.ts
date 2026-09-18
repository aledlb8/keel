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

const INTERRUPT =
  /\b(?:esc|escape|ctrl\s*\+\s*c)\s+(?:again\s+)?(?:to\s+)?(?:interrupt|cancel|stop)\b/i;
const RETRY =
  /\b(?:reconnecting|retrying|waiting for (?:connection|response|api))\b/i;
const APPROVAL =
  /\b(?:do you want to (?:proceed|allow)|would you like to run|allow (?:once|always|for this)|approve (?:this|once|network)|waiting for (?:approval|permission)|yes, (?:allow|proceed|and don't ask again)|no, keep planning)\b/i;

/** Claude 2.1 spinner byline: glyph + verb, or the elapsed/token clock. */
const CLAUDE_SPINNER =
  /(?:^|\n|[─│]\s*)[✻✽✶✳✢◐◓◑◒]\s+\S/u;
const CLAUDE_SPINNER_CLOCK = /\(\d+\s*s\s*[·•]\s*↓/u;
const CLAUDE_SPINNER_STATUS =
  /(?:^|\n)(?:deep in thought|picking the thought back up|almost done thinking|thinking some more|still thinking|compacting conversation|running precompact hooks|running postcompact hooks)\b/i;
const CLAUDE_MODE =
  /\b(?:(?:manual|plan|auto)\s+mode on|accept edits on|don't ask on|bypass permissions on)\b/i;
const CLAUDE_PROMPT = /❯(?:\s|$)/u;

/** OpenCode 1.18 composer chrome. The ╹▀ edge is painted while busy too. */
const OPENCODE_EDGE = /╹(?:▀{3,}| {3,})/u;
const OPENCODE_HINTS = /\b(?:tab\s+agents|ctrl\+\S+\s+commands)\b/i;
const OPENCODE_SPINNER = /(?:[■⬝]{4,}|\[⋯\])/u;

const CODEX_PROMPT = /(?:^|\n|[│╰╭])\s*[›▌](?:\s|$)/u;
const GEMINI_PROMPT = /│\s*>\s.*│/u;
const GEMINI_BOX = /╰─+╯/u;
const GROK_SHORTCUTS = /\bctrl\+x\s*:\s*shortcuts\b/i;
const GROK_BUSY = /\bctrl\+c\s*:\s*cancel\b/i;
const GROK_BLOCKED = /(?:\btab:next option\b|\b[1-9]\/\d+:select\b)/i;

/**
 * Keep these deliberately narrow. A new/unrecognised CLI layout must not turn
 * silence into a successful completion. Ordinary prose saying "thinking" or
 * "finished" is not a lifecycle event.
 *
 * `truncated` only means the reader skipped rows above the last 120 — the live
 * composer is at the bottom, so it is still in `lines`. Full-width TUI borders
 * are wrap-joined onto the prompt row; never require the hardware cursor to
 * sit on a `^❯` line of its own.
 */
export function agentSignal(agentId: string, screen: AgentScreen): AgentSignal {
  const lines = screen.lines.map((line) => line.trim());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const body = lines.join("\n");
  const footer = lines.slice(-12).join("\n");
  const cursor = lines[screen.cursorLine] ?? "";

  if (INTERRUPT.test(body)) return "busy";
  if (RETRY.test(footer)) return "busy";
  if (APPROVAL.test(footer)) return "blocked";

  switch (agentId) {
    case "claude":
      if (
        CLAUDE_SPINNER.test(body) ||
        CLAUDE_SPINNER_CLOCK.test(body) ||
        CLAUDE_SPINNER_STATUS.test(body) ||
        lines.some((line) => /^[✻✽✶✳✢·*◐◓◑◒]\s+\S.*(?:…|\.{3})/u.test(line))
      ) return "busy";
      // Composer stays on screen while thinking. Custom statusLine hides
      // "? for shortcuts" and "esc to interrupt"; mode badges do not.
      return CLAUDE_PROMPT.test(footer) || CLAUDE_PROMPT.test(cursor)
        ? (/\?\s+for shortcuts|shift\+tab to cycle/i.test(footer) ||
            CLAUDE_MODE.test(footer) ||
            /─{3,}/u.test(footer) ? "ready" : "unknown")
        : "unknown";
    case "codex":
      // Current Codex defaults to a model/directory status line. Both the
      // shortcuts hint and context percentage are optional footer items.
      // The live cursor or an empty composer also identifies that prompt.
      return CODEX_PROMPT.test(footer) || /^[›▌](?:\s|$)/u.test(cursor)
        ? (/\?\s+for shortcuts|\d+%\s+(?:context\s+)?left/i.test(footer) ||
            /^[›▌](?:\s|$)/u.test(cursor) ||
            /(?:^|\n)[›▌]\s*(?:\n|$)/u.test(footer) ||
            /(?:^|\n)(?:gpt-|o\d)[\w.-]+\b.*[·•]/i.test(footer)
            ? "ready" : "unknown")
        : "unknown";
    case "gemini":
      return (GEMINI_PROMPT.test(footer) || GEMINI_PROMPT.test(cursor)) && GEMINI_BOX.test(footer)
        ? "ready" : "unknown";
    case "opencode":
      if (/\b(?:permission required|esc dismiss|enter\s+confirm)\b/i.test(footer)) return "blocked";
      if (OPENCODE_SPINNER.test(body) || /\b\[retrying\b/i.test(body)) return "busy";
      // Dialogs replace the composer. Idle and busy share ╹▀ / ctrl+p; the
      // interrupt hint above is what separates them. Transparent themes paint
      // the edge as spaces, so the shortcut labels are the fallback.
      return OPENCODE_EDGE.test(body) || OPENCODE_HINTS.test(footer) ? "ready" : "unknown";
    case "grok":
      if (GROK_BLOCKED.test(footer)) return "blocked";
      if (GROK_BUSY.test(footer) || /\[stop\]/i.test(footer)) return "busy";
      return GROK_SHORTCUTS.test(footer) ? "ready" : "unknown";
    case "cursor-agent":
      // Ink TUI (2026): placeholder stays while working; ctrl+c to stop does not.
      return /plan, search, build anything|add a follow-up/i.test(footer) ? "ready" : "unknown";
    case "crush":
      return /\benter\s+send\b/i.test(footer) ? "ready" : "unknown";
    case "aider":
      return /(?:^|\n)(?:code|diff|ask|architect)(?:\s+multi)?\s*>/i.test(footer) ||
        /^(?:code|diff|ask|architect)(?:\s+multi)?\s*>/i.test(cursor)
        ? "ready" : "unknown";
    case "goose":
      return /\benter to send\b/i.test(footer) ? "ready" : "unknown";
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
