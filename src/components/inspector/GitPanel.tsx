/**
 * Git for the open project: what changed, the commit you are about to make, and
 * the branches, pull requests and history around it.
 *
 * Top to bottom in the order you reach for it. The branch comes first with the
 * sync buttons beside it, because "where am I, and am I behind" is the question
 * before any other; a count lights up on pull or push when there is something
 * to move. The message box stays put under that and everything below scrolls.
 *
 * Changes come in folding groups whose rows read like the left sidebar's — a
 * file glyph, the name, the folder it sits in, git's letter on a chip — with
 * open, discard and stage appearing on hover in place of the letter. Branches,
 * pull requests and history fold away until you want them.
 *
 * Click a change to read its diff beside the terminals; double-click opens the
 * file itself; right-click for the rest.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type HTMLAttributes,
  type ReactNode,
  type SetStateAction,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Copy,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
  GitPullRequestDraft,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { DockNotice } from "@/components/Dock";
import { Fold } from "@/components/Fold";
import { FileIcon } from "@/components/inspector/FileIcon";
import { GitLetter } from "@/components/inspector/GitLetter";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import {
  ContextMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  aheadBehind,
  fileName,
  groupGitFiles,
  parentRel,
  relativeTime,
} from "@/lib/git";
import { cn } from "@/lib/utils";
import type {
  GitBranches,
  GitCommit,
  GitFile,
  GitStatus,
  PrList,
  PullRequest,
} from "@/lib/workspace";
import { useWorkspace, type GitMetaSection } from "@/state/workspace";

type SectionId =
  | "conflict"
  | "staged"
  | "changes"
  | "untracked"
  | "branches"
  | "prs"
  | "history";

/** What you are about to commit is open; the reference material is folded. */
const INITIALLY_OPEN: Record<SectionId, boolean> = {
  conflict: true,
  staged: true,
  changes: true,
  untracked: true,
  branches: false,
  prs: false,
  history: false,
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

function discardPrompt(file: GitFile): string {
  const name = fileName(file.path);
  if (file.untracked && IS_WINDOWS) {
    return `Discard ${name}? It will be moved to the Recycle Bin.`;
  }
  return `Discard changes to ${name}? This can't be undone.`;
}

function pathsOf(files: GitFile[]): string[] {
  return files.map((file) => file.path);
}

function isControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, input") !== null;
}

/**
 * Dragging a change between groups: drop an unstaged file on Staged to stage
 * it, a staged one on Changes to unstage it.
 */
const DRAG_TYPE = "application/x-keel-change";

interface ChangeDrag {
  path: string;
  staged: boolean;
}

const ChangeDragContext = createContext<{
  drag: ChangeDrag | null;
  setDrag: (drag: ChangeDrag | null) => void;
  over: SectionId | null;
  setOver: Dispatch<SetStateAction<SectionId | null>>;
} | null>(null);

function dropActionFor(
  id: SectionId,
  drag: ChangeDrag | null,
): "stage" | "unstage" | null {
  if (!drag) return null;
  if (id === "staged") return drag.staged ? null : "stage";
  if (id === "changes" || id === "untracked") return drag.staged ? "unstage" : null;
  return null;
}

type ZoneProps = HTMLAttributes<HTMLElement> & { "data-drop"?: "true" | undefined };

export function GitPanel() {
  const root = useWorkspace((state) => state.root);
  const git = useWorkspace((state) => state.git);
  const gitLoading = useWorkspace((state) => state.gitLoading);
  const gitError = useWorkspace((state) => state.gitError);
  const branches = useWorkspace((state) => state.branches);
  const prs = useWorkspace((state) => state.prs);
  const commits = useWorkspace((state) => state.commits);
  const busy = useWorkspace((state) => state.busy);
  const [sections, setSections] = useState(INITIALLY_OPEN);
  const [focusBranchInput, setFocusBranchInput] = useState(0);
  const [drag, setDrag] = useState<ChangeDrag | null>(null);
  const [over, setOver] = useState<SectionId | null>(null);
  const branchesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void useWorkspace.getState().refreshGit();
  }, [root]);

  useEffect(() => {
    if (sections.branches) void useWorkspace.getState().refreshBranches();
  }, [root, sections.branches]);
  useEffect(() => {
    if (sections.prs) void useWorkspace.getState().refreshPrs();
  }, [root, sections.prs]);
  useEffect(() => {
    if (sections.history) void useWorkspace.getState().refreshHistory();
  }, [root, sections.history]);

  const groups = useMemo(() => groupGitFiles(git?.files ?? []), [git]);
  const stagedCount = groups.staged.length;
  const changeCount =
    groups.conflict.length +
    groups.staged.length +
    groups.unstaged.length +
    groups.untracked.length;

  if (!root) return null;

  if (!git && !gitError) {
    return <LoadingRows label="Loading Git" rows={9} />;
  }

  if (git && !git.git) {
    return (
      <DockNotice
        icon={GitBranch}
        title="Git isn't installed"
        detail="Install git and Keel will pick it up on its own."
        className="pt-10"
      />
    );
  }

  if (git && !git.repo) {
    return (
      <DockNotice
        icon={GitBranch}
        title="Not a git repository"
        detail="This project's folder isn't under version control."
        className="pt-10"
      />
    );
  }

  const toggle = (id: SectionId) =>
    setSections((previous) => ({ ...previous, [id]: !previous[id] }));

  const newBranch = () => {
    setSections((previous) => ({ ...previous, branches: true }));
    setFocusBranchInput((previous) => previous + 1);
    requestAnimationFrame(() =>
      branchesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

  const workspace = useWorkspace.getState;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BranchBar
        git={git}
        branches={branches}
        busy={busy}
        onNewBranch={newBranch}
      />
      <Composer
        git={git}
        busy={busy}
        stagedCount={stagedCount}
        changeCount={changeCount}
      />

      {gitError ? (
        <p className="mx-[var(--keel-inset)] mb-2 rounded-[var(--keel-r-control)] bg-[color:var(--keel-dead)]/10 px-2.5 py-2 text-[12px] leading-snug text-[color:var(--keel-dead)]">
          {gitError}
        </p>
      ) : null}

      {/* A soft fade instead of a rule where the list slides under the box. */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 pt-1 [mask-image:linear-gradient(to_bottom,transparent,black_10px)]">
        {!git ? (
          <p className="px-[calc(var(--keel-inset)+8px)] py-2 text-[12px] text-faint">
            {gitLoading ? "Reading git status…" : "Git status isn't available."}
          </p>
        ) : changeCount === 0 ? (
          <CleanTree git={git} />
        ) : (
          <ChangeDragContext.Provider value={{ drag, setDrag, over, setOver }}>
            <ChangeGroup
              id="conflict"
              title="Merge conflicts"
              files={groups.conflict}
              staged={false}
              open={sections.conflict}
              onToggle={toggle}
            />
            <ChangeGroup
              id="staged"
              title="Staged"
              files={groups.staged}
              staged
              open={sections.staged}
              onToggle={toggle}
              actions={
                <RowIcon
                  label="Unstage all"
                  onClick={() => void workspace().unstage(pathsOf(groups.staged))}
                >
                  <Minus className="size-3" />
                </RowIcon>
              }
            />
            <ChangeGroup
              id="changes"
              title="Changes"
              files={groups.unstaged}
              staged={false}
              open={sections.changes}
              onToggle={toggle}
              actions={
                <>
                  <RowIcon
                    label="Discard all changes"
                    danger
                    onClick={() => {
                      const count = groups.unstaged.length;
                      const ok = window.confirm(
                        `Discard changes to ${plural(count, "file")}? This can't be undone.`,
                      );
                      if (ok) void workspace().discard(pathsOf(groups.unstaged));
                    }}
                  >
                    <Undo2 className="size-3" />
                  </RowIcon>
                  <RowIcon
                    label="Stage all"
                    onClick={() => void workspace().stage(pathsOf(groups.unstaged))}
                  >
                    <Plus className="size-3" />
                  </RowIcon>
                </>
              }
            />
            <ChangeGroup
              id="untracked"
              title="Untracked"
              files={groups.untracked}
              staged={false}
              open={sections.untracked}
              onToggle={toggle}
              actions={
                <RowIcon
                  label="Stage all"
                  onClick={() => void workspace().stage(pathsOf(groups.untracked))}
                >
                  <Plus className="size-3" />
                </RowIcon>
              }
            />
          </ChangeDragContext.Provider>
        )}

        <div ref={branchesRef} className="scroll-mt-1">
          <Section
            id="branches"
            title="Branches"
            count={branches?.items.filter((item) => !item.remote).length}
            open={sections.branches}
            onToggle={toggle}
          >
            <MetaContent section="branches" loaded={branches !== null}>
              <BranchList branches={branches} busy={busy} focusKey={focusBranchInput} />
            </MetaContent>
          </Section>
        </div>
        <Section
          id="prs"
          title="Pull requests"
          count={prs?.available ? prs.items.length : undefined}
          open={sections.prs}
          onToggle={toggle}
        >
          <MetaContent section="prs" loaded={prs !== null}>
            <PullRequests prs={prs} busy={busy} />
          </MetaContent>
        </Section>
        <Section
          id="history"
          title="History"
          open={sections.history}
          onToggle={toggle}
        >
          <MetaContent section="history" loaded={commits !== null}>
            <History commits={commits ?? []} />
          </MetaContent>
        </Section>
      </div>
    </div>
  );
}

// ---- Branch and sync ------------------------------------------------------

function BranchBar({
  git,
  branches,
  busy,
  onNewBranch,
}: {
  git: GitStatus | null;
  branches: GitBranches | null;
  busy: boolean;
  onNewBranch: () => void;
}) {
  const current = git?.detached ? "Detached HEAD" : (git?.branch ?? "…");
  const ahead = git?.ahead ?? 0;
  const behind = git?.behind ?? 0;
  const published = Boolean(git?.upstream);
  const local = branches?.items.filter((item) => !item.remote) ?? [];
  const workspace = useWorkspace.getState;
  const branchesError = useWorkspace((state) => state.metaErrors.branches);

  return (
    <div className="flex shrink-0 items-center gap-1.5 px-[var(--keel-inset)] pb-2">
      <DropdownMenu modal={false} onOpenChange={(open) => {
        if (open) void workspace().refreshBranches();
      }}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={git?.upstream ? `${current} → ${git.upstream}` : current}
            className="k-field k-field-button min-w-0 flex-1"
          >
            <GitBranch aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-foreground">
              {current}
            </span>
            <ChevronDown aria-hidden className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-60"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuLabel>Switch branch</DropdownMenuLabel>
          {!branches ? (
            branchesError ? (
              <DropdownMenuItem onSelect={(event) => {
                event.preventDefault();
                void workspace().refreshBranches();
              }}>Couldn't load branches. Retry</DropdownMenuItem>
            ) : <LoadingRows label="Loading branches" rows={3} />
          ) : local.length === 0 ? (
            <DropdownMenuItem disabled>No local branches</DropdownMenuItem>
          ) : (
            local.map((item) => (
              <DropdownMenuItem
                key={item.name}
                disabled={busy}
                onSelect={() => {
                  if (!item.current) void workspace().checkout(item.name);
                }}
              >
                {item.current ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onNewBranch}>
            <GitBranchPlus className="size-3.5" />
            New branch…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="k-seg shrink-0">
        <SyncButton
          label={behind ? `Pull ${plural(behind, "commit")}` : "Pull"}
          count={behind}
          disabled={busy}
          onClick={() => void workspace().pull()}
        >
          <ArrowDown className="size-3.5" />
        </SyncButton>
        <SyncButton
          label={
            !published
              ? "Publish this branch"
              : ahead
                ? `Push ${plural(ahead, "commit")}`
                : "Push"
          }
          count={ahead}
          disabled={busy}
          onClick={() => void workspace().push()}
        >
          <ArrowUp className="size-3.5" />
        </SyncButton>
        <SyncButton
          label="Fetch"
          disabled={busy}
          onClick={() => void workspace().fetch()}
        >
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
        </SyncButton>
      </div>
    </div>
  );
}

function SyncButton({
  label,
  count = 0,
  disabled,
  onClick,
  children,
}: {
  label: string;
  count?: number;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Lit when there is something to move, so the direction reads at a glance.
      data-active={count > 0}
      disabled={disabled}
      onClick={onClick}
      className="k-seg-btn gap-1 px-[7px] disabled:opacity-40"
    >
      {children}
      {count ? <span className="text-[11px] tabular-nums">{count}</span> : null}
    </button>
  );
}

// ---- Commit ---------------------------------------------------------------

function Composer({
  git,
  busy,
  stagedCount,
  changeCount,
}: {
  git: GitStatus | null;
  busy: boolean;
  stagedCount: number;
  changeCount: number;
}) {
  const message = useWorkspace((state) => state.commitMessage);
  const setMessage = useWorkspace((state) => state.setCommitMessage);
  const commitAll = stagedCount === 0 && changeCount > 0;
  const canCommit = Boolean(message.trim()) && changeCount > 0 && !busy;
  const lines = message.split("\n").length;

  const summary =
    changeCount === 0
      ? "Nothing to commit"
      : commitAll
        ? `Commits all ${plural(changeCount, "change")}`
        : `${stagedCount} staged`;

  const commit = (andPush: boolean) => {
    if (canCommit) void useWorkspace.getState().commit(andPush);
  };

  return (
    <div className="shrink-0 px-[var(--keel-inset)] pb-2">
      <div className="k-composer">
        <textarea
          value={message}
          rows={Math.min(8, Math.max(2, lines))}
          spellCheck
          placeholder={git?.branch ? `Message for ${git.branch}` : "Commit message"}
          aria-label="Commit message"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit(event.shiftKey);
            }
          }}
        />
        <div className="flex items-center gap-2 pb-1.5 pl-2.5 pr-1.5">
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-faint"
            title="Ctrl+Enter commits, Ctrl+Shift+Enter commits and pushes"
          >
            {summary}
          </span>
          <div className="k-split" data-disabled={!canCommit}>
            <button
              type="button"
              title="Commit (Ctrl+Enter)"
              disabled={!canCommit}
              onClick={() => commit(false)}
              className="k-split-main"
            >
              <Check className="size-3.5" />
              {commitAll ? "Commit all" : "Commit"}
            </button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More ways to commit"
                  disabled={!canCommit}
                  className="k-split-more"
                >
                  <ChevronDown className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onSelect={() => commit(true)}>
                  <ArrowUp className="size-3.5" />
                  {commitAll ? "Commit all and push" : "Commit and push"}
                  <DropdownMenuShortcut>Ctrl+Shift+↵</DropdownMenuShortcut>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}

function CleanTree({ git }: { git: GitStatus }) {
  const sync = aheadBehind(git.ahead, git.behind);
  const detail = !git.upstream
    ? "This branch isn't published yet."
    : sync
      ? `${sync} · ${git.upstream}`
      : `Up to date with ${git.upstream}`;

  return (
    <div className="mx-[var(--keel-inset)] mb-2 mt-0.5 flex items-center gap-3 rounded-[var(--keel-r-control)] bg-veil px-3 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[color:var(--keel-done)]/12">
        <Check className="size-3.5 text-[color:var(--keel-done)]" />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-dim">No local changes</span>
        <span className="block truncate text-[11px] text-faint">{detail}</span>
      </span>
    </div>
  );
}

// ---- Sections and rows ----------------------------------------------------

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  actions,
  zone,
  children,
}: {
  id: SectionId;
  title: string;
  count?: number | undefined;
  open: boolean;
  onToggle: (id: SectionId) => void;
  actions?: ReactNode | undefined;
  /** Present while this section would take the change being dragged. */
  zone?: ZoneProps | undefined;
  children: ReactNode;
}) {
  return (
    <section {...zone} className={cn("pb-1", zone && "k-drop-zone")}>
      <div className="group/section flex h-7 items-center gap-1 px-[var(--keel-inset)]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(id)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--keel-r-chip)] pl-2 pr-1.5 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-faint transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          <span className="truncate text-[11px] font-medium text-faint transition-colors group-hover/section:text-dim">
            {title}
          </span>
          {count ? <span className="k-count">{count}</span> : null}
        </button>
        {actions ? (
          <span className="flex shrink-0 items-center gap-px opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/section:opacity-100">
            {actions}
          </span>
        ) : null}
      </div>
      <Fold open={open}>{children}</Fold>
    </section>
  );
}

function ChangeGroup({
  id,
  title,
  files,
  staged,
  open,
  onToggle,
  actions,
}: {
  id: SectionId;
  title: string;
  files: GitFile[];
  staged: boolean;
  open: boolean;
  onToggle: (id: SectionId) => void;
  actions?: ReactNode | undefined;
}) {
  const dnd = useContext(ChangeDragContext);

  // Rows that just arrived — staged, unstaged, newly changed — ease in, so a
  // file visibly moves between groups instead of blinking from one to the other.
  const seen = useRef<Set<string> | null>(null);
  const arrived = useMemo(() => {
    const before = seen.current;
    if (!before) return new Set<string>();
    return new Set(files.map((file) => file.path).filter((path) => !before.has(path)));
  }, [files]);
  useEffect(() => {
    seen.current = new Set(files.map((file) => file.path));
  }, [files]);

  const action = dropActionFor(id, dnd?.drag ?? null);
  // An empty Staged or Changes still shows up mid-drag, so there is somewhere to drop.
  const placeholder = files.length === 0 && action !== null && id !== "untracked";
  if (files.length === 0 && !placeholder) return null;

  const zone: ZoneProps | undefined =
    action && dnd
      ? {
          "data-drop": dnd.over === id ? "true" : undefined,
          onDragOver: (event) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dnd.over !== id) dnd.setOver(id);
          },
          onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            dnd.setOver((previous) => (previous === id ? null : previous));
          },
          onDrop: (event) => {
            event.preventDefault();
            const carried = dnd.drag;
            dnd.setDrag(null);
            dnd.setOver(null);
            if (!carried) return;
            const workspace = useWorkspace.getState();
            void (action === "stage"
              ? workspace.stage([carried.path])
              : workspace.unstage([carried.path]));
          },
        }
      : undefined;

  return (
    <Section
      id={id}
      title={title}
      count={files.length}
      open={open}
      onToggle={onToggle}
      actions={actions}
      zone={zone}
    >
      {placeholder ? (
        <div className="k-row h-[28px] justify-center text-[12px] text-faint">
          {action === "stage" ? "Drop to stage" : "Drop to unstage"}
        </div>
      ) : (
        files.map((file) => (
          <ChangeRow
            key={`${id}:${file.path}`}
            file={file}
            staged={staged}
            arrived={arrived.has(file.path)}
          />
        ))
      )}
    </Section>
  );
}

function changeMenu(file: GitFile, staged: boolean): MenuEntry[] {
  const state = useWorkspace.getState();
  const entries: MenuEntry[] = [
    {
      kind: "item",
      label: "Open changes",
      icon: FileDiff,
      onSelect: () => void state.openDiff(file.path, staged),
    },
    {
      kind: "item",
      label: "Open file",
      icon: FileText,
      disabled: file.status === "deleted",
      onSelect: () => void state.openFile(file.path),
    },
    { kind: "separator" },
    staged
      ? {
          kind: "item",
          label: "Unstage",
          icon: Minus,
          onSelect: () => void state.unstage([file.path]),
        }
      : {
          kind: "item",
          label: "Stage",
          icon: Plus,
          onSelect: () => void state.stage([file.path]),
        },
    {
      kind: "item",
      label: "Copy path",
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(file.path).catch(() => {}),
    },
  ];
  if (!file.conflict) {
    entries.push(
      { kind: "separator" },
      {
        kind: "item",
        label: "Discard changes",
        icon: Undo2,
        destructive: true,
        confirm:
          file.untracked && IS_WINDOWS
            ? "Discard? It will be moved to the Recycle Bin"
            : "Discard? This can't be undone",
        onSelect: () => void state.discard([file.path]),
      },
    );
  }
  return entries;
}

function ChangeRow({
  file,
  staged,
  arrived,
}: {
  file: GitFile;
  staged: boolean;
  arrived: boolean;
}) {
  const name = fileName(file.path);
  const parent = parentRel(file.path);
  const deleted = file.status === "deleted";
  const selected = useWorkspace((state) => state.selectedRel === file.path);
  const workspace = useWorkspace.getState;
  const dnd = useContext(ChangeDragContext);
  const dragging =
    dnd?.drag?.path === file.path && dnd.drag.staged === staged;

  const openDiff = () => {
    workspace().setSelected(file.path);
    void workspace().openDiff(file.path, staged);
  };
  const openFile = () => {
    if (!deleted) void workspace().openFile(file.path);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          data-selected={selected}
          data-motion={arrived ? "enter" : undefined}
          data-dragging={dragging ? "true" : undefined}
          // A conflict has to be resolved, not moved between groups.
          draggable={!file.conflict}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DRAG_TYPE, file.path);
            dnd?.setDrag({ path: file.path, staged });
          }}
          onDragEnd={() => {
            dnd?.setDrag(null);
            dnd?.setOver(null);
          }}
          className="k-row group/change h-[28px] gap-2"
          onClick={(event) => {
            if (!isControl(event.target)) openDiff();
          }}
          onDoubleClick={(event) => {
            if (!isControl(event.target)) openFile();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openDiff();
            }
          }}
        >
          <FileIcon name={name} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span
              className={cn(
                "max-w-full shrink-0 truncate",
                selected ? "text-foreground" : "text-dim",
                deleted && "line-through decoration-foreground/25",
              )}
            >
              {name}
            </span>
            {parent ? (
              <span className="min-w-0 truncate text-[11px] text-faint">{parent}</span>
            ) : null}
          </span>

          <span className="hidden shrink-0 items-center gap-px group-hover/change:flex group-focus-visible/change:flex">
            {deleted ? null : (
              <RowIcon label="Open file" onClick={openFile}>
                <FileText className="size-3" />
              </RowIcon>
            )}
            {file.conflict ? null : (
              <RowIcon
                label="Discard changes"
                danger
                onClick={() => {
                  const ok = window.confirm(discardPrompt(file));
                  if (ok) void workspace().discard([file.path]);
                }}
              >
                <Undo2 className="size-3" />
              </RowIcon>
            )}
            {staged ? (
              <RowIcon
                label="Unstage"
                onClick={() => void workspace().unstage([file.path])}
              >
                <Minus className="size-3" />
              </RowIcon>
            ) : (
              <RowIcon
                label="Stage"
                onClick={() => void workspace().stage([file.path])}
              >
                <Plus className="size-3" />
              </RowIcon>
            )}
          </span>
          <GitLetter
            status={file.status}
            className="group-hover/change:hidden group-focus-visible/change:hidden"
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={() => changeMenu(file, staged)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RowIcon({
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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="k-icon-btn size-[22px]"
    >
      {children}
    </button>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="px-[calc(var(--keel-inset)+8px)] pb-1.5 pt-0.5 text-[12px] leading-relaxed text-faint">
      {children}
    </p>
  );
}

const META_LABELS = { branches: "branches", prs: "pull requests", history: "history" };
const META_REFRESH = { branches: "refreshBranches", prs: "refreshPrs", history: "refreshHistory" } as const;

function MetaContent({ section, loaded, children }: {
  section: GitMetaSection;
  loaded: boolean;
  children: ReactNode;
}) {
  const error = useWorkspace((state) => state.metaErrors[section]);
  const loading = useWorkspace((state) => state.metaLoading[section]);
  if (!loaded && (!error || loading)) {
    return <LoadingRows label={`Loading ${META_LABELS[section]}`} />;
  }
  return <>
    {error ? <Hint>
      {error}{" "}
      <button type="button" disabled={loading} className="underline" onClick={() => {
        void useWorkspace.getState()[META_REFRESH[section]]();
      }}>Retry</button>
    </Hint> : null}
    {loaded ? children : null}
  </>;
}

// ---- Branches -------------------------------------------------------------

function BranchList({
  branches,
  busy,
  focusKey,
}: {
  branches: GitBranches | null;
  busy: boolean;
  /** Bumped by "New branch…" in the branch menu, to put the caret here. */
  focusKey: number;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const local = branches?.items.filter((item) => !item.remote) ?? [];
  const remote = branches?.items.filter((item) => item.remote) ?? [];
  const workspace = useWorkspace.getState;

  useEffect(() => {
    if (focusKey) inputRef.current?.focus();
  }, [focusKey]);

  const checkout = (name: string) => {
    if (!busy) void workspace().checkout(name);
  };

  return (
    <>
      <form
        className="px-[var(--keel-inset)] pb-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draft.trim();
          if (!name || busy) return;
          void workspace().createBranch(name, true);
          setDraft("");
        }}
      >
        <div className="k-field">
          <GitBranchPlus aria-hidden className="size-3.5 shrink-0" />
          <input
            ref={inputRef}
            value={draft}
            spellCheck={false}
            placeholder="New branch from here"
            aria-label="New branch name"
            // Branch names cannot hold spaces; turn them into the usual dash.
            onChange={(event) => setDraft(event.target.value.replace(/\s/g, "-"))}
          />
          {draft.trim() ? <kbd className="k-kbd">↵</kbd> : null}
        </div>
      </form>

      {local.map((item) => (
        <div
          key={item.name}
          role="button"
          tabIndex={0}
          aria-current={item.current || undefined}
          title={item.upstream ? `${item.name} → ${item.upstream}` : item.name}
          className="k-row group/branch h-[28px] gap-2"
          onClick={(event) => {
            if (!isControl(event.target) && !item.current) checkout(item.name);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if ((event.key === "Enter" || event.key === " ") && !item.current) {
              event.preventDefault();
              checkout(item.name);
            }
          }}
        >
          {item.current ? (
            <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />
          ) : (
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-faint" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              item.current ? "font-medium text-foreground" : "text-dim",
            )}
          >
            {item.name}
          </span>
          {item.current ? null : (
            <span className="hidden shrink-0 group-hover/branch:flex group-focus-visible/branch:flex">
              <RowIcon
                label="Delete branch"
                danger
                onClick={() => {
                  const ok = window.confirm(`Delete the branch ${item.name}?`);
                  if (ok) void workspace().deleteBranch(item.name);
                }}
              >
                <Trash2 className="size-3" />
              </RowIcon>
            </span>
          )}
        </div>
      ))}

      {remote.length > 0 ? (
        <>
          <p className="px-[calc(var(--keel-inset)+8px)] pb-0.5 pt-2 text-[11px] text-faint">
            Remote
          </p>
          {remote.map((item) => (
            <div
              key={item.name}
              role="button"
              tabIndex={0}
              title={`Check out ${item.name}`}
              className="k-row h-[28px] gap-2"
              onClick={() => checkout(item.name)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  checkout(item.name);
                }
              }}
            >
              <CloudDownload aria-hidden className="size-3.5 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-dim">{item.name}</span>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

// ---- Pull requests --------------------------------------------------------

function PullRequests({ prs, busy }: { prs: PrList | null; busy: boolean }) {
  const [composing, setComposing] = useState(false);

  if (!prs) return <Hint>Loading pull requests…</Hint>;
  if (!prs.available) {
    return (
      <Hint>
        {prs.error ?? "Install the GitHub CLI (gh) to see and open pull requests."}
      </Hint>
    );
  }

  return (
    <>
      {prs.error ? <Hint>{prs.error}</Hint> : null}
      {prs.items.length === 0 && !composing ? (
        <Hint>No open pull requests.</Hint>
      ) : null}
      {prs.items.map((pr) => (
        <PrRow key={pr.number} pr={pr} busy={busy} />
      ))}
      {composing ? (
        <PrForm busy={busy} onDone={() => setComposing(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="k-row h-[28px] gap-2 text-faint hover:text-dim"
        >
          <Plus aria-hidden className="size-3.5 shrink-0" />
          New pull request
        </button>
      )}
    </>
  );
}

function PrRow({ pr, busy }: { pr: PullRequest; busy: boolean }) {
  const Icon = pr.draft ? GitPullRequestDraft : GitPullRequest;
  const checkout = () => {
    if (!busy) void useWorkspace.getState().checkoutPr(pr.number);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      title={`Check out #${pr.number}`}
      className="k-row group/pr h-auto items-start gap-2 py-1.5"
      onClick={(event) => {
        if (!isControl(event.target)) checkout();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          checkout();
        }
      }}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-[3px] size-3.5 shrink-0",
          pr.draft ? "text-faint" : "text-[color:var(--keel-done)]",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5 text-dim">{pr.title}</span>
        <span className="block truncate text-[11px] leading-4 text-faint">
          <span className="tabular-nums">#{pr.number}</span> · {pr.head} → {pr.base}
        </span>
      </span>
      <span className="hidden shrink-0 group-hover/pr:flex group-focus-visible/pr:flex">
        <RowIcon
          label="Open on GitHub"
          onClick={() => void openUrl(pr.url).catch(() => {})}
        >
          <ExternalLink className="size-3" />
        </RowIcon>
      </span>
    </div>
  );
}

function PrForm({ busy, onDone }: { busy: boolean; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);

  return (
    <form
      className="flex flex-col gap-1.5 px-[var(--keel-inset)] pb-1 pt-0.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || busy) return;
        void useWorkspace.getState().createPr({
          title: title.trim(),
          body,
          base: base.trim() || null,
          draft,
        });
        onDone();
      }}
    >
      <div className="k-field">
        <input
          autoFocus
          value={title}
          placeholder="Title"
          aria-label="Pull request title"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="k-composer">
        <textarea
          rows={3}
          value={body}
          placeholder="Description"
          aria-label="Pull request description"
          onChange={(event) => setBody(event.target.value)}
          className="pb-2"
        />
      </div>
      <div className="k-field">
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <input
          value={base}
          spellCheck={false}
          placeholder="Base branch (default)"
          aria-label="Base branch"
          onChange={(event) => setBase(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <div className="k-seg">
          <button
            type="button"
            data-active={!draft}
            onClick={() => setDraft(false)}
            className="k-seg-btn"
          >
            Ready
          </button>
          <button
            type="button"
            data-active={draft}
            onClick={() => setDraft(true)}
            className="k-seg-btn"
          >
            Draft
          </button>
        </div>
        <span className="flex-1" />
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={busy || !title.trim()}>
          Open
        </Button>
      </div>
    </form>
  );
}

// ---- History --------------------------------------------------------------

function History({ commits }: { commits: GitCommit[] }) {
  if (commits.length === 0) return <Hint>No commits yet.</Hint>;

  return (
    <>
      {commits.map((commit) => (
        <div
          key={commit.hash}
          role="button"
          tabIndex={0}
          title={`${commit.subject}\n\n${commit.hash}\nClick to copy the hash`}
          className="k-row h-auto items-start gap-2.5 py-1.5"
          onClick={() => {
            void navigator.clipboard
              .writeText(commit.hash)
              .then(() => toast.success(`Copied ${commit.short}`))
              .catch(() => {});
          }}
        >
          <span className="k-hash mt-px">{commit.short}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate leading-5 text-dim">{commit.subject}</span>
            <span className="block truncate text-[11px] leading-4 text-faint">
              {commit.author}
              {commit.timestamp ? ` · ${relativeTime(commit.timestamp)}` : ""}
            </span>
          </span>
        </div>
      ))}
    </>
  );
}
