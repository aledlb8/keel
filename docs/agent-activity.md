# Agent lifecycle and conversation restoration

## Ownership

| Identity | Owner | Lifetime |
| --- | --- | --- |
| Pane + generation | Keel | One terminal shell spawn |
| Agent process | OS process tree | One CLI invocation inside that shell |
| Conversation | Provider | A chat, which can survive a process restart |
| Turn | Provider, when supplied | One submission and its response |

`src/lib/agentRuntime.ts` owns lifecycle validation and transitions for a shell
generation. `src/lib/agentActivity.ts` is exclusively the parsed-screen fallback.
The store persists accepted identities and presents activity; it does not
implement a second hook state machine.

The backend attaches the verified owner process identity to every hook and to
watcher start/exit events. It compares processes as well as provider names. Windows
identities include creation time; other platforms currently use PID identity
(PID reuse in a very long-lived shell remains a limitation). Helper PIDs verify
ancestry; they are not the owner identity.

Stale channel sequences are rejected before changing providers or saved chat IDs.
Sequence ordering belongs to the shell and survives CLI exits. Retired processes
cannot reclaim a pane. A late watcher exit cannot end a replacement that already
emitted hooks; a late watcher start cannot erase the current owner's turn.

Conversation changes reset turn state. Only session start or submission can switch
an existing conversation. Codex turn IDs survive the helper/HTTP/Tauri path: a
previous turn's late Stop or Interrupt cannot end a newer turn. Other providers
have less precise ordering: channel sequence orders receipt, not event creation.

## Provider contracts

Reviewed 2026-09-26 against primary sources:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks): SessionStart identifies
  startup/resume/clear/compaction. Compaction preserves an active turn. Stop does
  not fire on user interruption; API failures emit StopFailure. Other Stop hooks
  can request continuation, so subsequent work must retract completion.
- [Codex hooks](https://developers.openai.com/codex/hooks): turn-scoped events carry
  `turn_id`; Interrupt refers to the interrupted turn. Subagent hooks must not
  finish the root pane, even when they carry its session ID.
- [Grok Build hooks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md):
  StopCancelled and StopFailure differ from successful Stop. Imported Claude hooks
  are not evidence that the invoking process is Claude.
- [OpenCode plugins](https://opencode.ai/docs/plugins/): lifecycle and permission
  events are independent of terminal rendering. Keel serializes SDK lookups and
  delivery, checks root parentage, ignores token deltas and unknown statuses, and
  treats retries/replies as progress rather than new submissions.

Installed versions inspected: Claude Code 2.1.283, Grok 1.0.41, OpenCode 1.18.32.
Version inspection is not a live conversation smoke test.

The installed Claude startup hook was also exercised against the built Keel
executable using an isolated configuration, open loopback listener and the Windows
PowerShell launcher. It delivered one SessionStart with conversation identity.
Reproduce with `cargo build --manifest-path src-tauri/Cargo.toml` then
`pnpm test:agent-hooks` (requires Claude on PATH). This uses `--init-only`, with no
model request, and does not modify the user's provider configuration.

Hook installation precedes launch and preserves user groups and explicit Codex
hook disabling. PreToolUse/PostToolUse provide continuation and permission-response
evidence. Hooks receive a pane-scoped loopback capability. Process ancestry rejects
imported hooks from the wrong provider and nested CLIs. The helper reads one JSON
value without waiting for EOF and returns neutral JSON. Prompts, tool arguments,
transcripts and credentials are not forwarded. OpenCode and Grok use separate
Keel-owned files; Claude and Codex merge Keel's groups into settings.

## Activity

| Event | Result |
| --- | --- |
| Session / identity / compaction | Link identity; preserve an existing turn in the same chat |
| Submission | Working; clear previous completion/cancellation |
| Progress | Working unless this turn failed, ended or was cancelled |
| Permission/question wait | Waiting for input; available through F8 navigation |
| Stop after work | One completion, suppressed when this terminal has focus |
| Duplicate or unmatched Stop | No additional completion |
| Failure / cancellation / session end | Idle, no success alert |
| CLI exit | Release that process; retain shell event ordering |
| Shell restart | New generation; invalidate old callbacks and ordering |

Acknowledgement clears pending completion even before the attention timer paints
it. Waiting does not play a completion chime. A local interrupt temporarily enables
fresh screen sampling. A stable live prompt can settle it to cancelled, never to
done. This handles Claude's missing Stop-on-interrupt event. Ordinary protocol work
never completes from silence, a ready-looking composer or a timeout.

Fallback reads xterm's parsed active buffer, not ANSI bytes or the scrollback
viewport. It requires local submission after a recognized composer, observed busy
UI, then a stable ready prompt (2 seconds, with 1 second of visible quiet).
Pending writes block completion. Paste, focus reports, resize redraws and restored
history cannot manufacture a turn. Unsupported/custom/localized layouts may stay
unknown. Screen inference never assigns conversation identity.

## Persistence

Accepted IDs are saved immediately with provider and account. Writes are serialized;
closing also drains identities queued during the close-time write. Failed saves
show Retry save. A failed close-time save keeps the window open. Atomic JSON
replacement and failed-load protection remain.

Resume commands name the exact saved ID and preserve quoted executable paths.
Unlinked panes launch fresh. The unused recent-session API, private SQLite schema
readers, timestamp discovery code and SQLite dependency have been removed.
`sessions.rs` retains ID validation and the exact-ID legacy Grok identity repair.

Grok is the exception to hook capture on Windows. Its command hooks would open a
console window per event, and its HTTP hooks accept only `https://` and refuse
loopback. Instead, Enter in a Grok pane makes Keel read Grok's own registry of
live chats (`active_sessions.json`) after 2 and 10 seconds. It takes the entry
whose `pid` is a `grok` process under that pane's shell, newest first, and
ignores entries opened before that process started (an earlier holder of the
PID). New Grok panes still launch bare; the captured ID is resumed with
`--resume`, and a `/new` is picked up on the next Enter.

Grok also imports the hooks in `~/.claude/settings.json`, which holds Keel's Claude
observer. On Windows every Keel shell sets `GROK_CLAUDE_HOOKS_ENABLED=0`, so
Grok skips that file instead of starting a console shell for each event. A
user's own Claude hooks therefore do not run inside Grok in a Keel pane.

The linked indicator confirms a captured ID, not a successful future resume.
Deleted provider history, disabled persistence, external account changes or an
unsupported CLI version can prevent resumption. A hard kill can interrupt a save.
This is conversation resumption, not PTY resurrection or scrollback persistence.

## Verification

Run `pnpm check` for type checking, frontend tests, rustfmt, Clippy with warnings
denied, and Rust tests. Relevant behavior coverage:

- `attentionTracking.test.ts`: five regressions first demonstrated failing against
  the old implementation, plus store/timer, focus, hidden-deck and generation tests.
- `agentRuntime.test.ts`: watcher ordering across all four providers, retired
  processes and turns, interruption, paste and malformed events.
- `persistRestore.test.ts`: eight concurrent panes written to a temporary disk
  file and reloaded, separate accounts, replacement processes, stale events,
  failed writes and recovery.
- `persistQueue.test.ts`: delayed writes and identity changes during close.
  `launch.test.ts`: exact-ID arguments including quoted Windows executables.
- Rust hook tests: real child processes, open stdin, loopback HTTP, process-tree
  checks, Tauri serialization, identity, isolation and revocation. The test
  executable stands in for a provider; this does not test its hook loader.
- OpenCode tests execute the exact embedded plugin. Config tests preserve user
  hook groups, Codex trust and disabled settings.

Release smoke coverage still requires interactive conversations in the native app:
two panes of one provider, separate accounts, approval/reply, interruption, long
tools, /clear or /new, exit/relaunch, close/reopen and hidden decks. Fixtures cannot
establish compatibility with every future provider release.
