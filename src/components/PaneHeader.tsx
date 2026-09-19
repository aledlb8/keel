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
 *
 * The strip is also the pane's handle: press on any part of it that is not a
 * button and drag, and the pane can be dropped against another one.
 */

import {
  BellOff,
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
import { AgentMark } from "@/components/AgentMark";
import { InlineRename } from "@/components/InlineRename";
import { withShortcut } from "@/lib/keymap";
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
  /** A press on the strip itself, which may turn into dragging the pane. */
  onDragStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** Unmute from the header indicator. Muting itself is a menu action. */
  onMute: (muted: boolean) => void;
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
  onDragStart,
  onMute,
}: PaneHeaderProps) {
  const agentAccounts = agent
    ? accounts.filter((account) => account.agentId === agent.id)
    : [];
  const currentAccount =
    agentAccounts.find((account) => account.id === pane.accountId) ?? null;

  return (
    <div
      data-no-select
      className="flex h-7 shrink-0 cursor-grab items-center gap-1 pl-2.5 pr-1"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Same portal caveat as below: only presses on the strip itself.
        if (!event.currentTarget.contains(event.target as Node)) return;
        if ((event.target as HTMLElement).closest("button, input")) return;
        // No preventDefault: the mousedown below still has to focus the pane.
        onDragStart(event);
      }}
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
      <span className="mr-0.5 flex shrink-0" title={cwd ?? undefined}>
        <AgentMark
          agentId={agent?.id ?? pane.agentId ?? null}
          name={agent?.name}
          accent={accent}
          size={16}
        />
      </span>

      {renaming ? (
        <InlineRename
          value={pane.title}
          className="h-5 max-w-56 flex-initial text-body"
          onCommit={onRename}
          onDone={onStopRename}
        />
      ) : (
        <span
          className="k-pane-title min-w-0 truncate text-body"
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
              className="flex h-5 min-w-0 max-w-32 items-center gap-1 rounded-[var(--keel-r-chip)] px-1.5 text-small text-dim outline-none transition-colors duration-100 hover:bg-veil-2 hover:text-foreground focus-visible:bg-veil-2 data-[state=open]:bg-veil-2 data-[state=open]:text-foreground"
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
          <span className="ml-1 shrink-0 text-small text-faint">
            Exited
          </span>
          <HeaderButton label="Relaunch" onClick={onRestart}>
            <RotateCw className="size-3.5" />
          </HeaderButton>
        </>
      ) : null}

      {pane.muted && !pane.editor ? (
        <HeaderButton label="Unmute desktop notifications" onClick={() => onMute(false)}>
          <BellOff className="size-3.5" />
        </HeaderButton>
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
        <HeaderButton
          label={withShortcut("Split right", "splitRight")}
          onClick={() => onSplit("row")}
        >
          <SplitSquareHorizontal className="size-3.5" />
        </HeaderButton>
        <HeaderButton
          label={withShortcut("Split down", "splitDown")}
          onClick={() => onSplit("column")}
        >
          <SplitSquareVertical className="size-3.5" />
        </HeaderButton>
        <HeaderButton
          label={withShortcut(zoomed ? "Restore" : "Fullscreen", "fullscreen")}
          onClick={onZoom}
        >
          {zoomed ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </HeaderButton>
        <HeaderButton
          label={withShortcut("Close", "closePane")}
          danger
          onClick={onClose}
        >
          <X className="size-3.5" />
        </HeaderButton>
      </div>
    </div>
  );
}
