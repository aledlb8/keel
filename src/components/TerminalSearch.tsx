/**
 * Find-in-scrollback controls for one terminal.
 *
 * Absolute overlay on the xterm host — it must not take layout height, or the
 * PTY grid would change and agent TUIs would reflow. The SearchAddon does the
 * matching; this is only the field, the count, and next/prev/close.
 */

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { isTerminalFindChord } from "@/lib/terminalFind";

export function TerminalSearch({
  value,
  onValueChange,
  caseSensitive,
  onCaseSensitiveChange,
  resultIndex,
  resultCount,
  onNext,
  onPrevious,
  onClose,
  inputRef,
}: {
  value: string;
  onValueChange: (value: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  resultIndex: number;
  resultCount: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const onBarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Enter on next/prev/close must activate that button, not also search.
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      event.shiftKey ? onPrevious() : onNext();
      return;
    }
    const action = isTerminalFindChord(event);
    if (!action) return;
    event.preventDefault();
    if (action === "open") {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (action === "next") onNext();
    else onPrevious();
  };

  const querying = value.length > 0;
  const countLabel = !querying
    ? ""
    : resultCount === 0
      ? "No results"
      : resultIndex < 0
        ? `${resultCount}+`
        : `${resultIndex + 1}/${resultCount}`;

  return (
    <div
      role="search"
      className="absolute top-2 right-2 z-20 flex max-w-[calc(100%-16px)] items-center gap-0.5 rounded-[var(--keel-r-control)] border border-line-strong bg-[color:var(--keel-chrome-strong)] p-1 shadow-[var(--keel-lift)]"
      onKeyDown={onBarKeyDown}
    >
      <div className="k-field min-w-0 w-[220px] flex-1">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="Find in scrollback"
          aria-label="Find in scrollback"
          onChange={(event) => onValueChange(event.target.value)}
        />
      </div>
      <span
        aria-live="polite"
        className="min-w-[4.25rem] px-1 text-right text-[11px] tabular-nums text-faint"
      >
        {countLabel}
      </span>
      <IconButton
        label="Match case"
        pressed={caseSensitive}
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        <CaseSensitive className="size-3.5" />
      </IconButton>
      <IconButton label="Previous match" shortcut="Shift+F3" onClick={onPrevious}>
        <ChevronUp className="size-3.5" />
      </IconButton>
      <IconButton label="Next match" shortcut="F3" onClick={onNext}>
        <ChevronDown className="size-3.5" />
      </IconButton>
      <IconButton label="Close" shortcut="Esc" onClick={onClose}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      data-primary={pressed ? "true" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="k-icon-btn size-6"
    >
      {children}
    </button>
  );
}
