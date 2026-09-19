/**
 * An editor pane: open files and diffs, living in the layout like a terminal.
 *
 * It used to be a dock of its own beside the canvas, outside the layout tree —
 * so it hung over every deck, emptied whenever you changed project, and could
 * not be moved. Now it is a pane. It belongs to one deck and is saved with it,
 * and it splits, zooms, drags and closes the way a terminal does. Only what it
 * shows is saved; the text is read from disk when it next comes on screen.
 *
 * The header is its tabs and, like a terminal's strip, the handle you drag it
 * by. The body is the tab on screen: a CodeMirror surface, or a diff.
 */

import { useEffect, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  ChevronRight,
  FileDiff,
  FileImage,
  FileText,
  Maximize2,
  Minimize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { DiffView } from "@/components/editor/DiffView";
import { languageName } from "@/components/editor/language";
import { FileIcon } from "@/components/inspector/FileIcon";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import { editorRefId, editorRefName } from "@/lib/editorRefs";
import { diffStats } from "@/lib/git";
import { withShortcut } from "@/lib/keymap";
import type { Direction, EditorRef, Pane } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";
import { useWorkspace } from "@/state/workspace";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The tab a pane has on screen: its active one, or its first. */
function shownTab(pane: Pane): EditorRef | null {
  const editor = pane.editor;
  if (!editor) return null;
  return (
    editor.tabs.find((tab) => editorRefId(tab) === editor.active) ??
    editor.tabs[0] ??
    null
  );
}

function useDirty(ref: EditorRef): boolean {
  const id = editorRefId(ref);
  return useWorkspace(
    (state) =>
      ref.kind === "file" && (state.buffers[id] ?? "") !== (state.originals[id] ?? ""),
  );
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
  children: ReactNode;
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

export interface EditorHeaderProps {
  projectId: string;
  pane: Pane;
  focused: boolean;
  zoomed: boolean;
  onFocus: () => void;
  onSplit: (direction: Direction) => void;
  onZoom: () => void;
  onClose: () => void;
  /** A press on the strip, which may turn into dragging the pane. */
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function EditorHeader({
  projectId,
  pane,
  focused,
  zoomed,
  onFocus,
  onSplit,
  onZoom,
  onClose,
  onDragStart,
}: EditorHeaderProps) {
  const tabs = pane.editor?.tabs ?? [];
  const shown = shownTab(pane);
  const shownId = shown ? editorRefId(shown) : null;

  return (
    <div
      data-no-select
      className="flex h-8 shrink-0 cursor-grab items-center gap-1 pl-1 pr-1"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (!event.currentTarget.contains(event.target as Node)) return;
        // Tabs are not buttons, so a tab is a handle too; a click still selects it.
        if ((event.target as HTMLElement).closest("button, input")) return;
        onDragStart(event);
      }}
      onMouseDown={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        // Keep the caret in the editor while you pick a tab or press a button.
        event.preventDefault();
        if (!(event.target as HTMLElement).closest("button")) onFocus();
      }}
    >
      <div
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const id = editorRefId(tab);
          return (
            <TabChip
              key={id}
              projectId={projectId}
              paneId={pane.id}
              tab={tab}
              active={id === shownId}
            />
          );
        })}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-px transition-opacity duration-100",
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
        <HeaderButton label={withShortcut("Close", "closePane")} danger onClick={onClose}>
          <X className="size-3.5" />
        </HeaderButton>
      </div>
    </div>
  );
}

/**
 * A tab. The close button waits for hover — except on the tab you are on — and
 * an unsaved file shows a dot in its place until you reach for it.
 */
function TabChip({
  projectId,
  paneId,
  tab,
  active,
}: {
  projectId: string;
  paneId: string;
  tab: EditorRef;
  active: boolean;
}) {
  const id = editorRefId(tab);
  const name = editorRefName(tab);
  const dirty = useDirty(tab);
  const chip = useRef<HTMLDivElement>(null);
  const close = () => useWorkspace.getState().closeTab(projectId, paneId, id);

  useEffect(() => {
    if (!active) return;
    // `nearest` on both axes: the least scrolling that reveals it, and no
    // vertical movement in a strip that only scrolls sideways.
    chip.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      ref={chip}
      role="tab"
      aria-selected={active}
      data-active={active}
      title={tab.kind === "diff" ? `Changes in ${tab.rel}` : tab.rel}
      className="k-tab group/tab"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        showEditorTab(projectId, paneId, id);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        close();
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {tab.kind === "diff" ? (
          <FileDiff aria-hidden className="size-3.5 shrink-0 text-faint" />
        ) : (
          <FileIcon name={name} />
        )}
        <span className="min-w-0 truncate">{name}</span>
      </span>

      <span className="relative grid size-[18px] shrink-0 place-items-center">
        {dirty ? (
          <span
            aria-hidden
            className="size-[7px] rounded-full bg-foreground/60 group-hover/tab:opacity-0"
          />
        ) : null}
        <button
          type="button"
          title="Close"
          aria-label={`Close ${name}`}
          onClick={close}
          className={cn(
            "k-icon-btn absolute inset-0",
            active && !dirty
              ? ""
              : "opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100",
          )}
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  );
}

export interface EditorBodyProps {
  /** The folder the pane's project is. Contents only load while it is the open one. */
  projectPath: string | null;
  pane: Pane;
  focused: boolean;
  /** On screen: the active deck of the active project. */
  visible: boolean;
  onFocus: (paneId: string) => void;
}

export function EditorBody({
  projectPath,
  pane,
  focused,
  visible,
  onFocus,
}: EditorBodyProps) {
  const active = shownTab(pane);
  const id = active ? editorRefId(active) : null;
  const root = useWorkspace((state) => state.root);
  // Every project's decks stay mounted. A pane from a folder that is not the
  // open one has no contents to show, and nothing to show them to.
  const here = root !== null && root === projectPath;
  const known = useWorkspace(
    (state) => id !== null && state.editors.some((tab) => tab.id === id),
  );
  const loading = useWorkspace((state) => (id ? Boolean(state.editorLoading[id]) : false));
  const error = useWorkspace((state) => (id ? (state.editorErrors[id] ?? null) : null));
  const snapshot = useWorkspace((state) => (id ? state.snapshots[id] : undefined));
  const diff = useWorkspace((state) => (id ? state.diffs[id] : undefined));

  const kind = active?.kind;
  const rel = active?.rel;
  const staged = active?.staged;
  useEffect(() => {
    if (!here || !visible || !kind || rel === undefined || known) return;
    void useWorkspace
      .getState()
      .ensureDocument({ kind, rel, staged: Boolean(staged) });
  }, [here, visible, kind, rel, staged, known]);

  return (
    <div
      data-editor-pane={pane.id}
      className="flex h-full min-h-0 flex-col"
      onMouseDown={() => onFocus(pane.id)}
    >
      {!active || !id ? (
        <DockNotice
          icon={FileText}
          title="No open files"
          detail="Open a file from the files panel."
          className="h-full justify-center"
        />
      ) : !here ? null : (
        <>
          <PathBar
            tab={active}
            id={id}
            truncated={Boolean(snapshot?.truncated && !snapshot.binary)}
            stats={active.kind === "diff" && diff ? diffStats(diff) : null}
          />
          <div className="relative min-h-0 flex-1">
            {!known || loading ? (
              <LoadingRows
                label={active.kind === "diff" ? "Loading diff" : "Loading file"}
                rows={12}
              />
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2">
                <DockNotice icon={FileDiff} title="Couldn't load this file" detail={error} />
                <button
                  type="button"
                  className="k-tag"
                  onClick={() => void useWorkspace.getState().ensureDocument(active)}
                >
                  Retry
                </button>
              </div>
            ) : snapshot?.binary ? (
              <DockNotice
                icon={FileImage}
                title="Binary file"
                detail={
                  snapshot.size
                    ? `${formatBytes(snapshot.size)}. Keel only opens text.`
                    : "Keel only opens text."
                }
                className="h-full justify-center"
              />
            ) : active.kind === "diff" ? (
              <DiffView id={id} />
            ) : (
              <CodeEditor key={id} id={id} rel={active.rel} focused={focused} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Where the file lives, and the one fact about it worth knowing right now. */
function PathBar({
  tab,
  id,
  truncated,
  stats,
}: {
  tab: EditorRef;
  id: string;
  truncated: boolean;
  stats: { added: number; removed: number } | null;
}) {
  const dirty = useDirty(tab);
  const segments = tab.rel.split("/");
  const shown = segments.length > 4 ? ["…", ...segments.slice(-4)] : segments;

  return (
    <div className="flex h-[var(--keel-h-row)] shrink-0 items-center gap-3 border-y border-[color:var(--keel-term-border)] px-3">
      <nav
        aria-label="Path"
        title={tab.rel}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-small text-faint"
      >
        {shown.map((segment, index) => {
          const last = index === shown.length - 1;
          return (
            <span
              key={`${index}:${segment}`}
              className={cn("flex min-w-0 items-center gap-1", last ? "shrink" : "shrink-0")}
            >
              {index > 0 ? (
                <ChevronRight aria-hidden className="size-3 shrink-0 opacity-60" />
              ) : null}
              <span className={cn("truncate", last && "text-dim")}>{segment}</span>
            </span>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-2.5 text-[11px]">
        {truncated ? (
          <span className="text-faint">Showing the start of a large file</span>
        ) : null}
        {tab.kind === "diff" ? (
          <>
            {stats ? (
              <span className="flex items-center gap-1.5 font-mono tabular-nums">
                <span className="text-[color:var(--keel-done)]">+{stats.added}</span>
                <span className="text-[color:var(--keel-dead)]">−{stats.removed}</span>
              </span>
            ) : null}
            <span className="k-tag">{tab.staged ? "Staged" : "Working tree"}</span>
          </>
        ) : dirty && !truncated ? (
          <>
            <span className="text-faint">Unsaved</span>
            <button
              type="button"
              title="Save (Ctrl+S)"
              onClick={() => void useWorkspace.getState().saveTab(id)}
              className="k-tag"
            >
              Save
            </button>
          </>
        ) : truncated ? null : (
          <span className="text-faint">{languageName(tab.rel)}</span>
        )}
      </div>
    </div>
  );
}
