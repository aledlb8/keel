/**
 * A pane: a floating terminal window, and as little else as possible.
 *
 * This is the one surface the whole look is built around — a rounded slab, a
 * step *lighter* than the ground it sits on, lifted off it by a soft shadow.
 * That value step is what makes it read as an object on the desk rather than a
 * hole cut in the window.
 *
 * Focus is expressed in light: the focused pane brightens its hairline and
 * deepens its lift. Nothing else on screen competes for attention that way.
 *
 * The one exception to a hueless edge is a pane that has *stopped and asked you
 * something*, or died. That is the event the entire app exists to surface, and a
 * word inside a chip you have to hover to see was not carrying it — so the edge
 * itself takes the status colour. It is the same vocabulary as everywhere else
 * (amber waits, red is dead), just spent on the largest object on screen.
 *
 * There is no titlebar. Everything you can *do* to a pane lives in a small chip
 * that appears on hover or focus. It is deliberately short: four actions. Moving
 * a pane around the grid is a keyboard job (Alt+Shift+arrows), and eleven icons
 * in a row was clutter pretending to be power.
 */

import { memo } from "react";
import {
  ChevronDown,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";

import { TerminalSurface } from "@/components/TerminalSurface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Agent, AgentAccount, Pane, PaneStatus } from "@/lib/types";

export interface PaneViewProps {
  pane: Pane;
  agent: Agent | null;
  accounts: AgentAccount[];
  status: PaneStatus;
  focused: boolean;
  zoomed: boolean;
  cwd: string | null;
  generation: number;
  rect: { left: number; top: number; width: number; height: number } | null;
  hidden: boolean;
  onFocus: (paneId: string) => void;
  onOutput: (paneId: string) => void;
  onSplit: (paneId: string, direction: "row" | "column") => void;
  onZoom: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onRestart: (paneId: string) => void;
  onAccountChange: (paneId: string, accountId: string | null) => void;
  onCreateAccount: (paneId: string, agentId: string, name: string) => void;
  onSpawnResult?: (paneId: string, ok: boolean, reason?: string) => void;
}

/**
 * The edge of a pane, as one value.
 *
 * Status wins over focus when there is any, because "this one needs you" is
 * worth more than "this one has the cursor" — and you can always see which pane
 * has the cursor by looking at the cursor.
 */
function edgeFor(status: PaneStatus, focused: boolean): string {
  if (status === "waiting") return "var(--keel-waiting)";
  if (status === "exited") return "var(--keel-dead)";
  return focused
    ? "var(--keel-term-border-focus)"
    : "var(--keel-term-border)";
}

function liftFor(status: PaneStatus, focused: boolean): string {
  // A hairline of light along the slab's own top edge. Same trick as the glass
  // chrome: without it a flat fill at this size reads as a hole in the window
  // rather than as a surface catching the light.
  const sheen = "inset 0 1px 0 0 rgba(255,255,255,0.045)";
  const base = focused
    ? `${sheen}, var(--keel-lift)`
    : `${sheen}, 0 2px 10px -6px rgba(0,0,0,0.6)`;
  // A halo in the status colour, tight enough to read as part of the edge
  // rather than as a glow effect sitting behind the window.
  if (status === "waiting")
    return `${base}, 0 0 0 3px color-mix(in srgb, var(--keel-waiting) 14%, transparent)`;
  if (status === "exited")
    return `${base}, 0 0 0 3px color-mix(in srgb, var(--keel-dead) 12%, transparent)`;
  return base;
}

function ChipButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-danger={danger ? "true" : undefined}
      // Mousedown would steal focus from the terminal before the click lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="k-icon-btn size-[21px]"
    >
      {children}
    </button>
  );
}

export const PaneView = memo(function PaneView({
  pane,
  agent,
  accounts,
  status,
  focused,
  zoomed,
  cwd,
  generation,
  rect,
  hidden,
  onFocus,
  onOutput,
  onSplit,
  onZoom,
  onClose,
  onRestart,
  onAccountChange,
  onCreateAccount,
  onSpawnResult,
}: PaneViewProps) {
  const accent = agentAccent(agent?.accent);
  const agentAccounts = agent
    ? accounts.filter((account) => account.agentId === agent.id)
    : [];
  const currentAccount =
    agentAccounts.find((account) => account.id === pane.accountId) ?? null;
  // The chip stays put while waiting or dead, so the Relaunch button and the
  // "needs you" line are reachable without hunting for them.
  const chipSticky = status === "waiting" || status === "exited";

  return (
    <div
      data-pane={pane.id}
      className={cn(
        "group absolute flex overflow-hidden rounded-[var(--keel-r-window)]",
        "transition-[box-shadow,border-color] duration-200",
        hidden && "pointer-events-none opacity-0",
      )}
      style={{
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        // Solid, and the same in every state — the fill never shifts tone when
        // you click between terminals.
        background: "var(--keel-term-solid)",
        zIndex: zoomed ? 20 : focused ? 10 : 1,
        border: `1px solid ${edgeFor(status, focused)}`,
        boxShadow: liftFor(status, focused),
      }}
      onMouseDown={() => onFocus(pane.id)}
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <TerminalSurface
          paneId={pane.id}
          cwd={cwd}
          command={agent?.command ?? null}
          accountEnv={agent?.accountEnv ?? null}
          accountId={pane.accountId}
          generation={generation}
          visible={!hidden}
          focused={focused}
          onOutput={onOutput}
          onFocus={onFocus}
          onSpawnResult={onSpawnResult}
        />

        <div
          className={cn(
            "absolute right-2.5 top-2.5 flex items-center gap-0.5 rounded-[var(--keel-r-control)] border border-line-strong bg-[color:var(--keel-chrome-strong)] p-1 pl-2.5 shadow-[var(--keel-lift)] backdrop-blur-[var(--keel-blur)]",
            // Invisible *and* untouchable until pointed at, so a stray click on
            // the terminal can never land on a control you cannot see.
            "pointer-events-none opacity-0 transition-opacity duration-150",
            "group-hover:pointer-events-auto group-hover:opacity-100",
            "focus-within:pointer-events-auto focus-within:opacity-100",
            chipSticky && "pointer-events-auto opacity-100",
          )}
          data-no-select
        >
          <span
            className="mr-1.5 select-none font-mono text-[11px] font-medium"
            style={{ color: accent }}
            title={cwd ?? undefined}
          >
            {agent?.short ?? "SH"}
          </span>

          {agent?.accountEnv ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={`Profile: ${currentAccount?.name ?? "Default"}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  className="mr-1.5 flex max-w-28 items-center gap-1 rounded-[var(--keel-r-chip)] px-1.5 py-0.5 text-[11px] text-dim outline-none hover:bg-veil-2 hover:text-foreground"
                >
                  <span className="truncate">
                    {currentAccount?.name ?? "Default"}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuRadioGroup
                  value={pane.accountId ?? "__default__"}
                  onValueChange={(value) =>
                    onAccountChange(
                      pane.id,
                      value === "__default__" ? null : value,
                    )
                  }
                >
                  <DropdownMenuRadioItem value="__default__">
                    Default
                  </DropdownMenuRadioItem>
                  {agentAccounts.map((profile) => (
                    <DropdownMenuRadioItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    onCreateAccount(
                      pane.id,
                      agent.id,
                      `Profile ${agentAccounts.length + 1}`,
                    )
                  }
                >
                  <Plus className="size-3.5" />
                  Add profile
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {status === "waiting" ? (
            <span className="mr-1.5 select-none text-[12px] text-[color:var(--keel-waiting)]">
              Needs you
            </span>
          ) : null}

          {status === "exited" ? (
            <>
              <span className="mr-1.5 select-none text-[12px] text-[color:var(--keel-dead)]">
                Agent exited
              </span>
              <ChipButton label="Relaunch" onClick={() => onRestart(pane.id)}>
                <RotateCw className="size-3" />
              </ChipButton>
              <span aria-hidden className="mx-1 h-3.5 w-px bg-line-strong" />
            </>
          ) : null}

          <ChipButton
            label="Split right"
            onClick={() => onSplit(pane.id, "row")}
          >
            <SplitSquareHorizontal className="size-3" />
          </ChipButton>
          <ChipButton
            label="Split down"
            onClick={() => onSplit(pane.id, "column")}
          >
            <SplitSquareVertical className="size-3" />
          </ChipButton>
          <ChipButton
            label={zoomed ? "Restore" : "Fullscreen"}
            onClick={() => onZoom(pane.id)}
          >
            {zoomed ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </ChipButton>
          <ChipButton label="Close" danger onClick={() => onClose(pane.id)}>
            <X className="size-3" />
          </ChipButton>
        </div>
      </div>
    </div>
  );
});
