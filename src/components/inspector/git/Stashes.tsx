/**
 * Work set aside. Stash what is in progress with a note of what it was, and
 * bring it back later — applied, or popped off the list as it comes. Open a
 * stash to see which files it holds; each opens as a diff.
 */

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ChevronRight, Copy, Ellipsis, Trash2 } from "lucide-react";

import { Fold } from "@/components/Fold";
import { FileIcon } from "@/components/inspector/FileIcon";
import { GitLetter } from "@/components/inspector/GitLetter";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import {
  ContextMenuEntries,
  DropdownMenuEntries,
  type MenuEntry,
} from "@/components/menu/MenuEntries";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fileName, parentRel, relativeTime } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { GitStash, GitStatus } from "@/lib/workspace";
import { useWorkspace } from "@/state/workspace";

import { Checkbox, copy, Empty, isControl, MetaContent, plural, Stat } from "./shared";

const workspace = useWorkspace.getState;

export function StashesView({ git, busy }: { git: GitStatus; busy: boolean }) {
  const stashes = useWorkspace((state) => state.stashes);
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const changes = git.files.filter((file) => !file.conflict);
  const hasUntracked = changes.some((file) => file.untracked);
  const stashable = untracked ? changes.length : changes.filter((file) => !file.untracked).length;

  useEffect(() => {
    void workspace().refreshStashes();
  }, [git.stashes]);

  const stash = () => {
    if (busy || stashable === 0) return;
    void workspace().stashPush({ message: message.trim() || null, includeUntracked: untracked });
    setMessage("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      <form
        className="mx-[var(--keel-inset)] mb-2 flex flex-col gap-2 rounded-[var(--keel-r-control)] bg-veil p-2"
        onSubmit={(event) => {
          event.preventDefault();
          stash();
        }}
      >
        <div className="k-field k-field-sm bg-transparent">
          <Archive aria-hidden className="size-3.5 shrink-0" />
          <input
            value={message}
            placeholder={changes.length ? "What you were in the middle of" : "No changes to stash"}
            aria-label="Stash message"
            disabled={changes.length === 0}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pl-0.5">
          {hasUntracked ? (
            <Checkbox checked={untracked} onChange={setUntracked}>
              Include untracked
            </Checkbox>
          ) : (
            <span className="text-small text-faint">
              {changes.length ? plural(changes.length, "change") : "Working tree is clean"}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-right text-small text-faint">
            {stashable ? plural(stashable, "change") : ""}
          </span>
          <Button type="submit" size="xs" disabled={busy || stashable === 0}>
            Stash
          </Button>
        </div>
      </form>

      <MetaContent section="stashes" loaded={stashes !== null} rows={3}>
        {stashes && stashes.length === 0 ? (
          <Empty
            icon={Archive}
            title="Nothing stashed"
            detail="Stash changes to set them aside, switch branches with a clean tree, and bring them back later."
          />
        ) : null}
        {stashes?.map((item) => (
          <StashItem
            key={item.hash}
            stash={item}
            busy={busy}
            open={open === item.hash}
            onToggle={() => setOpen((current) => (current === item.hash ? null : item.hash))}
          />
        ))}
      </MetaContent>
    </div>
  );
}

function StashItem({
  stash,
  busy,
  open,
  onToggle,
}: {
  stash: GitStash;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const details = useWorkspace((state) => state.commitDetails[stash.hash]);
  useEffect(() => {
    if (open) void workspace().loadCommitDetails(stash.hash);
  }, [open, stash.hash]);

  const entries = (): MenuEntry[] => [
    { kind: "item", label: "Apply", icon: ArchiveRestore, disabled: busy, onSelect: () => void workspace().stashApply(stash, false) },
    { kind: "item", label: "Pop — apply and drop", disabled: busy, onSelect: () => void workspace().stashApply(stash, true) },
    { kind: "item", label: "Copy message", icon: Copy, onSelect: () => copy(stash.message, "Copied the message") },
    { kind: "separator" },
    {
      kind: "item",
      label: "Drop",
      icon: Trash2,
      destructive: true,
      disabled: busy,
      confirm: "Drop this stash? It can't be brought back",
      onSelect: () => void workspace().stashDrop(stash),
    },
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={open}
            data-selected={open}
            className="k-row k-row-two group/stash gap-2"
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
              className={cn(
                "mt-[4px] size-3 shrink-0 text-faint transition-transform duration-150",
                open && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate leading-5 text-dim">{stash.message || "Stash"}</span>
              <span className="block truncate text-small leading-4 text-faint">
                {stash.branch ? `on ${stash.branch} · ` : ""}
                {relativeTime(stash.timestamp)}
              </span>
            </span>
            <span className="mt-px hidden shrink-0 items-center gap-1 group-hover/stash:flex group-focus-within/stash:flex">
              <button
                type="button"
                disabled={busy}
                className="k-tag hover:bg-veil-3 hover:text-foreground disabled:opacity-40"
                onClick={() => void workspace().stashApply(stash, true)}
                title="Apply it, and drop it from the list"
              >
                Pop
              </button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More for this stash" className="k-icon-btn size-[22px]">
                    <Ellipsis className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-52">
                  <DropdownMenuEntries entries={entries} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuEntries entries={entries} />
        </ContextMenuContent>
      </ContextMenu>
      <Fold open={open}>
        <div className="pb-1 pl-4">
          {!details ? (
            <LoadingRows label="Loading the stash" rows={2} />
          ) : details.files.length === 0 ? (
            <p className="px-[calc(var(--keel-inset)+8px)] py-1 text-small text-faint">
              Only untracked files, which show up once it's applied.
            </p>
          ) : (
            details.files.map((file) => (
              <div
                key={file.path}
                role="button"
                tabIndex={0}
                title={file.path}
                className="k-row k-row-dense gap-2"
                onClick={() => void workspace().openCommitDiff(stash.hash, file)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void workspace().openCommitDiff(stash.hash, file);
                  }
                }}
              >
                <FileIcon name={fileName(file.path)} />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="max-w-full shrink-0 truncate text-body text-dim">{fileName(file.path)}</span>
                  <span className="min-w-0 truncate text-small text-faint">{parentRel(file.path)}</span>
                </span>
                <Stat stat={file.stat} />
                <GitLetter status={file.status} />
              </div>
            ))
          )}
        </div>
      </Fold>
    </>
  );
}
