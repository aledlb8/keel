/**
 * Keyboard shortcuts: the reference and the editor, in one sheet.
 *
 * Every row is an action and the chord it answers to. Click the chord and the
 * row starts listening; the next chord you press becomes the shortcut, and Esc
 * stops listening without changing anything. The ✕ that appears on hover
 * removes a shortcut altogether.
 *
 * Only what you change is saved. A changed row carries a small mark and a
 * reset button that brings its default back, and "Reset all" appears the moment
 * anything differs from the defaults. A chord that is already taken is never
 * moved silently: the row says which action has it and offers to move it.
 */

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { RotateCcw, Search, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MODIFIER_CODES,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  bindingParts,
  conflictsWith,
  formatBinding,
  isCustomized,
  recordBinding,
  resolveBindings,
  sameBinding,
  shortcutById,
  type Binding,
  type Shortcut,
  type ShortcutFamily,
  type ShortcutId,
} from "@/lib/keymap";
import { cn } from "@/lib/utils";
import { useKeel } from "@/state/store";

const FAMILY_HINT: Partial<Record<ShortcutFamily, string>> = {
  digits: "You choose the modifiers. The keys stay 1 to 9.",
  arrows: "You choose the modifiers. The keys stay the arrows.",
};

type Held = { ctrl: boolean; shift: boolean; alt: boolean };
const NOTHING_HELD: Held = { ctrl: false, shift: false, alt: false };

/** What a row has to say under itself, if anything. */
type Note =
  | { id: ShortcutId; kind: "problem"; text: string }
  | { id: ShortcutId; kind: "warning"; text: string }
  | {
      id: ShortcutId;
      kind: "conflict";
      binding: Binding;
      conflicts: ShortcutId[];
      warning: string | null;
    };

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const overrides = useKeel((state) => state.keybindings);
  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);

  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [held, setHeld] = useState<Held>(NOTHING_HELD);
  const [note, setNote] = useState<Note | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setRecording(null);
    setHeld(NOTHING_HELD);
    setNote(null);
    setConfirmReset(false);
  }, [open]);

  const customized = SHORTCUTS.filter((shortcut) =>
    isCustomized(shortcut.id, overrides),
  );
  useEffect(() => {
    if (customized.length === 0) setConfirmReset(false);
  }, [customized.length]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = SHORTCUTS.filter((shortcut) => {
    if (!needle) return true;
    const binding = bindings[shortcut.id];
    const keys = binding ? formatBinding(binding, shortcut.family) : "not set";
    return (
      shortcut.label.toLocaleLowerCase().includes(needle) ||
      keys.toLocaleLowerCase().includes(needle)
    );
  });

  function listen(id: ShortcutId) {
    setNote(null);
    setHeld(NOTHING_HELD);
    setRecording(id);
  }

  function stopListening() {
    setRecording(null);
    setHeld(NOTHING_HELD);
  }

  function assign(
    id: ShortcutId,
    binding: Binding | null,
    displace: ShortcutId[] = [],
    warning: string | null = null,
  ) {
    useKeel.getState().setKeybinding(id, binding, displace);
    setNote(warning ? { id, kind: "warning", text: warning } : null);
    stopListening();
  }

  function onRecordKey(event: KeyboardEvent<HTMLButtonElement>, shortcut: Shortcut) {
    event.preventDefault();
    event.stopPropagation();
    const mods: Held = {
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
    };

    if (event.code === "Escape" && !mods.ctrl && !mods.shift && !mods.alt) {
      stopListening();
      setNote(null);
      return;
    }
    if (MODIFIER_CODES.has(event.code)) {
      setHeld(mods);
      return;
    }

    const result = recordBinding(event, shortcut.family);
    if ("problem" in result) {
      setNote({ id: shortcut.id, kind: "problem", text: result.problem });
      return;
    }
    if (sameBinding(result.binding, bindings[shortcut.id])) {
      stopListening();
      setNote(null);
      return;
    }
    const conflicts = conflictsWith(shortcut.id, result.binding, bindings);
    if (conflicts.length > 0) {
      stopListening();
      setNote({
        id: shortcut.id,
        kind: "conflict",
        binding: result.binding,
        conflicts,
        warning: result.warning,
      });
      return;
    }
    assign(shortcut.id, result.binding, [], result.warning);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[min(720px,88vh)] max-w-[680px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[680px]"
        // Esc while listening, or while a conflict is waiting on you, belongs
        // to that row — not to the dialog.
        onEscapeKeyDown={(event) => {
          if (recording || note?.kind === "conflict") {
            event.preventDefault();
            stopListening();
            setNote(null);
          }
        }}
      >
        <header className="flex flex-col gap-4 px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em]">
                Keyboard shortcuts
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12px] leading-snug text-faint">
                Click a shortcut to change it. Changes save as you make them.
              </DialogDescription>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => onOpenChange(false)}
              className="k-icon-btn -mr-1.5 -mt-1 size-7"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[var(--keel-r-control)] bg-veil px-3 shadow-[inset_0_0_0_1px_var(--keel-line)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--keel-line-strong)]">
              <Search className="size-3.5 shrink-0 text-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search actions or keys"
                aria-label="Search shortcuts"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
              />
            </label>

            {customized.length > 0 ? (
              confirmReset ? (
                <span className="flex shrink-0 items-center gap-1.5 animate-in fade-in-0">
                  <span className="text-[12px] text-dim">
                    Reset {customized.length}{" "}
                    {customized.length === 1 ? "shortcut" : "shortcuts"}?
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      useKeel.getState().resetKeybindings();
                      setNote(null);
                      stopListening();
                      setConfirmReset(false);
                    }}
                  >
                    Reset
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 shrink-0 gap-1.5 text-dim"
                  onClick={() => setConfirmReset(true)}
                >
                  <RotateCcw className="size-3.5" />
                  Reset all
                  <span className="rounded-full bg-veil-2 px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-dim">
                    {customized.length}
                  </span>
                </Button>
              )
            ) : null}
          </div>
        </header>

        <div className="min-h-0 overflow-y-auto border-t border-line px-5 pb-5">
          {visible.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-faint">
              No shortcut matches &ldquo;{query.trim()}&rdquo;
            </p>
          ) : (
            SHORTCUT_GROUPS.map((group) => {
              const rows = visible.filter((shortcut) => shortcut.group === group);
              if (rows.length === 0) return null;
              return (
                <section key={group} className="pt-4">
                  <h3 className="px-1 pb-1.5 text-[11px] font-medium text-faint">
                    {group}
                  </h3>
                  <div className="flex flex-col gap-px rounded-[var(--keel-r-window)] bg-veil p-1 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
                    {rows.map((shortcut) => (
                      <ShortcutRow
                        key={shortcut.id}
                        shortcut={shortcut}
                        binding={bindings[shortcut.id]}
                        customized={isCustomized(shortcut.id, overrides)}
                        recording={recording === shortcut.id}
                        held={held}
                        note={note?.id === shortcut.id ? note : null}
                        onListen={() => listen(shortcut.id)}
                        onStopListening={stopListening}
                        onRecordKey={(event) => onRecordKey(event, shortcut)}
                        onKeyUp={(event) =>
                          setHeld({
                            ctrl: event.ctrlKey,
                            shift: event.shiftKey,
                            alt: event.altKey,
                          })
                        }
                        onReset={() => {
                          useKeel.getState().resetKeybinding(shortcut.id);
                          setNote(null);
                        }}
                        onClear={() => assign(shortcut.id, null)}
                        onMove={(pending) =>
                          assign(
                            shortcut.id,
                            pending.binding,
                            pending.conflicts,
                            pending.warning,
                          )
                        }
                        onDismiss={() => setNote(null)}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>

        <footer className="flex h-12 items-center gap-3 border-t border-line bg-veil px-5">
          <p className="flex items-center gap-1.5 text-[11px] text-faint">
            {recording ? (
              <>
                Press the new shortcut, or <Cap muted>Esc</Cap> to stop
              </>
            ) : (
              "Shortcuts are saved with your layout in keel.json."
            )}
          </p>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutRow({
  shortcut,
  binding,
  customized,
  recording,
  held,
  note,
  onListen,
  onStopListening,
  onRecordKey,
  onKeyUp,
  onReset,
  onClear,
  onMove,
  onDismiss,
}: {
  shortcut: Shortcut;
  binding: Binding | null;
  customized: boolean;
  recording: boolean;
  held: Held;
  note: Note | null;
  onListen: () => void;
  onStopListening: () => void;
  onRecordKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onReset: () => void;
  onClear: () => void;
  onMove: (pending: Extract<Note, { kind: "conflict" }>) => void;
  onDismiss: () => void;
}) {
  const hint = FAMILY_HINT[shortcut.family];
  const defaultKeys = formatBinding(shortcut.defaults, shortcut.family);
  const heldParts = [
    held.ctrl && "Ctrl",
    held.shift && "Shift",
    held.alt && "Alt",
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className={cn(
        "group/row rounded-[var(--keel-r-control)] transition-colors duration-100",
        recording || note ? "bg-veil-2" : "hover:bg-veil",
      )}
    >
      <div className="flex min-h-11 items-center gap-3 py-1.5 pl-3 pr-1.5">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
            <span className="truncate">{shortcut.label}</span>
            {customized ? (
              <span
                title={`Changed from ${defaultKeys}`}
                className="size-1.5 shrink-0 rounded-full bg-foreground/55"
              />
            ) : null}
          </p>
          {hint && recording ? (
            <p className="mt-0.5 text-[11px] text-faint animate-in fade-in-0">{hint}</p>
          ) : null}
        </div>

        <span className="flex shrink-0 items-center gap-0.5">
          {customized && !recording ? (
            <button
              type="button"
              title={`Reset to ${defaultKeys}`}
              aria-label={`Reset ${shortcut.label} to ${defaultKeys}`}
              onClick={onReset}
              className="k-icon-btn size-7"
            >
              <RotateCcw className="size-3.5" />
            </button>
          ) : null}
          {binding && !recording ? (
            <button
              type="button"
              title="Remove shortcut"
              aria-label={`Remove the shortcut for ${shortcut.label}`}
              data-danger="true"
              onClick={onClear}
              className="k-icon-btn size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </span>

        <button
          type="button"
          data-shortcut-recorder={recording ? "" : undefined}
          aria-label={
            recording
              ? `Listening for a new shortcut for ${shortcut.label}`
              : `${shortcut.label}: ${binding ? formatBinding(binding, shortcut.family) : "not set"}. Click to change.`
          }
          onClick={() => (recording ? onStopListening() : onListen())}
          onKeyDown={recording ? onRecordKey : undefined}
          onKeyUp={recording ? onKeyUp : undefined}
          onBlur={recording ? onStopListening : undefined}
          className={cn(
            "flex h-8 shrink-0 items-center justify-end rounded-[var(--keel-r-control)] px-1.5 outline-none transition-[background-color,box-shadow] duration-150",
            recording
              ? // Room for the prompt and a few held keys, only while listening,
                // so a reset button otherwise sits right beside its keys.
                "min-w-[148px] bg-[color:var(--keel-chrome-strong)] shadow-[inset_0_0_0_1px_var(--keel-text-faint)]"
              : "hover:bg-veil-2 focus-visible:bg-veil-2",
          )}
        >
          {recording ? (
            <span className="flex items-center gap-1.5 pr-0.5">
              {heldParts.length > 0 ? (
                <Caps parts={heldParts} muted />
              ) : (
                <span className="text-[12px] text-dim">Press a shortcut</span>
              )}
              <span aria-hidden className="k-caret h-3.5 w-px bg-foreground/70" />
            </span>
          ) : binding ? (
            <Caps parts={bindingParts(binding, shortcut.family)} />
          ) : (
            <span className="rounded-[5px] border border-dashed border-line-strong px-2 py-[3px] text-[11px] text-faint">
              Not set
            </span>
          )}
        </button>
      </div>

      {note ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-2.5 pl-3 pr-1.5 text-[12px] animate-in fade-in-0 slide-in-from-top-1 duration-150">
          {note.kind === "problem" ? (
            <p className="text-[color:var(--keel-dead)]">{note.text}</p>
          ) : note.kind === "warning" ? (
            <>
              <p className="flex min-w-0 flex-1 items-center gap-1.5 text-dim">
                <TriangleAlert
                  className="size-3.5 shrink-0"
                  style={{ color: "var(--keel-working)" }}
                />
                {note.text}
              </p>
              <Button size="xs" variant="ghost" onClick={onDismiss}>
                Got it
              </Button>
            </>
          ) : (
            <>
              <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-dim">
                <Caps parts={bindingParts(note.binding, shortcut.family)} small />
                <span>
                  is already used by{" "}
                  <span className="text-foreground">
                    {note.conflicts.map((id) => shortcutById(id).label).join(", ")}
                  </span>
                  .
                </span>
              </p>
              <Button size="xs" variant="ghost" onClick={onDismiss}>
                Cancel
              </Button>
              <Button size="xs" variant="secondary" onClick={() => onMove(note)}>
                Use it here
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Caps({
  parts,
  muted,
  small,
}: {
  parts: string[];
  muted?: boolean | undefined;
  small?: boolean | undefined;
}) {
  return (
    <span className="flex items-center gap-1">
      {parts.map((part, index) => (
        <Cap key={`${part}-${index}`} muted={muted} small={small}>
          {part}
        </Cap>
      ))}
    </span>
  );
}

function Cap({
  children,
  muted,
  small,
}: {
  children: ReactNode;
  muted?: boolean | undefined;
  small?: boolean | undefined;
}) {
  return (
    <kbd
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-[5px] font-sans font-medium shadow-[inset_0_0_0_1px_var(--keel-line-strong),inset_0_-1px_0_0_var(--keel-line-strong)]",
        small ? "h-5 min-w-5 px-1 text-[10px]" : "h-6 min-w-6 px-1.5 text-[11px]",
        muted ? "text-faint" : "bg-veil-2 text-foreground",
      )}
    >
      {children}
    </kbd>
  );
}
