/**
 * Agents & profiles.
 *
 * Built out of the same pieces as the rest of the window, so it reads as part of
 * Keel rather than as a settings form bolted onto it:
 *
 *  - **The rail** is a sidebar. Same inset rows, same darker chrome, grouped by
 *    whether the agent can actually be launched.
 *  - **The pane** is a scale model of the terminal this agent opens as, lit in
 *    its colour. The command is edited on its prompt line, so what you type is
 *    shown exactly where it will be typed.
 *  - **Profiles** are a list of sign-ins, renamed and removed the way sidebar
 *    rows are: double-click, or the ⋯ that appears on hover.
 *
 * Agents save themselves: an edit is written a moment after you stop typing, as
 * soon as every entry is valid, so there is no Save button to forget. Profiles
 * live in app state and change immediately.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  Eye,
  EyeOff,
  FileJson,
  LoaderCircle,
  Maximize2,
  Pencil,
  Pipette,
  Plus,
  RefreshCw,
  RotateCcw,
  SplitSquareHorizontal,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

import { AgentMark } from "@/components/AgentMark";
import { InlineRename } from "@/components/InlineRename";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentCatalogueDefaults, agentCataloguePath } from "@/lib/backend";
import { agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Agent, AgentAccount, AgentSpec } from "@/lib/types";
import { nextProfileName, useKeel } from "@/state/store";

/** How long after the last keystroke an agent edit is written to disk. */
const SAVE_DELAY_MS = 500;

/** Tuned to sit on the neutral chrome; the brand accents from the catalogue are included as-is. */
const SWATCHES = [
  "#d97757",
  "#e9a23b",
  "#4cc38a",
  "#10a37f",
  "#3fc1b0",
  "#6c9bf5",
  "#4285f4",
  "#b48cf2",
  "#e07fb7",
  "#a1a1a1",
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Field = "name" | "command" | "short" | "accent" | "accountEnv";
type Problems = Partial<Record<Field, string>>;

const FIELD =
  "w-full min-w-0 rounded-[var(--keel-r-control)] border border-line-strong bg-veil px-2.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-faint hover:border-foreground/20 focus:border-foreground/40 focus:bg-veil-2 aria-invalid:border-[color:var(--keel-dead)]/70";

function expandHex(value: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  return `#${full.toLowerCase()}`;
}

/** Dark ink on light swatches, white on dark ones. */
function inkOn(colour: string): string {
  const hex = expandHex(colour);
  if (!hex) return "#ffffff";
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0a0a0a" : "#ffffff";
}

function problemsOf(agent: AgentSpec): Problems {
  const problems: Problems = {};
  if (!agent.name.trim()) problems.name = "Give it a name.";
  if (!agent.command.trim()) {
    problems.command = "Enter the command that starts this agent.";
  } else if (/[\r\n]/.test(agent.command)) {
    problems.command = "One line only.";
  }
  if (agent.short.trim().length > 3) problems.short = "Up to three characters.";
  if (agent.accent.trim() && !expandHex(agent.accent)) {
    problems.accent = "Use a hex colour, like #6c9bf5.";
  }
  const key = agent.accountEnv?.trim();
  if (key && !ENV_NAME.test(key)) {
    problems.accountEnv =
      "Letters, digits and underscores, not starting with a digit.";
  }
  return problems;
}

function hasProblems(agent: AgentSpec): boolean {
  return Object.keys(problemsOf(agent)).length > 0;
}

/** Strip detection results and editing slack before a draft goes to disk. */
function specOf(agent: Agent): AgentSpec {
  const lines = (values: string[]) =>
    values.map((value) => value.trim()).filter(Boolean);
  return {
    id: agent.id,
    name: agent.name.trim(),
    command: agent.command.trim(),
    session: agent.session ?? undefined,
    short: agent.short.trim().toUpperCase(),
    accent: agent.accent.trim(),
    accountEnv: agent.accountEnv?.trim() || null,
    bins: lines(agent.bins),
    paths: lines(agent.paths),
    hidden: agent.hidden || undefined,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function AgentSettingsDialog() {
  const { open, agentId } = useKeel((state) => state.agentSettings);
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const projects = useKeel((state) => state.projects);

  const [drafts, setDrafts] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const draftsRef = useRef<Agent[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Take a fresh copy of the catalogue every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const current = useKeel.getState().agents;
    draftsRef.current = current;
    setDrafts(current);
    setSelectedId(agentId ?? current[0]?.id ?? null);
    setSaveState("idle");
    setSaveError(null);
  }, [open, agentId]);

  // After a save or a scan, pick up what detection found without touching
  // anything the user may be halfway through typing.
  useEffect(() => {
    if (!open) return;
    const next = draftsRef.current.map((draft) => {
      const fresh = agents.find((agent) => agent.id === draft.id);
      return fresh
        ? {
            ...draft,
            installed: fresh.installed,
            path: fresh.path,
            builtin: fresh.builtin,
          }
        : draft;
    });
    draftsRef.current = next;
    setDrafts(next);
  }, [agents, open]);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [saveState]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const usage = useMemo(() => {
    const byAccount: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const project of projects) {
      for (const deck of project.decks) {
        for (const pane of Object.values(deck.panes)) {
          if (pane.accountId) {
            byAccount[pane.accountId] = (byAccount[pane.accountId] ?? 0) + 1;
          }
          if (pane.agentId) {
            byAgent[pane.agentId] = (byAgent[pane.agentId] ?? 0) + 1;
          }
        }
      }
    }
    return { byAccount, byAgent };
  }, [projects]);

  async function persist() {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const next = draftsRef.current;
    // Nothing reaches disk while any entry is invalid; the fields say why.
    if (next.some(hasProblems)) return;
    setSaveState("saving");
    try {
      await useKeel.getState().saveAgents(next.map(specOf));
      setSaveState("saved");
      setSaveError(null);
    } catch (error) {
      setSaveState("error");
      setSaveError(String(error));
    }
  }

  function commit(next: Agent[], delay = SAVE_DELAY_MS) {
    draftsRef.current = next;
    setDrafts(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist(), delay);
  }

  function update(id: string, change: Partial<AgentSpec>) {
    commit(
      draftsRef.current.map((draft) =>
        draft.id === id ? { ...draft, ...change } : draft,
      ),
    );
  }

  function addAgent() {
    const agent: Agent = {
      id: `custom-${Math.random().toString(36).slice(2, 8)}`,
      name: "New agent",
      command: "",
      short: "NA",
      accent: SWATCHES[5],
      accountEnv: null,
      bins: [],
      paths: [],
      hidden: false,
      builtin: false,
      installed: false,
      path: null,
    };
    commit([...draftsRef.current, agent]);
    setSelectedId(agent.id);
  }

  function deleteAgent(id: string) {
    const current = draftsRef.current;
    const index = current.findIndex((draft) => draft.id === id);
    const next = current.filter((draft) => draft.id !== id);
    setSelectedId(next[Math.max(0, index - 1)]?.id ?? null);
    commit(next, 0);
  }

  async function resetAgent(id: string) {
    const base = (await agentCatalogueDefaults()).find(
      (entry) => entry.id === id,
    );
    if (!base) return;
    update(id, {
      ...base,
      accountEnv: base.accountEnv ?? null,
      hidden: false,
    });
  }

  async function scan() {
    setScanning(true);
    try {
      await useKeel.getState().refreshAgents();
    } finally {
      setScanning(false);
    }
  }

  function close() {
    if (saveTimer.current !== undefined) void persist();
    useKeel.getState().closeAgentSettings();
  }

  const selected =
    drafts.find((draft) => draft.id === selectedId) ?? drafts[0] ?? null;
  const blocked = drafts.some(hasProblems);

  const groups: { label: string; agents: Agent[] }[] = [
    {
      label: "Ready",
      agents: drafts.filter((draft) => !draft.hidden && draft.installed),
    },
    {
      label: "Not installed",
      agents: drafts.filter((draft) => !draft.hidden && !draft.installed),
    },
    { label: "Hidden", agents: drafts.filter((draft) => draft.hidden) },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="h-[min(720px,88vh)] w-[min(980px,calc(100vw-2rem))] max-w-none grid-cols-[236px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none"
        // Focus the dialog itself: landing on the rail's first button drew a
        // ring on it every time the dialog opened.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        // Escape in a field being renamed reverts the field, not the dialog.
        onEscapeKeyDown={(event) => {
          const target = document.activeElement;
          if (
            target instanceof HTMLElement &&
            target.closest("[data-escape-reverts]")
          ) {
            event.preventDefault();
          }
        }}
      >
        <aside className="flex min-h-0 flex-col bg-[color:var(--keel-chrome)] shadow-[inset_-1px_0_0_0_var(--keel-line)]">
          <div className="flex h-[52px] shrink-0 items-center gap-2 pl-4 pr-2">
            <DialogTitle className="text-[13px] font-semibold">
              Agents
            </DialogTitle>
            <DialogDescription className="sr-only">
              Choose how each agent starts, how it looks, and which sign-ins it
              can use.
            </DialogDescription>
            <span className="text-[12px] tabular-nums text-faint">
              {drafts.length}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              title="New agent"
              aria-label="New agent"
              onClick={addAgent}
              className="k-icon-btn size-7"
            >
              <Plus className="size-4" />
            </button>
          </div>

          <nav
            aria-label="Agents"
            className="min-h-0 flex-1 overflow-y-auto pb-3"
          >
            {groups.map((group) =>
              group.agents.length > 0 ? (
                <div key={group.label} className="pb-2">
                  <h3 className="k-label pb-1 pt-2">{group.label}</h3>
                  {group.agents.map((draft) => (
                    <RailRow
                      key={draft.id}
                      agent={draft}
                      selected={draft.id === selected?.id}
                      invalid={hasProblems(draft)}
                      onSelect={() => setSelectedId(draft.id)}
                    />
                  ))}
                </div>
              ) : null,
            )}
          </nav>

          <div className="flex shrink-0 items-center gap-0.5 px-2 pb-2 pt-1">
            <RailAction
              onClick={() => void scan()}
              disabled={scanning}
              title="Look for installed agents again"
            >
              <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} />
              Scan again
            </RailAction>
            <RailAction
              onClick={() => void agentCataloguePath().then(openPath)}
              title="Edit the catalogue by hand"
            >
              <FileJson className="size-3.5" />
              agents.json
            </RailAction>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col">
          <div className="flex h-[52px] shrink-0 items-center gap-1 pl-8 pr-2">
            <SaveIndicator
              state={saveState}
              error={saveError}
              blocked={blocked}
            />
            <span className="flex-1" />
            {selected ? (
              <AgentMenu
                agent={selected}
                onToggleHidden={() =>
                  update(selected.id, { hidden: !selected.hidden })
                }
                onReset={() => void resetAgent(selected.id)}
                onDelete={() => deleteAgent(selected.id)}
                openPanes={usage.byAgent[selected.id] ?? 0}
              />
            ) : null}
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="k-icon-btn size-8"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {selected ? (
              <AgentEditor
                key={selected.id}
                agent={selected}
                problems={problemsOf(selected)}
                accounts={accounts.filter(
                  (account) => account.agentId === selected.id,
                )}
                accountUsage={usage.byAccount}
                onChange={(change) => update(selected.id, change)}
              />
            ) : (
              <div className="grid h-full place-items-center pb-16">
                <button
                  type="button"
                  onClick={addAgent}
                  className="flex flex-col items-center gap-3 rounded-[var(--keel-r-window)] border border-dashed border-line-strong px-10 py-8 text-[13px] text-dim transition-colors hover:border-foreground/25 hover:bg-veil hover:text-foreground"
                >
                  <span className="grid size-9 place-items-center rounded-full bg-veil-2">
                    <Plus className="size-4" />
                  </span>
                  Add an agent
                </button>
              </div>
            )}
          </div>
        </main>
      </DialogContent>
    </Dialog>
  );
}

// ---- Rail ------------------------------------------------------------------

function RailRow({
  agent,
  selected,
  invalid,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  invalid: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className="k-row h-[34px] gap-2.5 pl-2 pr-2.5"
    >
      <AgentMark
        agentId={agent.id}
        name={agent.name}
        accent={agentAccent(agent.accent)}
        size={20}
        muted={agent.hidden || !agent.installed}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          selected ? "text-foreground" : "text-dim",
        )}
      >
        {agent.name.trim() || "Untitled"}
      </span>
      {invalid ? (
        <span
          title="Needs attention"
          aria-label="Needs attention"
          className="size-1.5 shrink-0 rounded-full bg-[color:var(--keel-dead)]"
        />
      ) : null}
    </button>
  );
}

function RailAction({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 items-center gap-1.5 rounded-[var(--keel-r-chip)] px-2 text-[12px] text-faint transition-colors hover:bg-veil-2 hover:text-foreground disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

function SaveIndicator({
  state,
  error,
  blocked,
}: {
  state: SaveState;
  error: string | null;
  blocked: boolean;
}) {
  const [icon, text, tone] = blocked
    ? [null, "Fix the highlighted fields to save", "text-[color:var(--keel-dead)]"]
    : state === "saving"
      ? [<LoaderCircle key="i" className="size-3.5 animate-spin" />, "Saving", "text-faint"]
      : state === "saved"
        ? [<Check key="i" className="size-3.5" />, "Saved", "text-dim"]
        : state === "error"
          ? [null, "Couldn't save", "text-[color:var(--keel-dead)]"]
          : [null, "Changes save automatically", "text-faint"];

  return (
    <span
      role="status"
      title={state === "error" ? (error ?? undefined) : undefined}
      className={cn(
        "flex items-center gap-1.5 text-[12px] animate-in fade-in-0",
        tone,
      )}
    >
      {icon}
      {text}
    </span>
  );
}

function AgentMenu({
  agent,
  openPanes,
  onToggleHidden,
  onReset,
  onDelete,
}: {
  agent: Agent;
  openPanes: number;
  onToggleHidden: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setConfirming(false), [agent.id]);

  if (confirming) {
    return (
      <span className="mr-1 flex items-center gap-2 animate-in fade-in-0">
        <span className="text-[12px] text-dim">
          Delete {agent.name.trim() || "this agent"}?
          {openPanes > 0 ? (
            <span className="text-faint">
              {" "}
              {plural(openPanes, "terminal uses", "terminals use")} it.
            </span>
          ) : null}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button size="xs" variant="destructive" onClick={onDelete}>
          Delete
        </Button>
      </span>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Agent actions"
          title="More"
          className="k-icon-btn size-8 data-[state=open]:bg-veil-2 data-[state=open]:text-foreground"
        >
          <Ellipsis className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onToggleHidden}>
          {agent.hidden ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )}
          {agent.hidden ? "Show in the launcher" : "Hide from the launcher"}
        </DropdownMenuItem>
        {agent.builtin ? (
          <DropdownMenuItem onSelect={onReset}>
            <RotateCcw className="size-3.5" />
            Reset to defaults
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
              Delete agent
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Editor ----------------------------------------------------------------

function AgentEditor({
  agent,
  problems,
  accounts,
  accountUsage,
  onChange,
}: {
  agent: Agent;
  problems: Problems;
  accounts: AgentAccount[];
  accountUsage: Record<string, number>;
  onChange: (change: Partial<AgentSpec>) => void;
}) {
  const accent = agentAccent(agent.accent);
  const env = agent.accountEnv?.trim() ?? "";
  const profilesOn = env !== "" && !problems.accountEnv;

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-10 px-8 pb-12 pt-1 animate-in fade-in-0 duration-150">
      <header className="flex items-center gap-4">
        <AgentMark
          agentId={agent.id}
          name={agent.name}
          accent={accent}
          size={48}
          muted={agent.hidden}
        />
        <div className="min-w-0 flex-1">
          <input
            value={agent.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Agent name"
            aria-label="Name"
            aria-invalid={Boolean(problems.name)}
            spellCheck={false}
            className="-ml-1.5 h-9 w-full rounded-[var(--keel-r-control)] bg-transparent px-1.5 text-[22px] font-semibold tracking-[-0.02em] text-foreground outline-none transition-colors placeholder:text-faint hover:bg-veil focus:bg-veil-2"
          />
          {problems.name ? (
            <FieldError message={problems.name} />
          ) : (
            <Availability agent={agent} />
          )}
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <PanePreview
          agent={agent}
          accent={accent}
          invalid={Boolean(problems.command)}
          profileName={
            profilesOn
              ? (accounts.find((account) => account.isDefault)?.name ??
                "Default")
              : null
          }
          onCommand={(command) => onChange({ command })}
        />
        {problems.command ? (
          <FieldError message={problems.command} />
        ) : (
          <p className="text-[12px] text-faint">
            Typed into a new shell each time one of these terminals opens.
          </p>
        )}
        <ColourPicker
          value={agent.accent}
          problem={problems.accent}
          onChange={(value) => onChange({ accent: value })}
        />
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading
          title="Profiles"
          detail={
            profilesOn
              ? "Separate sign-ins. New terminals start on the marked one; any terminal can switch from its header."
              : undefined
          }
        />
        {profilesOn ? (
          <ProfileList
            agent={agent}
            accent={accent}
            env={env}
            accounts={accounts}
            usage={accountUsage}
          />
        ) : (
          <ProfilesOff
            agentName={agent.name.trim() || "this agent"}
            example={`${agent.id.replace(/^custom-/, "agent").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_HOME`}
            onEnable={(value) => onChange({ accountEnv: value })}
          />
        )}
      </section>

      <Advanced
        agent={agent}
        problems={problems}
        onChange={onChange}
        defaultOpen={Boolean(problems.accountEnv)}
      />
    </div>
  );
}

function Availability({ agent }: { agent: Agent }) {
  const colour = agent.installed ? "var(--keel-done)" : "var(--keel-idle)";
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px]">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{
          background: colour,
          boxShadow: agent.installed
            ? `0 0 0 3px color-mix(in srgb, ${colour} 20%, transparent)`
            : undefined,
        }}
      />
      <span className="shrink-0 text-dim">
        {agent.installed ? "Installed" : "Not found on this machine"}
      </span>
      {agent.installed && agent.path ? (
        <span
          className="min-w-0 truncate font-mono text-[11px] text-faint"
          title={agent.path}
        >
          {agent.path}
        </span>
      ) : null}
      {agent.hidden ? (
        <span className="shrink-0 rounded-full bg-veil-2 px-2 py-0.5 text-[11px] leading-none text-dim">
          Hidden from the launcher
        </span>
      ) : null}
    </p>
  );
}

function SectionHeading({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-end gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        {detail ? (
          <p className="mt-0.5 text-[12px] text-faint">{detail}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-0.5 text-[12px] text-[color:var(--keel-dead)] animate-in fade-in-0">
      {message}
    </p>
  );
}

/**
 * The terminal this agent opens as, drawn the way the canvas draws it: a slab
 * lifted off the ground, a header strip, and a prompt. The prompt line is the
 * command field.
 */
function PanePreview({
  agent,
  accent,
  invalid,
  profileName,
  onCommand,
}: {
  agent: Agent;
  accent: string;
  invalid: boolean;
  profileName: string | null;
  onCommand: (command: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const ring = invalid
    ? "color-mix(in srgb, var(--keel-dead) 70%, transparent)"
    : `color-mix(in srgb, ${accent} ${focused ? 60 : 30}%, transparent)`;

  return (
    <div
      className="overflow-hidden rounded-[var(--keel-r-window)] transition-shadow duration-150"
      style={{
        background: `color-mix(in srgb, ${accent} 6%, var(--keel-term-solid))`,
        boxShadow: `inset 0 0 0 1px ${ring}, var(--keel-lift)`,
      }}
    >
      <div aria-hidden className="flex h-8 items-center gap-1.5 pl-2.5 pr-1.5">
        <AgentMark
          agentId={agent.id}
          name={agent.name}
          accent={accent}
          size={16}
        />
        <span className="min-w-0 truncate text-[12px] text-dim">
          {agent.name.trim() || "Untitled"}
        </span>
        {profileName ? (
          <span className="flex h-5 shrink-0 items-center gap-1 px-1.5 text-[11px] text-faint">
            {profileName}
            <ChevronDown className="size-3" />
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="flex items-center gap-px text-faint opacity-60">
          <span className="grid size-6 place-items-center">
            <SplitSquareHorizontal className="size-3.5" />
          </span>
          <span className="grid size-6 place-items-center">
            <Maximize2 className="size-3.5" />
          </span>
          <span className="grid size-6 place-items-center">
            <X className="size-3.5" />
          </span>
        </span>
      </div>

      <label className="flex cursor-text items-center gap-2.5 px-4 pb-8 pt-3 font-mono text-[13px]">
        <span aria-hidden style={{ color: accent }}>
          ❯
        </span>
        <input
          value={agent.command}
          onChange={(event) => onCommand(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="command to start the agent"
          aria-label="Command"
          aria-invalid={invalid}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[color:var(--keel-term-fg)] caret-[color:var(--keel-term-cursor)] outline-none placeholder:text-faint"
        />
      </label>
    </div>
  );
}

function ColourPicker({
  value,
  problem,
  onChange,
}: {
  value: string;
  problem?: string;
  onChange: (value: string) => void;
}) {
  const current = expandHex(value);
  const custom = current !== null && !SWATCHES.includes(current);
  const ring =
    "ring-2 ring-foreground/70 ring-offset-2 ring-offset-[color:var(--keel-chrome-strong)]";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Colour"
          className="flex flex-wrap items-center gap-2"
        >
          {SWATCHES.map((swatch) => {
            const active = current === swatch;
            return (
              <button
                key={swatch}
                type="button"
                title={swatch}
                aria-label={`Colour ${swatch}`}
                aria-pressed={active}
                onClick={() => onChange(swatch)}
                className={cn(
                  "grid size-5 place-items-center rounded-full outline-none transition-transform duration-100 hover:scale-110 focus-visible:ring-2 focus-visible:ring-foreground/50",
                  active && ring,
                )}
                style={{ background: swatch }}
              >
                {active ? (
                  <Check
                    className="size-3"
                    strokeWidth={3}
                    style={{ color: inkOn(swatch) }}
                  />
                ) : null}
              </button>
            );
          })}

          <label
            title="Custom colour"
            className={cn(
              "relative grid size-5 cursor-pointer place-items-center rounded-full text-faint transition-colors hover:text-foreground",
              custom ? ring : "border border-dashed border-line-strong",
            )}
            style={custom ? { background: current } : undefined}
          >
            {custom ? (
              <Check
                className="size-3"
                strokeWidth={3}
                style={{ color: inkOn(current) }}
              />
            ) : (
              <Pipette className="size-3" />
            )}
            <input
              type="color"
              value={current ?? "#8f8f8f"}
              onChange={(event) => onChange(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Pick a custom colour"
            />
          </label>
        </div>

        <span className="flex-1" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="#6c9bf5"
          spellCheck={false}
          aria-label="Hex colour"
          aria-invalid={Boolean(problem)}
          className="h-7 w-[84px] rounded-[var(--keel-r-chip)] bg-transparent px-2 text-right font-mono text-[12px] text-dim outline-none transition-colors placeholder:text-faint hover:bg-veil focus:bg-veil-2 focus:text-foreground aria-invalid:text-[color:var(--keel-dead)]"
        />
      </div>
      <FieldError message={problem} />
    </div>
  );
}

// ---- Profiles --------------------------------------------------------------

function ProfilesOff({
  agentName,
  example,
  onEnable,
}: {
  agentName: string;
  /** A plausible variable name, shown as the placeholder. */
  example: string;
  onEnable: (env: string) => void;
}) {
  // Kept local until it is turned on: the moment the agent has a variable this
  // whole panel is replaced by the list, and focus would go with it.
  const [draft, setDraft] = useState("");
  const clean = draft.trim();
  const valid = ENV_NAME.test(clean);

  return (
    <div className="flex gap-3.5 rounded-[var(--keel-r-window)] bg-veil p-4 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
      <span className="grid size-8 shrink-0 place-items-center rounded-[var(--keel-r-control)] bg-veil-2 text-dim">
        <UsersRound className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <p className="text-[13px] font-medium text-foreground">
            Use more than one sign-in
          </p>
          <p className="mt-1 max-w-[460px] text-[12px] leading-relaxed text-faint">
            Profiles point {agentName} at a separate config folder. Enter the
            environment variable it reads that folder from to turn them on.
          </p>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onEnable(clean);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={example}
            aria-label="Profile variable"
            aria-invalid={clean !== "" && !valid}
            spellCheck={false}
            className={cn(FIELD, "h-8 max-w-[260px] font-mono")}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!valid}>
            Turn on
          </Button>
        </form>
      </div>
    </div>
  );
}

function ProfileList({
  agent,
  accent,
  env,
  accounts,
  usage,
}: {
  agent: Agent;
  accent: string;
  env: string;
  accounts: AgentAccount[];
  usage: Record<string, number>;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const chosen = accounts.find((account) => account.isDefault) ?? null;

  function add() {
    const id = useKeel
      .getState()
      .addAccount(agent.id, nextProfileName(accounts));
    if (id) setRenamingId(id);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-px rounded-[var(--keel-r-window)] bg-veil p-1 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
        <div className="group flex h-12 items-center gap-3 rounded-[var(--keel-r-control)] px-2.5 transition-colors hover:bg-veil">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-veil-2 text-dim">
            <UserRound className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] text-foreground">
                Default
              </span>
              {chosen ? null : <NewTerminalsBadge />}
            </span>
            <span className="text-[11px] text-faint">
              The CLI&apos;s own sign-in
            </span>
          </span>
          {chosen ? (
            <RowMenu label="Actions for Default">
              <DropdownMenuItem
                onSelect={() =>
                  useKeel.getState().setDefaultAccount(agent.id, null)
                }
              >
                <CircleCheck className="size-3.5" />
                Use for new terminals
              </DropdownMenuItem>
            </RowMenu>
          ) : null}
        </div>

        {accounts.map((account) => (
          <ProfileRow
            key={account.id}
            account={account}
            accent={accent}
            usage={usage[account.id] ?? 0}
            renaming={renamingId === account.id}
            onMakeDefault={() =>
              useKeel.getState().setDefaultAccount(agent.id, account.id)
            }
            onStartRename={() => setRenamingId(account.id)}
            onStopRename={() => setRenamingId(null)}
          />
        ))}

        <button
          type="button"
          onClick={add}
          className="flex h-10 items-center gap-3 rounded-[var(--keel-r-control)] px-2.5 text-[13px] text-dim transition-colors hover:bg-veil-2 hover:text-foreground"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-line-strong">
            <Plus className="size-3.5" />
          </span>
          Add profile
        </button>
      </div>
      <p className="px-1 text-[11px] text-faint">
        Each profile gets its own folder, handed to the CLI as{" "}
        <code className="font-mono text-dim">{env}</code>.
      </p>
    </div>
  );
}

function ProfileRow({
  account,
  accent,
  usage,
  renaming,
  onMakeDefault,
  onStartRename,
  onStopRename,
}: {
  account: AgentAccount;
  accent: string;
  usage: number;
  renaming: boolean;
  onMakeDefault: () => void;
  onStartRename: () => void;
  onStopRename: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const initial = (account.name.trim()[0] ?? "?").toUpperCase();

  if (confirming) {
    return (
      <div className="flex h-12 items-center gap-3 rounded-[var(--keel-r-control)] bg-[color:color-mix(in_srgb,var(--keel-dead)_8%,transparent)] px-2.5 animate-in fade-in-0">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground">
            Remove {account.name}?
          </span>
          <span className="block text-[11px] text-faint">
            {usage > 0
              ? `${plural(usage, "terminal restarts", "terminals restart")} on Default.`
              : "Its sign-in folder stays on disk."}
          </span>
        </span>
        <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="destructive"
          onClick={() => useKeel.getState().removeAccount(account.id)}
        >
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div
      className="group flex h-12 items-center gap-3 rounded-[var(--keel-r-control)] px-2.5 transition-colors hover:bg-veil animate-in fade-in-0 duration-150"
      onDoubleClick={() => !renaming && onStartRename()}
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold"
        style={{
          color: accent,
          background: `color-mix(in srgb, ${accent} 14%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 22%, transparent)`,
        }}
      >
        {initial}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <span data-escape-reverts className="-ml-1.5 flex">
            <InlineRename
              value={account.name}
              className="h-6 max-w-64 flex-initial"
              onCommit={(name) =>
                useKeel.getState().renameAccount(account.id, name)
              }
              onDone={onStopRename}
            />
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="truncate text-[13px] text-foreground"
              title="Double-click to rename"
            >
              {account.name}
            </span>
            {account.isDefault ? <NewTerminalsBadge /> : null}
          </span>
        )}
        <span className="text-[11px] text-faint">
          {usage > 0
            ? `Open in ${plural(usage, "terminal", "terminals")}`
            : "Not in use"}
        </span>
      </span>

      <RowMenu label={`Actions for ${account.name}`}>
          {account.isDefault ? null : (
            <DropdownMenuItem onSelect={onMakeDefault}>
              <CircleCheck className="size-3.5" />
              Use for new terminals
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onStartRename}>
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            <Trash2 className="size-3.5" />
            Remove profile
          </DropdownMenuItem>
      </RowMenu>
    </div>
  );
}

/** Marks the sign-in new terminals of this agent start on. */
function NewTerminalsBadge() {
  return (
    <span
      title="New terminals start on this profile"
      className="shrink-0 rounded-full bg-veil-2 px-2 py-[3px] text-[10px] font-medium leading-none text-dim"
    >
      New terminals
    </span>
  );
}

/** The ⋯ on a profile row: hidden until the row is hovered or focused. */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="k-icon-btn size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-veil-2 data-[state=open]:text-foreground data-[state=open]:opacity-100"
        >
          <Ellipsis className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        // Let a rename field keep the focus it is about to take.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Advanced --------------------------------------------------------------

function Advanced({
  agent,
  problems,
  onChange,
  defaultOpen,
}: {
  agent: Agent;
  problems: Problems;
  onChange: (change: Partial<AgentSpec>) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-5">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="-ml-1 flex w-fit items-center gap-1.5 rounded-[var(--keel-r-chip)] px-1 py-0.5 text-[13px] font-medium text-dim transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        Advanced
      </button>

      {open ? (
        <div className="flex flex-col gap-5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          <SettingRow
            label="Profile variable"
            hint="Where this CLI reads its config folder from. Clear it to turn profiles off."
            error={problems.accountEnv}
          >
            <input
              value={agent.accountEnv ?? ""}
              onChange={(event) => onChange({ accountEnv: event.target.value })}
              placeholder="None"
              spellCheck={false}
              aria-label="Profile variable"
              aria-invalid={Boolean(problems.accountEnv)}
              className={cn(FIELD, "h-8 font-mono")}
            />
          </SettingRow>
          <SettingRow
            label="Executables"
            hint="Looked for on PATH, one per line. Empty uses the command's first word."
          >
            <textarea
              value={agent.bins.join("\n")}
              onChange={(event) =>
                onChange({ bins: event.target.value.split("\n") })
              }
              rows={2}
              spellCheck={false}
              aria-label="Executables"
              className={cn(FIELD, "resize-none py-2 font-mono leading-relaxed")}
            />
          </SettingRow>
          <SettingRow
            label="Search folders"
            hint="Extra places to look, one per line. {home} is your home folder."
          >
            <textarea
              value={agent.paths.join("\n")}
              onChange={(event) =>
                onChange({ paths: event.target.value.split("\n") })
              }
              rows={4}
              spellCheck={false}
              aria-label="Search folders"
              className={cn(FIELD, "resize-none py-2 font-mono leading-relaxed")}
            />
          </SettingRow>
          <SettingRow label="Catalogue id" hint="How saved layouts refer to it.">
            <code className="flex h-8 items-center font-mono text-[12px] text-dim">
              {agent.id}
            </code>
          </SettingRow>
        </div>
      ) : null}
    </section>
  );
}

function SettingRow({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  // A div, not a <label>: the control carries its own aria-label, and a label
  // would forward clicks on the hint to it.
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-x-6">
      <div className="pt-1.5">
        <p className="text-[12px] text-dim">{label}</p>
        {hint ? (
          <p className="mt-1 text-[11px] leading-relaxed text-faint">{hint}</p>
        ) : null}
      </div>
      <div className="min-w-0">
        {children}
        <FieldError message={error} />
      </div>
    </div>
  );
}
