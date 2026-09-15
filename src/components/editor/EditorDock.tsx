/**
 * Open files and diffs, docked beside the terminals.
 *
 * The first version was a sheet over the whole canvas, so opening a file hid
 * every terminal you were working with. The editor is now a column of its own
 * on the canvas's right: the panes reflow into what is left — the same thing
 * that happens when a pane is split — and a seam in the gutter trades width
 * between the two. Maximise when you do want the whole canvas; the terminals
 * keep running underneath it either way.
 *
 * It is drawn the way a pane is — the same slab, hairline and lift, brighter
 * hairline while it has focus — because it is the same kind of thing: work,
 * not chrome.
 */

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  FileDiff,
  FileImage,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { DiffView } from "@/components/editor/DiffView";
import { languageName } from "@/components/editor/language";
import { FileIcon } from "@/components/inspector/FileIcon";
import { diffStats } from "@/lib/git";
import { listPanes } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { activeDeck, useKeel } from "@/state/store";
import { useWorkspace, type EditorTab } from "@/state/workspace";

const WIDTH_KEY = "keel.editorWidth";
/** The editor's share of the canvas row. */
const DEFAULT_SHARE = 0.5;
const MIN_SHARE = 0.28;
const MAX_SHARE = 0.78;

function clampShare(share: number): number {
  return Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));
}

function readShare(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored ? clampShare(stored) : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

function isDirty(
  tab: EditorTab,
  buffers: Record<string, string>,
  originals: Record<string, string>,
): boolean {
  if (tab.kind !== "file") return false;
  return (buffers[tab.id] ?? "") !== (originals[tab.id] ?? "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EditorDock() {
  const editors = useWorkspace((state) => state.editors);
  const activeEditor = useWorkspace((state) => state.activeEditor);
  const snapshots = useWorkspace((state) => state.snapshots);
  const buffers = useWorkspace((state) => state.buffers);
  const originals = useWorkspace((state) => state.originals);
  const diffs = useWorkspace((state) => state.diffs);
  const [share, setShare] = useState(readShare);
  const [maximized, setMaximized] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // With no terminals on the deck there is nothing to sit beside, so the
  // editor takes the whole canvas rather than a column next to empty ground.
  const hasTerminals = useKeel((state) => {
    const project = state.projects.find(
      (item) => item.id === state.activeProjectId,
    );
    const deck = activeDeck(project);
    return deck ? listPanes(deck.tree).length > 0 : false;
  });

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(share));
    } catch {
      // Storage unavailable: the width just lasts for this session.
    }
  }, [share]);

  const open = editors.length > 0;
  // Maximised belongs to this batch of files; the next one opens as a column.
  useEffect(() => {
    if (!open) setMaximized(false);
  }, [open]);

  if (!open) return null;

  const active = editors.find((tab) => tab.id === activeEditor) ?? editors[0];
  const snapshot = snapshots[active.id];
  const diff = diffs[active.id];
  const fill = maximized || !hasTerminals;

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const row = ref.current?.parentElement;
    if (event.button !== 0 || !row) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    handle.setPointerCapture(pointer);
    const bounds = row.getBoundingClientRect();

    const onMove = (move: PointerEvent) => {
      setShare(clampShare((bounds.right - move.clientX) / bounds.width));
    };
    const onUp = () => {
      handle.releasePointerCapture(pointer);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={ref}
      data-maximized={fill}
      className="k-editor-dock"
      style={fill ? undefined : { width: `${share * 100}%` }}
    >
      {fill ? null : (
        // Same seam as between two panes: nothing until you reach for it.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the editor"
          title="Drag to resize, double-click to split evenly"
          onPointerDown={startResize}
          onDoubleClick={() => setShare(DEFAULT_SHARE)}
          className="k-editor-seam group/seam"
        >
          <span
            aria-hidden
            className="h-8 w-0.5 rounded-full bg-line-strong opacity-0 transition-opacity duration-100 group-hover/seam:opacity-100"
          />
        </div>
      )}

      <section aria-label="Editor" className="k-editor">
        <header className="flex h-[40px] shrink-0 items-center gap-1 px-1.5">
          <div
            role="tablist"
            aria-label="Open files"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            {editors.map((tab) => (
              <EditorTabChip
                key={tab.id}
                tab={tab}
                active={tab.id === active.id}
                dirty={isDirty(tab, buffers, originals)}
              />
            ))}
          </div>
          {/* Only meaningful when there are terminals to share the row with. */}
          {hasTerminals ? (
            <HeaderButton
              label={maximized ? "Put back beside the terminals" : "Maximize"}
              onClick={() => setMaximized((value) => !value)}
            >
              {maximized ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </HeaderButton>
          ) : null}
          <HeaderButton
            label="Close all files"
            onClick={() => useWorkspace.getState().closeAllEditors()}
          >
            <X className="size-3.5" />
          </HeaderButton>
        </header>

        <PathBar
          tab={active}
          dirty={isDirty(active, buffers, originals)}
          truncated={Boolean(snapshot?.truncated && !snapshot.binary)}
          stats={active.kind === "diff" && diff ? diffStats(diff) : null}
        />

        <div className="relative min-h-0 flex-1">
          {snapshot?.binary ? (
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
            <DiffView id={active.id} />
          ) : (
            <CodeEditor id={active.id} rel={active.rel} />
          )}
        </div>
      </section>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="k-icon-btn size-7"
    >
      {children}
    </button>
  );
}

/**
 * A tab. The close button waits for hover — except on the tab you are on — and
 * an unsaved file shows a dot in its place until you reach for it.
 */
function EditorTabChip({
  tab,
  active,
  dirty,
}: {
  tab: EditorTab;
  active: boolean;
  dirty: boolean;
}) {
  const close = () => useWorkspace.getState().closeEditor(tab.id);

  return (
    <div
      role="tab"
      aria-selected={active}
      data-active={active}
      className="k-tab group/tab"
    >
      <button
        type="button"
        title={tab.kind === "diff" ? `Changes in ${tab.rel}` : tab.rel}
        onClick={() => useWorkspace.getState().setActiveEditor(tab.id)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          close();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {tab.kind === "diff" ? (
          <FileDiff aria-hidden className="size-3.5 shrink-0 text-faint" />
        ) : (
          <FileIcon name={tab.name} />
        )}
        <span className="min-w-0 truncate">{tab.name}</span>
      </button>

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
          aria-label={`Close ${tab.name}`}
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

/** Where the file lives, and the one fact about it worth knowing right now. */
function PathBar({
  tab,
  dirty,
  truncated,
  stats,
}: {
  tab: EditorTab;
  dirty: boolean;
  truncated: boolean;
  stats: { added: number; removed: number } | null;
}) {
  const segments = tab.rel.split("/");
  const shown =
    segments.length > 4 ? ["…", ...segments.slice(-4)] : segments;

  return (
    <div className="flex h-[30px] shrink-0 items-center gap-3 border-b border-[color:var(--keel-term-border)] px-3">
      <nav
        aria-label="Path"
        title={tab.rel}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[11.5px] text-faint"
      >
        {shown.map((segment, index) => {
          const last = index === shown.length - 1;
          return (
            <span
              key={`${index}:${segment}`}
              className={cn(
                "flex min-w-0 items-center gap-1",
                last ? "shrink" : "shrink-0",
              )}
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
        ) : dirty ? (
          <>
            <span className="text-faint">Unsaved</span>
            <button
              type="button"
              title="Save (Ctrl+S)"
              onClick={() => void useWorkspace.getState().saveTab(tab.id)}
              className="k-tag"
            >
              Save
            </button>
          </>
        ) : (
          <span className="text-faint">{languageName(tab.rel)}</span>
        )}
      </div>
    </div>
  );
}
