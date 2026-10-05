/**
 * Git for the open project.
 *
 * The top is where you are: the branch, how far it is from its remote, and
 * the sync buttons beside it, because "where am I, and am I behind" comes
 * before any other question. A merge or rebase that stopped halfway shows
 * under that until it is finished or abandoned.
 *
 * Below are the pages. Changes is the commit you are about to make; History
 * is the graph of the ones already made; Branches, Stashes and Pull requests
 * hold the rest. The dock is narrow, so the pages are icons with only the
 * current one named, until it is wide enough to name them all.
 */

import { useEffect, type ReactNode } from "react";
import {
  Archive,
  FileDiff,
  GitBranch,
  GitPullRequest,
  History as HistoryIcon,
  type LucideIcon,
} from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import { Button } from "@/components/ui/button";
import { changeCount } from "@/lib/git";
import type { GitStatus } from "@/lib/workspace";
import { useWorkspace, type GitView } from "@/state/workspace";

import { BranchesView } from "./git/Branches";
import { ChangesView } from "./git/Changes";
import { HistoryView } from "./git/History";
import { PullRequestsView } from "./git/PullRequests";
import { OperationBanner, RepoBar } from "./git/RepoBar";
import { PromptHost } from "./git/shared";
import { StashesView } from "./git/Stashes";

export function GitPanel() {
  const root = useWorkspace((state) => state.root);
  const git = useWorkspace((state) => state.git);
  const gitError = useWorkspace((state) => state.gitError);
  const busy = useWorkspace((state) => state.busy);
  const view = useWorkspace((state) => state.gitView);

  useEffect(() => {
    void useWorkspace.getState().refreshGit();
  }, [root]);

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
        detail="This project's folder isn't under version control yet."
        className="pt-10"
      >
        <Button
          size="xs"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() => void useWorkspace.getState().initRepo()}
        >
          Initialize repository
        </Button>
      </DockNotice>
    );
  }

  if (!git) {
    return (
      <p className="mx-[var(--keel-inset)] rounded-[var(--keel-r-control)] bg-[color:var(--keel-dead)]/10 px-2.5 py-2 text-body leading-snug text-[color:var(--keel-dead)]">
        {gitError}
      </p>
    );
  }

  return (
    <PromptHost>
      <div className="k-git flex min-h-0 flex-1 flex-col">
        <RepoBar git={git} busy={busy} />
        <OperationBanner git={git} busy={busy} />
        <GitNav git={git} view={view} />
        {gitError ? (
          <p className="mx-[var(--keel-inset)] mb-2 rounded-[var(--keel-r-control)] bg-[color:var(--keel-dead)]/10 px-2.5 py-2 text-body leading-snug text-[color:var(--keel-dead)]">
            {gitError}
          </p>
        ) : null}
        <div key={view} className="k-fade-in flex min-h-0 flex-1 flex-col">
          {view === "changes" ? (
            <ChangesView git={git} busy={busy} />
          ) : view === "history" ? (
            <HistoryView git={git} />
          ) : view === "branches" ? (
            <BranchesView git={git} busy={busy} />
          ) : view === "stashes" ? (
            <StashesView git={git} busy={busy} />
          ) : (
            <PullRequestsView git={git} busy={busy} />
          )}
        </div>
      </div>
    </PromptHost>
  );
}

function GitNav({ git, view }: { git: GitStatus; view: GitView }) {
  const prs = useWorkspace((state) => state.prs);
  const changes = changeCount(git);
  const stashes = git.stashes ?? 0;
  const openPrs = prs?.available ? prs.items.length : 0;
  const setView = useWorkspace((state) => state.setGitView);

  return (
    <nav aria-label="Git pages" className="k-gitnav shrink-0 px-[var(--keel-inset)] pb-2">
      <NavButton id="changes" view={view} icon={FileDiff} label="Changes" count={changes} onSelect={setView} />
      <NavButton id="history" view={view} icon={HistoryIcon} label="History" onSelect={setView} />
      <NavButton id="branches" view={view} icon={GitBranch} label="Branches" onSelect={setView} />
      <NavButton id="stashes" view={view} icon={Archive} label="Stashes" count={stashes} onSelect={setView} />
      <NavButton id="prs" view={view} icon={GitPullRequest} label="Pull requests" count={openPrs} onSelect={setView} />
    </nav>
  );
}

function NavButton({
  id,
  view,
  icon: Icon,
  label,
  count = 0,
  onSelect,
}: {
  id: GitView;
  view: GitView;
  icon: LucideIcon;
  label: string;
  count?: number;
  onSelect: (view: GitView) => void;
}): ReactNode {
  const active = id === view;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={count ? `${label}, ${count}` : label}
      title={count ? `${label} · ${count}` : label}
      data-active={active}
      onClick={() => onSelect(id)}
      className="k-gitnav-btn"
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="k-gitnav-label">{label}</span>
      {count ? (
        <span className="k-count k-gitnav-count" data-active={active}>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
      {count && !active ? <span aria-hidden className="k-gitnav-dot" /> : null}
    </button>
  );
}
