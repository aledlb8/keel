# Telegram main agent

One coding agent you message from your phone, which can see and drive the rest
of Keel. Open it from the **Telegram** chip in the status bar, Help → Telegram…,
or the Ctrl+P switcher.

## Setup

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`,
   and paste the token into Keel. Use a bot made for Keel: Telegram lets only
   one program read a bot's messages.
2. Keel shows a six-digit code for 15 minutes. Open the bot and press Start
   (the button in Keel opens it with the code filled in), or send the code.
   The first account to send it is paired; everyone else is ignored without a
   reply.
3. Choose the main agent. It runs with your own login and permission prompts
   off, the same way Keel launches agents in panes.

Bot commands: `/status` (what's running, answered without a model), `/stop`,
`/new` (fresh conversation), `/agent`, `/help`.

## Bob

The main agent is Bob: a coworker who texts, not a help desk. Short, plain,
opinionated, allowed a joke or a swear when it lands, and never opening with
"Great question". Two files in `<config>/assistant/` shape him, and both go
into his instructions on every turn (up to 4,000 characters each):

- `SOUL.md` — his personality. Written from `src-tauri/src/assistant_soul.md`
  the first time; after that the copy in the folder is the one used. Edit it,
  or ask Bob to change how he talks. Delete it to get the default back.
- `USER.md` — what he knows about you. Bob adds a line when he learns
  something lasting (how you like things done, which agent for what, your
  projects) and fixes lines that stop being true. It survives `/new`, which
  only forgets the conversation.

The working rules (short replies, the acknowledgement, passing your words on
unchanged) stay in `RULES` in `assistant.rs`, ahead of both files.

## Images and voice messages

- **Images** (photos, or images sent as files to keep their quality) are saved
  in `<config>/assistant/inbox/` and attached to the turn: `--image` for Codex,
  `--file` for opencode, `@path` for Pi; Claude and Grok open the path given
  in the prompt. An album becomes one turn.
- **Voice notes and audio files** are transcribed on this PC with OpenAI
  Whisper (`pip install openai-whisper`, plus ffmpeg on PATH), using the best
  multilingual model already downloaded. Nothing is uploaded. The transcript is
  echoed to the phone, so a misheard word shows up before the agent acts on it.
- **Languages.** Whisper guesses the language from the audio, and on a
  two-second "sí, dale" it guesses French. Pick the languages you speak in the
  dialog: Keel then chooses among those, and for short or uncertain clips
  transcribes in each and keeps the most confident result
  (`src-tauri/src/whisper_transcribe.py`). Project folder names, agent names,
  Bob, and the git words dictated most ("commit", "co-authors") are passed as
  vocabulary, so "Keel" is not heard as "kill" nor "co-authors" as "crowdfans".
- **Videos and other files** are declined with a short reply; a caption still
  goes through.

Attachments over Telegram's 20 MB bot limit are declined. The inbox is cleared
of files older than a week.

## How it works

| Part | File |
| --- | --- |
| Long polling, pairing, the turn queue, settings | `src-tauri/src/assistant.rs` |
| Bot API calls, Markdown → Telegram HTML, message splitting | `src-tauri/src/telegram.rs` |
| Each CLI's headless command line and event stream | `src-tauri/src/assistant_agents.rs` |
| Attachments, Whisper discovery and transcription | `src-tauri/src/assistant_media.rs`, `whisper_transcribe.py` |
| Keel's tools as an MCP server on loopback HTTP | `src-tauri/src/assistant_mcp.rs` |
| Answering tool calls and reporting pane events | `src/state/assistant.ts`, `src/lib/assistantView.ts` |

Every message is one headless turn of the chosen CLI in
`<config>/assistant/`, continuing the same conversation (`--resume`,
`exec resume`, `--session`, `--session-id`). A task gets two messages: a
one-line "got it, doing X" the agent sends with `tell_user` once it is sure
what was meant (or a short question when it isn't), and the outcome. Quick
answers are just the answer, and a `[Keel]` report is answered with the reply
alone: Keel turns down a second `tell_user` in a turn, and any on a turn Keel
started, so the phone never hears the same news twice. In between the phone
only shows "typing"; the tools it uses go to the activity log in Keel, by what
they do ("typing into a pane"), Grok's `use_tool` calls included. The agent is told to answer in
a sentence or two unless asked for detail, such as console output. The reply
goes out as soon as the CLI reports the turn finished (Claude, Codex, Grok) or
closes its output (opencode, Pi), without waiting for the process to exit. A conversation the CLI no longer has is
replaced once, automatically.

Claude runs with `--strict-mcp-config`, so it loads only Keel's MCP server and
not the ones in `~/.claude.json`: it connects them all before the turn starts,
and one that was slow to fail held every message for about 20 seconds. Grok
gets the same through its environment (`GROK_CLAUDE_MCPS_ENABLED=false` and
the Cursor and hooks equivalents): Grok's own config still applies, but not the
Claude and Cursor servers and hooks it would import. Those included Keel's own
Claude hooks, which launched Keel.exe before and after every tool call for
events nothing listened to, 3 to 4 seconds a message.

Keel's tools reach the agent as an MCP server on `127.0.0.1` with a per-launch
bearer token. Most calls are answered by the window, which owns the workspace:

- `list_projects`, `read_pane` — see projects, panes, agent status, screens.
- `start_agent` — open a pane in a project, wait for the agent to settle, type
  the first prompt.
- `send_to_pane`, `focus_pane`, `open_project`, `close_pane` (only panes the
  agent started). `send_to_pane` pastes, which agents' menus ignore.
- `press_key` — Esc, Ctrl+C, arrows, Enter, Tab, Shift+Tab, Backspace or 1 to
  9 in a pane, up to ten times: interrupt an agent, or pick from a menu (a
  number picks that option).
- `read_pane` and the screens in `[Keel]` reports are read once the pane's
  output pauses, so they never catch a repaint halfway or the spinner of the
  hook that reported the finish.
- `check_usage` — plan limits per signed-in login, the same reading as the
  status bar's usage gauges.

The ones that touch the phone or need no window are answered in Rust
(`LOCAL_TOOLS` in `assistant_mcp.rs`):

- `tell_user` — message the phone mid-turn.
- `send_file` — upload a file from this PC, up to 50 MB. png, jpg and webp
  under 10 MB go as photos and mp4 as videos that play in the chat; the rest,
  or a file Telegram refuses as either, as documents.
- `remind_me`, `list_reminders`, `cancel_reminder` — wake the agent after 1 to
  1,440 minutes, once or up to 48 times. When one fires, the agent gets a
  `[Keel]` message with its note; a check-in with nothing to say answers
  `NO_REPLY`, and Keel sends nothing. At most 20 at once, kept in memory only,
  so they are gone when Keel closes. A PC that slept through several fires gets
  one.

When a pane the agent started finishes, waits for input or exits, Keel sends
the agent a `[Keel]` message with the end of its screen, so it can report back
or carry on (at most eight times before you speak again; after that, a plain
one-line notice). So does a pane you opened once the agent has passed it your
request (`send_to_pane`, or a menu choice with `press_key`), until it finishes:
"record a video and send it to me" gets the video whatever the forwarding
setting. Files and recordings go out only when you asked for them; when one
would help, the agent asks you first instead of adding it to the request.
Other agents can be forwarded to the phone never, while Keel is in
the background, or always. A forwarded one also goes to the agent with
its screen, to sum up in a sentence without acting on it, so the phone says
what the agent did rather than only that it finished. Nothing Keel sends
itself uses emojis.

## Security

- The token lives in `<config>/assistant.json`, never in `keel.json`, and is
  never sent back to the window. Errors are stripped of the request URL.
- Only the paired Telegram account is listened to, in private chats only.
  Messages older than ten minutes (sent while Keel was closed) are dropped.
- The main agent can run anything your account can, from wherever your
  Telegram account is signed in. Treat that account like an SSH key: turn on
  Telegram's two-step verification, and pause or unpair the bot when you don't
  need it.
- The agent's own instructions tell it not to push, deploy or delete beyond
  what you asked. That is guidance to a model, not a sandbox.

## Verification

`cargo test` covers the event parsers against output captured from Claude Code
2.1.289, Codex 0.160.0, opencode 1.18.34 and Pi 1.0.0, plus Markdown
conversion, splitting, pairing and MCP handling. The full loop was driven
against a stand-in Bot API (debug builds read `KEEL_TELEGRAM_API`), with
Claude Code and Codex as the main agent: status, tool calls through the window,
delegating to a pane and the report when it finished, conversation memory,
`/stop`, token entry and pairing. Voice was checked with English and Spanish
notes from 2 to 5 seconds (all transcribed in the right language, which plain
auto-detection did not manage for the short Spanish ones), images were read by
Claude, Codex, opencode and Pi, and albums and declined videos went through
the stand-in.

Grok Build ran live turns with 1.0.46. Grok loads a folder's MCP config only
once the folder is trusted, so Keel launches it with `--trust`, which records
the main agent's folder in Grok's `trusted_folders.toml`. Without it Grok had
no Keel tools and spent minutes per message looking for another way. With the
Claude and Cursor switches off, `grok inspect` lists the `~/.claude.json`
servers as disabled, and a live turn ran none of the imported Keel.exe hooks
(a Telegram session's log had them at 23 turns and 62 tool calls). Every
supported CLI lists Keel's tools as it starts, so when a turn ends without that,
Keel logs it and warns on the phone once per run. Gemini CLI is not supported.
