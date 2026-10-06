/**
 * Handing a pane's conversation to another agent, from the window's side.
 *
 * Rust reads the conversation back out of the CLI that had it and writes it
 * down (`handoff.rs`). This does the parts only the window can: asking the
 * agent in the pane for its own notes first, when wanted, then opening the
 * new agent beside it in the same folder and typing the prompt that points it
 * at what was written.
 *
 * Notes are the one way to pass on reasoning providers keep encrypted. They
 * cost a turn of the first agent, so they are optional, and they are only
 * asked of an agent that is sitting at its prompt.
 */

import { toast } from "sonner";
import { create } from "zustand";

import { terminalSettled, terminalType } from "@/components/TerminalSurface";
import { canHandOff, handoffTitle, targetLabel } from "@/lib/handoff";
import { invoke } from "@/lib/invoke";
import { deckOfPane, useKeel } from "@/state/store";

const NOTES_KEY = "keel.handoff.notes";
/** Long enough for an agent to write a page of notes; past it, go without. */
const NOTES_TIMEOUT_MS = 10 * 60_000;
const NOTES_POLL_MS = 1000;

interface Begun {
  name: string;
  notesPrompt: string;
}

interface Written {
  prompt: string;
  folder: string;
  userMessages: number;
  toolCalls: number;
  thoughts: number;
  hiddenThoughts: number;
  memories: number;
  notes: boolean;
}

interface HandoffSource {
  agentId: string;
  agentName: string;
  accountId: string | null;
  sessionId: string;
  cwd: string;
  title: string;
}

const handoffIpc = {
  begin: (cwd: string, targetName: string) =>
    invoke<Begun>("handoff_begin", { cwd, targetName }),
  notesReady: (cwd: string, name: string) =>
    invoke<boolean>("handoff_notes_ready", { cwd, name }),
  write: (source: HandoffSource, name: string, targetName: string) =>
    invoke<Written>("handoff_write", { source, name, targetName }),
};

function readNotesPreference(): boolean {
  try {
    return localStorage.getItem(NOTES_KEY) === "true";
  } catch {
    return false;
  }
}

interface HandoffState {
  /** Panes handing off right now, with what they are doing. */
  running: Record<string, string>;
  /** Ask the first agent for notes before handing off. Remembered. */
  askNotes: boolean;
  setAskNotes: (ask: boolean) => void;
}

export const useHandoff = create<HandoffState>((set) => ({
  running: {},
  askNotes: readNotesPreference(),
  setAskNotes: (askNotes) => {
    try {
      localStorage.setItem(NOTES_KEY, String(askNotes));
    } catch {
      // Only the preference is lost.
    }
    set({ askNotes });
  },
}));

function setPhase(paneId: string, phase: string | null) {
  useHandoff.setState((state) => {
    const running = { ...state.running };
    if (phase === null) delete running[paneId];
    else running[paneId] = phase;
    return { running };
  });
}

/** The pane is a live agent at its prompt, so it can be asked for notes. */
export function canAskForNotes(paneId: string): boolean {
  const state = useKeel.getState();
  const status = state.status[paneId];
  return !(paneId in state.exited) && status !== "working" && status !== "waiting";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Wait for the first agent to write its notes and finish its turn. Resolves
 * true when it did, false when it couldn't (exited, timed out, or skipped).
 */
function waitForNotes(
  paneId: string,
  cwd: string,
  name: string,
  skipped: { current: boolean },
): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (skipped.current) return resolve(false);
      if (paneId in useKeel.getState().exited) return resolve(false);
      if (Date.now() - started > NOTES_TIMEOUT_MS) return resolve(false);
      const ready = await handoffIpc.notesReady(cwd, name).catch(() => false);
      const status = useKeel.getState().status[paneId];
      // Written and done writing: the turn that wrote it has ended.
      if (ready && status !== "working" && status !== "waiting") return resolve(true);
      setTimeout(() => void tick(), NOTES_POLL_MS);
    };
    // The first poll waits a beat, for the prompt to land and the turn to start.
    setTimeout(() => void tick(), NOTES_POLL_MS);
  });
}

/**
 * Hand the conversation in `paneId` to `targetId`, in a new pane beside it.
 * `accountId` left out starts the target on the profile new terminals use.
 */
export async function handOff(
  projectId: string,
  paneId: string,
  targetId: string,
  accountId?: string | null,
): Promise<void> {
  const keel = useKeel.getState();
  const project = keel.projects.find((item) => item.id === projectId);
  const deck = project ? deckOfPane(project, paneId) : null;
  const pane = deck?.panes[paneId];
  const source = keel.agents.find((item) => item.id === pane?.agentId);
  const target = keel.agents.find((item) => item.id === targetId);
  if (!project || !deck || !pane || !source || !target || !canHandOff(pane)) return;
  if (useHandoff.getState().running[paneId]) return;

  const cwd = pane.cwd ?? project.path;
  const targetName = targetLabel(target, source.id);
  const notesWanted = useHandoff.getState().askNotes;
  const toastId = toast.loading(`Handing off to ${targetName}…`, {
    description: `Reading ${source.name}'s conversation.`,
  });
  setPhase(paneId, "Preparing");
  try {
    const begun = await handoffIpc.begin(cwd, target.name);

    let notes: "written" | "skipped" | "busy" | "none" = "none";
    if (notesWanted) {
      if (!canAskForNotes(paneId)) {
        notes = "busy";
      } else {
        const skipped = { current: false };
        setPhase(paneId, "Waiting for notes");
        toast.loading(`Asking ${source.name} for handoff notes…`, {
          id: toastId,
          description: `${target.name} opens once they're written.`,
          action: {
            label: "Skip",
            onClick: () => {
              skipped.current = true;
            },
          },
        });
        const typed = await terminalType(paneId, begun.notesPrompt, true);
        notes = typed && (await waitForNotes(paneId, cwd, begun.name, skipped))
          ? "written"
          : "skipped";
      }
    }

    setPhase(paneId, "Writing");
    toast.loading(`Handing off to ${targetName}…`, {
      id: toastId,
      description: "Writing the conversation down.",
      action: undefined,
    });
    // Read after the notes turn, so the transcript includes it.
    const written = await handoffIpc.write(
      {
        agentId: source.id,
        agentName: source.name,
        accountId: pane.accountId,
        sessionId: pane.sessionId ?? "",
        cwd,
        title: pane.title,
      },
      begun.name,
      target.name,
    );

    setPhase(paneId, "Opening");
    // The new pane goes beside the old, so the source's deck must be in front.
    const now = useKeel.getState();
    const current = now.projects.find((item) => item.id === projectId);
    const home = current ? deckOfPane(current, paneId) : null;
    if (current && home && current.activeDeckId !== home.id) now.selectDeck(projectId, home.id);
    const opened = now.addPane(
      projectId,
      {
        agentId: target.id,
        ...(accountId !== undefined ? { accountId } : {}),
        cwd,
        title: handoffTitle(pane.title, source.name),
      },
      { beside: paneId, direction: "row" },
    );
    if (!opened) throw new Error(`Couldn't open a pane for ${target.name}.`);
    await terminalSettled(opened);
    await terminalType(opened, written.prompt, true);

    const carried = [
      plural(written.userMessages, "message"),
      plural(written.toolCalls, "tool call"),
      written.memories ? plural(written.memories, "memory file") : null,
    ].filter(Boolean);
    const aside =
      notes === "written"
        ? ` and ${source.name}'s notes`
        : notes === "busy"
          ? `. ${source.name} was busy, so it wasn't asked for notes`
          : notes === "skipped"
            ? `. ${source.name}'s notes didn't arrive, so it went without`
            : "";
    toast.success(`Handed off to ${targetName}`, {
      id: toastId,
      description: `Passed on ${carried.join(", ")}${aside}. Saved in ${written.folder}.`,
      action: undefined,
    });
  } catch (error) {
    toast.error(`Couldn't hand off to ${targetName}`, {
      id: toastId,
      description: error instanceof Error ? error.message : String(error),
      action: undefined,
    });
  } finally {
    setPhase(paneId, null);
  }
}
