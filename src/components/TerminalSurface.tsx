/**
 * One xterm instance bound to one PTY.
 *
 * Three rules this file exists to enforce:
 *
 *  1. The terminal is created once and never torn down while its pane exists.
 *     Hidden decks stay mounted — unmounting would drop scrollback.
 *  2. Bytes from Rust go straight into `write()`. No decoding, no line
 *     splitting, no state derived from the stream beyond "something arrived".
 *  3. The grid is resized in exactly one place, `refit`, and everything that can
 *     change a cell's size — layout, a renderer swap — goes through it. A grid
 *     that disagrees with the PTY by a single column is what garbles agent TUIs.
 */

import { memo, useEffect, useRef } from "react";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme, type IWindowsPty } from "@xterm/xterm";

import { createPromptDraft, type TitleSource } from "@/lib/paneTitle";
import { resizePty, spawnPty, writePty } from "@/lib/pty";
import type { PaneActivity } from "@/lib/types";

/**
 * Every PTY resize makes ConPTY repaint the whole screen, and an agent TUI
 * redraws on top of that. Dragging a seam should cost one of those, not sixty.
 */
const PTY_RESIZE_DELAY_MS = 60;

/**
 * How long after the layout stops moving before we recell the grid.
 *
 * Recelling the WebGL canvas blanks a frame. During a live drag we CSS-scale
 * the existing glyphs instead, and only recell once the size has settled — or
 * sooner, if the stretch would get ugly.
 */
const FIT_SETTLE_MS = 80;
const STRETCH_LIMIT = 0.15;

/**
 * Cells that fit in the host, using the whole area.
 *
 * FitAddon always subtracts a 14px scrollbar gutter. Agent TUIs (Claude, Codex,
 * Grok, …) paint every column of the PTY, so that gutter plus any CSS padding
 * is a dead frame of pane around their own chrome. The scrollbar is an overlay;
 * it does not get a reserved column.
 */
function proposeGrid(term: Terminal, host: HTMLElement) {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width <= 0 || height <= 0) return null;
  const cell = (
    term as unknown as {
      _core: {
        _renderService: {
          dimensions: { css: { cell: { width: number; height: number } } };
        };
      };
    }
  )._core._renderService.dimensions.css.cell;
  if (!cell.width || !cell.height) return null;
  return {
    cols: Math.max(2, Math.floor(width / cell.width)),
    rows: Math.max(1, Math.floor(height / cell.height)),
  };
}

const isWindows = /Windows/i.test(navigator.userAgent);

/**
 * Which ConPTY xterm is talking to. xterm only reflows wrapped lines from build
 * 21376 on, and guesses at wrapping below it. WebView2 reports the OS major
 * version (13 and up is Windows 11) but not the build, which is precise enough
 * for that one threshold — the two numbers below stand for "either side of it".
 */
const windowsPtyInfo: Promise<IWindowsPty | undefined> = (async () => {
  if (!isWindows) return undefined;
  const agentData = (
    navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }>;
      };
    }
  ).userAgentData;
  try {
    const values = await agentData?.getHighEntropyValues(["platformVersion"]);
    const major = Number.parseInt(values?.platformVersion ?? "", 10);
    return { backend: "conpty", buildNumber: major >= 13 ? 22000 : 19045 };
  } catch {
    return { backend: "conpty" };
  }
})();

/**
 * WebGL contexts, shared out across every terminal in the app.
 *
 * Every deck of every project stays mounted, and a browser hands out only about
 * sixteen WebGL contexts before it starts destroying the oldest. Giving a
 * context back the moment a pane left the screen, and taking a new one when it
 * returned, meant every deck switch rebuilt the glyph atlas, painted a frame
 * through the DOM renderer, and could re-measure the grid a column off — which
 * made the agent redraw its whole screen. That was the flicker.
 *
 * So a pane keeps its context after it is hidden. Contexts are reclaimed only
 * when the pool is full, from whichever hidden pane was on screen longest ago,
 * and flipping between decks never touches the renderer at all.
 */
const MAX_GPU_TERMINALS = 12;

interface GpuSlot {
  attached: boolean;
  visible: boolean;
  attach: () => void;
  detach: () => void;
}

let webglUnsupported = false;

/** Live terminals by pane id, for the things a menu can ask one to do. */
const terminals = new Map<string, Terminal>();

/** Clipboard and buffer commands for one pane's terminal. */
export function terminalCommands(paneId: string) {
  const find = () => terminals.get(paneId);
  return {
    hasSelection: () => find()?.hasSelection() ?? false,
    copy: () => {
      const term = find();
      if (term?.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      }
      term?.focus();
    },
    paste: () => {
      void navigator.clipboard
        .readText()
        // `paste` goes through the same path as typing, bracketed when the
        // program asked for that.
        .then((text) => text && find()?.paste(text))
        .catch(() => {});
      find()?.focus();
    },
    selectAll: () => {
      find()?.selectAll();
      find()?.focus();
    },
    clear: () => {
      find()?.clear();
      find()?.focus();
    },
  };
}

const gpu = (() => {
  // Map order doubles as recency: the most recently shown pane is last.
  const slots = new Map<string, GpuSlot>();

  function evict() {
    let attached = 0;
    for (const slot of slots.values()) if (slot.attached) attached += 1;
    for (const slot of slots.values()) {
      if (attached <= MAX_GPU_TERMINALS) return;
      if (slot.attached && !slot.visible) {
        slot.detach();
        attached -= 1;
      }
    }
  }

  return {
    register(paneId: string, slot: GpuSlot) {
      slots.set(paneId, slot);
    },
    unregister(paneId: string) {
      slots.delete(paneId);
    },
    setVisible(paneId: string, visible: boolean) {
      const slot = slots.get(paneId);
      if (!slot) return;
      slot.visible = visible;
      if (!visible) return;
      slots.delete(paneId);
      slots.set(paneId, slot);
      if (!slot.attached) slot.attach();
      evict();
    },
  };
})();

/**
 * Read the locked `--keel-term-*` / `--keel-ansi-*` palette out of CSS.
 *
 * The background is the pane's own solid colour, not transparent. WebGL can
 * only rasterise glyphs cleanly onto an opaque ground; over a transparent one
 * text loses its antialiasing and turns thin and ragged.
 */
function keelTerminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    background: v("--keel-term-solid"),
    foreground: v("--keel-term-fg"),
    cursor: v("--keel-term-cursor"),
    cursorAccent: v("--keel-term-solid"),
    selectionBackground: v("--keel-term-selection"),
    scrollbarSliderBackground: "rgba(255, 255, 255, 0.10)",
    scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
    scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.24)",
    black: v("--keel-ansi-black"),
    red: v("--keel-ansi-red"),
    green: v("--keel-ansi-green"),
    yellow: v("--keel-ansi-yellow"),
    blue: v("--keel-ansi-blue"),
    magenta: v("--keel-ansi-magenta"),
    cyan: v("--keel-ansi-cyan"),
    white: v("--keel-ansi-white"),
    brightBlack: v("--keel-ansi-bright-black"),
    brightRed: v("--keel-ansi-bright-red"),
    brightGreen: v("--keel-ansi-bright-green"),
    brightYellow: v("--keel-ansi-bright-yellow"),
    brightBlue: v("--keel-ansi-bright-blue"),
    brightMagenta: v("--keel-ansi-bright-magenta"),
    brightCyan: v("--keel-ansi-bright-cyan"),
    brightWhite: v("--keel-ansi-bright-white"),
  };
}

export interface TerminalSurfaceProps {
  paneId: string;
  cwd: string | null;
  /** Typed into the shell once. Changing it does nothing until a restart. */
  command: string | null;
  /** CLI-specific config-home variable and the selected isolated profile. */
  accountEnv?: string | null;
  accountId?: string | null;
  /** Bumping this respawns the process in the same terminal, keeping scrollback. */
  generation: number;
  /** On the active deck of the active project — i.e. actually on screen. */
  visible: boolean;
  focused: boolean;
  onOutput: (paneId: string) => void;
  /** Keystrokes, resizes and (re)starts — the things output is a reply to. */
  onActivity?: (paneId: string, kind: PaneActivity) => void;
  onFocus: (paneId: string) => void;
  /** Spawn settled — ok or fail. Used for reopen chrome + spawn-fail UI. */
  onSpawnResult?: (paneId: string, ok: boolean, reason?: string) => void;
  /** A prompt was submitted, or the process set the window title. */
  onTitle?: (paneId: string, title: string, source: TitleSource) => void;
}

/**
 * Memoised so the pane around it can re-render freely — hovering, opening a
 * menu — without dragging React through the terminal every time.
 */
export const TerminalSurface = memo(function TerminalSurface({
  paneId,
  cwd,
  command,
  accountEnv,
  accountId,
  generation,
  visible,
  focused,
  onOutput,
  onActivity,
  onFocus,
  onSpawnResult,
  onTitle,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  /** Wired up by the setup effect; the later effects only ever call these. */
  const actions = useRef({ refit: () => {}, syncPty: () => {} });
  /** The size the PTY was last told about, and whether there is a PTY to tell. */
  const pty = useRef({ ready: false, cols: 0, rows: 0 });
  const promptDraft = useRef(createPromptDraft());
  // Latest callbacks without re-running the setup effect.
  const handlers = useRef({
    onOutput,
    onActivity,
    onFocus,
    onSpawnResult,
    onTitle,
  });
  handlers.current = { onOutput, onActivity, onFocus, onSpawnResult, onTitle };

  // 1. Create the terminal and everything that lives exactly as long as it does.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--keel-font-mono")
        .trim(),
      fontSize: 13,
      // Exactly 1. Agent TUIs draw their boxes and bars out of line-drawing
      // glyphs, and any extra leading shows up as a gap through every one of them.
      lineHeight: 1,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      // Nerd Font icons are wider than a cell. Squeeze them into it rather than
      // let them paint over the next character.
      rescaleOverlappingGlyphs: true,
      scrollback: 20_000,
      // Left at 1: the palette is locked so agents' colours read true, and
      // contrast correction would quietly shift them.
      minimumContrastRatio: 1,
      // Known up front so the scrollback heuristics apply from the first byte;
      // the build number is filled in below once the webview reports it.
      windowsPty: isWindows ? { backend: "conpty" } : undefined,
      theme: keelTerminalTheme(),
    });

    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    term.open(host);
    termRef.current = term;
    terminals.set(paneId, term);

    void windowsPtyInfo.then((info) => {
      if (!disposed && info) term.options.windowsPty = info;
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    // CSS size of the host the last time the grid was recelled. Used to scale
    // the existing canvas during a live resize instead of blanking it.
    let lastFit = { w: 0, h: 0 };

    const syncPty = () => {
      const current = pty.current;
      if (!current.ready) return;
      if (term.cols === current.cols && term.rows === current.rows) return;
      current.cols = term.cols;
      current.rows = term.rows;
      void resizePty(paneId, term.cols, term.rows).catch(() => {});
    };

    const clearPreviewScale = () => {
      const el = term.element;
      if (!el) return;
      el.style.transform = "";
      el.style.transformOrigin = "";
    };

    const commitFit = () => {
      if (disposed) return;
      // A hidden pane measures zero; fitting then would collapse the grid to 1x1.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      clearPreviewScale();
      const size = proposeGrid(term, host);
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) {
        return;
      }
      // Resize in place — FitAddon.fit() calls renderService.clear() first,
      // which is the blank frame you see on every recell.
      if (size.cols !== term.cols || size.rows !== term.rows) {
        handlers.current.onActivity?.(paneId, "resize");
        term.resize(size.cols, size.rows);
      }
      lastFit = { w: host.clientWidth, h: host.clientHeight };
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncPty, PTY_RESIZE_DELAY_MS);
    };

    const refit = (mode: "live" | "commit" = "commit") => {
      if (disposed) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;

      if (mode === "live" && lastFit.w > 0 && lastFit.h > 0) {
        const sx = host.clientWidth / lastFit.w;
        const sy = host.clientHeight / lastFit.h;
        const stretched =
          !Number.isFinite(sx) ||
          !Number.isFinite(sy) ||
          Math.abs(sx - 1) > STRETCH_LIMIT ||
          Math.abs(sy - 1) > STRETCH_LIMIT;
        if (!stretched) {
          const el = term.element;
          if (el) {
            el.style.transform = `scale(${sx}, ${sy})`;
            el.style.transformOrigin = "0 0";
          }
          clearTimeout(fitTimer);
          fitTimer = setTimeout(commitFit, FIT_SETTLE_MS);
          return;
        }
      }

      clearTimeout(fitTimer);
      commitFit();
    };

    actions.current = { refit: () => refit("commit"), syncPty };

    let webgl: WebglAddon | null = null;
    const slot: GpuSlot = {
      attached: false,
      visible: false,
      attach() {
        if (webglUnsupported || disposed) return;
        try {
          const addon = new WebglAddon();
          addon.onContextLoss(() => {
            if (webgl === addon) slot.detach();
          });
          term.loadAddon(addon);
          webgl = addon;
          slot.attached = true;
        } catch {
          // No WebGL here; the DOM renderer carries on, and nobody retries.
          webglUnsupported = true;
        }
        // The renderers measure cells slightly differently, so every swap is
        // followed by a refit. Skipping that is how the grid ends up a column off.
        refit();
      },
      detach() {
        const addon = webgl;
        webgl = null;
        slot.attached = false;
        addon?.dispose();
        refit();
      },
    };
    gpu.register(paneId, slot);

    const layout = new ResizeObserver(() => refit("live"));
    layout.observe(host);
    refit("commit");

    const typed = term.onData((data) => {
      handlers.current.onActivity?.(paneId, "input");
      const brief = promptDraft.current.push(data);
      if (brief) handlers.current.onTitle?.(paneId, brief, "prompt");
      void writePty(paneId, data).catch(() => {});
    });

    const titled = term.onTitleChange((title) => {
      handlers.current.onTitle?.(paneId, title, "osc");
    });

    const textarea = term.textarea;
    const noteFocus = () => handlers.current.onFocus(paneId);
    textarea?.addEventListener("focus", noteFocus);

    // Paste. Left alone, xterm turns Ctrl+V into a raw ^V byte and cancels the
    // browser's paste, so text only ever arrived in shells that read the
    // clipboard themselves (PSReadLine) and never in an agent. Handing the chord
    // back to the browser fires a real paste event, which xterm sends on as
    // text — bracketed, when the program asked for that.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const ctrlV =
        key === "v" && event.ctrlKey && !event.altKey && !event.metaKey;
      const shiftInsert =
        key === "insert" && event.shiftKey && !event.ctrlKey && !event.altKey;
      return !(ctrlV || shiftInsert);
    });

    // A clipboard holding only an image has no text for xterm to paste. Agents
    // such as Claude Code read images off the clipboard themselves when they
    // receive ^V, so send them that instead of nothing.
    const pasteImage = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data || data.getData("text/plain")) return;
      if (!Array.from(data.items).some((item) => item.kind === "file")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void writePty(paneId, "\x16").catch(() => {});
    };
    textarea?.addEventListener("paste", pasteImage, true);

    // Theme / class changes update the palette in place — never remount xterm.
    const palette = new MutationObserver(() => {
      term.options.theme = keelTerminalTheme();
    });
    palette.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    return () => {
      disposed = true;
      gpu.unregister(paneId);
      terminals.delete(paneId);
      clearTimeout(resizeTimer);
      clearTimeout(fitTimer);
      clearPreviewScale();
      layout.disconnect();
      palette.disconnect();
      textarea?.removeEventListener("focus", noteFocus);
      textarea?.removeEventListener("paste", pasteImage, true);
      typed.dispose();
      titled.dispose();
      term.dispose();
      termRef.current = null;
      actions.current = { refit: () => {}, syncPty: () => {} };
    };
  }, [paneId]);

  // 2. GPU rendering follows visibility; the `gpu` pool above decides when a
  //    context is taken and when it is reclaimed. Coming back on screen, force
  //    a redraw so a compositor that discarded the hidden canvas does not show
  //    one blank frame.
  useEffect(() => {
    gpu.setVisible(paneId, visible);
    if (!visible) return;
    const term = termRef.current;
    if (term) term.refresh(0, term.rows - 1);
    actions.current.refit();
  }, [paneId, visible]);

  // 3. Start the process. Re-runs only when the pane is explicitly restarted.
  useEffect(() => {
    let cancelled = false;
    const term = termRef.current;
    if (!term) return;
    promptDraft.current.reset();

    const start = async () => {
      pty.current.ready = false;
      handlers.current.onActivity?.(paneId, "spawn");
      // Size the PTY from the real grid, not whatever xterm defaulted to.
      actions.current.refit();
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      try {
        await spawnPty(
          {
            id: paneId,
            cwd,
            command,
            accountEnv,
            accountId,
            cols,
            rows,
          },
          (bytes) => {
            if (cancelled) return;
            termRef.current?.write(bytes);
            handlers.current.onOutput(paneId);
          },
        );
        if (cancelled) return;
        pty.current = { ready: true, cols, rows };
        // The layout may have moved while the process was starting.
        actions.current.syncPty();
        handlers.current.onSpawnResult?.(paneId, true);
      } catch (error) {
        const reason = String(error);
        // Keep a brief stream note; actionable UI lives in toast + Relaunch.
        term.writeln(`\r\n\x1b[31m${reason}\x1b[0m`);
        if (!cancelled) handlers.current.onSpawnResult?.(paneId, false, reason);
      }
    };

    void start();
    return () => {
      cancelled = true;
    };
    // Spawn inputs are read at restart time; generation is the explicit trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, generation]);

  // 4. Focus follows the layout, so keystrokes land where the border says.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    // No inset. Agent TUIs draw a full-screen frame; padding around the grid
    // is a second frame of pane around theirs. `isolate` keeps xterm's
    // z-indexed layers from stacking over the header.
    <div
      className="isolate h-full w-full overflow-hidden"
      onMouseDown={() => onFocus(paneId)}
    >
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
    </div>
  );
});
