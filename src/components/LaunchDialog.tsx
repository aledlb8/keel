/**
 * "Three Codex, three Claude, one empty shell."
 *
 * The whole dialog is built around making that sentence one gesture. Click an
 * agent to add one; the preview on the right redraws the exact grid you are about
 * to get, in the agents' own colours, so you commit to a layout you have already
 * seen.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Folder,
  Minus,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listSubdirectories } from "@/lib/backend";
import { KEEL_AGENT_FALLBACK, agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";
import { useKeel, type PaneSpec } from "@/state/store";

/** Stands in for "no agent, just a shell" wherever an agent id is expected. */
const SHELL = "__shell__";

export interface LaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project the terminals will be opened in. */
  project: Project | null;
}

export function LaunchDialog({
  open,
  onOpenChange,
  project,
}: LaunchDialogProps) {
  const agents = useKeel((state) => state.agents);

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [folder, setFolder] = useState("");
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);

  useEffect(() => {
    if (open) return;
    setCounts({});
    setFolder("");
  }, [open]);

  // Subdirectories of the project root, so a pane can start inside a package.
  useEffect(() => {
    if (!open || !project) {
      setFolders([]);
      return;
    }
    let stale = false;
    void listSubdirectories(project.path)
      .then((entries) => !stale && setFolders(entries))
      .catch(() => setFolders([]));
    return () => {
      stale = true;
    };
  }, [open, project]);

  const installed = useMemo(
    () => agents.filter((agent) => agent.installed && !agent.hidden),
    [agents],
  );
  const missing = useMemo(
    () => agents.filter((agent) => !agent.installed && !agent.hidden),
    [agents],
  );

  const cwd = folder
    ? (folders.find((entry) => entry.name === folder)?.path ?? null)
    : (project?.path ?? null);

  /** Flattened in pick order — the same order the grid preview draws. */
  const chosen: { key: string; short: string; accent: string; name: string }[] =
    [];
  if ((counts[SHELL] ?? 0) > 0) {
    for (let index = 0; index < counts[SHELL]; index += 1) {
      chosen.push({
        key: SHELL,
        short: "SH",
        accent: KEEL_AGENT_FALLBACK,
        name: "Shell",
      });
    }
  }
  for (const agent of installed) {
    for (let index = 0; index < (counts[agent.id] ?? 0); index += 1) {
      chosen.push({
        key: agent.id,
        short: agent.short || agent.name.slice(0, 2).toUpperCase(),
        accent: agentAccent(agent.accent),
        name: agent.name,
      });
    }
  }

  const specs: PaneSpec[] = chosen.map((pick) => ({
    agentId: pick.key === SHELL ? null : pick.key,
    cwd,
  }));

  const bump = (key: string, delta: number) =>
    setCounts((previous) => ({
      ...previous,
      [key]: Math.max(0, Math.min((previous[key] ?? 0) + delta, 16)),
    }));

  function openTerminals() {
    if (!project || specs.length === 0) return;
    useKeel.getState().addPanes(project.id, specs);
    onOpenChange(false);
  }

  function refreshAgents() {
    void useKeel.getState().refreshAgents();
  }

  function editCatalogue() {
    onOpenChange(false);
    useKeel.getState().openAgentSettings(null);
  }

  const catalogueEmpty = agents.length === 0;
  const onlyMissing = installed.length === 0 && missing.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            openTerminals();
          }
        }}
      >
        <DialogHeader className="flex-row items-center justify-between gap-4 space-y-0 border-b border-line py-0 pl-5 pr-0">
          <div className="py-3.5">
            <DialogTitle className="text-[15px] font-medium">
              Add terminals
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-dim">
              Each one is a fresh shell with the agent typed into it.
            </DialogDescription>
          </div>
          <div className="flex self-stretch">
            <button
              type="button"
              title="Customize agents"
              aria-label="Customize agents"
              onClick={editCatalogue}
              className="k-icon-btn w-[52px] self-stretch rounded-none"
            >
              <SlidersHorizontal className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Close"
              onClick={() => onOpenChange(false)}
              className="k-icon-btn w-[52px] self-stretch rounded-none"
            >
              <X className="size-4" />
            </button>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_320px] items-stretch">
          <div className="max-h-[52vh] overflow-y-auto p-2.5">
            {catalogueEmpty ? (
              <div className="px-2 py-5">
                <p className="text-[14px] text-foreground">No agents found</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-dim">
                  Nothing is in the catalogue yet, or discovery came back empty.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={refreshAgents}>
                    Refresh
                  </Button>
                  <Button size="sm" onClick={editCatalogue}>
                    Customize agents
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {onlyMissing ? (
                  <div className="mb-2.5 rounded-[var(--keel-r-control)] bg-veil-2 px-3 py-2.5">
                    <p className="text-[13px] text-foreground">CLI not found</p>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-dim">
                      Keel can&apos;t find the agent CLI on this machine. Install
                      it or fix the path, then try again.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="outline" onClick={refreshAgents}>
                        Retry
                      </Button>
                      <Button size="sm" onClick={editCatalogue}>
                        Customize agents
                      </Button>
                    </div>
                  </div>
                ) : null}

                <AgentRow
                  name="Plain shell"
                  hint="nothing typed in"
                  short="SH"
                  accent={KEEL_AGENT_FALLBACK}
                  count={counts[SHELL] ?? 0}
                  onBump={(delta) => bump(SHELL, delta)}
                />
                {installed.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    name={agent.name}
                    hint={agent.command}
                    short={agent.short || agent.name.slice(0, 2).toUpperCase()}
                    accent={agentAccent(agent.accent)}
                    count={counts[agent.id] ?? 0}
                    onBump={(delta) => bump(agent.id, delta)}
                  />
                ))}
                {missing.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    name={agent.name}
                    hint="not installed"
                    short={agent.short || agent.name.slice(0, 2).toUpperCase()}
                    accent={KEEL_AGENT_FALLBACK}
                    count={0}
                    disabled
                    onBump={() => {}}
                  />
                ))}
              </>
            )}
          </div>

          <div className="flex flex-col gap-3.5 border-l border-line p-5">
            <GridPreview cells={chosen} />

            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[26px] leading-none tabular-nums">
                {chosen.length}
              </span>
              <span className="text-[13px] text-dim">
                {chosen.length === 1 ? "terminal" : "terminals"}
              </span>
              {chosen.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setCounts({})}
                  className="ml-auto text-[13px] text-dim transition-colors hover:text-foreground"
                >
                  Clear
                </button>
              ) : null}
            </div>

            {project ? (
              <label className="relative flex items-center gap-2">
                <Folder className="pointer-events-none absolute left-2 size-3 text-faint" />
                <select
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  className="w-full appearance-none rounded-[var(--keel-r-control)] border border-line-strong bg-veil-2 py-2 pl-7 pr-6 font-mono text-[12px] text-foreground outline-none transition-colors focus:border-foreground/40"
                >
                  <option value="">{project.name}</option>
                  {folders.map((entry) => (
                    <option key={entry.path} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 size-3 text-faint" />
              </label>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end border-t border-line px-5 py-3.5">
          <Button
            size="sm"
            disabled={specs.length === 0 || !project}
            onClick={openTerminals}
          >
            Open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({
  name,
  hint,
  short,
  accent,
  count,
  disabled,
  onBump,
}: {
  name: string;
  hint: string;
  short: string;
  accent: string;
  count: number;
  disabled?: boolean;
  onBump: (delta: number) => void;
}) {
  const picked = count > 0;
  return (
    <div
      role={disabled ? undefined : "button"}
      tabIndex={disabled ? undefined : 0}
      // The whole row adds one. Reaching for the small "+" is optional.
      onClick={disabled ? undefined : () => onBump(1)}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onBump(1);
        }
      }}
      className={cn(
        "flex items-center gap-3 rounded-[var(--keel-r-control)] border-l-2 px-2.5 py-2.5 transition-colors",
        disabled
          ? "border-l-transparent opacity-35"
          : "cursor-pointer border-l-transparent hover:bg-veil",
        picked && "bg-veil-2",
      )}
      style={picked ? { borderLeftColor: accent } : undefined}
    >
      <span
        className="grid size-8 shrink-0 place-items-center rounded-[var(--keel-r-chip)] bg-[color:var(--keel-term-solid)] font-mono text-[11px] font-medium"
        style={{ color: accent }}
      >
        {short}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-tight">{name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">
          {hint}
        </span>
      </span>

      {disabled ? null : (
        <span
          className="flex shrink-0 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label={`One fewer ${name}`}
            onClick={() => onBump(-1)}
            disabled={count === 0}
            className="k-icon-btn size-[26px] disabled:opacity-0"
          >
            <Minus className="size-3.5" />
          </button>
          <span
            className={cn(
              "w-5 text-center font-mono text-[14px] tabular-nums",
              picked ? "text-foreground" : "text-faint/50",
            )}
          >
            {count}
          </span>
          <button
            type="button"
            aria-label={`One more ${name}`}
            onClick={() => onBump(1)}
            className="k-icon-btn size-[26px]"
          >
            <Plus className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * A scale model of the layout these panes will land in.
 *
 * It mirrors `gridOf` exactly — columns are `ceil(sqrt(n))`, rows are the panes
 * chunked across them — so what you see here is what the canvas does.
 */
function GridPreview({
  cells,
}: {
  cells: { short: string; accent: string }[];
}) {
  if (cells.length === 0) {
    return (
      <div className="grid aspect-[16/10] place-items-center rounded-[var(--keel-r-window)] border border-dashed border-line-strong text-[13px] text-faint">
        Pick some terminals
      </div>
    );
  }

  const columns = Math.ceil(Math.sqrt(cells.length));
  const rows: { short: string; accent: string }[][] = [];
  for (let index = 0; index < cells.length; index += columns) {
    rows.push(cells.slice(index, index + columns));
  }

  return (
    <div className="flex aspect-[16/10] flex-col gap-1.5 rounded-[var(--keel-r-window)] bg-veil p-1.5">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex flex-1 gap-1.5">
          {row.map((cell, cellIndex) => (
            <div
              key={cellIndex}
              className="grid flex-1 place-items-center overflow-hidden rounded-[var(--keel-r-chip)] border-l-2"
              style={{
                borderLeftColor: cell.accent,
                background: "var(--keel-term-solid)",
              }}
            >
              <span
                className="font-mono text-[10px] font-medium"
                style={{ color: cell.accent }}
              >
                {cell.short}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
