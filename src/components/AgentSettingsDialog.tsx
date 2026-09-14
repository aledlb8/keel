/**
 * Agents & profiles.
 *
 * The catalogue used to be a JSON file behind a Help menu item, and profiles
 * could be created from a pane's header but never renamed or removed. This is
 * the one place for both.
 *
 * Agents save themselves: an edit is written a moment after you stop typing, as
 * soon as the entry is valid, so there is no Save button to forget. Profiles
 * live in app state and change immediately.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FileJson,
  Pipette,
  Plus,
  RotateCcw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentCatalogueDefaults, agentCataloguePath } from "@/lib/backend";
import { agentAccent } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Agent, AgentAccount, AgentSpec } from "@/lib/types";
import { nextProfileName, useKeel } from "@/state/store";

/** How long after the last keystroke an agent edit is written to disk. */
const SAVE_DELAY_MS = 500;

const SWATCHES = [
  "#d97757",
  "#e5bd6c",
  "#6fd39c",
  "#10a37f",
  "#5fc7d4",
  "#6fa4ee",
  "#4285f4",
  "#9a8ff0",
  "#dd8fbc",
  "#b6c1d2",
];

type Field = "name" | "command" | "short" | "accent" | "accountEnv";
type Problems = Partial<Record<Field, string>>;

const INPUT =
  "h-8 w-full min-w-0 rounded-[var(--keel-r-control)] border border-line-strong bg-veil px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-faint hover:border-foreground/20 focus:border-foreground/40 focus:bg-veil-2 aria-invalid:border-[color:var(--keel-dead)]/70";

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
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0a0c12" : "#ffffff";
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "··"
  );
}

function problemsOf(agent: AgentSpec): Problems {
  const problems: Problems = {};
  if (!agent.name.trim()) problems.name = "Give it a name.";
  if (!agent.command.trim()) {
    problems.command = "What should be typed into the shell?";
  } else if (/[\r\n]/.test(agent.command)) {
    problems.command = "One line only.";
  }
  if (agent.short.trim().length > 3) problems.short = "Up to three characters.";
  if (agent.accent.trim() && !expandHex(agent.accent)) {
    problems.accent = "Use a hex colour, like #6fa4ee.";
  }
  const key = agent.accountEnv?.trim();
  if (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    problems.accountEnv = "Letters, digits and underscores, not starting with a digit.";
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
    short: agent.short.trim().toUpperCase(),
    accent: agent.accent.trim(),
    accountEnv: agent.accountEnv?.trim() || null,
    bins: lines(agent.bins),
    paths: lines(agent.paths),
    hidden: agent.hidden || undefined,
  };
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

  // After a save, pick up what detection found without touching anything the
  // user may be halfway through typing.
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

  function close() {
    if (saveTimer.current !== undefined) void persist();
    useKeel.getState().closeAgentSettings();
  }

  const selected =
    drafts.find((draft) => draft.id === selectedId) ?? drafts[0] ?? null;
  const blocked = drafts.some(hasProblems);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="h-[min(680px,86vh)] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-4xl"
        // Escape in a field being renamed reverts the field, not the dialog.
        onEscapeKeyDown={(event) => {
          const target = document.activeElement;
          if (
            target instanceof HTMLElement &&
            target.dataset.escapeReverts !== undefined
          ) {
            event.preventDefault();
          }
        }}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line pl-5">
          <div className="min-w-0 py-3.5">
            <DialogTitle className="text-[15px] font-medium">
              Agents & profiles
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-[13px] text-dim">
              What each agent is called, how it starts, and who it is signed in
              as.
            </DialogDescription>
          </div>
          <div className="flex items-center self-stretch">
            <SaveIndicator state={saveState} error={saveError} blocked={blocked} />
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="k-icon-btn w-[52px] self-stretch rounded-none"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 grid-cols-[232px_minmax(0,1fr)]">
          <nav className="flex min-h-0 flex-col border-r border-line">
            <div className="min-h-0 flex-1 space-y-px overflow-y-auto p-2">
              {drafts.map((draft) => (
                <AgentListRow
                  key={draft.id}
                  agent={draft}
                  selected={draft.id === selected?.id}
                  invalid={hasProblems(draft)}
                  onSelect={() => setSelectedId(draft.id)}
                />
              ))}
            </div>
            <div className="border-t border-line p-2">
              <button
                type="button"
                onClick={addAgent}
                className="flex w-full items-center gap-2 rounded-[var(--keel-r-control)] px-2.5 py-2 text-[13px] text-dim transition-colors hover:bg-veil hover:text-foreground"
              >
                <Plus className="size-3.5" />
                New agent
              </button>
            </div>
          </nav>

          <div className="min-h-0 overflow-y-auto">
            {selected ? (
              <AgentEditor
                key={selected.id}
                agent={selected}
                problems={problemsOf(selected)}
                accounts={accounts.filter(
                  (account) => account.agentId === selected.id,
                )}
                accountUsage={usage.byAccount}
                openPanes={usage.byAgent[selected.id] ?? 0}
                onChange={(change) => update(selected.id, change)}
                onDelete={() => deleteAgent(selected.id)}
                onReset={() => void resetAgent(selected.id)}
              />
            ) : (
              <div className="grid h-full place-items-center text-[13px] text-faint">
                No agents yet.
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-line px-5 py-2.5">
          <button
            type="button"
            onClick={() => void agentCataloguePath().then(openPath)}
            className="flex items-center gap-1.5 rounded-[var(--keel-r-control)] px-1.5 py-1 text-[12px] text-faint transition-colors hover:text-foreground"
          >
            <FileJson className="size-3.5" />
            Open agents.json
          </button>
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
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
  const content = blocked ? (
    <span className="text-faint">Fix the highlighted fields to save</span>
  ) : state === "saving" ? (
    <span className="text-faint">Saving…</span>
  ) : state === "saved" ? (
    <span className="flex items-center gap-1 text-dim">
      <Check className="size-3.5" />
      Saved
    </span>
  ) : state === "error" ? (
    <span className="text-[color:var(--keel-dead)]" title={error ?? undefined}>
      Couldn&apos;t save
    </span>
  ) : null;

  return content ? (
    <span className="mr-2 text-[12px] animate-in fade-in-0">{content}</span>
  ) : null;
}

function Badge({
  short,
  accent,
  size,
  muted,
}: {
  short: string;
  accent: string;
  size: number;
  muted?: boolean;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[var(--keel-r-chip)] bg-[color:var(--keel-term-solid)] font-mono font-medium shadow-[inset_0_0_0_1px_var(--keel-line)] transition-colors"
      style={{
        width: size,
        height: size,
        color: accent,
        fontSize: size >= 40 ? 15 : 11,
        opacity: muted ? 0.45 : 1,
      }}
    >
      {short}
    </span>
  );
}

function AgentListRow({
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
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[var(--keel-r-control)] px-2 py-1.5 text-left transition-colors",
        selected ? "bg-veil-2" : "hover:bg-veil",
      )}
    >
      <Badge
        short={agent.short.trim() || initials(agent.name)}
        accent={agentAccent(agent.accent)}
        size={28}
        muted={agent.hidden}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px] leading-tight",
            selected ? "text-foreground" : "text-dim",
          )}
        >
          {agent.name.trim() || "Untitled"}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-faint">
          {agent.hidden
            ? "Hidden"
            : agent.installed
              ? "Installed"
              : "Not found"}
        </span>
      </span>
      {invalid ? (
        <span
          aria-label="Needs attention"
          className="size-1.5 shrink-0 rounded-full bg-[color:var(--keel-dead)]"
        />
      ) : null}
    </button>
  );
}

function AgentEditor({
  agent,
  problems,
  accounts,
  accountUsage,
  openPanes,
  onChange,
  onDelete,
  onReset,
}: {
  agent: Agent;
  problems: Problems;
  accounts: AgentAccount[];
  accountUsage: Record<string, number>;
  openPanes: number;
  onChange: (change: Partial<AgentSpec>) => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const accent = agentAccent(agent.accent);
  const profilesEnabled = Boolean(agent.accountEnv?.trim());

  return (
    <div className="flex flex-col gap-8 px-7 pb-8 pt-6 animate-in fade-in-0 duration-150">
      <div className="flex items-start gap-4">
        <Badge
          short={agent.short.trim() || initials(agent.name)}
          accent={accent}
          size={48}
          muted={agent.hidden}
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <input
            value={agent.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Agent name"
            aria-label="Name"
            aria-invalid={Boolean(problems.name)}
            className="-ml-1.5 h-8 w-full rounded-[var(--keel-r-control)] bg-transparent px-1.5 text-[19px] font-medium tracking-[-0.01em] text-foreground outline-none transition-colors placeholder:text-faint hover:bg-veil focus:bg-veil-2"
          />
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-faint"
            title={agent.path ?? undefined}
          >
            {agent.installed ? agent.path : "Not found on this machine"}
          </p>
          <FieldError message={problems.name} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onChange({ hidden: !agent.hidden })}
            title={
              agent.hidden
                ? "Show this agent in the launcher"
                : "Keep this agent out of the launcher"
            }
          >
            {agent.hidden ? <Eye /> : <EyeOff />}
            {agent.hidden ? "Show" : "Hide"}
          </Button>
          {agent.builtin ? (
            <Button
              size="xs"
              variant="outline"
              onClick={onReset}
              title="Restore the name, command, colour and detection this agent shipped with"
            >
              <RotateCcw />
              Reset
            </Button>
          ) : confirmDelete ? (
            <>
              <Button size="xs" variant="destructive" onClick={onDelete}>
                Delete
                {openPanes > 0 ? ` · ${openPanes} open` : ""}
              </Button>
              <button
                type="button"
                aria-label="Keep"
                onClick={() => setConfirmDelete(false)}
                className="k-icon-btn size-6"
              >
                <X className="size-3.5" />
              </button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
              Delete
            </Button>
          )}
        </div>
      </div>

      <Section title="Launch" hint="Typed into a fresh shell whenever a terminal opens.">
        <FieldBlock label="Command" error={problems.command}>
          <input
            value={agent.command}
            onChange={(event) => onChange({ command: event.target.value })}
            placeholder="claude --model opus"
            spellCheck={false}
            aria-invalid={Boolean(problems.command)}
            className={cn(INPUT, "font-mono text-[12px]")}
          />
        </FieldBlock>
      </Section>

      <Section title="Appearance">
        <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-5">
          <FieldBlock label="Badge" error={problems.short}>
            <input
              value={agent.short}
              maxLength={3}
              onChange={(event) =>
                onChange({ short: event.target.value.toUpperCase() })
              }
              placeholder={initials(agent.name)}
              spellCheck={false}
              aria-invalid={Boolean(problems.short)}
              className={cn(INPUT, "text-center font-mono text-[12px] tracking-[0.08em]")}
            />
          </FieldBlock>
          <FieldBlock label="Colour" error={problems.accent}>
            <ColourPicker
              value={agent.accent}
              invalid={Boolean(problems.accent)}
              onChange={(accent) => onChange({ accent })}
            />
          </FieldBlock>
        </div>
      </Section>

      <Section
        title="Profiles"
        hint="Separate sign-ins for the same agent. Each profile gets its own config folder, handed to the CLI through an environment variable."
      >
        <FieldBlock label="Profile variable" error={problems.accountEnv}>
          <input
            value={agent.accountEnv ?? ""}
            onChange={(event) => onChange({ accountEnv: event.target.value })}
            placeholder="e.g. CLAUDE_CONFIG_DIR"
            spellCheck={false}
            aria-invalid={Boolean(problems.accountEnv)}
            className={cn(INPUT, "max-w-[280px] font-mono text-[12px]")}
          />
        </FieldBlock>

        {profilesEnabled ? (
          <ProfileList
            agentId={agent.id}
            accounts={accounts}
            usage={accountUsage}
          />
        ) : (
          <p className="rounded-[var(--keel-r-control)] border border-dashed border-line-strong px-3 py-2.5 text-[12px] leading-relaxed text-faint">
            Set the variable this CLI reads its config folder from, and profiles
            become available here and in each pane&apos;s header.
          </p>
        )}
      </Section>

      <Disclosure title="Detection">
        <FieldBlock
          label="Executables"
          hint="Names looked for on PATH, one per line. Leave empty to use the command's first word."
        >
          <textarea
            value={agent.bins.join("\n")}
            onChange={(event) => onChange({ bins: event.target.value.split("\n") })}
            rows={2}
            spellCheck={false}
            className={cn(INPUT, "h-auto resize-none py-2 font-mono text-[12px] leading-relaxed")}
          />
        </FieldBlock>
        <FieldBlock
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
            className={cn(INPUT, "h-auto resize-none py-2 font-mono text-[12px] leading-relaxed")}
          />
        </FieldBlock>
      </Disclosure>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3.5">
      <div>
        <h3 className="text-[11px] font-medium text-faint">{title}</h3>
        {hint ? (
          <p className="mt-1 max-w-[520px] text-[12px] leading-relaxed text-dim">
            {hint}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Disclosure({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-3.5">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-[11px] font-medium text-faint transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
        />
        {title}
      </button>
      {open ? (
        <div className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function FieldBlock({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  // A div, not a <label>: some fields hold several controls (the colour row is
  // eleven buttons), and a label forwards clicks on its text to the first one.
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12px] text-dim">{label}</span>
      {children}
      {hint && !error ? (
        <span className="text-[11px] leading-relaxed text-faint">{hint}</span>
      ) : null}
      <FieldError message={error} />
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span className="text-[11px] text-[color:var(--keel-dead)] animate-in fade-in-0">
      {message}
    </span>
  );
}

function ColourPicker({
  value,
  invalid,
  onChange,
}: {
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const current = expandHex(value);
  const custom = current !== null && !SWATCHES.includes(current);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
              "grid size-6 place-items-center rounded-full outline-none transition-transform duration-100 hover:scale-110 focus-visible:ring-2 focus-visible:ring-foreground/50",
              active && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-[color:var(--keel-chrome-strong)]",
            )}
            style={{ background: swatch }}
          >
            {active ? (
              <Check className="size-3" strokeWidth={3} style={{ color: inkOn(swatch) }} />
            ) : null}
          </button>
        );
      })}

      <label
        title="Custom colour"
        className={cn(
          "relative grid size-6 cursor-pointer place-items-center rounded-full border text-faint transition-colors hover:text-foreground",
          custom
            ? "border-transparent ring-2 ring-foreground/70 ring-offset-2 ring-offset-[color:var(--keel-chrome-strong)]"
            : "border-dashed border-line-strong",
        )}
        style={custom ? { background: current } : undefined}
      >
        {custom ? (
          <Check className="size-3" strokeWidth={3} style={{ color: inkOn(current) }} />
        ) : (
          <Pipette className="size-3" />
        )}
        <input
          type="color"
          value={current ?? "#6fa4ee"}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Pick a custom colour"
        />
      </label>

      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="#6fa4ee"
        spellCheck={false}
        aria-label="Hex colour"
        aria-invalid={invalid}
        className={cn(INPUT, "ml-1.5 h-7 w-[88px] font-mono text-[12px]")}
      />
    </div>
  );
}

function ProfileList({
  agentId,
  accounts,
  usage,
}: {
  agentId: string;
  accounts: AgentAccount[];
  usage: Record<string, number>;
}) {
  const [justAdded, setJustAdded] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-line overflow-hidden rounded-[var(--keel-r-control)] border border-line">
        <div className="flex h-10 items-center gap-2.5 px-3">
          <UserRound className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 text-[13px] text-dim">Default</span>
          <span className="shrink-0 text-[11px] text-faint">
            The CLI&apos;s own sign-in
          </span>
        </div>
        {accounts.map((account) => (
          <ProfileRow
            key={account.id}
            account={account}
            usage={usage[account.id] ?? 0}
            autoFocus={account.id === justAdded}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() =>
          setJustAdded(
            useKeel.getState().addAccount(agentId, nextProfileName(accounts)),
          )
        }
        className="flex w-fit items-center gap-1.5 rounded-[var(--keel-r-control)] px-2 py-1.5 text-[12px] text-dim transition-colors hover:bg-veil hover:text-foreground"
      >
        <Plus className="size-3.5" />
        Add profile
      </button>
    </div>
  );
}

function ProfileRow({
  account,
  usage,
  autoFocus,
}: {
  account: AgentAccount;
  usage: number;
  autoFocus: boolean;
}) {
  const [name, setName] = useState(account.name);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setName(account.name), [account.name]);

  const commitName = () => {
    const clean = name.trim();
    if (!clean) {
      setName(account.name);
      return;
    }
    if (clean !== account.name) {
      useKeel.getState().renameAccount(account.id, clean);
    }
  };

  return (
    <div className="group flex h-10 items-center gap-2.5 px-3 animate-in fade-in-0 duration-150">
      <UserRound className="size-3.5 shrink-0 text-faint" />
      <input
        value={name}
        autoFocus={autoFocus}
        onFocus={(event) => autoFocus && event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(account.name);
            // Let the blur commit the reverted value, not the edited one.
            requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
          }
        }}
        data-escape-reverts
        aria-label="Profile name"
        spellCheck={false}
        className="-ml-1.5 h-7 min-w-0 flex-1 rounded-[var(--keel-r-chip)] bg-transparent px-1.5 text-[13px] text-foreground outline-none transition-colors hover:bg-veil focus:bg-veil-2"
      />

      {usage > 0 && !confirming ? (
        <span className="shrink-0 text-[11px] text-faint">{usage} open</span>
      ) : null}

      {confirming ? (
        <span className="flex shrink-0 items-center gap-1 animate-in fade-in-0">
          <Button
            size="xs"
            variant="destructive"
            onClick={() => useKeel.getState().removeAccount(account.id)}
          >
            {usage > 0 ? `Remove · restarts ${usage}` : "Remove"}
          </Button>
          <button
            type="button"
            aria-label="Keep profile"
            onClick={() => setConfirming(false)}
            className="k-icon-btn size-6"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          title="Remove profile"
          aria-label="Remove profile"
          data-danger="true"
          onClick={() => setConfirming(true)}
          className="k-icon-btn size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
