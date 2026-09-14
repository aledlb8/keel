/**
 * One xterm instance bound to one PTY.
 *
 * Two rules this file exists to enforce:
 *
 *  1. The terminal is created once and never torn down while its project is
 *     open. Hidden projects stay mounted — unmounting would drop scrollback.
 *  2. Bytes from Rust go straight into `write()`. No decoding, no line
 *     splitting, no state derived from the stream beyond "something arrived".
 */

import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";

import { resizePty, spawnPty, writePty } from "@/lib/pty";

/**
 * Read the locked `--keel-term-*` / `--keel-ansi-*` palette out of CSS.
 *
 * The background is deliberately fully transparent. The pane shell around this
 * terminal paints the translucent fill, the radius and the clip, which keeps the
 * whole look controlled from one place in `index.css` and means changing the
 * terminal's opacity never has to touch a re-theme of every live xterm.
 */
function keelTerminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    background: "#00000000",
    foreground: v("--keel-term-fg"),
    cursor: v("--keel-term-cursor"),
    cursorAccent: v("--keel-term-solid"),
    selectionBackground: v("--keel-term-selection"),
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
  onFocus: (paneId: string) => void;
  /** Spawn settled — ok or fail. Used for reopen chrome + spawn-fail UI. */
  onSpawnResult?: (paneId: string, ok: boolean, reason?: string) => void;
}

export function TerminalSurface({
  paneId,
  cwd,
  command,
  accountEnv,
  accountId,
  generation,
  visible,
  focused,
  onOutput,
  onFocus,
  onSpawnResult,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Latest callbacks without re-running the setup effect.
  const handlers = useRef({ onOutput, onFocus, onSpawnResult });
  handlers.current = { onOutput, onFocus, onSpawnResult };

  // 1. Create the terminal. Runs once per pane, for the life of the pane.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      allowProposedApi: true,
      // The pane behind the glyphs is translucent; without this xterm would
      // paint its own opaque ground over it and the look would collapse.
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--keel-font-mono")
        .trim(),
      fontSize: 13,
      // A little more air than xterm's default; the panes are large and the
      // extra leading is most of what makes output read as calm rather than dense.
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 20000,
      // Left at 1 on purpose: contrast correction needs a known background, and
      // this terminal does not have one. The palette is already high-contrast.
      minimumContrastRatio: 1,
      theme: keelTerminalTheme(),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    term.open(host);

    termRef.current = term;
    fitRef.current = fit;

    const typed = term.onData((data) => {
      void writePty(paneId, data).catch(() => {});
    });
    const focus = term.textarea;
    focus?.addEventListener("focus", () => handlers.current.onFocus(paneId));

    return () => {
      typed.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [paneId]);

  // 1b. Theme / class changes update the palette in place — never remount xterm.
  useEffect(() => {
    const apply = () => {
      const term = termRef.current;
      if (!term) return;
      term.options.theme = keelTerminalTheme();
    };

    apply();

    const root = document.documentElement;
    const observer = new MutationObserver(apply);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    return () => observer.disconnect();
  }, [paneId]);

  /**
   * 2. GPU rendering, but only for terminals actually on screen.
   *
   * Every deck of every project stays mounted, and a browser will only hand out
   * around sixteen WebGL contexts before it starts throwing the oldest away. So
   * the context is taken when a pane comes into view and given back when it
   * leaves; off-screen panes fall back to the DOM renderer, which nobody is
   * looking at anyway.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term || !visible) return;

    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      /* No WebGL here; the default renderer is already doing the job. */
      webgl = null;
    }

    return () => {
      webgl?.dispose();
    };
  }, [visible]);

  // 3. Keep the PTY the same size as the visible grid.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let frame = 0;
    const apply = () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      // A hidden project measures zero; fitting then would collapse the grid.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) {
        return;
      }
      if (size.cols !== term.cols || size.rows !== term.rows) {
        fit.fit();
      }
      void resizePty(paneId, term.cols, term.rows).catch(() => {});
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(host);
    apply();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [paneId]);

  // 4. Start the process. Re-runs only when the pane is explicitly restarted.
  useEffect(() => {
    let cancelled = false;
    const term = termRef.current;
    if (!term) return;

    const start = async () => {
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
        if (!cancelled) handlers.current.onSpawnResult?.(paneId, true);
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

  // 5. Focus follows the layout, so keystrokes land where the border says.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-hidden"
      onMouseDown={() => onFocus(paneId)}
    />
  );
}
