/**
 * The strip along the top of a pane: which agent, which profile, and the four
 * things you can do to it.
 *
 * This used to be a chip floating over the terminal on hover, and it could not
 * be made reliable. It shared a stacking context with xterm's own positioned
 * layers — the scrollbar sits at z-index 11, the IME helpers at 5 — so parts of
 * it were covered by things you could not see, and whether it took clicks at
 * all hung on WebView2's stale idea of `:hover`. A strip in the layout overlaps
 * nothing and is always live. Hover only changes how bright it is, never
 * whether it works.
 */

import {
  ChevronDown,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  Settings2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineRename } from "@/components/InlineRename";
import { cn } from "@/lib/utils";
import type { Agent, AgentAccount, Pane } from "@/lib/types";
import { nextProfileName } from "@/state/store";

const DEFAULT_ACCOUNT = "__default__";

export interface PaneHeaderProps {
  pane: Pane;
  agent: Agent | null;
  /** The agent's colour, already resolved. */
  accent: string;
  /** Every account in the app; the header picks out this agent's own. */
  accounts: AgentAccount[];
  /** The shell has exited; offer to start it again. */
  exited: boolean;
  focused: boolean;
  zoomed: boolean;
  cwd: string | null;
  onFocus: () => void;
  onSplit: (direction: "row" | "column") => void;
  onZoom: () => void;
  onClose: () => void;
  onRestart: () => void;
  onAccountChange: (accountId: string | null) => void;
  onCreateAccount: (agentId: string, name: string) => void;
  /** Open the agents & profiles dialog on this agent. */
  onManageProfiles: () => void;
  /** The pane's name is being edited here. */
  renaming: boolean;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onStopRename: () => void;
}

function HeaderButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-danger={danger ? "true" : undefined}
      onClick={onClick}
      className="k-icon-btn size-6"
    >
      {children}
    </button>
  );
}

export function PaneHeader({
  pane,
  agent,
  accent,
  accounts,
  exited,
  focused,
  zoomed,
  cwd,
  onFocus,
  onSplit,
  onZoom,
  onClose,
  onRestart,
  onAccountChange,
  onCreateAccount,
  onManageProfiles,
  renaming,
  onStartRename,
  onRename,
  onStopRename,
}: PaneHeaderProps) {
  const agentAccounts = agent
    ? accounts.filter((account) => account.agentId === agent.id)
    : [];
  const currentAccount =
    agentAccounts.find((account) => account.id === pane.accountId) ?? null;

  return (
    <div
      data-no-select
      className="flex h-7 shrink-0 items-center gap-1 border-b border-line pl-2.5 pr-1"
      onMouseDown={(event) => {
        // The profile menu is portalled to <body>, but React still bubbles its
        // events up through here. Only presses that physically landed on the
        // strip count — a click in the menu must never refocus the terminal,
        // because that pulls focus out of the menu and closes it mid-click.
        if (!event.currentTarget.contains(event.target as Node)) return;
        const target = event.target as HTMLElement;
        // The rename field needs its mousedown to place the caret.
        if (target.closest("input")) return;
        // Keep keyboard focus wherever it already is; a pressed button should
        // not park the caret on itself.
        event.preventDefault();
        if (!target.closest("button")) onFocus();
      }}
    >
      <span
        className="shrink-0 font-mono text-[11px] font-medium"
        style={{ color: accent }}
        title={cwd ?? undefined}
      >
        {agent?.short ?? "SH"}
      </span>

      {renaming ? (
        <InlineRename
          value={pane.title}
          className="h-5 max-w-56 flex-initial text-[12px]"
          onCommit={onRename}
          onDone={onStopRename}
        />
      ) : (
        <span
          className="min-w-0 truncate text-[12px] text-dim"
          title="Double-click to rename"
          onDoubleClick={onStartRename}
        >
          {pane.title}
        </span>
      )}

      {agent?.accountEnv ? (
        // Non-modal: a modal menu makes the whole window inert while it is
        // open, so the next click anywhere is spent just closing it.
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={`Profile: ${currentAccount?.name ?? "Default"}`}
              className="flex h-5 min-w-0 max-w-32 items-center gap-1 rounded-[var(--keel-r-chip)] px-1.5 text-[11px] text-dim outline-none transition-colors duration-100 hover:bg-veil-2 hover:text-foreground focus-visible:bg-veil-2 data-[state=open]:bg-veil-2 data-[state=open]:text-foreground"
            >
              <span className="truncate">
                {currentAccount?.name ?? "Default"}
              </span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="min-w-44"
            // Leave focus alone on close rather than bouncing it to the trigger.
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuRadioGroup
              value={pane.accountId ?? DEFAULT_ACCOUNT}
              onValueChange={(value) => {
                const next = value === DEFAULT_ACCOUNT ? null : value;
                // Re-picking the current profile would restart the agent for
                // nothing.
                if (next !== pane.accountId) onAccountChange(next);
              }}
            >
              <DropdownMenuRadioItem value={DEFAULT_ACCOUNT}>
                Default
              </DropdownMenuRadioItem>
              {agentAccounts.map((account) => (
                <DropdownMenuRadioItem key={account.id} value={account.id}>
                  {account.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                onCreateAccount(agent.id, nextProfileName(agentAccounts))
              }
            >
              <Plus className="size-3.5" />
              Add profile
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onManageProfiles}>
              <Settings2 className="size-3.5" />
              Manage profiles…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {exited ? (
        <>
          <span className="ml-1 shrink-0 text-[11px] text-faint">
            Exited
          </span>
          <HeaderButton label="Relaunch" onClick={onRestart}>
            <RotateCw className="size-3.5" />
          </HeaderButton>
        </>
      ) : null}

      <span className="min-w-0 flex-1" />

      <div
        className={cn(
          "flex shrink-0 items-center gap-px transition-opacity duration-100",
          // Quieter on panes you are not using. Purely visual: the buttons take
          // clicks at every opacity.
          focused ? "opacity-100" : "opacity-60 group-hover/pane:opacity-100",
        )}
      >
        <HeaderButton label="Split right" onClick={() => onSplit("row")}>
          <SplitSquareHorizontal className="size-3.5" />
        </HeaderButton>
        <HeaderButton label="Split down" onClick={() => onSplit("column")}>
          <SplitSquareVertical className="size-3.5" />
        </HeaderButton>
        <HeaderButton label={zoomed ? "Restore" : "Fullscreen"} onClick={onZoom}>
          {zoomed ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </HeaderButton>
        <HeaderButton label="Close" danger onClick={onClose}>
          <X className="size-3.5" />
        </HeaderButton>
      </div>
    </div>
  );
}
