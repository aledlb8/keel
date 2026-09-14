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

import { memo } from "react";

import { ContextMenuEntries } from "@/components/menu/MenuEntries";
import { terminalMenu } from "@/components/menu/actions";
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
  rect: { left: number; top: number; width: number; height: number } | null;
  hidden: boolean;
  onFocus: (paneId: string) => void;
  onOutput: (paneId: string) => void;
  onActivity: (paneId: string, kind: PaneActivity) => void;
  onSplit: (paneId: string, direction: "row" | "column") => void;
  onZoom: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onRestart: (paneId: string) => void;
  onAccountChange: (paneId: string, accountId: string | null) => void;
  onCreateAccount: (paneId: string, agentId: string, name: string) => void;
  onSpawnResult?: (paneId: string, ok: boolean, reason?: string) => void;
  onTitle: (paneId: string, title: string, source: TitleSource) => void;
  /** A press on the header that may become a drag. Must be stable: this is memoised. */
  onDragStart: (paneId: string, event: React.PointerEvent) => void;
}

// A hairline of light along the slab's own top edge. Same trick as the glass
// chrome: without it a flat fill at this size reads as a hole in the window
// rather than as a surface catching the light.
const SHEEN = "inset 0 1px 0 0 rgba(255,255,255,0.045)";

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
  onDragStart,
}: PaneViewProps) {
  const renaming = useKeel(
    (state) =>
      state.renaming?.where === "pane" &&
      state.renaming.kind === "pane" &&
      state.renaming.id === pane.id,
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-pane={pane.id}
          className={cn(
            "group/pane absolute flex flex-col overflow-hidden rounded-[var(--keel-r-window)]",
            "transition-[box-shadow,border-color] duration-150 ease-out",
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
            />

            <div className="relative min-h-0 flex-1">
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
              />
            </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Built when the menu opens, so "Copy" knows about the selection. */}
        <ContextMenuEntries entries={() => terminalMenu(projectId, pane.id)} />
      </ContextMenuContent>
    </ContextMenu>
  );
});
