# Handing off a conversation

Any agent pane with a linked conversation can hand it to another agent: the
new one opens beside it in the same folder, already knowing everything the
first one knew. Use the **Hand off** button in the pane's header (it turns into
a labelled chip once the agent is back at its prompt) or **Hand off to** in the
pane's right-click menu, and pick an agent, or a profile of it. The same agent
is offered too, as a new chat, for when a conversation has grown too long.

## What is passed on

| | |
| --- | --- |
| History | Every message, oldest first. A rewound or edited prompt follows the branch you kept; a compaction is followed back to the start, so nothing from before it is lost. |
| Reasoning | Everything the CLI saved as text: Claude's thinking when it kept it, Codex's reasoning summaries, Grok's thought stream, opencode's reasoning parts. |
| Tool calls | Each one with its input and result. Output over 4,000 characters is cut in the middle, the only thing ever shortened. |
| Context | Compaction summaries, plans, interruptions, subagent results, slash commands. |
| Memory | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md` from the project's root down to the pane's folder; the user-level `CLAUDE.md` or `AGENTS.md`; Claude's own memory folder for the project; Grok's project memory; and the instruction files the transcript shows the agent loading. |
| The repository | `git status --short --branch` and the last ten commits, at the moment of handing off. |

Providers keep some reasoning encrypted: most of Claude's thinking, most of
Codex's and Grok's reasoning. No file holds it, so it can't be copied. Tick
**Ask _agent_ for notes first** in the menu and Keel first asks the agent itself
to write handoff notes (what you want, what it did and why, what it was about to
do, open questions, risks, anything it knows that isn't written down), waits up
to ten minutes for it to finish, and puts them first. It's remembered, and only
asked of an agent sitting at its prompt; the progress toast has **Skip**.

## Where it goes

`<pane folder>/.keel/handoffs/<UTC stamp>-<hex>/`:

- `HANDOFF.md` — read first: each of your requests in your own words, where the
  work stopped, the notes, compaction summaries, memory files, the repository.
- `TRANSCRIPT.md` — the full record.
- `NOTES.md` — the first agent's notes, when asked for.

The folder is inside the workspace because Gemini and opencode refuse to read
outside it, and `.keel/handoffs/.gitignore` (`*`) keeps it out of git without
touching the project's own `.gitignore`. Folders older than 30 days are cleared
when the next handoff is made. The new agent is told in one line to read
`HANDOFF.md`, check the repository, and either finish your last request or say
where things stand.

## Reading each CLI

| CLI | Source | Notes |
| --- | --- | --- |
| Claude Code | `<config>/projects/<dir>/<id>.jsonl` | The record names its parent; the conversation is the chain ending at the last record, followed through `compact_boundary`'s `logicalParentUuid`. |
| Codex | `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, or `archived_sessions/` | Append-only, so compactions only mark the spot. Its `# AGENTS.md instructions` turn is memory, not a request. |
| Grok Build | `<home>/sessions/<cwd>/<id>/updates.jsonl` | The event stream, not `chat_history.jsonl`, which compaction rewrites. MCP calls are shown by the tool `use_tool` called. |
| opencode | `opencode export <id>` | Its database changes shape between releases; the export doesn't. |

`<config>` and `<home>` are the CLI's own (`~/.claude`, `~/.codex`, `~/.grok`)
or the profile's folder under Keel's `accounts/`. A pane is tied to one
conversation by the id its CLI reported through hooks, so only Claude Code,
Codex, Grok Build and opencode can hand off; any installed agent can receive.

## How it works

| Part | File |
| --- | --- |
| The commands, finding sessions and memory, git state | `src-tauri/src/handoff.rs` |
| One reader per CLI, into a shared conversation model | `src-tauri/src/handoff_read.rs` |
| `HANDOFF.md`, `TRANSCRIPT.md` and the prompts | `src-tauri/src/handoff_write.rs` |
| Asking for notes, opening the new pane, the toasts | `src/state/handoff.ts` |
| Which panes can hand off, to whom | `src/lib/handoff.ts`, `handoffEntries` in `src/components/menu/actions.ts` |

Keel's own prompts start with `[Keel handoff]`, so the notes request is never
mistaken for your last request.

## Verification

`cargo test handoff` covers each reader against records shaped like Claude
Code 2.1.289, Codex 0.160.0, Grok Build 1.0.46 and opencode 1.18.34 output,
the brief and transcript, finding sessions, memory, the folder's naming,
ignoring and clearing, and a whole handoff on disk. The readers were also run
over real sessions of each CLI: every tool call came back with its result.
Real handoffs were then read by the receiving agent headless: Claude Code to
Codex and to Grok Build, and Codex to Claude Code, each naming the last
request, where the work stopped, and a memory it could only have learned from
the files. Gemini CLI couldn't be tried: its free tier no longer runs.
