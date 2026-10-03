/**
 * What has changed, and the commit you are about to make of it.
 *
 * The message box sits on top and stays put; under it the changes come in
 * folding groups — conflicts, staged, changes, untracked — as a flat list or
 * as folders. A row reads like the file tree's: the file's glyph, its name,
 * the folder it sits in, how many lines moved, and git's letter on a chip.
 *
 * Click a change to read its diff; ctrl-click and shift-click gather several,
 * and a bar rises with what you can do to all of them at once. Drag rows
 * between Staged and Changes to stage or unstage them. Right-click for the
 * rest.
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
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  EyeOff,
  FileDiff,
  FileText,
  Files,
  Filter,
  FolderClosed,
  FolderOpen,
  FolderTree,
  GitCommitHorizontal,
  List,
  Minus,
  Plus,
  Settings2,
  Undo2,
  X,
} from "lucide-react";

import { FileIcon } from "@/components/inspector/FileIcon";
import { GitLetter } from "@/components/inspector/GitLetter";
import {
  ContextMenuEntries,
  DropdownMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  aheadBehind,
  buildChangeTree,
  fileName,
  groupGitFiles,
  parentRel,
  subjectLength,
  type ChangeNode,
} from "@/lib/git";
import { cn } from "@/lib/utils";
import { ask } from "@/lib/ask";
import type { GitFile, GitStatus } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

import {
  copy,
  FilterField,
  IS_WINDOWS,
  isControl,
  plural,
  RowIcon,
  Section,
  Stat,
  usePrompt,
} from "./shared";

const workspace = useWorkspace.getState;

type GroupId = "conflict" | "staged" | "changes" | "untracked";

const GROUP_TITLES: Record<GroupId, string> = {
  conflict: "Merge conflicts",
  staged: "Staged",
  changes: "Changes",
  untracked: "Untracked",
};

const GROUP_ORDER: GroupId[] = ["conflict", "staged", "changes", "untracked"];

/** A row's identity: the same file can sit in Staged and in Changes at once. */
const keyOf = (group: GroupId, path: string) => `${group}:${path}`;

function parseKey(key: string): { group: GroupId; path: string } {
  const at = key.indexOf(":");
  return { group: key.slice(0, at) as GroupId, path: key.slice(at + 1) };
}

function pathsOf(files: GitFile[]): string[] {
  return files.map((file) => file.path);
}

function discardWarning(files: GitFile[]): string {
  if (files.length === 1 && files[0]) {
    const file = files[0];
    if (file.untracked && IS_WINDOWS) {
      return `Discard ${fileName(file.path)}? It will be moved to the Recycle Bin.`;
    }
    return `Discard changes to ${fileName(file.path)}? This can't be undone.`;
  }
  const untracked = files.some((file) => file.untracked);
  return `Discard changes to ${plural(files.length, "file")}? ${
    untracked && IS_WINDOWS ? "New files go to the Recycle Bin; the rest can't be undone." : "This can't be undone."
  }`;
}

async function confirmDiscard(files: GitFile[]) {
  const safe = files.filter((file) => !file.conflict);
  if (safe.length === 0) return;
  const ok = await ask(discardWarning(safe), {
    title: "Discard changes?",
    confirm: "Discard",
    destructive: true,
  });
  if (ok) void workspace().discard(pathsOf(safe));
}

/** Rows in the order they are on screen, so shift-click selects what you see. */
function flatten(nodes: ChangeNode[], out: GitFile[] = []): GitFile[] {
  for (const node of nodes) {
    if (node.kind === "file") out.push(node.file);
    else flatten(node.children, out);
  }
  return out;
}

// ---- Dragging between groups --------------------------------------------------

const DRAG_TYPE = "application/x-keel-change";

interface ChangeDrag {
  paths: string[];
  staged: boolean;
}

interface PanelContext {
  selection: Set<string>;
  onRowClick: (group: GroupId, file: GitFile, event: MouseEvent) => void;
  drag: ChangeDrag | null;
  setDrag: (drag: ChangeDrag | null) => void;
  over: GroupId | null;
  setOver: Dispatch<SetStateAction<GroupId | null>>;
  collapsed: Set<string>;
  toggleFolder: (key: string) => void;
  /** Every selected file, for a menu opened on one of them. */
  selectedFiles: () => { group: GroupId; file: GitFile }[];
}

const Panel = createContext<PanelContext | null>(null);

function dropActionFor(group: GroupId, drag: ChangeDrag | null): "stage" | "unstage" | null {
  if (!drag) return null;
  if (group === "staged") return drag.staged ? null : "stage";
  if (group === "changes" || group === "untracked") return drag.staged ? "unstage" : null;
  return null;
}

// ---- The page ---------------------------------------------------------------

export function ChangesView({ git, busy }: { git: GitStatus; busy: boolean }) {
  const layout = useWorkspace((state) => state.changeLayout);
  const prompt = usePrompt();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<GroupId, boolean>>({
    conflict: true,
    staged: true,
    changes: true,
    untracked: true,
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [drag, setDrag] = useState<ChangeDrag | null>(null);
  const [over, setOver] = useState<GroupId | null>(null);

  const all = useMemo(() => groupGitFiles(git.files), [git]);
  const byGroup = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const keep = (files: GitFile[]) =>
      needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
    return {
      conflict: keep(all.conflict),
      staged: keep(all.staged),
      changes: keep(all.unstaged),
      untracked: keep(all.untracked),
    } satisfies Record<GroupId, GitFile[]>;
  }, [all, filter]);
  const trees = useMemo(
    () =>
      layout === "tree"
        ? Object.fromEntries(GROUP_ORDER.map((id) => [id, buildChangeTree(byGroup[id])]))
        : null,
    [byGroup, layout],
  ) as Record<GroupId, ChangeNode[]> | null;
  const order = useMemo(
    () =>
      Object.fromEntries(
        GROUP_ORDER.map((id) => [id, trees ? flatten(trees[id]) : byGroup[id]]),
      ) as Record<GroupId, GitFile[]>,
    [byGroup, trees],
  );

  const total =
    all.conflict.length + all.staged.length + all.unstaged.length + all.untracked.length;

  // A row that left its group drops out of the selection with it.
  useEffect(() => {
    setSelection((previous) => {
      if (previous.size === 0) return previous;
      const present = new Set(
        GROUP_ORDER.flatMap((id) => order[id].map((file) => keyOf(id, file.path))),
      );
      const next = new Set([...previous].filter((key) => present.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [order]);

  const fileFor = (key: string) => {
    const { group, path } = parseKey(key);
    const file = order[group].find((item) => item.path === path);
    return file ? { group, file } : null;
  };

  const context: PanelContext = {
    selection,
    drag,
    setDrag,
    over,
    setOver,
    collapsed,
    toggleFolder: (key) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    selectedFiles: () =>
      [...selection].map(fileFor).filter((item): item is NonNullable<typeof item> => item !== null),
    onRowClick: (group, file, event) => {
      const key = keyOf(group, file.path);
      if (event.shiftKey && anchor.current && parseKey(anchor.current).group === group) {
        const files = order[group];
        const from = files.findIndex((item) => item.path === parseKey(anchor.current!).path);
        const to = files.findIndex((item) => item.path === file.path);
        const [start, end] = from < to ? [from, to] : [to, from];
        const range = files.slice(start, end + 1).map((item) => keyOf(group, item.path));
        setSelection((previous) =>
          new Set(event.ctrlKey || event.metaKey ? [...previous, ...range] : range),
        );
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        anchor.current = key;
        setSelection((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }
      anchor.current = key;
      setSelection(new Set([key]));
      workspace().setSelected(file.path);
      void workspace().openDiff(file.path, group === "staged");
    },
  };

  const groupActions = (id: GroupId): ReactNode => {
    const files = byGroup[id];
    switch (id) {
      case "conflict":
        return (
          <RowIcon label="Mark all resolved" onClick={() => void workspace().stage(pathsOf(files))}>
            <Check className="size-3" />
          </RowIcon>
        );
      case "staged":
        return (
          <RowIcon label="Unstage all" onClick={() => void workspace().unstage(pathsOf(files))}>
            <Minus className="size-3" />
          </RowIcon>
        );
      case "changes":
      case "untracked":
        return (
          <>
            <RowIcon label="Discard all" danger onClick={() => confirmDiscard(files)}>
              <Undo2 className="size-3" />
            </RowIcon>
            <RowIcon label="Stage all" onClick={() => void workspace().stage(pathsOf(files))}>
              <Plus className="size-3" />
            </RowIcon>
          </>
        );
    }
  };

  const selected = context.selectedFiles();

  return (
    <Panel.Provider value={context}>
      <Composer git={git} busy={busy} total={total} staged={all.staged.length} />
      {total === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CleanTree git={git} busy={busy} />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 px-[var(--keel-inset)] pb-1.5">
            <FilterField
              value={filter}
              onChange={setFilter}
              placeholder="Filter changes"
              icon={Filter}
            />
            <div className="k-seg shrink-0 p-[2px]">
              <button
                type="button"
                title="As a list"
                aria-label="As a list"
                data-active={layout === "list"}
                onClick={() => workspace().setChangeLayout("list")}
                className="k-seg-btn h-[20px] px-1.5"
              >
                <List className="size-3.5" />
              </button>
              <button
                type="button"
                title="As folders"
                aria-label="As folders"
                data-active={layout === "tree"}
                onClick={() => workspace().setChangeLayout("tree")}
                className="k-seg-btn h-[20px] px-1.5"
              >
                <FolderTree className="size-3.5" />
              </button>
            </div>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More change actions"
                  title="More"
                  className="k-icon-btn size-[26px]"
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-52">
                <DropdownMenuEntries
                  entries={() => [
                    {
                      kind: "item",
                      label: "Stage everything",
                      icon: Plus,
                      disabled: busy || all.unstaged.length + all.untracked.length === 0,
                      onSelect: () =>
                        void workspace().stage(pathsOf([...all.unstaged, ...all.untracked])),
                    },
                    {
                      kind: "item",
                      label: "Unstage everything",
                      icon: Minus,
                      disabled: busy || all.staged.length === 0,
                      onSelect: () => void workspace().unstage(pathsOf(all.staged)),
                    },
                    {
                      kind: "item",
                      label: "Stash everything…",
                      icon: Archive,
                      disabled: busy,
                      onSelect: () =>
                        prompt({
                          title: "Stash changes",
                          detail: `Sets aside ${plural(total, "change")}, untracked files included.`,
                          confirm: "Stash",
                          fields: [{ key: "message", label: "Message", optional: true, placeholder: "What you were in the middle of" }],
                          onSubmit: ({ message }) =>
                            void workspace().stashPush({ message: message ?? null, includeUntracked: true }),
                        }),
                    },
                    { kind: "separator" },
                    ...(layout === "tree"
                      ? [
                          { kind: "item" as const, label: "Expand all folders", icon: FolderOpen, onSelect: () => setCollapsed(new Set()) },
                          {
                            kind: "item" as const,
                            label: "Collapse all folders",
                            icon: FolderClosed,
                            onSelect: () =>
                              setCollapsed(
                                new Set(
                                  GROUP_ORDER.flatMap((id) =>
                                    folderKeys(trees?.[id] ?? []).map((path) => keyOf(id, path)),
                                  ),
                                ),
                              ),
                          },
                          { kind: "separator" as const },
                        ]
                      : []),
                    {
                      kind: "item",
                      label: "Discard everything",
                      icon: Undo2,
                      destructive: true,
                      disabled: busy,
                      confirm: "Discard every change? This can't be undone",
                      onSelect: () =>
                        void workspace().discard(
                          pathsOf(git.files.filter((file) => !file.conflict)),
                        ),
                    },
                  ]}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto pb-3 [mask-image:linear-gradient(to_bottom,transparent,black_8px)]"
            onKeyDown={(event) => {
              if (event.key === "Escape" && selection.size > 0) {
                event.stopPropagation();
                setSelection(new Set());
              }
              if ((event.key === "a" || event.key === "A") && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                setSelection(
                  new Set(GROUP_ORDER.flatMap((id) => order[id].map((file) => keyOf(id, file.path)))),
                );
              }
            }}
          >
            <div className="pt-1" />
            {GROUP_ORDER.map((id) => (
              <ChangeGroup
                key={id}
                id={id}
                files={byGroup[id]}
                tree={trees?.[id] ?? null}
                open={open[id]}
                onToggle={() => setOpen((previous) => ({ ...previous, [id]: !previous[id] }))}
                actions={groupActions(id)}
              />
            ))}
            {filter && GROUP_ORDER.every((id) => byGroup[id].length === 0) ? (
              <p className="px-[calc(var(--keel-inset)+8px)] py-2 text-body text-faint">
                No changes match “{filter}”.
              </p>
            ) : null}
            {selected.length > 1 ? (
              <SelectionBar items={selected} onClear={() => setSelection(new Set())} />
            ) : null}
          </div>
        </>
      )}
    </Panel.Provider>
  );
}

function folderKeys(nodes: ChangeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === "folder") {
      out.push(node.path);
      folderKeys(node.children, out);
    }
  }
  return out;
}

// ---- Commit box ---------------------------------------------------------------

function Composer({
  git,
  busy,
  total,
  staged,
}: {
  git: GitStatus;
  busy: boolean;
  total: number;
  staged: number;
}) {
  const message = useWorkspace((state) => state.commitMessage);
  const options = useWorkspace((state) => state.commitOptions);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const conflicts = git.files.filter((file) => file.conflict).length;
  const committable = total - conflicts;
  const commitAll = staged === 0 && committable > 0 && !options.amend;
  // Git refuses to commit with conflicts outstanding, so the button does too.
  const canCommit =
    Boolean(message.trim()) &&
    !busy &&
    conflicts === 0 &&
    (options.amend ? Boolean(git.head) : staged > 0 || committable > 0);
  const lines = message.split("\n").length;
  const subject = subjectLength(message);

  const summary = conflicts
    ? `Resolve ${plural(conflicts, "conflict")} first`
    : options.amend
    ? staged > 0
      ? `Amends ${git.head ?? "HEAD"} with ${staged} staged`
      : `Rewords ${git.head ?? "HEAD"}`
    : total === 0
      ? "Nothing to commit"
      : commitAll
        ? `Commits all ${plural(committable, "change")}`
        : `${staged} staged`;

  const commit = (andPush: boolean) => {
    if (canCommit) void workspace().commit(andPush);
  };

  const verb = options.amend ? "Amend" : commitAll ? "Commit all" : "Commit";

  return (
    <div className="shrink-0 px-[var(--keel-inset)] pb-2">
      <div className="k-composer">
        <textarea
          ref={area}
          value={message}
          rows={Math.min(8, Math.max(2, lines))}
          spellCheck
          placeholder={
            options.amend
              ? "New message for the last commit"
              : git.branch
                ? `Message for ${git.branch}`
                : "Commit message"
          }
          aria-label="Commit message"
          onChange={(event) => workspace().setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit(event.shiftKey);
            }
          }}
        />
        {options.amend || options.signoff || options.noVerify ? (
          <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
            {options.amend ? (
              <OptionChip label="Amending" onClear={() => workspace().setCommitOption("amend", false)} />
            ) : null}
            {options.signoff ? (
              <OptionChip label="Signed off" onClear={() => workspace().setCommitOption("signoff", false)} />
            ) : null}
            {options.noVerify ? (
              <OptionChip label="No hooks" onClear={() => workspace().setCommitOption("noVerify", false)} />
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 pb-1.5 pl-1.5 pr-1.5">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Commit options"
                title="Commit options"
                className="k-icon-btn size-[24px]"
              >
                <Settings2 className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-auto min-w-60">
              <DropdownMenuEntries
                entries={[
                  { kind: "label", label: "This commit" },
                  {
                    kind: "check",
                    label: "Amend the last commit",
                    checked: options.amend,
                    disabled: !git.head,
                    onChange: (on) => workspace().setCommitOption("amend", on),
                  },
                  { kind: "separator" },
                  { kind: "label", label: "Every commit" },
                  {
                    kind: "check",
                    label: "Add Signed-off-by",
                    checked: options.signoff,
                    onChange: (on) => workspace().setCommitOption("signoff", on),
                  },
                  {
                    kind: "check",
                    label: "Skip hooks (--no-verify)",
                    checked: options.noVerify,
                    onChange: (on) => workspace().setCommitOption("noVerify", on),
                  },
                ]}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <span
            className="min-w-0 flex-1 truncate text-small text-faint"
            title="Ctrl+Enter commits, Ctrl+Shift+Enter commits and pushes"
          >
            {summary}
          </span>
          {subject.length > 0 ? (
            <span
              className="k-meter shrink-0 text-small"
              data-level={subject.level}
              title={
                subject.level === "ok"
                  ? "Subject length"
                  : subject.level === "long"
                    ? "Subjects read best under 50 characters"
                    : "Past 72 characters, the subject gets cut off in most tools"
              }
            >
              {subject.length}
            </span>
          ) : null}
          <div className="k-split" data-disabled={!canCommit}>
            <button
              type="button"
              title={`${verb} (Ctrl+Enter)`}
              disabled={!canCommit}
              onClick={() => commit(false)}
              className="k-split-main"
            >
              <Check className="size-3.5" />
              {verb}
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
              <DropdownMenuContent align="end" className="w-auto min-w-56">
                <DropdownMenuItem onSelect={() => commit(true)}>
                  <ArrowUp className="size-3.5" />
                  {verb} and push
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

function OptionChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="k-tag gap-1 pr-1">
      {label}
      <button
        type="button"
        aria-label={`Turn off ${label.toLowerCase()}`}
        onClick={onClear}
        className="grid size-3.5 place-items-center rounded-[3px] hover:bg-veil-3"
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

function CleanTree({ git, busy }: { git: GitStatus; busy: boolean }) {
  const sync = aheadBehind(git.ahead, git.behind);
  const detail = !git.head
    ? "Nothing has been committed yet."
    : !git.upstream
      ? "This branch isn't published yet."
      : sync
        ? `${sync} · ${git.upstream}`
        : `Up to date with ${git.upstream}`;
  const stashes = git.stashes ?? 0;

  return (
    <div className="flex flex-col gap-1.5 px-[var(--keel-inset)] pt-0.5">
      <div className="flex items-center gap-3 rounded-[var(--keel-r-control)] bg-veil px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[color:var(--keel-done)]/12">
          <Check className="size-3.5 text-[color:var(--keel-done)]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body text-dim">No local changes</span>
          <span className="block truncate text-small text-faint">{detail}</span>
        </span>
        {git.head && !git.detached && git.hasRemote !== false && (!git.upstream || git.ahead > 0) ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void workspace().push()}
            className="k-tag shrink-0 gap-1 disabled:opacity-40"
          >
            <ArrowUp className="size-3" />
            {git.upstream ? "Push" : "Publish"}
          </button>
        ) : null}
      </div>
      {stashes > 0 ? (
        <button
          type="button"
          onClick={() => workspace().setGitView("stashes")}
          className="flex items-center gap-2.5 rounded-[var(--keel-r-control)] px-3 py-2 text-left text-body text-faint hover:bg-veil hover:text-dim"
        >
          <Archive aria-hidden className="size-3.5 shrink-0" />
          {plural(stashes, "stash", "stashes")} set aside
        </button>
      ) : null}
      {git.head ? (
        <button
          type="button"
          onClick={() => workspace().setGitView("history")}
          className="flex items-center gap-2.5 rounded-[var(--keel-r-control)] px-3 py-2 text-left text-body text-faint hover:bg-veil hover:text-dim"
        >
          <GitCommitHorizontal aria-hidden className="size-3.5 shrink-0" />
          See the history of {git.branch ?? "this commit"}
        </button>
      ) : null}
    </div>
  );
}

// ---- Groups and rows ----------------------------------------------------------

type ZoneProps = HTMLAttributes<HTMLElement> & { "data-drop"?: "true" | undefined };

function ChangeGroup({
  id,
  files,
  tree,
  open,
  onToggle,
  actions,
}: {
  id: GroupId;
  files: GitFile[];
  tree: ChangeNode[] | null;
  open: boolean;
  onToggle: () => void;
  actions: ReactNode;
}) {
  const panel = useContext(Panel);

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

  const action = dropActionFor(id, panel?.drag ?? null);
  // An empty Staged or Changes still shows up mid-drag, so there is somewhere to drop.
  const placeholder = files.length === 0 && action !== null && id !== "untracked";
  if (files.length === 0 && !placeholder) return null;

  const zone: ZoneProps | undefined =
    action && panel
      ? {
          "data-drop": panel.over === id ? "true" : undefined,
          onDragOver: (event) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (panel.over !== id) panel.setOver(id);
          },
          onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            panel.setOver((previous) => (previous === id ? null : previous));
          },
          onDrop: (event) => {
            event.preventDefault();
            const carried = panel.drag;
            panel.setDrag(null);
            panel.setOver(null);
            if (!carried) return;
            void (action === "stage"
              ? workspace().stage(carried.paths)
              : workspace().unstage(carried.paths));
          },
        }
      : undefined;

  return (
    <Section
      title={GROUP_TITLES[id]}
      count={files.length}
      open={open}
      onToggle={onToggle}
      actions={actions}
      zone={zone}
    >
      {placeholder ? (
        <div className="k-row k-row-dense justify-center text-body text-faint">
          {action === "stage" ? "Drop to stage" : "Drop to unstage"}
        </div>
      ) : tree ? (
        <TreeRows group={id} nodes={tree} depth={0} arrived={arrived} />
      ) : (
        files.map((file) => (
          <ChangeRow
            key={file.path}
            group={id}
            file={file}
            depth={0}
            showFolder
            arrived={arrived.has(file.path)}
          />
        ))
      )}
    </Section>
  );
}

function TreeRows({
  group,
  nodes,
  depth,
  arrived,
}: {
  group: GroupId;
  nodes: ChangeNode[];
  depth: number;
  arrived: Set<string>;
}) {
  const panel = useContext(Panel);
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return (
            <ChangeRow
              key={node.file.path}
              group={group}
              file={node.file}
              depth={depth}
              showFolder={false}
              arrived={arrived.has(node.file.path)}
            />
          );
        }
        const key = keyOf(group, node.path);
        const shut = panel?.collapsed.has(key) ?? false;
        return (
          <div key={node.path}>
            <FolderRow
              group={group}
              name={node.name}
              path={node.path}
              files={node.files}
              depth={depth}
              open={!shut}
              onToggle={() => panel?.toggleFolder(key)}
            />
            {shut ? null : (
              <TreeRows group={group} nodes={node.children} depth={depth + 1} arrived={arrived} />
            )}
          </div>
        );
      })}
    </>
  );
}

const indent = (depth: number) => ({ ["--row-indent" as string]: `${depth * 12}px` });

function FolderRow({
  group,
  name,
  path,
  files,
  depth,
  open,
  onToggle,
}: {
  group: GroupId;
  name: string;
  path: string;
  files: GitFile[];
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          title={path}
          aria-expanded={open}
          style={indent(depth)}
          className="k-row group/change k-row-dense gap-1.5"
          onClick={(event) => {
            if (!isControl(event.target)) onToggle();
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle();
            }
          }}
        >
          <ChevronRight
            aria-hidden
            className={cn("size-3 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")}
          />
          {open ? (
            <FolderOpen aria-hidden className="size-3.5 shrink-0 text-faint" />
          ) : (
            <FolderClosed aria-hidden className="size-3.5 shrink-0 text-faint" />
          )}
          <span className="min-w-0 flex-1 truncate text-dim">{name}</span>
          <span className="hidden shrink-0 items-center gap-px group-hover/change:flex group-focus-visible/change:flex">
            <FileActions group={group} files={files} />
          </span>
          <span className="k-count group-hover/change:hidden group-focus-visible/change:hidden">
            {files.length}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries entries={() => bulkMenu(files.map((file) => ({ group, file })))} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The hover buttons for one file or a whole folder of them. */
function FileActions({ group, files }: { group: GroupId; files: GitFile[] }) {
  const one = files.length === 1 ? files[0] : undefined;
  const label = (verb: string) => (one ? verb : `${verb} folder`);
  return (
    <>
      {one && one.status !== "deleted" ? (
        <RowIcon label="Open file" onClick={() => void workspace().openFile(one.path)}>
          <FileText className="size-3" />
        </RowIcon>
      ) : null}
      {group === "conflict" ? (
        <RowIcon label="Mark resolved" onClick={() => void workspace().stage(pathsOf(files))}>
          <Check className="size-3" />
        </RowIcon>
      ) : (
        <>
          <RowIcon label={label("Discard")} danger onClick={() => confirmDiscard(files)}>
            <Undo2 className="size-3" />
          </RowIcon>
          {group === "staged" ? (
            <RowIcon label={label("Unstage")} onClick={() => void workspace().unstage(pathsOf(files))}>
              <Minus className="size-3" />
            </RowIcon>
          ) : (
            <RowIcon label={label("Stage")} onClick={() => void workspace().stage(pathsOf(files))}>
              <Plus className="size-3" />
            </RowIcon>
          )}
        </>
      )}
    </>
  );
}

function ChangeRow({
  group,
  file,
  depth,
  showFolder,
  arrived,
}: {
  group: GroupId;
  file: GitFile;
  depth: number;
  showFolder: boolean;
  arrived: boolean;
}) {
  const panel = useContext(Panel);
  const name = fileName(file.path);
  const parent = parentRel(file.path);
  const deleted = file.status === "deleted";
  const key = keyOf(group, file.path);
  const picked = panel?.selection.has(key) ?? false;
  const many = (panel?.selection.size ?? 0) > 1;
  const dragging =
    panel?.drag?.paths.includes(file.path) === true && panel.drag.staged === (group === "staged");
  const stat = group === "staged" ? file.stagedStat : file.stat;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
          aria-pressed={picked}
          data-selected={picked}
          data-motion={arrived ? "enter" : undefined}
          data-dragging={dragging ? "true" : undefined}
          style={indent(depth)}
          // A conflict has to be resolved, not moved between groups.
          draggable={group !== "conflict"}
          onDragStart={(event) => {
            // Carrying a selected row carries the whole selection with it.
            const carried =
              picked && many
                ? panel!
                    .selectedFiles()
                    .filter((item) => (item.group === "staged") === (group === "staged"))
                    .map((item) => item.file.path)
                : [file.path];
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DRAG_TYPE, carried.join("\n"));
            panel?.setDrag({ paths: carried, staged: group === "staged" });
          }}
          onDragEnd={() => {
            panel?.setDrag(null);
            panel?.setOver(null);
          }}
          className="k-row group/change k-row-dense gap-2"
          onClick={(event) => {
            if (!isControl(event.target)) panel?.onRowClick(group, file, event);
          }}
          onDoubleClick={(event) => {
            if (!isControl(event.target) && !deleted) void workspace().openFile(file.path);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              workspace().setSelected(file.path);
              void workspace().openDiff(file.path, group === "staged");
            }
          }}
        >
          <FileIcon name={name} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span
              className={cn(
                "max-w-full shrink-0 truncate",
                picked ? "text-foreground" : "text-dim",
                deleted && "line-through decoration-foreground/25",
              )}
            >
              {name}
            </span>
            {showFolder && parent ? (
              <span className="min-w-0 truncate text-small text-faint">{parent}</span>
            ) : null}
          </span>

          <span className="hidden shrink-0 items-center gap-px group-hover/change:flex group-focus-visible/change:flex">
            <FileActions group={group} files={[file]} />
          </span>
          {group === "conflict" ? null : (
            <Stat stat={stat} className="group-hover/change:hidden group-focus-visible/change:hidden" />
          )}
          <GitLetter
            status={file.status}
            className="group-hover/change:hidden group-focus-visible/change:hidden"
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuEntries
          entries={() =>
            picked && many ? bulkMenu(panel!.selectedFiles()) : fileMenu(group, file)
          }
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ignoreEntries(path: string): MenuEntry[] {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  const folder = parentRel(path);
  return [
    { kind: "item", label: path, onSelect: () => void workspace().ignore(`/${path}`) },
    ...(dot > 0
      ? [{ kind: "item" as const, label: `All *${name.slice(dot)} files`, onSelect: () => void workspace().ignore(`*${name.slice(dot)}`) }]
      : []),
    ...(folder
      ? [{ kind: "item" as const, label: `${folder}/`, onSelect: () => void workspace().ignore(`/${folder}/`) }]
      : []),
  ];
}

function fileMenu(group: GroupId, file: GitFile): MenuEntry[] {
  const state = workspace();
  const staged = group === "staged";
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
  ];
  if (file.conflict) {
    entries.push(
      { kind: "item", label: "Take ours", onSelect: () => void state.resolve([file.path], "ours") },
      { kind: "item", label: "Take theirs", onSelect: () => void state.resolve([file.path], "theirs") },
      { kind: "item", label: "Mark resolved", icon: Check, onSelect: () => void state.stage([file.path]) },
    );
  } else if (staged) {
    entries.push({ kind: "item", label: "Unstage", icon: Minus, onSelect: () => void state.unstage([file.path]) });
  } else {
    entries.push({ kind: "item", label: "Stage", icon: Plus, onSelect: () => void state.stage([file.path]) });
  }
  if (!file.conflict) {
    entries.push({
      kind: "item",
      label: "Stash this file",
      icon: Archive,
      onSelect: () =>
        void state.stashPush({
          message: `${fileName(file.path)}`,
          includeUntracked: file.untracked,
          paths: [file.path],
        }),
    });
  }
  if (file.untracked) {
    entries.push({ kind: "sub", label: "Add to .gitignore", icon: EyeOff, entries: ignoreEntries(file.path) });
  }
  entries.push(
    { kind: "separator" },
    { kind: "item", label: "Show in Files", icon: Files, disabled: file.status === "deleted", onSelect: () => state.revealInTree(file.path) },
    { kind: "item", label: "Copy path", icon: Copy, onSelect: () => copy(file.path, "Copied the path") },
  );
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

function bulkMenu(items: { group: GroupId; file: GitFile }[]): MenuEntry[] {
  const state = workspace();
  const toStage = items.filter((item) => item.group !== "staged").map((item) => item.file.path);
  const toUnstage = items.filter((item) => item.group === "staged").map((item) => item.file.path);
  const conflicts = items.filter((item) => item.file.conflict).map((item) => item.file.path);
  const discardable = items.map((item) => item.file).filter((file) => !file.conflict);
  const unique = [...new Set(items.map((item) => item.file.path))];
  return [
    { kind: "label", label: plural(unique.length, "file") },
    ...(toStage.length
      ? [{ kind: "item" as const, label: conflicts.length === toStage.length ? "Mark resolved" : "Stage", icon: Plus, onSelect: () => void state.stage(toStage) }]
      : []),
    ...(toUnstage.length
      ? [{ kind: "item" as const, label: "Unstage", icon: Minus, onSelect: () => void state.unstage(toUnstage) }]
      : []),
    ...(conflicts.length
      ? [
          { kind: "item" as const, label: "Take ours", onSelect: () => void state.resolve(conflicts, "ours") },
          { kind: "item" as const, label: "Take theirs", onSelect: () => void state.resolve(conflicts, "theirs") },
        ]
      : []),
    {
      kind: "item",
      label: "Stash these",
      icon: Archive,
      disabled: discardable.length === 0,
      onSelect: () =>
        void state.stashPush({
          message: null,
          includeUntracked: discardable.some((file) => file.untracked),
          paths: [...new Set(pathsOf(discardable))],
        }),
    },
    { kind: "item", label: "Copy paths", icon: Copy, onSelect: () => copy(unique.join("\n"), "Copied the paths") },
    { kind: "separator" },
    {
      kind: "item",
      label: "Discard changes",
      icon: Undo2,
      destructive: true,
      disabled: discardable.length === 0,
      confirm: `Discard ${plural(discardable.length, "file")}? This can't be undone`,
      onSelect: () => void state.discard([...new Set(pathsOf(discardable))]),
    },
  ];
}

function SelectionBar({
  items,
  onClear,
}: {
  items: { group: GroupId; file: GitFile }[];
  onClear: () => void;
}) {
  const toStage = items.filter((item) => item.group !== "staged").map((item) => item.file.path);
  const toUnstage = items.filter((item) => item.group === "staged").map((item) => item.file.path);
  const files = items.map((item) => item.file);
  return (
    <div className="k-selbar" role="toolbar" aria-label="Selected changes">
      <span className="min-w-0 flex-1 truncate text-body font-medium text-dim">
        {plural(new Set(files.map((file) => file.path)).size, "file")}
      </span>
      {toStage.length ? (
        <button type="button" className="k-selbar-btn" onClick={() => void workspace().stage(toStage)}>
          <Plus className="size-3.5" />
          Stage
        </button>
      ) : null}
      {toUnstage.length ? (
        <button type="button" className="k-selbar-btn" onClick={() => void workspace().unstage(toUnstage)}>
          <Minus className="size-3.5" />
          Unstage
        </button>
      ) : null}
      <button
        type="button"
        title="Discard"
        aria-label="Discard"
        data-danger="true"
        className="k-selbar-btn px-1.5"
        onClick={() => confirmDiscard(files)}
      >
        <Undo2 className="size-3.5" />
      </button>
      <button
        type="button"
        title="Clear selection (Esc)"
        aria-label="Clear selection"
        className="k-selbar-btn px-1.5"
        onClick={onClear}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
