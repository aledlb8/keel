/**
 * Telegram: one agent you can message from your phone.
 *
 * Two faces. Until a phone is paired it is a short setup — make a bot, then
 * scan a code with the phone — and nothing else competes with that. Once
 * paired it becomes the conversation itself, with the few settings that shape
 * it in a rail beside it: which agent answers, what languages you speak, when
 * Keel should text you, and the connection.
 *
 * Colour follows the app's rule: the agent's own accent marks who is talking,
 * status colours say what is happening, and the rest is graphite.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { encode } from "uqr";

import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusLight } from "@/components/VpnDialog";
import { ask } from "@/lib/ask";
import {
  MAIN_AGENTS,
  type AssistantConfigure,
  type AssistantForward,
  type AssistantLogEntry,
  type AssistantSnapshot,
} from "@/lib/assistant";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAssistant } from "@/state/assistant";
import { useKeel } from "@/state/store";

type Tone = "connected" | "connecting" | "error" | "idle";

const TONE_COLOR: Record<Tone, string> = {
  connected: "var(--keel-done)",
  connecting: "var(--keel-working)",
  error: "var(--keel-dead)",
  idle: "var(--keel-text-faint)",
};

/** One reading of the bot's state, shared by the dialog and the footer chip. */
export function assistantView(snapshot: AssistantSnapshot | null): {
  tone: Tone;
  color: string;
  headline: string;
} {
  const tone: Tone =
    !snapshot || !snapshot.tokenSet || !snapshot.enabled
      ? "idle"
      : snapshot.phase === "error"
        ? "error"
        : snapshot.busy || snapshot.phase !== "online" || !snapshot.owner
          ? "connecting"
          : "connected";
  const headline = !snapshot?.tokenSet
    ? "Not set up"
    : !snapshot.enabled
      ? "Paused"
      : snapshot.phase === "error"
        ? "Can't reach Telegram"
        : snapshot.phase !== "online"
          ? "Connecting…"
          : !snapshot.owner
            ? "Waiting to pair"
            : snapshot.busy
              ? "Working"
              : "Listening";
  return { tone, color: TONE_COLOR[tone], headline };
}

const configure = (change: AssistantConfigure) =>
  void useAssistant
    .getState()
    .configure(change)
    .catch((error: unknown) => toast.error(String(error)));

export function AssistantDialog() {
  const open = useAssistant((state) => state.dialogOpen);
  const snapshot = useAssistant((state) => state.snapshot);
  const paired = Boolean(snapshot?.tokenSet && snapshot.owner);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) useAssistant.getState().openDialog();
        else useAssistant.getState().closeDialog();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Focus moves to the composer or the token field on its own terms.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className={cn(
          "gap-0 overflow-hidden p-0",
          paired
            ? "h-[min(640px,86vh)] max-w-[900px] sm:max-w-[900px]"
            : "max-w-[480px] sm:max-w-[480px]",
        )}
      >
        {!snapshot ? (
          <div className="flex items-center gap-2 p-6 text-body text-faint">
            <LoaderCircle className="size-4 animate-spin" />
            Loading…
            <DialogTitle className="sr-only">Telegram</DialogTitle>
          </div>
        ) : paired ? (
          <Paired snapshot={snapshot} />
        ) : (
          <Setup snapshot={snapshot} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CloseButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={() => useAssistant.getState().closeDialog()}
      className={cn("k-icon-btn size-7", className)}
    >
      <X className="size-4" />
    </button>
  );
}

/* ------------------------------------------------------------------ setup */

function Setup({ snapshot }: { snapshot: AssistantSnapshot }) {
  const step = snapshot.tokenSet ? 2 : 1;
  return (
    <div className="flex flex-col">
      <header className="relative px-7 pb-6 pt-7">
        <CloseButton className="absolute right-4 top-4" />
        <span className="grid size-10 place-items-center rounded-[12px] bg-veil-2 text-foreground shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
          <Send className="size-[18px] -translate-x-px translate-y-px" />
        </span>
        <DialogTitle className="mt-4 text-display font-semibold tracking-[-0.015em]">
          Message Keel from your phone
        </DialogTitle>
        <DialogDescription className="mt-1.5 max-w-[24rem] text-row leading-relaxed text-faint">
          Pair a Telegram bot and one of your agents answers it. It can see
          what&apos;s open here, work in your projects, and start other agents.
        </DialogDescription>
      </header>

      <ol className="flex flex-col border-t border-line">
        <StepRow n={1} title="Connect a bot" state={step === 1 ? "current" : "done"} detail={snapshot.bot ? `@${snapshot.bot}` : null}>
          {step === 1 ? <TokenForm /> : null}
        </StepRow>
        <StepRow n={2} title="Pair your phone" state={step === 2 ? "current" : "next"}>
          {step === 2 ? <PairCode snapshot={snapshot} /> : null}
        </StepRow>
      </ol>

      {snapshot.phase === "error" && snapshot.error ? (
        <p className="border-t border-line px-7 py-3 text-body leading-snug text-[color:var(--keel-dead)]">
          {snapshot.error}
        </p>
      ) : null}
    </div>
  );
}

function StepRow({
  n,
  title,
  state,
  detail,
  children,
}: {
  n: number;
  title: string;
  state: "done" | "current" | "next";
  detail?: string | null;
  children?: ReactNode;
}) {
  return (
    <li className={cn("border-b border-line px-7 py-4 last:border-b-0", state === "current" && "bg-veil")}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "grid size-[22px] shrink-0 place-items-center rounded-full text-small font-semibold tabular-nums",
            state === "done" && "bg-[color:var(--keel-done)] text-[color:var(--keel-void)]",
            state === "current" && "bg-foreground text-[color:var(--keel-void)]",
            state === "next" && "text-faint shadow-[inset_0_0_0_1px_var(--keel-line-strong)]",
          )}
        >
          {state === "done" ? "✓" : n}
        </span>
        <span className={cn("text-row font-medium", state === "next" ? "text-faint" : "text-foreground")}>
          {title}
        </span>
        {detail ? <span className="ml-auto text-body text-faint">{detail}</span> : null}
      </div>
      {children ? <div className="mt-4 pl-[34px]">{children}</div> : null}
    </li>
  );
}

function TokenForm() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await useAssistant.getState().setToken(token);
      setToken("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={connect} className="flex flex-col gap-3">
      <p className="text-body leading-relaxed text-dim">
        In Telegram, open{" "}
        <button
          type="button"
          onClick={() => void openUrl("https://t.me/BotFather").catch(() => {})}
          className="font-medium text-foreground underline decoration-[var(--keel-line-strong)] underline-offset-2 hover:decoration-foreground"
        >
          @BotFather
        </button>
        , send <code className="rounded-[4px] bg-veil-2 px-1 font-mono text-small text-foreground">/newbot</code>,
        pick a name, and paste the token it replies with.
      </p>
      <div className="flex gap-2">
        <input
          autoFocus
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Bot token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-label="Bot token"
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-0 flex-1 rounded-[var(--keel-r-control)] bg-[color:var(--keel-void)] px-2.5 font-mono text-body text-foreground shadow-[inset_0_0_0_1px_var(--keel-line-strong)] outline-none placeholder:font-sans placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--keel-text-dim)] aria-invalid:shadow-[inset_0_0_0_1px_var(--keel-dead)]"
        />
        <Button size="sm" type="submit" disabled={busy || !token.trim()} className="h-8">
          {busy ? <LoaderCircle className="animate-spin" /> : null}
          Connect
        </Button>
      </div>
      {error ? (
        <p className="text-body leading-snug text-[color:var(--keel-dead)]">{error}</p>
      ) : (
        <p className="text-small text-faint">The token stays on this PC.</p>
      )}
    </form>
  );
}

/** The pairing link as a QR code, dark on light so any phone camera reads it. */
function QrCode({ text, size = 148 }: { text: string; size?: number }) {
  const qr = useMemo(() => encode(text, { border: 0, ecc: "M" }), [text]);
  const cells = qr.size;
  const path = useMemo(() => {
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return d;
  }, [qr]);
  return (
    <span className="block shrink-0 rounded-[12px] bg-[#ededed] p-2.5" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${cells} ${cells}`} width="100%" height="100%" shapeRendering="crispEdges" aria-hidden>
        <path d={path} fill="#0a0a0a" />
      </svg>
    </span>
  );
}

function PairCode({ snapshot }: { snapshot: AssistantSnapshot }) {
  if (!snapshot.pairingCode || !snapshot.pairingLink) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-body text-dim">The last code expired.</p>
        <Button size="sm" variant="outline" onClick={() => void useAssistant.getState().pair()}>
          <RefreshCw />
          New code
        </Button>
      </div>
    );
  }
  const link = snapshot.pairingLink;
  return (
    <div className="flex gap-5">
      <QrCode text={link} />
      <div className="flex min-w-0 flex-col">
        <p className="text-body leading-relaxed text-dim">
          Scan with your phone&apos;s camera and tap <span className="text-foreground">Start</span> in Telegram.
        </p>
        <p className="mt-3 text-small text-faint">Or send the bot this code:</p>
        <span className="mt-1 font-mono text-[22px] font-semibold tracking-[0.18em] text-foreground tabular-nums">
          {snapshot.pairingCode}
        </span>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-small">
          <button
            type="button"
            className="flex items-center gap-1 text-dim hover:text-foreground"
            onClick={() => void openUrl(link).catch(() => {})}
          >
            <ExternalLink className="size-3" />
            Open on this PC
          </button>
          <button
            type="button"
            className="text-faint hover:text-foreground"
            onClick={() => void useAssistant.getState().setToken("")}
          >
            Use another bot
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- paired */

function useMainAgent(snapshot: AssistantSnapshot) {
  const agents = useKeel((state) => state.agents);
  const agent = agents.find((item) => item.id === snapshot.agentId) ?? null;
  return { agents, agent };
}

function Paired({ snapshot }: { snapshot: AssistantSnapshot }) {
  const { agent } = useMainAgent(snapshot);
  const { tone, color, headline } = assistantView(snapshot);
  const name = agent?.name ?? "No agent";

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_288px]">
      <section className="flex min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <AgentMark agentId={agent?.id} name={name} accent={agent?.accent ?? ""} size={30} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-title font-semibold tracking-[-0.01em]">{name}</DialogTitle>
            <DialogDescription className="truncate text-small text-faint">
              Answering @{snapshot.bot} on Telegram
            </DialogDescription>
          </div>
          <span
            className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-2 pr-2.5 text-small font-medium text-dim shadow-[inset_0_0_0_1px_var(--keel-line)]"
            title={snapshot.phase === "error" ? (snapshot.error ?? undefined) : undefined}
          >
            <StatusLight tone={tone} color={color} size={7} />
            {headline}
          </span>
        </header>
        <Transcript snapshot={snapshot} agent={agent} />
        <Composer snapshot={snapshot} name={name} />
      </section>
      <Rail snapshot={snapshot} />
    </div>
  );
}

/** A turn's tool calls fold into one line; the reply is what matters. */
type Row =
  | { kind: "message"; entry: AssistantLogEntry }
  | { kind: "tools"; id: number; labels: string[] }
  | { kind: "note"; entry: AssistantLogEntry };

function rowsOf(log: AssistantLogEntry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of log) {
    if (entry.kind === "tool") {
      const last = rows[rows.length - 1];
      if (last?.kind === "tools") last.labels.push(entry.text);
      else rows.push({ kind: "tools", id: entry.id, labels: [entry.text] });
    } else if (entry.kind === "event") {
      rows.push({ kind: "note", entry });
    } else {
      rows.push({ kind: "message", entry });
    }
  }
  return rows;
}

function Transcript({ snapshot, agent }: { snapshot: AssistantSnapshot; agent: Agent | null }) {
  const log = useAssistant((state) => state.log);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => rowsOf(log), [log]);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log.length, snapshot.busy]);

  if (rows.length === 0 && !snapshot.busy) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-10 text-center">
        <p className="text-row font-medium text-foreground">Say something to @{snapshot.bot}</p>
        <p className="max-w-[22rem] text-body leading-relaxed text-faint">
          Ask what&apos;s running, have it start an agent in a project, or send a
          screenshot or a voice note. The conversation shows up here too.
        </p>
      </div>
    );
  }

  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-5">
      {rows.map((row) =>
        row.kind === "tools" ? (
          <ToolRow key={`t${row.id}`} labels={row.labels} />
        ) : row.kind === "note" ? (
          <Note key={row.entry.id} entry={row.entry} />
        ) : (
          <Message key={row.entry.id} entry={row.entry} />
        ),
      )}
      {snapshot.busy ? (
        <div className="flex items-center gap-2 py-1 text-body text-faint">
          <AgentMark agentId={agent?.id} name={agent?.name} accent={agent?.accent ?? ""} size={16} variant="glyph" />
          <span className="k-shimmer-text truncate">{snapshot.activity ?? "Thinking"}…</span>
          {snapshot.queued > 0 ? <span className="shrink-0">· {snapshot.queued} waiting</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Message({ entry }: { entry: AssistantLogEntry }) {
  const mine = entry.kind === "in";
  const failed = entry.kind === "error";
  return (
    <div className={cn("group flex max-w-[82%] flex-col gap-1", mine ? "self-end items-end" : "self-start")}>
      <div
        className={cn(
          "rounded-[14px] px-3 py-2 text-row leading-[1.5]",
          mine && "rounded-br-[5px] bg-veil-3 text-foreground",
          !mine && !failed && "rounded-bl-[5px] bg-veil-1 text-foreground shadow-[inset_0_0_0_1px_var(--keel-line)]",
          failed &&
            "rounded-bl-[5px] text-[color:var(--keel-dead)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--keel-dead)_35%,transparent)]",
        )}
      >
        {mine || failed ? <p className="whitespace-pre-wrap break-words">{entry.text}</p> : <Markdown text={entry.text} />}
      </div>
      <span className="px-1 text-micro text-faint opacity-0 transition-opacity group-hover:opacity-100">
        {time(entry.at)}
      </span>
    </div>
  );
}

function ToolRow({ labels }: { labels: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="self-start">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-[6px] py-0.5 pr-1.5 text-small text-faint hover:text-dim"
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {labels.length === 1 ? labels[0] : `${labels[labels.length - 1]} and ${labels.length - 1} more`}
      </button>
      {open ? (
        <ul className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-line pl-3 font-mono text-micro text-faint">
          {labels.map((label, index) => (
            <li key={index} className="truncate">
              {label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** System lines: pairing, stops, and what a voice note was heard as. */
function Note({ entry }: { entry: AssistantLogEntry }) {
  const heard = /^Heard \((\w+)\): ([\s\S]*)$/.exec(entry.text);
  if (heard) {
    return (
      <p className="self-end max-w-[82%] text-right text-small italic leading-snug text-faint">
        heard in {languageName(heard[1]!)}: “{heard[2]}”
      </p>
    );
  }
  return <p className="self-center py-1 text-small text-faint">{entry.text}</p>;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The small part of Markdown agents use in chat: code, bold, lists. */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```[^\n]*\n?/);
  return (
    <div className="flex flex-col gap-1.5 break-words">
      {blocks.map((block, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-[8px] bg-[color:var(--keel-void)] px-2.5 py-2 font-mono text-small leading-relaxed text-dim"
          >
            {block.replace(/\n$/, "")}
          </pre>
        ) : (
          block
            .split(/\n{2,}/)
            .filter((paragraph) => paragraph.trim())
            .map((paragraph, part) => (
              <p key={`${index}-${part}`} className="whitespace-pre-wrap">
                {paragraph.split("\n").map((line, at, lines) => (
                  <span key={at}>
                    {inline(line.replace(/^(\s*)[-*] /, "$1• ").replace(/^#{1,6} /, ""))}
                    {at < lines.length - 1 ? "\n" : null}
                  </span>
                ))}
              </p>
            ))
        ),
      )}
    </div>
  );
}

function inline(line: string): ReactNode[] {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={index} className="rounded-[4px] bg-veil-2 px-1 font-mono text-[0.92em]">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={index} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

function Composer({ snapshot, name }: { snapshot: AssistantSnapshot; name: string }) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await useAssistant.getState().send(text);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setDraft(text);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-line p-3">
      <div className="flex items-end gap-2 rounded-[12px] bg-[color:var(--keel-void)] p-1.5 pl-3 shadow-[inset_0_0_0_1px_var(--keel-line)] focus-within:shadow-[inset_0_0_0_1px_var(--keel-line-strong)]">
        <textarea
          ref={field}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          placeholder={`Message ${name}. Replies also go to your phone.`}
          aria-label={`Message ${name}`}
          className="max-h-28 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-row leading-[1.45] text-foreground outline-none [field-sizing:content] placeholder:text-faint"
        />
        {snapshot.busy ? (
          <button
            type="button"
            aria-label="Stop"
            title="Stop the current task"
            onClick={() => void useAssistant.getState().stop()}
            className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-veil-3 text-foreground hover:bg-veil-2"
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Send"
          disabled={!draft.trim()}
          onClick={() => void send()}
          className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-foreground text-[color:var(--keel-void)] transition-opacity disabled:opacity-25"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- rail */

const FORWARD: Array<{ value: AssistantForward; label: string }> = [
  { value: "never", label: "Never" },
  { value: "background", label: "When away" },
  { value: "always", label: "Always" },
];

/** Languages offered as chips; Whisper understands many more. */
const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
];

function RailSection({ title, children, hint }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-line px-4 py-4 last:border-b-0">
      <h3 className="text-body font-medium text-dim">{title}</h3>
      {children}
      {hint ? <p className="text-small leading-snug text-faint">{hint}</p> : null}
    </section>
  );
}

function Rail({ snapshot }: { snapshot: AssistantSnapshot }) {
  return (
    <aside className="flex min-h-0 flex-col border-l border-line bg-veil">
      <div className="flex justify-end px-2 pt-2">
        <CloseButton />
      </div>
      <div className="-mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
        <AgentChoice snapshot={snapshot} />
        <VoiceChoice snapshot={snapshot} />
        <RailSection title="Text me when an agent finishes">
          <div className="k-seg">
            {FORWARD.map((option) => (
              <button
                key={option.value}
                type="button"
                data-active={snapshot.forward === option.value}
                onClick={() => configure({ forward: option.value })}
                className="k-seg-btn h-[24px] flex-1 whitespace-nowrap px-1.5 text-small"
              >
                {option.label}
              </button>
            ))}
          </div>
        </RailSection>
        <div className="flex-1" />
        <Connection snapshot={snapshot} />
      </div>
    </aside>
  );
}

function AgentChoice({ snapshot }: { snapshot: AssistantSnapshot }) {
  const agents = useKeel((state) => state.agents);
  const accounts = useKeel((state) => state.accounts);
  const choices = agents.filter(
    (agent) => (MAIN_AGENTS as readonly string[]).includes(agent.id) && agent.installed,
  );
  const logins = accounts.filter((account) => account.agentId === snapshot.agentId);

  return (
    <RailSection
      title="Who answers"
      hint={
        snapshot.hasSession ? (
          <button
            type="button"
            className="flex items-center gap-1 hover:text-foreground"
            onClick={async () => {
              const ok = await ask("The agent won't remember what you talked about.", {
                title: "Start a new conversation?",
                confirm: "Start over",
                destructive: false,
              });
              if (ok) void useAssistant.getState().newConversation();
            }}
          >
            <RotateCcw className="size-3" />
            Start a new conversation
          </button>
        ) : null
      }
    >
      {choices.length === 0 ? (
        <p className="text-body text-faint">Install Claude Code, Codex, opencode, Pi or Grok Build.</p>
      ) : (
        <div className="grid grid-cols-5 gap-1.5">
          {choices.map((agent) => {
            const on = agent.id === snapshot.agentId;
            return (
              <button
                key={agent.id}
                type="button"
                title={agent.name}
                aria-label={agent.name}
                aria-pressed={on}
                onClick={() => configure({ agentId: agent.id })}
                className={cn(
                  "grid aspect-square place-items-center rounded-[10px] transition-[background-color,box-shadow]",
                  on ? "bg-veil-3" : "hover:bg-veil-2",
                )}
                style={
                  on
                    ? { boxShadow: `inset 0 0 0 1.5px color-mix(in srgb, ${agent.accent || "var(--keel-text)"} 70%, transparent)` }
                    : undefined
                }
              >
                <AgentMark agentId={agent.id} name={agent.name} accent={agent.accent} size={24} muted={!on} />
              </button>
            );
          })}
        </div>
      )}
      {logins.length > 0 ? (
        <div className="k-seg mt-1 flex-wrap">
          {[{ id: null, name: "Normal login" }, ...logins].map((login) => (
            <button
              key={login.id ?? "default"}
              type="button"
              data-active={(snapshot.accountId ?? null) === login.id}
              onClick={() => configure({ accountId: login.id })}
              className="k-seg-btn h-[22px] px-2 text-small"
            >
              {login.name}
            </button>
          ))}
        </div>
      ) : null}
    </RailSection>
  );
}

function VoiceChoice({ snapshot }: { snapshot: AssistantSnapshot }) {
  const [checking, setChecking] = useState(false);
  const chosen = snapshot.languages;

  if (!snapshot.voice) {
    return (
      <RailSection
        title="Voice notes"
        hint={
          <>
            Need Whisper on this PC:{" "}
            <code className="font-mono text-foreground/80">pip install openai-whisper</code>, plus ffmpeg.
          </>
        }
      >
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              await useAssistant.getState().checkVoice();
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Check again
        </Button>
      </RailSection>
    );
  }

  return (
    <RailSection
      title="Voice notes in"
      hint={
        chosen.length === 0
          ? "Any language. Pick yours so short notes aren't heard as another one."
          : `Transcribed here with ${snapshot.voice}.`
      }
    >
      <div className="flex flex-wrap gap-1">
        {LANGUAGES.map((language) => {
          const on = chosen.includes(language.code);
          return (
            <button
              key={language.code}
              type="button"
              aria-pressed={on}
              onClick={() =>
                configure({
                  languages: on
                    ? chosen.filter((code) => code !== language.code)
                    : [...chosen, language.code],
                })
              }
              className={cn(
                "h-[24px] rounded-full px-2.5 text-small font-medium transition-colors",
                on
                  ? "bg-foreground text-[color:var(--keel-void)]"
                  : "text-dim shadow-[inset_0_0_0_1px_var(--keel-line-strong)] hover:text-foreground",
              )}
            >
              {language.label}
            </button>
          );
        })}
      </div>
    </RailSection>
  );
}

function Connection({ snapshot }: { snapshot: AssistantSnapshot }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line px-4 py-4">
      <div className="flex items-center gap-2 text-body">
        <span className="min-w-0 flex-1 truncate text-dim">
          <span className="text-foreground">{snapshot.owner}</span> on @{snapshot.bot}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={snapshot.enabled}
          title={snapshot.enabled ? "Pause the bot" : "Resume the bot"}
          onClick={() => configure({ enabled: !snapshot.enabled })}
          className={cn(
            "relative h-[18px] w-8 shrink-0 rounded-full transition-colors",
            snapshot.enabled ? "bg-foreground" : "bg-veil-3",
          )}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 size-[14px] rounded-full transition-transform",
              snapshot.enabled ? "translate-x-[14px] bg-[color:var(--keel-void)]" : "bg-foreground/70",
            )}
          />
        </button>
      </div>
      {snapshot.phase === "error" && snapshot.error ? (
        <p className="text-small leading-snug text-[color:var(--keel-dead)]">{snapshot.error}</p>
      ) : null}
      <div className="flex gap-3 text-small">
        <button
          type="button"
          className="text-faint hover:text-foreground"
          onClick={async () => {
            const ok = await ask("You'll need to scan a new code to pair again.", {
              title: `Unpair ${snapshot.owner}?`,
              confirm: "Unpair",
            });
            if (ok) void useAssistant.getState().unpair();
          }}
        >
          Unpair phone
        </button>
        <button
          type="button"
          className="text-faint hover:text-foreground"
          onClick={async () => {
            const ok = await ask("Keel stops listening to this bot. Your phone stays paired.", {
              title: "Disconnect the bot?",
              confirm: "Disconnect",
            });
            if (ok) void useAssistant.getState().setToken("");
          }}
        >
          Disconnect bot
        </button>
      </div>
    </section>
  );
}
