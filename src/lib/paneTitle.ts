/**
 * Terminal names, as a brief of the work.
 *
 * Agents already have a name ("Claude") and a badge ("CL"). Those identify the
 * program, not the task. The pane title is the other thing: a short line you can
 * still read in the sidebar and the deck overview after you have forgotten which
 * terminal was doing what.
 *
 * Two sources, same output:
 *
 *  - **Prompt:** the line you submitted. This is the reliable one — it is the
 *    work you asked for.
 *  - **OSC title:** some CLIs publish a session topic through the terminal. Used
 *    only while the pane still has its default agent name, because OSC is just
 *    as likely to be "Claude Code" or a path as it is to be a topic.
 *
 * A name you typed yourself is never overwritten.
 */

export type TitleSource = "osc" | "prompt";

/** Enough to tell agents apart from their default labels. */
export interface TitleAgent {
  name: string;
  short: string;
  command: string;
}

/** Stored length. The UI truncates further in tight cells. */
export const TITLE_MAX = 64;

const MIN_PROMPT = 6;

/** Labels that name the program, a shell, or a version — never the work. */
const GENERIC = [
  "shell",
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "windows powershell",
  "cmd",
  "command prompt",
  "node",
  "python",
  "claude",
  "claude code",
  "claude-code",
  "codex",
  "gemini",
  "gemini cli",
  "aider",
  "opencode",
  "open code",
  "amp",
  "cursor",
  "copilot",
  "github copilot",
  "npx",
  "npm",
  "pnpm",
];

const CONFIRMATIONS = new Set([
  "y",
  "n",
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "yeah",
  "nah",
  "continue",
  "wait",
]);

export interface PromptDraft {
  /** Feed bytes headed for the PTY. Returns a brief when a line is submitted. */
  push(data: string): string | null;
  reset(): void;
}

export function createPromptDraft(): PromptDraft {
  let buffer = "";

  return {
    push(data: string): string | null {
      if (!data) return null;
      // Arrow keys, focus reports, mouse tracking — one escape chunk. Ignore.
      if (data.startsWith("\x1b")) return null;

      if (data === "\x03" || data === "\x15") {
        buffer = "";
        return null;
      }

      if (data === "\b" || data === "\x7f") {
        buffer = dropLast(buffer);
        return null;
      }

      if (data === "\r" || data === "\n" || data === "\r\n") {
        const brief = briefFromPrompt(buffer);
        buffer = "";
        return brief;
      }

      if (data.includes("\r") || data.includes("\n")) {
        const first = data.split(/\r\n|\r|\n/, 1)[0] ?? "";
        const brief = briefFromPrompt(buffer + first);
        buffer = "";
        return brief;
      }

      for (const char of data) {
        const code = char.codePointAt(0) ?? 0;
        if (char === "\t") {
          buffer += " ";
          continue;
        }
        if (code < 32) continue;
        buffer += char;
      }
      if (buffer.length > 400) buffer = buffer.slice(-400);
      return null;
    },
    reset() {
      buffer = "";
    },
  };
}

/** True when the pane is still wearing its factory name. */
export function isGenericLabel(
  title: string,
  agent: TitleAgent | null,
): boolean {
  const trimmed = collapse(title);
  if (!trimmed) return true;
  const needle = trimmed.toLowerCase();
  return aliases(agent).some((alias) => alias === needle);
}

/**
 * A submitted prompt, turned into a title. Returns `null` when the line is a
 * confirmation, a slash command, or too short to identify the work.
 */
export function briefFromPrompt(input: string): string | null {
  let text = collapse(input);
  if (!text) return null;

  const titled = /^\/title\s+(.+)/i.exec(text);
  if (titled?.[1]) text = collapse(titled[1]);

  if (!text) return null;
  if (CONFIRMATIONS.has(text.toLowerCase())) return null;
  // `/help`, `/clear`, `/compact` — navigation, not work.
  if (/^\/\S+$/.test(text)) return null;
  if (text.length < MIN_PROMPT) return null;

  return clip(text);
}

/**
 * An OSC window title, if it actually describes work. Generic program names,
 * versions and paths are dropped; a prefix of those followed by a topic is kept.
 */
export function briefFromOsc(
  title: string,
  agent: TitleAgent | null,
): string | null {
  let text = collapse(title);
  if (!text) return null;

  text = text.replace(/^[*·●◐○◦▪▸►]+(?:\s+|(?=\w))/u, "");
  text = stripGenericPrefix(text, agent);
  text = collapse(text);
  if (!text) return null;
  if (isNoise(text)) return null;
  if (isGenericLabel(text, agent)) return null;
  if (text.length < MIN_PROMPT) return null;

  return clip(text);
}

function aliases(agent: TitleAgent | null): string[] {
  const set = new Set(GENERIC);
  set.add("shell");
  if (!agent) return [...set];
  set.add(agent.name.trim().toLowerCase());
  set.add(agent.short.trim().toLowerCase());
  for (const word of agent.command.split(/\s+/)) {
    const base = (word.split(/[\\/]/).pop() ?? word)
      .replace(/\.(exe|cmd|bat)$/i, "")
      .trim()
      .toLowerCase();
    if (base) set.add(base);
  }
  return [...set].filter(Boolean);
}

function stripGenericPrefix(text: string, agent: TitleAgent | null): string {
  // Longest first so "Claude Code — topic" wins over "Claude — topic".
  const names = aliases(agent).sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  for (const name of names) {
    if (!lower.startsWith(name)) continue;
    const rest = text.slice(name.length);
    if (/^\s*[-—:·|]\s+/.test(rest)) return rest.replace(/^\s*[-—:·|]\s+/, "");
  }
  return text;
}

function isNoise(text: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (text.startsWith("/") || text.startsWith("~")) return true;
  if (/\.(exe|cmd|bat)(\s|$)/i.test(text)) return true;
  if (/^administrator:/i.test(text)) return true;
  if (/^\d+(\.\d+){1,3}$/.test(text)) return true;
  return false;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const slice = text.slice(0, TITLE_MAX);
  const space = slice.lastIndexOf(" ");
  const cut = space >= TITLE_MAX * 0.6 ? slice.slice(0, space) : slice;
  return cut.replace(/[.,;:]+$/, "");
}

function dropLast(text: string): string {
  const chars = [...text];
  chars.pop();
  return chars.join("");
}
