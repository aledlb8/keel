/**
 * A pane: a floating terminal window, and as little else as possible.
 *
 * This is the one surface the whole look is built around — a rounded slab, a
 * step *lighter* than the ground it sits on, lifted off it by a soft shadow.
 * That value step is what makes it read as an object on the desk rather than a
 * hole cut in the window.
 *
 * Focus is expressed in light: the focused pane brightens its hairline and
 * deepens its lift. The pane never carries status colour — that lives on the
 * sidebar dot and nowhere else.
 *
 * Two stacked parts, and they never overlap: a slim header (see PaneHeader)
 * and the terminal under it. Right-click anywhere on the pane for copy, paste
 * and everything else you can do to it.
 */

import { memo, useLayoutEffect, useRef } from "react";

import { EditorBody, EditorHeader } from "@/components/editor/EditorPane";
import { ContextMenuEntries } from "@/components/menu/MenuEntries";
import { paneMenu, terminalMenu } from "@/components/menu/actions";
import { PaneHeader } from "@/components/PaneHeader";
import { TerminalSurface } from "@/components/TerminalSurface";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { applySession } from "@/lib/launch";
import type { TitleSource } from "@/lib/paneTitle";
import { agentAccent } from "@/lib/tokens";
import type { Agent, AgentAccount, Pane, PaneActivity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";

export interface PaneViewProps {
  projectId: string;
  pane: Pane;
  agent: Agent | null;
  accounts: AgentAccount[];
  /** The shell has exited. */
  exited: boolean;
  focused: boolean;
  zoomed: boolean;
  cwd: string | null;
  generation: number;
  /**
   * Until when (a `performance.now()` time) a change of place should glide
   * rather than jump. A stable ref, so it never breaks the memo.
   */
  motion: { readonly current: number };
  rect: PaneRect | null;
  hidden: boolean;
  onFocus: (paneId: string) => void;
  onOutput: (paneId: string) => void;
  onActivity: (paneId: string, kind: PaneActivity, data?: string) => void;
  onSplit: (paneId: string, direction: "row" | "column") => void;
  onZoom: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onRestart: (paneId: string) => void;
  onAccountChange: (paneId: string, accountId: string | null) => void;
  onCreateAccount: (paneId: string, agentId: string, name: string) => void;
  onSpawnResult?: ((paneId: string, ok: boolean, reason?: string) => void) | undefined;
  onTitle: (paneId: string, title: string, source: TitleSource) => void;
  /** The shell's folder changed; kept on the pane for the next spawn. */
  onCwd?: ((paneId: string, dir: string) => void) | undefined;
  /** A press on the header that may become a drag. Must be stable: this is memoised. */
  onDragStart: (paneId: string, event: React.PointerEvent) => void;
}

// A hairline of light along the slab's own top edge. Same trick as the glass
// chrome: without it a flat fill at this size reads as a hole in the window
// rather than as a surface catching the light.
const SHEEN = "inset 0 1px 0 0 rgba(255,255,255,0.045)";

type PaneRect = { left: number; top: number; width: number; height: number };

/** The docks' fold curve: quick to start, soft to land, no overshoot. */
const GLIDE = "cubic-bezier(0.32, 0.72, 0, 1)";
const MOVE_MS = 320;
const ENTER_MS = 260;

/**
 * Glide from where the pane was to where it is now.
 *
 * FLIP: the pane is already laid out at its new size, so the terminal recells
 * once; a transform then plays it back from the old box. Animating left, top,
 * width and height instead would refit xterm on every frame.
 */
function glide(node: HTMLElement, from: PaneRect, to: PaneRect) {
  if (
    from.left === to.left &&
    from.top === to.top &&
    from.width === to.width &&
    from.height === to.height
  ) {
    return;
  }
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  node.animate(
    [
      { transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: "0 0", transform: "none" },
    ],
    { duration: MOVE_MS, easing: GLIDE },
  );
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const PaneView = memo(function PaneView({
  projectId,
  pane,
  agent,
  accounts,
  exited,
  focused,
  zoomed,
  cwd,
  generation,
  motion,
  rect,
  hidden,
  onFocus,
  onOutput,
  onActivity,
  onSplit,
  onZoom,
  onClose,
  onRestart,
  onAccountChange,
  onCreateAccount,
  onSpawnResult,
  onTitle,
  onCwd,
  onDragStart,
}: PaneViewProps) {
  const renaming = useKeel(
    (state) =>
      state.renaming?.where === "pane" &&
      state.renaming.kind === "pane" &&
      state.renaming.id === pane.id,
  );
  const closing = useKeel((state) => pane.id in state.closing);
  /** An editor pane: files instead of a process, in the same window. */
  const isEditor = pane.editor !== undefined;

  const nodeRef = useRef<HTMLDivElement | null>(null);
  /** Where the pane last sat, and whether it was on screen there. */
  const placed = useRef<{ rect: PaneRect; hidden: boolean } | null>(null);
  const left = rect?.left;
  const top = rect?.top;
  const width = rect?.width;
  const height = rect?.height;

  useLayoutEffect(() => {
    const node = nodeRef.current;
    const previous = placed.current;
    if (!rect) return;
    placed.current = { rect, hidden };
    if (!node || hidden || rect.width === 0 || rect.height === 0) return;
    if (motion.current < performance.now() || reducedMotion()) return;

    if (!previous) {
      // A new pane: it grows out of the space its neighbours just made.
      node.animate(
        [
          { opacity: 0, transform: "scale(0.96)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: ENTER_MS, easing: GLIDE },
      );
      return;
    }
    // Coming back on screen is not a move.
    if (!previous.hidden && previous.rect.width > 0) glide(node, previous.rect, rect);
    // Only the four numbers matter; the zoomed rect is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, top, width, height, hidden]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={nodeRef}
          data-pane={pane.id}
          className={cn(
            "group/pane absolute flex flex-col overflow-hidden rounded-[var(--keel-r-window)]",
            "transition-[box-shadow,border-color] duration-150 ease-out",
            closing && "k-pane-out",
            // Instant hide, not a fade. Opacity-crossing a WebGL canvas blanks
            // a frame and invalidates the chrome's compositing — that was the
            // whole-app flash on deck/project switch. `invisible` keeps the
            // node in layout (scrollback, GPU context) without covering the
            // deck in front.
            hidden && "pointer-events-none invisible",
          )}
          aria-hidden={hidden}
          style={{
            left: rect?.left ?? 0,
            top: rect?.top ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            // Solid, and the same in every state — the fill never shifts tone
            // when you click between terminals.
            background: "var(--keel-term-solid)",
            zIndex: zoomed ? 20 : focused ? 10 : 1,
            border: `1px solid ${
              focused ? "var(--keel-term-border-focus)" : "var(--keel-term-border)"
            }`,
            boxShadow: focused
              ? `${SHEEN}, var(--keel-lift)`
              : `${SHEEN}, 0 2px 10px -6px rgba(0,0,0,0.6)`,
          }}
        >
          {isEditor ? (
            <EditorHeader
              projectId={projectId}
              pane={pane}
              focused={focused}
              zoomed={zoomed}
              onFocus={() => onFocus(pane.id)}
              onSplit={(direction) => onSplit(pane.id, direction)}
              onZoom={() => onZoom(pane.id)}
              onClose={() => onClose(pane.id)}
              onDragStart={(event) => onDragStart(pane.id, event)}
            />
          ) : (
          <PaneHeader
              pane={pane}
              agent={agent}
              accent={agentAccent(agent?.accent)}
              accounts={accounts}
              exited={exited}
              focused={focused}
              zoomed={zoomed}
              cwd={cwd}
              renaming={renaming}
              onFocus={() => onFocus(pane.id)}
              onSplit={(direction) => onSplit(pane.id, direction)}
              onZoom={() => onZoom(pane.id)}
              onClose={() => onClose(pane.id)}
              onRestart={() => onRestart(pane.id)}
              onAccountChange={(accountId) => onAccountChange(pane.id, accountId)}
              onCreateAccount={(agentId, name) =>
                onCreateAccount(pane.id, agentId, name)
              }
              onManageProfiles={() =>
                useKeel.getState().openAgentSettings(agent?.id ?? null)
              }
              onStartRename={() =>
                useKeel
                  .getState()
                  .startRename({ kind: "pane", id: pane.id, where: "pane" })
              }
              onRename={(title) =>
                useKeel.getState().renamePane(projectId, pane.id, title)
              }
              onStopRename={() => useKeel.getState().stopRename()}
              onDragStart={(event) => onDragStart(pane.id, event)}
              onMute={(muted) => useKeel.getState().setPaneMuted(pane.id, muted)}
            />
          )}

            <div className="relative min-h-0 flex-1">
              {isEditor ? (
                <EditorBody
                  projectPath={cwd}
                  pane={pane}
                  focused={focused}
                  visible={!hidden}
                  onFocus={onFocus}
                />
              ) : (
              <TerminalSurface
                paneId={pane.id}
                cwd={cwd}
                command={
                  pane.resumeAgent && agent
                    ? applySession(agent.command, agent.session, {
                        sessionId: pane.sessionId,
                        sessionReady: pane.sessionReady,
                      })
                    : null
                }
                launchAgentId={pane.resumeAgent ? pane.agentId : null}
                accountEnv={agent?.accountEnv ?? null}
                accountId={pane.accountId}
                generation={generation}
                visible={!hidden}
                focused={focused}
                onOutput={onOutput}
                onActivity={onActivity}
                onFocus={onFocus}
                onSpawnResult={onSpawnResult}
                onTitle={onTitle}
                onCwd={onCwd}
              />
              )}
            </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Built when the menu opens, so "Copy" knows about the selection. */}
        <ContextMenuEntries
          entries={() =>
            isEditor
              ? paneMenu(projectId, pane.id, "pane")
              : terminalMenu(projectId, pane.id)
          }
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});
