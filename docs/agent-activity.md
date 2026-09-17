# Agent activity detection

Completion is a turn transition, not an output timeout. The former detector
declared a pane finished after three seconds of silence and treated output
after six seconds of startup as work. Both assumptions fail for thinking,
tool execution, network pauses, and slow conversation restoration.

`src/lib/agentActivity.ts` owns one detector per terminal process lifetime.
Only a local Enter submission arms it. Startup banners, historical spinners,
restored responses, resize output, and terminal focus/device reports cannot
create a completed turn. Bracketed paste is input, not submission. Escape and
Ctrl+C cancel completion eligibility.

A completion requires observed busy UI followed by a recognised live input
prompt, stable for two seconds, with no visible changes for one second. Busy,
retry, and approval indicators prevent completion. Pending xterm writes block
completion until their parsed cells have been inspected. Identical redraws and
terminal title changes do not restart the visible-change timer. Durations use
`performance.now()`; wall time is only used for notification ordering and
conversation capture.

The screen reader uses the active buffer's `baseY`, never `viewportY`, so user
scrolling cannot turn historical output into current state. Sampling is bounded
to 120 rows from the bottom of the live buffer, coalesced with a 50 ms timer,
and works on hidden decks. A tall pane sets `truncated` because rows above that
window were skipped; the live composer is still in the sample, so adapters must
not treat truncated as "prompt missing". Raw PTY bytes still go directly to
xterm, which handles ANSI escapes, wrapping, cursor movement, alternate
buffers, and fragmented UTF-8 before detection. Full-width TUI borders occupy
an entire row and xterm marks them wrapped, so the reader joins them onto the
prompt line — a `❯` may sit in the middle of a joined string, not at column 0.

Current prompt adapters cover Claude Code, Codex, Gemini CLI, opencode, grok,
Cursor Agent, Crush, Aider, and Goose. These are conservative UI heuristics,
not an agent lifecycle protocol. Claude Code 2.1 keeps the composer visible
while thinking; a custom `statusLine` hides `? for shortcuts` and
`esc to interrupt`, so busy is the spinner/token clock and ready is the
prompt plus a mode badge or box. opencode 1.18 also keeps the composer (and
its `╹▀` edge, or `tab agents` / `ctrl+p commands` when the theme paints that
edge as spaces) while running; `esc interrupt` is what separates busy from
ready, and permission/question dialogs replace the composer. Changed layouts,
localised/custom interfaces, very fast turns with no observed busy frame, and
other agents may not produce a finished alert. Unknown layouts never fall back
to silence-based completion. An unconfirmed submission settles to idle; an
observed running turn remains working until there is enough evidence to finish
or the user cancels/the process exits. Auto-started work with no local
submission does not produce completion notifications. Add captured screen
fixtures and lifecycle tests when extending an adapter. Structured provider
lifecycle events would be a stronger future signal than terminal UI parsing.

The store consumes completion once: it records `doneAt` only for an unwatched
pane and clears the timestamp on acknowledgement, restart, or process exit.
Restarts invalidate the detector immediately. PTY start/exit events and parsed
screen callbacks carry the pane generation so an old process cannot update its
replacement. Host loss invalidates prompt evidence until fresh output arrives.

OS toasts and a short chime fire only when the window is unfocused — the island
already covers an in-app finish. A pane can be muted so it never toasts or
chimes. Process death is a separate "exited" alert, not a completion. On Windows,
toasts use the app identity of an installed build; `pnpm dev` may show them as
PowerShell.

Regression coverage lives in `agentActivity.test.ts` and
`attentionTracking.test.ts`. A release smoke test should also exercise installed
CLI versions with a long thinking/tool turn, an approval wait, a queued turn,
a hidden deck, a custom Claude status line, and a restored conversation.
