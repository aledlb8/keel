/**
 * The project folder as a tree you can search, open, rename and grow.
 *
 * Click opens a file or folds a folder; double-click or F2 renames; right-click
 * or the ⋯ does everything else. Expanding a folder loads its children.
 *
 * It borrows the left sidebar's rows exactly — inset chips, the same hover and
 * selection — and adds what a tree of files needs on top: a glyph per kind of
 * file, a guide line down each open folder so depth reads without counting
 * indents, a fold that opens and shuts its own height rather than snapping,
 * and git's colours on anything that changed. A changed file takes the hue on
 * its name and git's letter beside it; a folder takes the hue alone, standing
 * for the worst change below it, so nothing hides behind a fold.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { Fold } from "@/components/Fold";
import { InlineRename } from "@/components/InlineRename";
import { FileIcon } from "@/components/inspector/FileIcon";
import { GitLetter } from "@/components/inspector/GitLetter";
import { RecentDot } from "@/components/inspector/RecentDot";
import {
  ContextMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  fileName,
  folderStatuses,
  gitBadgeMap,
  gitStatusColor,
  parentRel,
} from "@/lib/git";
import { isRecent, recentAt } from "@/lib/recentFiles";
import { bindingFor, matchesBinding } from "@/lib/keymap";
import { cn } from "@/lib/utils";
import type { GitFileStatus, WorkspaceEntry } from "@/lib/workspace";
import { canMoveInto, useWorkspace } from "@/state/workspace";

/** Dragged tree rows carry this type, so nothing else mistakes them for text. */
const DRAG_TYPE = "application/x-keel-file";

/** How long a dragged row hovers over a closed folder before it opens. */
const SPRING_OPEN_MS = 600;

/** Indent per level. The chevron slot is the same width, so guides line up. */
const STEP = 14;

function indentStyle(depth: number): CSSProperties {
  return { paddingLeft: 8 + depth * STEP };
}

function joinFs(root: string, rel: string): string {
  if (/windows/i.test(navigator.userAgent)) {
    return `${root}\\${rel.replace(/\//g, "\\")}`;
  }
  return `${root}/${rel}`;
}

function isControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, input") !== null;
}

function openMenuFrom(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom + 2,
    }),
  );
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

function fileMenu(rel: string): MenuEntry[] {
  const { root, openFile, startRename, startCreate, deleteEntry } =
    useWorkspace.getState();
  const parent = parentRel(rel);
  return [
    {
      kind: "item",
      label: "Open",
      onSelect: () => void openFile(rel),
    },
    {
      kind: "item",
      label: "Reveal in Explorer",
      icon: FolderOpen,
      onSelect: () => {
        if (root) void revealItemInDir(joinFs(root, rel)).catch(() => {});
      },
    },
    {
      kind: "item",
      label: "Copy path",
      icon: Copy,
      onSelect: () => {
        if (root) copyText(joinFs(root, rel));
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      onSelect: () => startRename(rel),
    },
    {
      kind: "item",
      label: "New file",
      icon: FilePlus,
      onSelect: () => startCreate(parent, "file"),
    },
    {
      kind: "item",
      label: "New folder",
      icon: FolderPlus,
      onSelect: () => startCreate(parent, "dir"),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Delete",
      icon: Trash2,
      destructive: true,
      confirm: "Delete?",
      onSelect: () => void deleteEntry(rel),
    },
  ];
}

function folderMenu(rel: string): MenuEntry[] {
  const { startRename, startCreate, deleteEntry } = useWorkspace.getState();
  return [
    {
      kind: "item",
      label: "New file",
      icon: FilePlus,
      onSelect: () => startCreate(rel, "file"),
    },
    {
      kind: "item",
      label: "New folder",
      icon: FolderPlus,
      onSelect: () => startCreate(rel, "dir"),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Rename",
      icon: Pencil,
      onSelect: () => startRename(rel),
    },
    {
      kind: "item",
      label: "Delete",
      icon: Trash2,
      destructive: true,
      confirm: "Delete?",
      onSelect: () => void deleteEntry(rel),
    },
  ];
}

/** Right-click on the tree itself, away from any row: the project folder. */
function rootMenu(): MenuEntry[] {
  const {
    root,
    expanded,
    showHidden,
    startCreate,
    setShowHidden,
    collapseAll,
    refreshTree,
    refreshGit,
  } = useWorkspace.getState();
  return [
    {
      kind: "item",
      label: "New file",
      icon: FilePlus,
      onSelect: () => startCreate("", "file"),
    },
    {
      kind: "item",
      label: "New folder",
      icon: FolderPlus,
      onSelect: () => startCreate("", "dir"),
    },
    { kind: "separator" },
    {
      kind: "check",
      label: "Show hidden files",
      checked: showHidden,
      onChange: (checked) => void setShowHidden(checked),
    },
    {
      kind: "item",
      label: "Collapse folders",
      icon: ChevronsDownUp,
      disabled: !Object.values(expanded).some(Boolean),
      onSelect: collapseAll,
    },
    {
      kind: "item",
      label: "Refresh",
      icon: RefreshCw,
      onSelect: () => {
        void refreshTree();
        void refreshGit();
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Reveal in Explorer",
      icon: FolderOpen,
      onSelect: () => {
        if (root) void revealItemInDir(root).catch(() => {});
      },
    },
    {
      kind: "item",
      label: "Copy path",
      icon: Copy,
      onSelect: () => {
        if (root) copyText(root);
      },
    },
  ];
}

/** Where "New file" lands: inside the selected folder, else beside the selection. */
function createTarget(
  tree: Record<string, WorkspaceEntry[]>,
  selectedRel: string | null,
): string {
  if (!selectedRel) return "";
  for (const entries of Object.values(tree)) {
    const entry = entries.find((item) => item.rel === selectedRel);
    if (entry) return entry.kind === "dir" ? entry.rel : parentRel(entry.rel);
  }
  return parentRel(selectedRel);
}

interface TreeContext {
  tree: Record<string, WorkspaceEntry[]>;
  expanded: Record<string, boolean>;
  selectedRel: string | null;
  creating: { parent: string; kind: "file" | "dir" } | null;
  renaming: string | null;
  badges: Record<string, GitFileStatus>;
  /** Folders stand for the worst change inside them; files speak for themselves. */
  folderBadges: Record<string, GitFileStatus>;
  rowMotion: Record<string, "enter" | "leave">;
  /** The row being dragged, and the folder it would land in (`""` is the root). */
  drag: string | null;
  over: string | null;
  startDrag: (rel: string) => void;
  endDrag: () => void;
  dragOver: (event: ReactDragEvent, dir: string) => void;
  dropOn: (event: ReactDragEvent, dir: string) => void;
}

export function FileTree() {
  const root = useWorkspace((state) => state.root);
  const tree = useWorkspace((state) => state.tree);
  const expanded = useWorkspace((state) => state.expanded);
  const selectedRel = useWorkspace((state) => state.selectedRel);
  const creating = useWorkspace((state) => state.creating);
  const renaming = useWorkspace((state) => state.renaming);
  const query = useWorkspace((state) => state.query);
  const searchHits = useWorkspace((state) => state.searchHits);
  const showHidden = useWorkspace((state) => state.showHidden);
  const git = useWorkspace((state) => state.git);
  const setQuery = useWorkspace((state) => state.setQuery);
  const setShowHidden = useWorkspace((state) => state.setShowHidden);
  const rowMotion = useWorkspace((state) => state.rowMotion);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const badges = useMemo(() => gitBadgeMap(git?.files ?? []), [git]);
  const folderBadges = useMemo(() => folderStatuses(git?.files ?? []), [git]);

  // Hovering a closed folder mid-drag springs it open, so you can go deeper.
  useEffect(() => {
    if (drag === null || !over) return;
    if (useWorkspace.getState().expanded[over]) return;
    const timer = window.setTimeout(() => {
      useWorkspace.getState().toggleExpanded(over);
    }, SPRING_OPEN_MS);
    return () => window.clearTimeout(timer);
  }, [drag, over]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) return;
    const timer = window.setTimeout(() => {
      void useWorkspace.getState().search(query);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  if (!root) return null;

  const context: TreeContext = {
    tree,
    expanded,
    selectedRel,
    creating,
    renaming,
    badges,
    folderBadges,
    rowMotion,
    drag,
    over,
    startDrag: (rel) => setDrag(rel),
    endDrag: () => {
      setDrag(null);
      setOver(null);
    },
    dragOver: (event, dir) => {
      if (drag === null || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
      // Rows answer for themselves; the tree only takes what reaches empty space.
      event.stopPropagation();
      if (!canMoveInto(drag, dir)) {
        if (over !== null) setOver(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== dir) setOver(dir);
    },
    dropOn: (event, dir) => {
      const carried = drag;
      setDrag(null);
      setOver(null);
      if (carried === null || !canMoveInto(carried, dir)) return;
      event.preventDefault();
      event.stopPropagation();
      void useWorkspace.getState().moveEntry(carried, dir);
    },
  };
  const rootEntries = tree[""];
  const emptyRoot =
    rootEntries !== undefined &&
    rootEntries.length === 0 &&
    creating?.parent !== "";

  const create = (kind: "file" | "dir") =>
    useWorkspace.getState().startCreate(createTarget(tree, selectedRel), kind);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 px-[var(--keel-inset)] pb-2">
        <div className="k-field min-w-0 flex-1">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            value={query}
            spellCheck={false}
            placeholder="Search files"
            aria-label="Search files"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
          {query ? (
            <button
              type="button"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="k-icon-btn -mr-1 size-5"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
        <ToolButton label="New file" onClick={() => create("file")}>
          <FilePlus className="size-3.5" />
        </ToolButton>
        <ToolButton label="New folder" onClick={() => create("dir")}>
          <FolderPlus className="size-3.5" />
        </ToolButton>
        <ToolButton
          label={showHidden ? "Hide hidden files" : "Show hidden files"}
          pressed={showHidden}
          onClick={() => setShowHidden(!showHidden)}
        >
          {showHidden ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )}
        </ToolButton>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="tree"
            aria-label="Files"
            data-drop={over === "" ? "true" : undefined}
            className="k-drop-zone min-h-0 flex-1 overflow-y-auto pb-2"
            onDragOver={(event) => context.dragOver(event, "")}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setOver(null);
              }
            }}
            onDrop={(event) => context.dropOn(event, "")}
          >
            {searchHits ? (
              searchHits.length === 0 ? (
                <DockNotice
                  icon={SearchX}
                  title="No matches"
                  detail={`Nothing in this project is called “${query.trim()}”.`}
                  className="pt-8"
                />
              ) : (
                searchHits.map((entry) => (
                  <HitRow
                    key={entry.rel}
                    entry={entry}
                    selected={selectedRel === entry.rel}
                    status={
                      entry.kind === "dir"
                        ? folderBadges[entry.rel]
                        : badges[entry.rel]
                    }
                  />
                ))
              )
            ) : emptyRoot ? (
              <DockNotice
                icon={FolderOpen}
                title="Empty folder"
                detail="Create a file to get started."
                className="pt-8"
              />
            ) : (
              <ChildList parent="" depth={0} context={context} />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Rows open their own menu; this one is for the space around them. */}
          <ContextMenuEntries entries={rootMenu} />
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

function ToolButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("k-icon-btn size-[28px]", pressed && "text-dim")}
    >
      {children}
    </button>
  );
}

/** One hairline per open ancestor, centred under that ancestor's chevron. */
function Guides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="k-guide"
          style={{ left: 8 + level * STEP + STEP / 2 }}
        />
      ))}
    </>
  );
}

function ChildList({
  parent,
  depth,
  context,
  leaving = false,
}: {
  parent: string;
  depth: number;
  context: TreeContext;
  /** The folder holding these rows is folding away, so they go with it. */
  leaving?: boolean;
}) {
  const entries = context.tree[parent];
  const creating = context.creating;
  const showCreate = creating !== null && creating.parent === parent;
  const empty = entries !== undefined && entries.length === 0 && !showCreate;

  return (
    <>
      {showCreate && creating ? (
        <CreateRow kind={creating.kind} depth={depth} />
      ) : null}
      {entries?.map((entry) => (
        <TreeRow
          key={entry.rel}
          entry={entry}
          depth={depth}
          context={context}
          leaving={leaving}
        />
      ))}
      {empty && depth > 0 ? (
        <div
          className="k-row k-row-dense gap-1.5 text-body italic text-faint"
          style={indentStyle(depth)}
        >
          <Guides depth={depth} />
          <span className="w-3.5 shrink-0" />
          Empty
        </div>
      ) : null}
    </>
  );
}

function TreeRow({
  entry,
  depth,
  context,
  leaving,
}: {
  entry: WorkspaceEntry;
  depth: number;
  context: TreeContext;
  leaving: boolean;
}) {
  const root = useWorkspace((state) => state.root);
  const recentTick = useWorkspace((state) => state.recentEpoch);
  void recentTick;
  const folder = entry.kind === "dir";
  const open = Boolean(context.expanded[entry.rel]);
  const selected = context.selectedRel === entry.rel;
  const isRenaming = context.renaming === entry.rel;
  const status = folder
    ? context.folderBadges[entry.rel]
    : context.badges[entry.rel];
  const motion = leaving ? "leave" : context.rowMotion[entry.rel];
  /** Dropping on a folder puts it inside; dropping on a file, beside it. */
  const dropDir = folder ? entry.rel : parentRel(entry.rel);

  const activate = () => {
    const state = useWorkspace.getState();
    state.setSelected(entry.rel);
    if (folder) state.toggleExpanded(entry.rel);
    else void state.openFile(entry.rel);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-expanded={folder ? open : undefined}
            aria-selected={selected}
            tabIndex={0}
            data-selected={selected}
            data-motion={motion}
            data-dragging={context.drag === entry.rel ? "true" : undefined}
            data-drop={
              folder && context.over === entry.rel ? "inside" : undefined
            }
            draggable={!isRenaming}
            style={indentStyle(depth)}
            className="k-row group/entry k-row-dense gap-1.5"
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(DRAG_TYPE, entry.rel);
              context.startDrag(entry.rel);
            }}
            onDragEnd={context.endDrag}
            onDragOver={(event) => context.dragOver(event, dropDir)}
            onDrop={(event) => context.dropOn(event, dropDir)}
            onClick={(event) => {
              if (!isControl(event.target)) activate();
            }}
            onDoubleClick={(event) => {
              if (isControl(event.target)) return;
              useWorkspace.getState().startRename(entry.rel);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate();
              } else if (matchesBinding(event, bindingFor("rename"))) {
                event.preventDefault();
                useWorkspace.getState().startRename(entry.rel);
              } else if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                openMenuFrom(event.currentTarget);
              }
            }}
          >
            <Guides depth={depth} />
            <span className="grid w-3.5 shrink-0 place-items-center">
              {folder ? (
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3 text-faint transition-transform duration-150",
                    open && "rotate-90",
                  )}
                />
              ) : null}
            </span>
            <FileIcon name={entry.name} folder={folder} open={open} />

            {isRenaming ? (
              <InlineRename
                value={entry.name}
                className="h-[var(--keel-h-chip)]"
                onCommit={(name) =>
                  void useWorkspace.getState().confirmRename(name)
                }
                onDone={() => useWorkspace.getState().cancelRename()}
              />
            ) : (
              <>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    !status && (selected ? "text-foreground" : "text-dim"),
                  )}
                  style={status ? { color: gitStatusColor(status) } : undefined}
                >
                  {entry.name}
                </span>
                <span className="flex shrink-0 items-center gap-1 group-hover/entry:hidden group-focus-visible/entry:hidden">
                  {root && isRecent(root, entry.rel) ? (
                    <RecentDot at={recentAt(root, entry.rel)} />
                  ) : null}
                  {/* The folder's hue says enough; only files carry a letter. */}
                  {!folder && status ? <GitLetter status={status} /> : null}
                </span>
                <span className="hidden shrink-0 items-center group-hover/entry:flex group-focus-visible/entry:flex">
                  <MoreButton />
                </span>
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries
            entries={() => (folder ? folderMenu(entry.rel) : fileMenu(entry.rel))}
          />
        </ContextMenuContent>
      </ContextMenu>

      {folder ? (
        <Fold open={open}>
          <ChildList
            parent={entry.rel}
            depth={depth + 1}
            context={context}
            leaving={motion === "leave"}
          />
        </Fold>
      ) : null}
    </>
  );
}

function HitRow({
  entry,
  selected,
  status,
}: {
  entry: WorkspaceEntry;
  selected: boolean;
  status: GitFileStatus | undefined;
}) {
  const parent = parentRel(entry.rel);
  const folder = entry.kind === "dir";

  const activate = () => {
    const state = useWorkspace.getState();
    state.setSelected(entry.rel);
    if (!folder) void state.openFile(entry.rel);
  };

  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      data-selected={selected}
      className="k-row k-row-dense gap-2"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      <FileIcon name={entry.name} folder={folder} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span
          className={cn(
            "max-w-full shrink-0 truncate",
            !status && (selected ? "text-foreground" : "text-dim"),
          )}
          style={status ? { color: gitStatusColor(status) } : undefined}
        >
          {fileName(entry.rel)}
        </span>
        {parent ? (
          <span className="min-w-0 truncate text-small text-faint">{parent}</span>
        ) : null}
      </span>
      {!folder && status ? <GitLetter status={status} /> : null}
    </div>
  );
}

function CreateRow({ kind, depth }: { kind: "file" | "dir"; depth: number }) {
  return (
    <div className="k-row k-row-dense gap-1.5" style={indentStyle(depth)}>
      <Guides depth={depth} />
      <span className="w-3.5 shrink-0" />
      <FileIcon name="" folder={kind === "dir"} />
      <InlineRename
        value=""
        className="h-[var(--keel-h-chip)]"
        onCommit={(name) => void useWorkspace.getState().confirmCreate(name)}
        onDone={() => useWorkspace.getState().cancelCreate()}
      />
    </div>
  );
}

function MoreButton() {
  return (
    <button
      type="button"
      title="More actions"
      aria-label="More actions"
      onClick={(event) => {
        event.stopPropagation();
        openMenuFrom(event.currentTarget);
      }}
      className="k-icon-btn size-[22px]"
    >
      <Ellipsis className="size-3.5" />
    </button>
  );
}
