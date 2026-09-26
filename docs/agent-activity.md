# Agent activity and conversation identity

Keel uses provider lifecycle hooks for Claude Code, Codex, Grok, and OpenCode.

## Authoritative events

Each PTY receives an unguessable capability for a loopback listener. Its Tauri
channel is created before the shell starts and is bound to the pane generation.
Closing/restarting the PTY revokes that capability; stale frontend callbacks are
also rejected. Hooks run in the provider process environment and report the real
conversation ID. Keel saves that ID immediately and resumes it explicitly.
It no longer searches recently touched transcripts to decide which pane owns a
conversation. `/clear` or starting a new chat can update the identity.

Claude, Codex, and Grok call Keel's small `--keel-agent-hook` entry point. It reads
one JSON value without waiting for EOF, forwards only identity and lifecycle,
returns neutral `{}`, and does not initialize the desktop app. No tool permission
is granted or denied. OpenCode uses an event plugin, serializes lifecycle delivery,
ignores message deltas, and checks session parentage before publishing root events.
Subagent events cannot bind their IDs or finish a root turn.

SessionStart identifies a session without announcing completed work. A real
submission starts work; Stop consumes one completion. Duplicate Stops, stale
sequences, process exits, failures, and cancellations do not create extra finished
alerts. Claude compaction identity refreshes preserve the active turn. Live hooks
take precedence over terminal heuristics, and periodic parsed-screen reads stop
once this authority has been established. Automatic provider turns do not require
local Enter or an observed spinner.

Hook installation happens before Keel launches a supported agent. Claude settings
and Codex hooks are merged without moving user hook groups. Codex gets trust entries
for Keel's exact hook definitions only; existing user hook approvals and explicit
disabling remain intact. Grok and OpenCode use separate Keel-owned files. Account
homes and configured provider-home environment variables are respected. Hooks are
inert outside Keel because other shells do not have a capability. On Windows the
command-hook launcher uses encoded PowerShell to handle paths safely.

Grok also imports Claude's hook configuration. When `GROK_HOOK_EVENT` is set,
Keel's Claude observer returns neutral JSON without publishing; Grok's own
observer reports the event. This prevents an imported hook from relabeling a
Grok pane as Claude. On load, layouts affected by the earlier bug are repaired
only when a Claude-labeled pane retains a Grok home and its exact session ID
exists in that Grok account. The repair keeps the current chat ID and restores
the Grok account. It does not select a recent conversation.

Every hook also supplies its helper/plugin process ID. Before delivering an
event, the backend checks the live process tree: the sender must belong to the
agent identified in that pane, the provider label must match, and a different
agent nested between the owner and sender invalidates the event. This check
applies to every catalogue agent, including those without native Keel hooks.
It prevents imported hooks from changing provider, account, conversation or
activity state. No watcher tick is needed before the first valid event, and
quitting one CLI and manually starting another still works.

This is necessary beyond Grok: [Cursor imports third-party hooks](https://prod.cursor.com/docs/hooks),
and [OpenCode adapters can execute Claude hooks](https://github.com/romain325/opencode-hooks-plugin).
The check does not depend on an exhaustive list of compatibility environment
variables. Unknown wrappers, inaccessible process information and detached
runtimes cannot establish hook ownership; their hook events are ignored and
the screen fallback remains available until ownership can be verified.

The pane header indicates whether a conversation is linked for reopening. A linked
ID is not proof that the provider still retains its history: deleting a transcript,
changing accounts outside Keel, or disabling persistence can make a provider refuse
resume. Existing saved IDs are retained; Keel cannot reconstruct a chat already lost
by the previous timestamp-based capture.

## Persistence

Workspace writes are serialized, so an older snapshot cannot overwrite a newly
linked conversation. Ordinary layout mutations remain debounced. Binding a chat
queues a save immediately. Normal window close awaits the final write before
tearing down PTYs; a failed save leaves the app open with an error. A hard process
kill can still interrupt a save. Keel retains its existing atomic JSON replacement
and failed-load protection.

## Fallback and limits

The screen detector below remains available for unsupported agents, older CLI
versions, disabled hooks, or an integration that has not produced a live event.
It is not used to guess conversation ownership. An unlinked pane reopens as a fresh
chat. Launch a provider through Keel once to install its integration before relying
on hooks for a CLI typed manually into a plain shell. A provider started before
installation may need to restart to load the hooks.

This implementation does not add Orca's persistent PTY daemon, scrollback snapshots,
remote-host recovery, durable hook replay spool, or child-agent activity aggregation.
Child completion is ignored; background children outliving their parent are not
tracked separately. The agent's own resume command restores its conversation after
an app restart. Hidden terminals continue to stay mounted during the current run.

## Screen fallback

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
`performance.now()`; wall time is used for notification ordering.

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
not an agent lifecycle protocol. Claude Code 2.1.281 keeps the composer
visible while thinking. Its live spinner cycles `· ✢ * ✶ ✻ ✽` (reduced motion
uses `●`) and the verb ends in an ellipsis; a finished turn leaves
`✻ Worked for 4s` in the transcript, and that row is not busy. A custom
`statusLine` hides `? for shortcuts`, so ready is the prompt plus a mode badge
or box. The enter typed to launch the CLI is not a turn: a submission counts
only after a ready prompt has been seen. Codex on an Astra model paints braille
stars over the idle composer every 150ms; those cells do not restart the quiet
timer. opencode 1.18 also keeps the composer (and
its `╹▀` edge, or `tab agents` / `ctrl+p commands` when the theme paints that
edge as spaces) while running; `esc interrupt` is what separates busy from
ready, and permission/question dialogs replace the composer. Changed layouts,
localised/custom interfaces, very fast turns with no observed busy frame, and
other agents may not produce a finished alert. Unknown layouts never fall back
to silence-based completion. An unconfirmed submission settles to idle; an
observed running turn remains working until there is enough evidence to finish
or the user cancels/the process exits. Auto-started work with no local
submission does not produce completion notifications. Add captured screen
fixtures and lifecycle tests when extending an adapter. Provider lifecycle hooks above supersede this detector when available.

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

Regression coverage lives in `agentActivity.test.ts`, `attentionTracking.test.ts`,
`opencodeHooks.test.ts`, `persistQueue.test.ts`, and the Rust hook/config tests. A release smoke test should also exercise installed
CLI versions with a long thinking/tool turn, an approval wait, a queued turn,
a hidden deck, a custom Claude status line, and a restored conversation.
