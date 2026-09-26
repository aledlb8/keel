"use client";

import { useEffect, useRef, useState, type Dispatch } from "react";
import { Bell, BellOff, Maximize2, Minimize2, X } from "lucide-react";

import { AGENTS, AgentMark } from "../marks";
import { scriptFromPrompt, type Action, type Line, type Pane } from "./engine";

function LineView({ line, pane }: { line: Line; pane: Pane }) {
  const info = AGENTS[pane.agent];
  switch (line.kind) {
    case "banner":
      return (
        <div className="mb-3 inline-flex max-w-full flex-col gap-0.5 rounded-[6px] border border-white/15 px-3 py-2">
          <div className="flex items-center gap-2">
            <AgentMark agent={pane.agent} size={12} variant="glyph" />
            <span className="font-bold text-ink">{info.name}</span>
          </div>
          <div className="truncate text-faint">
            cwd <span className="text-dim">{line.text}</span>
          </div>
        </div>
      );
    case "user":
      return (
        <div className="-mx-3 my-1.5 bg-white/[0.06] px-3 py-1 text-ink">
          <span className="text-faint">› </span>
          {line.text}
        </div>
      );
    case "say":
      return (
        <div className="py-0.5 text-ink/90">
          <span className="text-ink">{info.bullet === "●" ? "● " : "  "}</span>
          {line.text}
        </div>
      );
    case "tool": {
      const [verb, ...rest] = line.text.split(" ");
      return (
        <div className="pt-1">
          <span style={{ color: info.accent }}>{info.bullet} </span>
          <span className="font-bold text-ink">{verb}</span>{" "}
          <span className="text-dim">{rest.join(" ")}</span>
        </div>
      );
    }
    case "detail":
      return <div className="text-faint">{"  ⎿  "}{line.text}</div>;
    case "add":
      return (
        <div className="ml-4 bg-[#4cc38a]/[0.09] px-1 whitespace-pre text-[#7fd9ad]">
          {line.text}
        </div>
      );
    case "del":
      return (
        <div className="ml-4 bg-[#ec5d5e]/[0.1] px-1 whitespace-pre text-[#f08d8d]">
          {line.text}
        </div>
      );
    case "ok":
      return <div className="py-0.5 text-done">{line.text}</div>;
    case "warn":
      return <div className="py-0.5 text-working">{line.text}</div>;
    case "cmd":
      return (
        <div className="pt-1">
          <span className="text-dim">keel</span>
          <span className="text-ink"> ❯ </span>
          <span className="text-ink">{line.text}</span>
        </div>
      );
    case "out":
    case "muted":
    default:
      return <div className="text-dim">{line.text}</div>;
  }
}

export function PaneView({
  pane,
  focused,
  now,
  seq,
  maximized,
  grab,
  dispatch,
}: {
  pane: Pane;
  focused: boolean;
  now: number;
  seq: number;
  maximized: boolean;
  /** Only take keyboard focus once the visitor has clicked into the demo. */
  grab: boolean;
  dispatch: Dispatch<Action>;
}) {
  const info = AGENTS[pane.agent];
  const [value, setValue] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const isShell = pane.agent === "shell";
  const working = pane.status === "working";

  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pane.lines.length, working]);

  useEffect(() => {
    if (focused && grab) input.current?.focus({ preventScroll: true });
  }, [focused, grab]);

  const secs = Math.max(0, Math.floor((now - pane.startedAt) / 1000));
  const frame = info.spinner[Math.floor(now / 120) % info.spinner.length];

  const submit = () => {
    const text = value.trim();
    if (isShell) {
      dispatch({ type: "shell", paneId: pane.id, cmd: value });
    } else if (text && !working) {
      dispatch({ type: "start", paneId: pane.id, script: scriptFromPrompt(text, seq) });
    }
    setValue("");
  };

  return (
    <div
      onPointerDown={() => {
        if (!focused) dispatch({ type: "focus", paneId: pane.id });
      }}
      className="sheen flex h-full w-full flex-col overflow-hidden rounded-[10px] border bg-slab transition-[border-color] duration-200"
      style={{
        borderColor: focused ? "rgba(255,255,255,0.17)" : "rgba(255,255,255,0.05)",
      }}
    >
      {/* Header */}
      <div className="flex h-[30px] shrink-0 items-center gap-2 px-2.5">
        <AgentMark agent={pane.agent} size={16} />
        <span
          className={`shrink-0 text-[12px] font-medium ${focused ? "text-ink" : "text-dim"}`}
        >
          {info.name}
        </span>
        {!isShell && pane.title !== "New session" && (
          <span className="truncate text-[11px] text-faint">{pane.title}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 text-faint">
          {!isShell && (
            <button
              type="button"
              aria-label={pane.muted ? "Unmute notifications" : "Mute notifications"}
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "mute", paneId: pane.id });
              }}
              className="grid size-6 place-items-center rounded-[5px] hover:bg-veil-2 hover:text-ink"
            >
              {pane.muted ? <BellOff size={12} /> : <Bell size={12} />}
            </button>
          )}
          <button
            type="button"
            aria-label={maximized ? "Restore pane" : "Maximize pane"}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: "maximize", paneId: maximized ? null : pane.id });
            }}
            className="grid size-6 place-items-center rounded-[5px] hover:bg-veil-2 hover:text-ink"
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            type="button"
            aria-label="Close pane"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: "close", paneId: pane.id });
            }}
            className="grid size-6 place-items-center rounded-[5px] hover:bg-veil-2 hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div
        className={`relative flex min-h-0 flex-1 flex-col font-mono text-[11.5px] leading-[17px] transition-opacity duration-300 ${focused ? "opacity-100" : "opacity-[0.82]"}`}
        onClick={() => input.current?.focus({ preventScroll: true })}
      >
        <div ref={body} className="term-scroll min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-2">
          {pane.lines.map((l) => (
            <LineView key={l.id} line={l} pane={pane} />
          ))}
          {working && (
            <div className="pt-1.5" style={{ color: info.accent }}>
              <span className="inline-block w-[1.2em]">{frame}</span>
              {pane.verb}…{" "}
              <span className="text-faint">
                ({secs}s · esc to interrupt)
              </span>
            </div>
          )}
          {!working && pane.status !== "working" && pane.finishedIn !== null && !isShell && (
            <div className="pt-1.5 text-faint">
              {info.spinner[4] ?? info.spinner[0]} Worked for {pane.finishedIn}s
            </div>
          )}
          {isShell && (
            <label className="flex items-center pt-1">
              <span className="text-dim">keel</span>
              <span className="text-ink">&nbsp;❯&nbsp;</span>
              <input
                ref={input}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => !focused && dispatch({ type: "focus", paneId: pane.id })}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                spellCheck={false}
                autoComplete="off"
                aria-label="Shell command"
                placeholder={focused ? "try git status" : ""}
                className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-white/20"
                style={{ caretColor: "#ededed" }}
              />
            </label>
          )}
        </div>
        {!isShell && (
          <div className="shrink-0 px-2.5 pb-2.5">
            <label
              className="flex items-center gap-2 rounded-[6px] border px-2.5 py-[7px] transition-colors"
              style={{
                borderColor: focused
                  ? `color-mix(in srgb, ${info.accent} 45%, rgba(255,255,255,0.1))`
                  : "rgba(255,255,255,0.1)",
              }}
            >
              <span className="text-faint">›</span>
              <input
                ref={input}
                value={value}
                disabled={working}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => !focused && dispatch({ type: "focus", paneId: pane.id })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                spellCheck={false}
                autoComplete="off"
                aria-label={`Task for ${info.name}`}
                placeholder={working ? "Esc to interrupt" : `Give ${info.name} a task`}
                className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-white/25 disabled:cursor-default"
                style={{ caretColor: info.accent }}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
