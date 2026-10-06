//! Writing a conversation down for the agent that takes it over.
//!
//! Two files. `TRANSCRIPT.md` is the record: every message, every piece of
//! reasoning the CLI kept, and every tool call with its result, oldest first.
//! Only tool output is ever shortened, from the middle, because a single build
//! log can be longer than everything else together. `HANDOFF.md` is what to
//! read first: each request of the user's in their own words, where the work
//! stopped, the notes the agent left, the memory and instruction files it had,
//! and the state of the repository now.
//!
//! The files are read by another model, so they say what things are in plain
//! words and never assume it knows how the first CLI records anything.

use crate::handoff_read::{Conversation, Item, Memory, Tool};

/// Tool input and output above this many characters is cut in the middle.
const TOOL_TEXT: usize = 4000;
/// A request quoted in the brief past this length points at the transcript.
const REQUEST_TEXT: usize = 6000;
const MEMORY_TEXT: usize = 12_000;
/// Things the brief lists after the last request before it stops listing.
const AFTER_LAST_REQUEST: usize = 40;

/// Keel's own words to an agent, which are not the user's requests.
pub const KEEL_MARK: &str = "[Keel handoff]";

pub const BRIEF: &str = "HANDOFF.md";
pub const TRANSCRIPT: &str = "TRANSCRIPT.md";
pub const NOTES: &str = "NOTES.md";

/// What the files say around the conversation itself.
pub struct Context<'a> {
    pub source: &'a str,
    pub target: &'a str,
    pub session_id: &'a str,
    pub cwd: &'a str,
    pub title: &'a str,
    /// When the handoff was made, already written for a reader.
    pub when: &'a str,
    /// `git status --short --branch` and recent commits, when it's a repo.
    pub git: Option<String>,
    /// Memory and instruction files read from disk now.
    pub memories: Vec<Memory>,
    /// Notes the first agent wrote for this handoff.
    pub notes: Option<String>,
}

/// Fence `text` so nothing inside it can close the fence early.
fn fenced(text: &str, language: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for ch in text.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}{language}\n{}\n{fence}", text.trim_end())
}

/// Keep the start and end of a long text, saying how much is gone between.
pub fn cut(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max * 3 / 5).collect();
    let tail: String = text.chars().skip(count - max * 2 / 5).collect();
    format!(
        "{}\n[… {} characters cut here …]\n{}",
        head.trim_end(),
        count - head.chars().count() - tail.chars().count(),
        tail.trim_start()
    )
}

/// `> ` before every line, so a message reads as quoted however it's written.
fn quoted(text: &str) -> String {
    text.trim()
        .lines()
        .map(|line| {
            if line.is_empty() {
                ">".to_string()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A numbered list entry, its later lines indented to stay inside it.
fn numbered(number: usize, text: &str) -> String {
    let mut lines = text.trim().lines();
    let mut out = format!("{number}. {}", lines.next().unwrap_or(""));
    for line in lines {
        out.push('\n');
        if !line.is_empty() {
            out.push_str("   ");
            out.push_str(line);
        }
    }
    out
}

fn is_keel(text: &str) -> bool {
    text.trim_start().starts_with(KEEL_MARK)
}

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

/// A shell call reads as its command line, with what it was for; any other
/// tool's input stays as given.
fn readable_input(input: &str) -> String {
    let Ok(serde_json::Value::Object(fields)) = serde_json::from_str(input) else {
        return input.to_string();
    };
    let command = match fields.get("command").or_else(|| fields.get("cmd")) {
        Some(serde_json::Value::String(line)) => line.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => return input.to_string(),
    };
    match fields
        .get("description")
        .and_then(serde_json::Value::as_str)
    {
        Some(why) => format!("# {why}\n$ {command}"),
        None => format!("$ {command}"),
    }
}

fn tool_block(tool: &Tool) -> String {
    let mut out = format!("**Tool: {}**", tool.name);
    if !tool.input.trim().is_empty() {
        out.push_str("\n\n");
        out.push_str(&fenced(&cut(&readable_input(&tool.input), TOOL_TEXT), ""));
    }
    match &tool.output {
        Some(output) if !output.trim().is_empty() => {
            out.push_str(if tool.failed {
                "\n\nFailed:\n\n"
            } else {
                "\n\nResult:\n\n"
            });
            out.push_str(&fenced(&cut(output, TOOL_TEXT), ""));
        }
        Some(_) => out.push_str("\n\nResult: (empty)"),
        None => out.push_str("\n\n(No result was recorded.)"),
    }
    out
}

/// The whole conversation, oldest first.
pub fn transcript(conversation: &Conversation, context: &Context) -> String {
    let source = context.source;
    let mut out = format!(
        "# Conversation with {source}: {title}\n\n\
         The full record of the conversation {target} is taking over, oldest first: each message, \
         the reasoning {source} saved, and each tool call with its result. Tool input and output \
         over {TOOL_TEXT} characters is cut in the middle; nothing else is left out. \
         Start with {BRIEF} beside this file.\n\n\
         - Folder: `{cwd}`\n- Session: {session}\n{model}- Handed off: {when}\n",
        title = context.title,
        target = context.target,
        cwd = context.cwd,
        session = context.session_id,
        model = conversation
            .model
            .as_deref()
            .map(|model| format!("- Model: {model}\n"))
            .unwrap_or_default(),
        when = context.when,
    );
    let mut request = 0;
    for item in &conversation.items {
        out.push('\n');
        match item {
            Item::User(text) if is_keel(text) => {
                out.push_str(&format!("_Keel to {source}:_\n\n{}\n", quoted(text)));
            }
            Item::User(text) => {
                request += 1;
                out.push_str(&format!(
                    "---\n\n## The user, message {request}\n\n{}\n",
                    text.trim()
                ));
            }
            Item::Agent(text) => out.push_str(&format!("**{source}:**\n\n{}\n", text.trim())),
            Item::Thinking(text) => {
                out.push_str(&format!("_{source}'s reasoning:_\n\n{}\n", quoted(text)));
            }
            Item::Tool(tool) => {
                out.push_str(&tool_block(tool));
                out.push('\n');
            }
            Item::Summary(text) => out.push_str(&format!(
                "**Summary {source} kept when it compacted its context:**\n\n{}\n",
                quoted(text)
            )),
            Item::Note(text) => out.push_str(&format!("_{}_\n", text.trim().replace('\n', "_\n_"))),
        }
    }
    if conversation.items.is_empty() {
        out.push_str("\n(The conversation is empty.)\n");
    }
    out
}

/// What to read first.
pub fn brief(conversation: &Conversation, context: &Context) -> String {
    let source = context.source;
    let target = context.target;
    let requests: Vec<&str> = conversation
        .items
        .iter()
        .filter_map(|item| match item {
            Item::User(text) if !is_keel(text) => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let mut out = format!(
        "# Handoff from {source} to {target}\n\n\
         You are {target}, taking over a conversation the user was having with {source} in \
         `{cwd}`. Everything {source} had is in this file or in {TRANSCRIPT} beside it. Treat it as \
         your own memory of the conversation: the user shouldn't have to repeat anything, and work \
         that's done shouldn't be redone. The repository may have changed since, so check its \
         current state before acting on what's described here.\n\n\
         - Conversation: {title} (session {session})\n\
         - So far: {requests}, {tools}, {thoughts} of saved reasoning\n",
        cwd = context.cwd,
        title = context.title,
        session = context.session_id,
        requests = plural(requests.len(), "message") + " from the user",
        tools = plural(conversation.tool_calls(), "tool call"),
        thoughts = plural(conversation.thoughts(), "passage"),
    );
    if let Some(model) = &conversation.model {
        out.push_str(&format!("- {source} was running {model}\n"));
    }
    out.push_str(&format!("- Handed off: {}\n", context.when));
    if conversation.hidden_thoughts > 0 {
        out.push_str(&format!(
            "\n{source} also reasoned in {} that its provider stores only in encrypted form, so \
             that reasoning can't be passed on. What it concluded is in its messages{} and in the \
             transcript.\n",
            plural(conversation.hidden_thoughts, "place"),
            if context.notes.is_some() {
                ", its notes below"
            } else {
                ""
            },
        ));
    }

    out.push_str("\n## What the user asked, in order\n\n");
    if requests.is_empty() {
        out.push_str("(Nothing yet.)\n");
    }
    for (index, request) in requests.iter().enumerate() {
        let shown = if request.chars().count() > REQUEST_TEXT {
            format!(
                "{}\n\n(Shortened here; message {} in {TRANSCRIPT} has all of it.)",
                cut(request, REQUEST_TEXT),
                index + 1
            )
        } else {
            request.trim().to_string()
        };
        out.push_str(&numbered(index + 1, &shown));
        out.push_str("\n\n");
    }

    out.push_str("## Where it stopped\n\n");
    let last_request = conversation
        .items
        .iter()
        .rposition(|item| matches!(item, Item::User(text) if !is_keel(text)));
    let after = last_request.map_or(&conversation.items[..], |index| {
        &conversation.items[index + 1..]
    });
    let mut stopped = Vec::new();
    for item in after.iter().take(AFTER_LAST_REQUEST) {
        stopped.push(match item {
            Item::Agent(text) => format!("**{source}:**\n\n{}", text.trim()),
            Item::Thinking(text) => {
                format!(
                    "_{source}'s reasoning:_\n\n{}",
                    quoted(&cut(text, TOOL_TEXT))
                )
            }
            Item::Tool(tool) => format!(
                "- Ran {}{}",
                tool.name,
                if tool.failed { " (it failed)" } else { "" }
            ),
            Item::Summary(_) => "- Compacted its context.".to_string(),
            Item::Note(text) => format!("- {}", text.lines().next().unwrap_or("")),
            Item::User(text) => format!("_Keel to {source}:_ {}", text.trim()),
        });
    }
    if after.len() > AFTER_LAST_REQUEST {
        stopped.push("(More follows in the transcript.)".to_string());
    }
    if stopped.is_empty() && last_request.is_some() {
        stopped.push(format!(
            "{source} hadn't answered the last message yet. Answer it."
        ));
    }
    out.push_str(&stopped.join("\n\n"));
    out.push('\n');

    if let Some(notes) = context
        .notes
        .as_deref()
        .filter(|notes| !notes.trim().is_empty())
    {
        out.push_str(&format!(
            "\n## {source}'s notes for you\n\n{source} wrote these for this handoff, with the whole \
             conversation still in mind ({NOTES} beside this file):\n\n{}\n",
            notes.trim()
        ));
    }

    let summaries: Vec<&str> = conversation
        .items
        .iter()
        .filter_map(|item| match item {
            Item::Summary(text) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if !summaries.is_empty() {
        out.push_str(&format!(
            "\n## What {source} kept when it compacted\n\n{source} ran out of room and summarised \
             the conversation so far {}. The latest summary:\n\n{}\n",
            if summaries.len() == 1 {
                "once".to_string()
            } else {
                format!("{} times", summaries.len())
            },
            quoted(summaries[summaries.len() - 1])
        ));
    }

    let memories = merged_memories(&context.memories, &conversation.memories, source);
    if !memories.is_empty() {
        out.push_str(&format!(
            "\n## Memory and instructions {source} had\n\nThe user's standing instructions and what \
             {source} remembered about them and this project. Some of these files may already be \
             loaded for you; the rest you'd otherwise never see.\n"
        ));
        for memory in &memories {
            out.push_str(&format!(
                "\n### {}\n\n{}\n",
                memory.label,
                fenced(&cut(&memory.content, MEMORY_TEXT), "markdown")
            ));
        }
    }

    if let Some(git) = &context.git {
        out.push_str(&format!("\n## The repository now\n\n{}\n", fenced(git, "")));
    }

    out.push_str(&format!(
        "\n## The full conversation\n\n{TRANSCRIPT} beside this file has every message, the \
         reasoning {source} saved and each tool call with its result. It's long: search it, or \
         read the parts you need.\n"
    ));
    out
}

/// Files read from disk now come first; what the agent recorded loading is
/// added only where no file on disk has the same path.
pub fn merged_memories(disk: &[Memory], recorded: &[Memory], source: &str) -> Vec<Memory> {
    let mut out: Vec<Memory> = disk.to_vec();
    for memory in recorded {
        if !out.iter().any(|known| known.same_file(&memory.path)) {
            out.push(Memory {
                label: format!("{} (as {source} loaded it)", memory.label),
                ..memory.clone()
            });
        }
    }
    out
}

/// What the new agent is told first, typed into its pane.
pub fn prompt(source: &str, folder: &str) -> String {
    format!(
        "{KEEL_MARK} You're taking over this conversation from {source}. Keel saved everything \
         it had in {folder}/: read {BRIEF} there first (what I asked, where it stopped, its notes, \
         memory and instructions), and open {TRANSCRIPT} when you need the full history with its \
         reasoning and every tool call. Then check the repository's current state and carry on: \
         if my last request isn't finished, finish it; if it is, tell me in a few lines where \
         things stand."
    )
}

/// What the first agent is asked before it hands off.
pub fn notes_prompt(target: &str, path: &str) -> String {
    format!(
        "{KEEL_MARK} {target} is about to take over this work from you, and will read this \
         conversation's transcript. Write handoff notes for it to {path}: what I want, what you've \
         done and why, what you were about to do next, open questions, risks, and anything you \
         know or suspect that isn't written down anywhere. Write only that file, change nothing \
         else, and then stop."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context<'a>() -> Context<'a> {
        Context {
            source: "Claude Code",
            target: "Codex",
            session_id: "abc",
            cwd: "C:\\code\\keel",
            title: "Login bug",
            when: "2026-10-05 21:40 UTC",
            git: Some("## main\n M src/login.rs".into()),
            memories: vec![Memory {
                label: "C:\\code\\keel\\CLAUDE.md".into(),
                path: "C:\\code\\keel\\CLAUDE.md".into(),
                content: "Use pnpm.".into(),
            }],
            notes: Some("The token check is inverted; tests 3 and 4 still fail.".into()),
        }
    }

    fn conversation() -> Conversation {
        Conversation {
            items: vec![
                Item::User("Fix the login bug".into()),
                Item::Thinking("Probably the token check.".into()),
                Item::Tool(Tool {
                    name: "Bash".into(),
                    input: "pnpm test".into(),
                    output: Some("```\n1 failing".into()),
                    failed: true,
                }),
                Item::Summary("Fixing login.".into()),
                Item::User("and update the docs".into()),
                Item::Agent("Docs updated.".into()),
                Item::User(format!("{KEEL_MARK} Codex is about to take over")),
                Item::Agent("Notes written.".into()),
            ],
            model: Some("claude-opus-5-5".into()),
            title: None,
            memories: vec![
                Memory {
                    label: "c:/code/keel/claude.md".into(),
                    path: "c:/code/keel/claude.md".into(),
                    content: "stale copy".into(),
                },
                Memory {
                    label: "C:\\Users\\me\\.claude\\CLAUDE.md".into(),
                    path: "C:\\Users\\me\\.claude\\CLAUDE.md".into(),
                    content: "Never add co-authors.".into(),
                },
            ],
            hidden_thoughts: 2,
        }
    }

    #[test]
    fn the_brief_carries_every_request_and_where_it_stopped() {
        let brief = brief(&conversation(), &context());
        assert!(brief.starts_with("# Handoff from Claude Code to Codex\n\nYou are Codex"));
        assert!(brief.contains("2 messages from the user, 1 tool call, 1 passage"));
        assert!(brief.contains("1. Fix the login bug\n\n2. and update the docs"));
        // Keel's own request for notes is not the user's last request.
        assert!(brief.contains("## Where it stopped\n\n**Claude Code:**\n\nDocs updated."));
        assert!(brief.contains("(as Claude Code loaded it)"));
        assert!(brief.contains("reasoned in 2 places"));
        assert!(brief.contains("tests 3 and 4 still fail"));
        assert!(brief.contains("The latest summary:\n\n> Fixing login."));
        assert!(brief.contains("Use pnpm."));
        assert!(!brief.contains("stale copy"), "the file on disk wins");
        assert!(brief.contains("Never add co-authors."));
        assert!(brief.contains(" M src/login.rs"));
    }

    #[test]
    fn the_transcript_keeps_everything_in_order() {
        let transcript = transcript(&conversation(), &context());
        let order = [
            "## The user, message 1",
            "_Claude Code's reasoning:_\n\n> Probably the token check.",
            "**Tool: Bash**",
            "Failed:",
            "**Summary Claude Code kept when it compacted its context:**",
            "## The user, message 2",
            "**Claude Code:**\n\nDocs updated.",
            "_Keel to Claude Code:_",
        ];
        let mut from = 0;
        for part in order {
            let at = transcript[from..]
                .find(part)
                .unwrap_or_else(|| panic!("{part} out of order"));
            from += at + part.len();
        }
        // Output holding a fence gets a longer one.
        assert!(transcript.contains("````\n```\n1 failing\n````"));
        assert!(transcript.contains("- Model: claude-opus-5-5"));
    }

    #[test]
    fn shell_calls_read_as_command_lines() {
        assert_eq!(
            readable_input(r#"{"command":"pnpm test","description":"Run the tests"}"#),
            "# Run the tests\n$ pnpm test"
        );
        assert_eq!(
            readable_input(r#"{"command":["git","status"]}"#),
            "$ git status"
        );
        assert_eq!(readable_input(r#"{"path":"a.rs"}"#), r#"{"path":"a.rs"}"#);
        assert_eq!(readable_input("rg loft"), "rg loft");
    }

    #[test]
    fn long_text_keeps_both_ends() {
        let text = format!("{}{}", "a".repeat(5000), "z".repeat(5000));
        let short = cut(&text, 1000);
        assert!(short.starts_with(&"a".repeat(600)));
        assert!(short.ends_with(&"z".repeat(400)));
        assert!(short.contains("[… 9000 characters cut here …]"));
        assert_eq!(cut("short", 10), "short");
        // Multi-byte text is cut on character boundaries.
        assert!(cut(&"é".repeat(50), 10).contains("40 characters cut"));
    }

    #[test]
    fn prompts_are_marked_as_keel() {
        let prompt = prompt("Claude Code", ".keel/handoffs/x");
        assert!(prompt.starts_with(KEEL_MARK));
        assert!(prompt.contains(".keel/handoffs/x/: read HANDOFF.md"));
        assert!(
            !prompt.contains('\n'),
            "one line, so no TUI submits it early"
        );
        let notes = notes_prompt("Codex", ".keel/handoffs/x/NOTES.md");
        assert!(is_keel(&notes));
        assert!(!notes.contains('\n'));
    }
}
