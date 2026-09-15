/**
 * The right dock: the project's files and its git state.
 *
 * The left sidebar's twin — the same floating card, folding to the same rail,
 * mirrored so its toggle sits on the inner edge. Two tabs share it: Files is
 * the folder the project is, Git is what has changed in it and the commit you
 * are about to make. Anything you open lands in the editor beside the
 * terminals, never on top of them.
 */

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { Files, FolderOpen, GitBranch } from "lucide-react";

import {
  DockNotice,
  DockToggle,
  RailTip,
  RailTipProvider,
} from "@/components/Dock";
import { FileTree } from "@/components/inspector/FileTree";
import { GitPanel } from "@/components/inspector/GitPanel";
import { useWorkspace, type InspectorTab } from "@/state/workspace";

export interface InspectorProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  projectPath: string | null;
  projectName: string | null;
}

function tileIndex(index: number): CSSProperties {
  return { ["--i" as string]: index };
}

export function Inspector({
  collapsed,
  onToggleCollapsed,
  projectPath,
  projectName,
}: InspectorProps) {
  const tab = useWorkspace((state) => state.tab);
  const setTab = useWorkspace((state) => state.setTab);
  const setRoot = useWorkspace((state) => state.setRoot);
  const git = useWorkspace((state) => state.git);

  useEffect(() => {
    setRoot(projectPath);
  }, [projectPath, setRoot]);

  useEffect(() => {
    if (!projectPath) return;
    const timer = window.setInterval(() => {
      void useWorkspace.getState().refreshGit();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [projectPath]);

  const changeCount = git?.repo ? git.files.length : 0;

  /** From the rail: pick the tab, and unfold to show it. */
  const openTab = (next: InspectorTab) => {
    setTab(next);
    if (collapsed) onToggleCollapsed();
  };

  return (
    <aside
      data-side="right"
      data-collapsed={collapsed}
      aria-label="Files and git"
      className="k-dock"
    >
      <DockToggle
        side="right"
        collapsed={collapsed}
        what="files and git"
        onToggle={onToggleCollapsed}
      />

      <div className="k-dock-panel" inert={collapsed}>
        {/* Left padding leaves the toggle its own slot. */}
        <div className="flex h-[44px] shrink-0 items-center pl-[40px] pr-2">
          <div role="tablist" aria-label="Files or git" className="k-seg flex-1">
            <TabButton active={tab === "files"} onClick={() => setTab("files")}>
              <Files className="size-3.5" />
              Files
            </TabButton>
            <TabButton active={tab === "git"} onClick={() => setTab("git")}>
              <GitBranch className="size-3.5" />
              Git
              {changeCount ? <span className="k-count">{changeCount}</span> : null}
            </TabButton>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {projectPath ? (
            tab === "files" ? (
              <FileTree />
            ) : (
              <GitPanel />
            )
          ) : (
            <DockNotice
              icon={FolderOpen}
              title="No project open"
              detail="Pick a project on the left to browse its files and git."
              className="pt-10"
            />
          )}
        </div>
      </div>

      <RailTipProvider>
        <nav aria-label="Files and git" className="k-dock-rail" inert={!collapsed}>
          {/* The toggle's slot, level with the panel's header. */}
          <div className="h-[44px] shrink-0" />
          <div className="flex flex-col gap-1 pt-1">
            <RailTip side="left" label="Files" detail={projectName ?? undefined}>
              <button
                type="button"
                aria-label="Files"
                data-selected={tab === "files"}
                style={tileIndex(0)}
                onClick={() => openTab("files")}
                className="k-rail-tile shrink-0"
              >
                <Files className="size-4" />
              </button>
            </RailTip>
            <RailTip
              side="left"
              label="Git"
              detail={changeCount ? `${changeCount} changed` : undefined}
            >
              <button
                type="button"
                aria-label={changeCount ? `Git, ${changeCount} changed` : "Git"}
                data-selected={tab === "git"}
                style={tileIndex(1)}
                onClick={() => openTab("git")}
                className="k-rail-tile shrink-0"
              >
                <GitBranch className="size-4" />
                {changeCount ? (
                  <span aria-hidden className="k-rail-count">
                    {changeCount > 99 ? "99+" : changeCount}
                  </span>
                ) : null}
              </button>
            </RailTip>
          </div>
        </nav>
      </RailTipProvider>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      onClick={onClick}
      className="k-seg-btn flex-1"
    >
      {children}
    </button>
  );
}
