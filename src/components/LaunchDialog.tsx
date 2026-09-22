/**
 * Add terminals — a scale model of what you are about to open.
 *
 * The stage along the top draws every terminal you have queued, lit in its
 * agent's colour, in the grid it will open as. Under it sits one key per agent.
 * Click a key or press its number to drop a pane onto the stage; click a pane,
 * or right-click a key, to take one back out. Enter arranges new and existing
 * panes together in a balanced grid. A pane's header can be dragged to rearrange
 * from there.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CornerDownLeft, SlidersHorizontal, X } from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listSubdirectories } from "@/lib/backend";
import { KEEL_AGENT_FALLBACK, agentAccent } from "@/lib/tokens";
import { gridRows, listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { Agent, Pane, Project } from "@/lib/types";
import { activeDeck, useKeel, type PaneSpec } from "@/state/store";

/** Stands in for "no agent, just a shell" wherever an agent id is expected. */
const SHELL = "__shell__";

/** The folder picker's value for the project root (a select item can't be ""). */
const ROOT = "__root__";

/** Past this, one batch stops being a layout and becomes a wall. */
const MAX_NEW = 16;

/** One key on the strip: something that can be opened. */
interface LaunchKey {
  id: string;
  /** Catalogue id, or null for a plain shell. */
  agentId: string | null;
  name: string;
  /** What gets typed into the shell; null for a plain shell. */
  command: string | null;
  accent: string;
  /** The number key that presses it, if it got one. */
  digit: string | null;
}

/** A queued terminal. `uid` keeps two picks of the same agent apart. */
interface Pick {
  uid: number;
  key: LaunchKey;
}

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

  const [picks, setPicks] = useState<{ uid: number; keyId: string }[]>([]);
  /** The pick that should grow onto the stage; cleared by any removal. */
  const [growing, setGrowing] = useState<number | null>(null);
  const [folder, setFolder] = useState(ROOT);
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const nextUid = useRef(0);

  useEffect(() => {
    if (open) return;
    setPicks([]);
    setGrowing(null);
    setFolder(ROOT);
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

  const keys = useMemo<LaunchKey[]>(
    () => [
      ...installed.map((agent, index) => ({
        id: agent.id,
        agentId: agent.id,
        name: agent.name,
        command: agent.command,
        accent: agentAccent(agent.accent),
        digit: index < 9 ? String(index + 1) : null,
      })),
      {
        id: SHELL,
        agentId: null,
        name: "Shell",
        command: null,
        accent: KEEL_AGENT_FALLBACK,
        digit: "0",
      },
    ],
    [installed],
  );
  const keyById = useMemo(
    () => new Map(keys.map((key) => [key.id, key])),
    [keys],
  );

  // A pick whose agent vanished from the catalogue mid-dialog just drops out.
  const queued: Pick[] = picks.flatMap((pick) => {
    const key = keyById.get(pick.keyId);
    return key ? [{ uid: pick.uid, key }] : [];
  });
  const lastPick = queued.length > 0 ? queued[queued.length - 1] : null;

  const counts = new Map<string, number>();
  for (const { key } of queued) {
    counts.set(key.id, (counts.get(key.id) ?? 0) + 1);
  }

  const deck = activeDeck(project);
  const existing = listPanes(deck?.tree ?? null).flatMap((paneId) => {
    const pane = deck?.panes[paneId];
    return pane ? [pane] : [];
  });

  const cwd =
    folder === ROOT
      ? (project?.path ?? null)
      : (folders.find((entry) => entry.name === folder)?.path ?? null);

  const count = queued.length;
  const full = count >= MAX_NEW;

  function add(keyId: string) {
    if (!project || full || !keyById.has(keyId)) return;
    const uid = nextUid.current++;
    setPicks([...picks, { uid, keyId }]);
    setGrowing(uid);
  }

  function remove(uid: number) {
    setPicks(picks.filter((pick) => pick.uid !== uid));
    // Removing reshuffles the grid and remounts tiles; none of them is new.
    setGrowing(null);
  }

  /** Take back the most recent pick of this key. */
  function withdraw(keyId: string) {
    const index = picks.map((pick) => pick.keyId).lastIndexOf(keyId);
    const pick = index >= 0 ? picks[index] : undefined;
    if (pick) remove(pick.uid);
  }

  function openTerminals() {
    if (!project || count === 0) return;
    const specs: PaneSpec[] = queued.map(({ key }) => ({
      agentId: key.agentId,
      cwd,
    }));
    useKeel.getState().addPanes(project.id, specs);
    onOpenChange(false);
  }

  function editCatalogue() {
    onOpenChange(false);
    useKeel.getState().openAgentSettings(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The folder list is portalled, but its keys still bubble up through here.
    if ((event.target as HTMLElement).closest("[data-slot^=select]")) return;

    if (event.key === "Enter") {
      event.preventDefault();
      openTerminals();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      if (lastPick) remove(lastPick.uid);
      return;
    }
    // By physical key, so Shift+1 still means 1 on any layout.
    const key = keys.find(
      ({ digit }) =>
        digit !== null &&
        (event.code === `Digit${digit}` || event.code === `Numpad${digit}`),
    );
    if (!key) return;
    event.preventDefault();
    if (event.shiftKey) withdraw(key.id);
    else add(key.id);
  }

  let placeholder = "Add a project folder first. Its terminals open here.";
  if (project) {
    placeholder =
      existing.length > 0
        ? "Pick an agent below, or press its number. New terminals will join the existing panes in a balanced grid."
        : "Pick an agent below, or press its number.";
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[760px] gap-0 overflow-hidden p-0 sm:max-w-[760px]"
        onKeyDown={onKeyDown}
        // Focus the dialog itself, not its first control: number keys have to
        // work the moment it opens, without a ring landing on the folder picker.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <header className="flex h-12 items-center gap-1 pl-5 pr-2">
          <DialogTitle className="text-title">Add terminals</DialogTitle>
          <DialogDescription className="sr-only">
            Pick agents to open as new terminals in the current deck.
          </DialogDescription>
          {project ? (
            <>
              <span className="ml-0.5 text-title text-faint">in</span>
              <FolderPicker
                project={project}
                folders={folders}
                value={folder}
                onChange={setFolder}
              />
            </>
          ) : null}

          <span className="flex-1" />

          <button
            type="button"
            title="Customize agents"
            aria-label="Customize agents"
            onClick={editCatalogue}
            className="k-icon-btn size-8"
          >
            <SlidersHorizontal className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="k-icon-btn size-8"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="px-3">
          <Stage
            existing={existing}
            picks={queued}
            growingUid={growing}
            onRemove={remove}
            placeholder={placeholder}
          />
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-1.5 px-3 pt-3">
          {keys.map((entry) => (
            <AgentKey
              key={entry.id}
              entry={entry}
              count={counts.get(entry.id) ?? 0}
              disabled={!project}
              onAdd={() => add(entry.id)}
              onWithdraw={() => withdraw(entry.id)}
            />
          ))}
        </div>

        <CatalogueNote
          empty={agents.length === 0}
          missing={missing}
          onRescan={() => void useKeel.getState().refreshAgents()}
          onCustomize={editCatalogue}
        />

        <footer className="mt-3 flex h-14 items-center gap-2 border-t border-line pl-5 pr-3">
          <p className="flex items-center gap-1.5 text-body text-faint">
            {full ? (
              `${MAX_NEW} at a time is the most one batch can open.`
            ) : (
              <>
                <Kbd>1</Kbd>
                <span>–</span>
                <Kbd>9</Kbd>
                <span className="mr-2.5">add</span>
                <Kbd>⇧</Kbd>
                <span className="mr-2.5">removes</span>
                <Kbd>⌫</Kbd>
                <span>undoes</span>
              </>
            )}
          </p>

          <span className="flex-1" />

          {count > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setPicks([])}>
              Clear
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={count === 0 || !project}
            onClick={openTerminals}
            className="h-8 gap-2 pl-3 pr-2.5"
          >
            {count === 0
              ? "Open terminals"
              : `Open ${count} ${count === 1 ? "terminal" : "terminals"}`}
            <CornerDownLeft className="size-3.5 opacity-60" />
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The resulting deck in miniature. Rows come from `gridRows`, the same chunking
 * `gridOf` uses when the queued terminals join the existing panes.
 */
function Stage({
  existing,
  picks,
  growingUid,
  onRemove,
  placeholder,
}: {
  existing: Pane[];
  picks: Pick[];
  growingUid: number | null;
  onRemove: (uid: number) => void;
  placeholder: string;
}) {
  const newest = picks.length > 0 ? picks[picks.length - 1]?.uid ?? null : null;
  const tiles: ({ kind: "existing"; pane: Pane } | { kind: "new"; pick: Pick })[] = [
    ...existing.map((pane) => ({ kind: "existing" as const, pane })),
    ...picks.map((pick) => ({ kind: "new" as const, pick })),
  ];

  return (
    <div
      role="group"
      aria-label="Layout after opening terminals"
      className="flex h-[min(40vh,320px)] flex-col gap-1.5 rounded-[var(--keel-r-window)] bg-[color:var(--keel-void)] p-1.5 shadow-[inset_0_0_0_1px_var(--keel-line)]"
    >
      {picks.length === 0 ? (
        <div className="grid flex-1 place-items-center rounded-[7px] border border-dashed border-line-strong px-10 text-center text-row leading-relaxed text-faint">
          {placeholder}
        </div>
      ) : (
        gridRows(tiles).map((row, index) => (
          <div
            // By index: a row stays mounted while the panes in it change.
            key={index}
            className={cn(
              "flex min-h-0 flex-1 gap-1.5",
              // A row that only just came into being grows in with its pane.
              row.length === 1 &&
                row[0]?.kind === "new" &&
                row[0].pick.uid === growingUid &&
                "k-pane-in",
            )}
          >
            {row.map((tile) =>
              tile.kind === "existing" ? (
                <div
                  key={tile.pane.id}
                  title={`${tile.pane.title} (already open)`}
                  className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden rounded-[7px] border border-line bg-veil-2 px-2 text-small text-faint"
                >
                  <span className="truncate text-dim">{tile.pane.title}</span>
                  <span className="truncate">Already open</span>
                </div>
              ) : (
                <StageTile
                  key={tile.pick.uid}
                  pick={tile.pick}
                  growing={tile.pick.uid === growingUid}
                  caret={tile.pick.uid === newest}
                  onRemove={() => onRemove(tile.pick.uid)}
                />
              ),
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** A terminal about to open, lit in its agent's colour. Clicking takes it back. */
function StageTile({
  pick: { key },
  growing,
  caret,
  onRemove,
}: {
  pick: Pick;
  growing: boolean;
  caret: boolean;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      title={`Remove ${key.name}`}
      aria-label={`Remove ${key.name}`}
      className={cn(
        "group/tile @container relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] text-left",
        growing && "k-pane-in",
      )}
      style={{
        background: `color-mix(in srgb, ${key.accent} 9%, var(--keel-term-solid))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${key.accent} 40%, transparent), var(--keel-lift)`,
      }}
    >
      <span className="flex h-6 shrink-0 items-center gap-1.5 px-2">
        <AgentMark
          agentId={key.agentId}
          name={key.name}
          accent={key.accent}
          size={12}
          variant="glyph"
        />
        <span className="hidden truncate text-small text-dim @min-[6rem]:block">
          {key.name}
        </span>
      </span>

      <span className="hidden items-center gap-1.5 px-2 pt-1 font-mono text-small leading-none @min-[8rem]:flex">
        <span style={{ color: key.accent }}>❯</span>
        {key.command ? (
          <span className="truncate text-dim">{key.command}</span>
        ) : null}
        {caret ? (
          <span className="k-caret inline-block h-3 w-1.5 shrink-0 bg-foreground/70" />
        ) : null}
      </span>

      <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-[4px] bg-[color:var(--keel-void)]/70 text-dim opacity-0 transition-opacity duration-100 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100">
        <X className="size-3" />
      </span>
    </button>
  );
}

/** One agent on the strip. Click adds; Shift-click or right-click removes. */
function AgentKey({
  entry,
  count,
  disabled,
  onAdd,
  onWithdraw,
}: {
  entry: LaunchKey;
  count: number;
  disabled: boolean;
  onAdd: () => void;
  onWithdraw: () => void;
}) {
  const lit = count > 0;
  const sheen = "inset 0 1px 0 0 var(--keel-sheen)";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => (event.shiftKey ? onWithdraw() : onAdd())}
      onContextMenu={(event) => {
        event.preventDefault();
        onWithdraw();
      }}
      title={
        entry.digit
          ? `Add ${entry.name} (${entry.digit}). Right-click to remove one.`
          : `Add ${entry.name}. Right-click to remove one.`
      }
      className={cn(
        "flex h-[52px] items-center gap-2.5 rounded-[var(--keel-r-control)] pl-2 pr-3 text-left transition-[background-color,transform] duration-100 active:translate-y-px disabled:pointer-events-none disabled:opacity-40",
        lit ? "bg-veil-2" : "bg-veil hover:bg-veil-2",
      )}
      style={{
        boxShadow: lit
          ? `inset 0 0 0 1px color-mix(in srgb, ${entry.accent} 45%, transparent), ${sheen}`
          : sheen,
      }}
    >
      <AgentMark
        agentId={entry.agentId}
        name={entry.name}
        accent={entry.accent}
        size={30}
      />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-row font-medium leading-tight">
          {entry.name}
        </span>
        <span className="mt-0.5 block truncate font-mono text-small text-faint">
          {entry.command ?? "nothing typed in"}
        </span>
      </span>

      {lit ? (
        <span
          className="text-row font-semibold tabular-nums"
          style={{ color: entry.accent }}
        >
          ×{count}
        </span>
      ) : entry.digit ? (
        <Kbd>{entry.digit}</Kbd>
      ) : null}
    </button>
  );
}

/** Why an agent you expected is not on the strip, and what to do about it. */
function CatalogueNote({
  empty,
  missing,
  onRescan,
  onCustomize,
}: {
  empty: boolean;
  missing: Agent[];
  onRescan: () => void;
  onCustomize: () => void;
}) {
  if (!empty && missing.length === 0) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-3 text-body text-faint">
      <span>
        {empty
          ? "No agents in the catalogue yet. Shells still work."
          : `Not installed: ${missing.map((agent) => agent.name).join(", ")}.`}
      </span>
      <NoteAction onClick={onRescan}>Scan again</NoteAction>
      <NoteAction onClick={onCustomize}>Customize agents</NoteAction>
    </p>
  );
}

function NoteAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-dim underline decoration-line-strong underline-offset-3 transition-colors hover:text-foreground hover:decoration-foreground/40"
    >
      {children}
    </button>
  );
}

/** Where the terminals start: the project root or one folder inside it. */
function FolderPicker({
  project,
  folders,
  value,
  onChange,
}: {
  project: Project;
  folders: { name: string; path: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        variant="ghost"
        aria-label="Folder"
        className="max-w-[300px] text-title"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[360px]">
        <SelectItem value={ROOT}>{project.name}</SelectItem>
        {folders.map((entry) => (
          <SelectItem key={entry.path} value={entry.name}>
            <span className="text-faint">{project.name}/</span>
            {entry.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-[4px] px-1 font-sans text-small font-medium text-faint shadow-[inset_0_0_0_1px_var(--keel-line-strong),inset_0_-1px_0_0_var(--keel-line-strong)]">
      {children}
    </kbd>
  );
}
