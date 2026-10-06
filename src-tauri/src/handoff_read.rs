//! Reading a conversation back out of the agent that had it.
//!
//! Every supported CLI keeps its own record of a session, and each records
//! something the others don't. This turns each one into the same list of
//! things that happened, oldest first:
//!
//! | CLI      | Read from                                  | Thinking           | Compaction |
//! | -------- | ------------------------------------------ | ------------------ | ---------- |
//! | Claude   | `projects/<dir>/<id>.jsonl`                | text when kept     | followed past `compact_boundary` |
//! | Codex    | `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` | reasoning summaries | `compacted` marks the spot |
//! | Grok     | `sessions/<cwd>/<id>/updates.jsonl`        | thought stream     | the stream outlives it |
//! | opencode | `opencode export <id>`                     | reasoning parts    | summary messages |
//!
//! Grok's `chat_history.jsonl` is what the model sees, so compaction rewrites
//! it and old tool results read "omitted". `updates.jsonl` is the event
//! stream the TUI draws from and keeps everything, so it is the one read.
//!
//! Formats were captured from Claude Code 2.1.289, Codex 0.160.0, Grok Build
//! 1.0.46 and opencode 1.18.34. Anything unrecognised is skipped, never fatal:
//! a newer CLI that adds a record type loses that record, not the handoff.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// One thing that happened in a conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User(String),
    Agent(String),
    /// Reasoning the CLI saved as text.
    Thinking(String),
    Tool(Tool),
    /// What the agent kept when its context was compacted.
    Summary(String),
    /// Something that happened around the conversation: a slash command, a
    /// plan, an interruption, a subagent's result.
    Note(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tool {
    pub name: String,
    pub input: String,
    pub output: Option<String>,
    pub failed: bool,
}

/// An instruction or memory file the agent was given.
#[derive(Debug, Clone, PartialEq)]
pub struct Memory {
    /// What the brief calls it: usually the file's path.
    pub label: String,
    /// The file it came from, which tells two copies of one file apart.
    pub path: String,
    pub content: String,
}

impl Memory {
    /// The same file under any spelling: separators, case, a trailing slash.
    pub fn same_file(&self, other: &str) -> bool {
        let key = |path: &str| path.replace('\\', "/").trim_end_matches('/').to_lowercase();
        key(&self.path) == key(other)
    }
}

#[derive(Debug, Default)]
pub struct Conversation {
    pub items: Vec<Item>,
    pub model: Option<String>,
    pub title: Option<String>,
    /// Instruction files as the agent recorded loading them.
    pub memories: Vec<Memory>,
    /// Reasoning the provider kept only encrypted, which no file can give back.
    pub hidden_thoughts: usize,
}

impl Conversation {
    fn push_tool(&mut self, tools: &mut HashMap<String, usize>, id: Option<&str>, tool: Tool) {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            tools.insert(id.to_string(), self.items.len());
        }
        self.items.push(Item::Tool(tool));
    }

    fn finish_tool(
        &mut self,
        tools: &HashMap<String, usize>,
        id: &str,
        output: String,
        failed: bool,
    ) {
        let Some(Item::Tool(tool)) = tools.get(id).and_then(|index| self.items.get_mut(*index))
        else {
            return;
        };
        tool.output = Some(match tool.output.take() {
            Some(earlier) if !earlier.is_empty() => format!("{earlier}\n{output}"),
            _ => output,
        });
        tool.failed |= failed;
    }

    /// Streams arrive in chunks; consecutive chunks of one kind are one item.
    fn append(&mut self, item: Item) {
        match (self.items.last_mut(), item) {
            (Some(Item::User(text)), Item::User(more))
            | (Some(Item::Agent(text)), Item::Agent(more))
            | (Some(Item::Thinking(text)), Item::Thinking(more)) => text.push_str(&more),
            (_, item) => self.items.push(item),
        }
    }

    fn remember(&mut self, label: &str, content: &str) {
        let content = content.trim();
        if content.is_empty() || self.memories.iter().any(|memory| memory.label == label) {
            return;
        }
        self.memories.push(Memory {
            label: label.to_string(),
            path: label.to_string(),
            content: content.to_string(),
        });
    }

    pub fn user_messages(&self) -> usize {
        self.items
            .iter()
            .filter(|item| matches!(item, Item::User(_)))
            .count()
    }

    pub fn tool_calls(&self) -> usize {
        self.items
            .iter()
            .filter(|item| matches!(item, Item::Tool(_)))
            .count()
    }

    pub fn thoughts(&self) -> usize {
        self.items
            .iter()
            .filter(|item| matches!(item, Item::Thinking(_)))
            .count()
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn lines(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

/// A tool's arguments as a reader would want them: JSON pretty-printed, a
/// string as itself.
fn show_input(input: Option<&Value>) -> String {
    match input {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(parsed @ (Value::Object(_) | Value::Array(_))) => {
                serde_json::to_string_pretty(&parsed).unwrap_or_else(|_| text.clone())
            }
            _ => text.clone(),
        },
        Some(value) => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}

/// Text from a tool result, whichever of the usual shapes it takes.
fn show_output(output: &Value) -> String {
    match output {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.clone()),
                _ if part.get("type").and_then(Value::as_str) == Some("image")
                    || part.get("type").and_then(Value::as_str) == Some("input_image") =>
                {
                    Some("[image]".to_string())
                }
                _ => part
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| str_at(part, "/content/text"))
                    .map(str::to_owned),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// Drop the `<system-reminder>` blocks harnesses append to user turns. They
/// are the harness talking to its model, not the user.
fn without_reminders(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<system-reminder>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</system-reminder>") {
            Some(end) => rest = &rest[start + end + "</system-reminder>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// The text between `<tag>` and `</tag>`, if the tag is there.
fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim())
}

// ------------------------------------------------------------------ claude

/// A Claude Code transcript. Each record names its parent, and the file holds
/// every branch ever taken (an edited prompt, a rewind) in write order. The
/// conversation is the chain that ends at the last record, followed back
/// through compactions to where it started.
pub fn claude(text: &str) -> Conversation {
    let records: Vec<Value> = lines(text).collect();
    let mut conversation = Conversation::default();
    for record in &records {
        if let Some(title) = record.get("aiTitle").and_then(Value::as_str) {
            conversation.title = Some(title.to_string());
        }
    }

    let by_uuid: HashMap<&str, &Value> = records
        .iter()
        .filter_map(|record| Some((record.get("uuid")?.as_str()?, record)))
        .collect();
    let leaf = records.iter().rev().find(|record| {
        record.get("uuid").is_some()
            && record.get("isSidechain").and_then(Value::as_bool) != Some(true)
            && matches!(
                record.get("type").and_then(Value::as_str),
                Some("user" | "assistant" | "attachment" | "system")
            )
    });
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = leaf;
    while let Some(record) = current {
        let Some(uuid) = record.get("uuid").and_then(Value::as_str) else {
            break;
        };
        if !seen.insert(uuid) {
            break;
        }
        chain.push(record);
        let parent = record
            .get("parentUuid")
            .and_then(Value::as_str)
            .or_else(|| record.get("logicalParentUuid").and_then(Value::as_str));
        current = parent.and_then(|parent| by_uuid.get(parent).copied());
    }
    chain.reverse();

    let mut tools = HashMap::new();
    for record in chain {
        claude_record(&mut conversation, &mut tools, record);
    }
    conversation
}

fn claude_record(
    conversation: &mut Conversation,
    tools: &mut HashMap<String, usize>,
    record: &Value,
) {
    match record.get("type").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            if record.get("isMeta").and_then(Value::as_bool) == Some(true) {
                return;
            }
            let content = record.pointer("/message/content");
            if record.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
                let text = content.map(show_output).unwrap_or_default();
                if !text.trim().is_empty() {
                    conversation
                        .items
                        .push(Item::Summary(text.trim().to_string()));
                }
                return;
            }
            match content {
                Some(Value::String(text)) => claude_user_text(conversation, text),
                Some(Value::Array(blocks)) => {
                    let mut said = Vec::new();
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => said.push(
                                block
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            ),
                            Some("image") => said.push("[image]".into()),
                            Some("tool_result") => {
                                let id = block
                                    .get("tool_use_id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let output =
                                    block.get("content").map(show_output).unwrap_or_default();
                                let failed =
                                    block.get("is_error").and_then(Value::as_bool) == Some(true);
                                conversation.finish_tool(tools, id, output, failed);
                            }
                            _ => {}
                        }
                    }
                    let text = said.join("\n");
                    if !text.trim().is_empty() {
                        claude_user_text(conversation, &text);
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            if let Some(model) =
                str_at(record, "/message/model").filter(|model| !model.starts_with('<'))
            {
                conversation.model = Some(model.to_string());
            }
            let blocks = record
                .pointer("/message/content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in &blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if !text.is_empty() {
                            conversation.items.push(Item::Agent(text.to_string()));
                        }
                    }
                    Some("thinking") => {
                        let text = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim();
                        if text.is_empty() {
                            conversation.hidden_thoughts += 1;
                        } else {
                            conversation.items.push(Item::Thinking(text.to_string()));
                        }
                    }
                    Some("redacted_thinking") => conversation.hidden_thoughts += 1,
                    Some("tool_use") => {
                        let tool = Tool {
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: show_input(block.get("input")),
                            ..Tool::default()
                        };
                        conversation.push_tool(
                            tools,
                            block.get("id").and_then(Value::as_str),
                            tool,
                        );
                    }
                    _ => {}
                }
            }
        }
        "attachment" => {
            let Some(attachment) = record.get("attachment") else {
                return;
            };
            match attachment.get("type").and_then(Value::as_str).unwrap_or("") {
                // Typed while the agent was busy; delivered with the next turn.
                "queued_command" => {
                    let prompt = attachment
                        .get("prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if prompt.trim_start().starts_with("<task-notification>") {
                        let summary =
                            tag(prompt, "summary").unwrap_or("A background task finished.");
                        conversation
                            .items
                            .push(Item::Note(format!("Background task: {summary}")));
                    } else {
                        claude_user_text(conversation, prompt);
                    }
                }
                "nested_memory" => {
                    let path = attachment
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("CLAUDE.md");
                    let content = str_at(attachment, "/content/content").unwrap_or("");
                    conversation.remember(path, content);
                }
                "instructions" => {
                    for file in attachment
                        .get("files")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        let path = file
                            .get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("instructions");
                        let content = file.get("content").and_then(Value::as_str).unwrap_or("");
                        conversation.remember(path, content);
                    }
                }
                "edited_text_file" => {
                    if let Some(file) = attachment.get("filename").and_then(Value::as_str) {
                        conversation
                            .items
                            .push(Item::Note(format!("{file} was changed outside the agent.")));
                    }
                }
                _ => {}
            }
        }
        "system" => match record.get("subtype").and_then(Value::as_str) {
            Some("compact_boundary") => conversation
                .items
                .push(Item::Note("Claude Code compacted its context here.".into())),
            Some("local_command") => {
                let content = record.get("content").and_then(Value::as_str).unwrap_or("");
                if let Some(output) =
                    tag(content, "local-command-stdout").filter(|text| !text.is_empty())
                {
                    conversation.items.push(Item::Note(output.to_string()));
                }
            }
            _ => {}
        },
        _ => {}
    }
}

/// A user turn's text: a slash command reads as what was run, a `!` shell
/// command as its line and output, anything else as what was said.
fn claude_user_text(conversation: &mut Conversation, text: &str) {
    if let Some(name) = tag(text, "command-name") {
        let args = tag(text, "command-args").unwrap_or("");
        conversation.items.push(Item::Note(
            format!("The user ran {name} {args}").trim().to_string(),
        ));
        return;
    }
    if let Some(output) = tag(text, "local-command-stdout") {
        if !output.is_empty() {
            conversation.items.push(Item::Note(output.to_string()));
        }
        return;
    }
    if let Some(command) = tag(text, "bash-input") {
        conversation.items.push(Item::Tool(Tool {
            name: "Shell (run by the user)".into(),
            input: command.to_string(),
            output: tag(text, "bash-stdout").map(str::to_owned),
            failed: tag(text, "bash-stderr").is_some_and(|stderr| !stderr.is_empty()),
        }));
        return;
    }
    if tag(text, "bash-stdout").is_some() || tag(text, "bash-stderr").is_some() {
        return;
    }
    let text = without_reminders(text);
    if !text.is_empty() {
        conversation.items.push(Item::User(text));
    }
}

// ------------------------------------------------------------------- codex

/// A Codex rollout. It only ever grows, so everything since the session
/// started is still in it, compactions included.
pub fn codex(text: &str) -> Conversation {
    let mut conversation = Conversation::default();
    let mut tools = HashMap::new();
    for record in lines(text) {
        let payload = record.get("payload").cloned().unwrap_or(Value::Null);
        match record.get("type").and_then(Value::as_str).unwrap_or("") {
            "turn_context" => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    conversation.model = Some(model.to_string());
                }
            }
            "compacted" => {
                let summary = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                conversation.items.push(if summary.is_empty() {
                    Item::Note("Codex compacted its context here.".into())
                } else {
                    Item::Summary(summary.to_string())
                });
            }
            "event_msg" => {
                if payload.get("type").and_then(Value::as_str) == Some("turn_aborted") {
                    conversation
                        .items
                        .push(Item::Note("The user interrupted this turn.".into()));
                }
            }
            "response_item" => codex_item(&mut conversation, &mut tools, &payload),
            _ => {}
        }
    }
    conversation
}

fn codex_item(conversation: &mut Conversation, tools: &mut HashMap<String, usize>, item: &Value) {
    let call_id = item.get("call_id").and_then(Value::as_str);
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "message" => {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("");
            let mut said = Vec::new();
            for block in item
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                match block.get("type").and_then(Value::as_str) {
                    Some("input_image") => said.push("[image]".to_string()),
                    Some("input_text") if role == "user" => {
                        let trimmed = text.trim_start();
                        if let Some(rest) = trimmed.strip_prefix("# AGENTS.md instructions for ") {
                            // Codex hands its model the project's AGENTS.md as a user turn.
                            let (dir, body) = rest.split_once('\n').unwrap_or((rest, ""));
                            let body = tag(body, "INSTRUCTIONS").unwrap_or(body);
                            conversation.remember(&format!("{}/AGENTS.md", dir.trim()), body);
                        } else if trimmed.starts_with("<environment_context>")
                            || trimmed.starts_with("<image name=")
                            || trimmed.starts_with("</image>")
                            || trimmed.starts_with("<user_instructions>")
                        {
                        } else {
                            said.push(text.to_string());
                        }
                    }
                    Some("output_text") if role == "assistant" => said.push(text.to_string()),
                    _ => {}
                }
            }
            let text = said.join("\n").trim().to_string();
            if text.is_empty() {
                return;
            }
            match role {
                "user" => conversation.items.push(Item::User(text)),
                "assistant" => conversation.items.push(Item::Agent(text)),
                // System and developer prompts are the harness, not the conversation.
                _ => {}
            }
        }
        "reasoning" => {
            let mut thought: Vec<String> = item
                .get("summary")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .map(str::to_owned)
                .collect();
            thought.extend(
                item.get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .map(str::to_owned),
            );
            let thought = thought.join("\n\n").trim().to_string();
            if thought.is_empty() {
                conversation.hidden_thoughts += 1;
            } else {
                conversation.items.push(Item::Thinking(thought));
            }
        }
        "function_call" | "custom_tool_call" => {
            let input = item.get("arguments").or_else(|| item.get("input"));
            let tool = Tool {
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                input: show_input(input),
                ..Tool::default()
            };
            conversation.push_tool(tools, call_id, tool);
        }
        "local_shell_call" => {
            let command = item
                .pointer("/action/command")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let tool = Tool {
                name: "shell".into(),
                input: command,
                ..Tool::default()
            };
            conversation.push_tool(tools, call_id, tool);
        }
        "web_search_call" => {
            let query = str_at(item, "/action/query").unwrap_or("").to_string();
            conversation.items.push(Item::Tool(Tool {
                name: "web_search".into(),
                input: query,
                ..Tool::default()
            }));
        }
        "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
            let Some(id) = call_id else {
                return;
            };
            let raw = item.get("output").cloned().unwrap_or(Value::Null);
            // Some outputs are themselves JSON wrapping the text.
            let output = match &raw {
                Value::String(text) => serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|parsed| {
                        parsed
                            .get("output")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| text.clone()),
                other => show_output(other),
            };
            conversation.finish_tool(tools, id, output, false);
        }
        _ => {}
    }
}

// -------------------------------------------------------------------- grok

/// Grok's session event stream.
pub fn grok(text: &str) -> Conversation {
    let mut conversation = Conversation::default();
    let mut tools = HashMap::new();
    let mut lookups = HashSet::new();
    let mut last_plan = String::new();
    for record in lines(text) {
        let Some(update) = record.pointer("/params/update") else {
            continue;
        };
        let chunk = || -> Option<String> {
            let content = update.get("content")?;
            match content.get("type").and_then(Value::as_str) {
                Some("image") => Some("[image]".into()),
                _ => content
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }
        };
        match update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "user_message_chunk" => {
                if let Some(model) = str_at(update, "/_meta/modelId") {
                    conversation.model = Some(model.to_string());
                }
                if let Some(text) = chunk() {
                    conversation.append(Item::User(text));
                }
            }
            "agent_message_chunk" => {
                if let Some(text) = chunk() {
                    conversation.append(Item::Agent(text));
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = chunk() {
                    conversation.append(Item::Thinking(text));
                }
            }
            "tool_call" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let name = str_at(update, "/_meta/x.ai~1tool/name")
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or("tool");
                let input = update.get("rawInput");
                let tool = match name {
                    // Looking a tool up says nothing the call itself doesn't.
                    "search_tool" => {
                        lookups.insert(id.to_string());
                        continue;
                    }
                    "use_tool" => Tool {
                        name: input
                            .and_then(|input| input.get("tool_name"))
                            .and_then(Value::as_str)
                            .unwrap_or("an MCP tool")
                            .to_string(),
                        input: show_input(input.and_then(|input| input.get("tool_input"))),
                        ..Tool::default()
                    },
                    _ => Tool {
                        name: name.to_string(),
                        input: show_input(input),
                        ..Tool::default()
                    },
                };
                conversation.push_tool(&mut tools, Some(id), tool);
            }
            "tool_call_update" => {
                let status = update.get("status").and_then(Value::as_str);
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !matches!(status, Some("completed" | "failed")) || lookups.contains(id) {
                    continue;
                }
                let output = grok_output(update);
                conversation.finish_tool(&tools, id, output, status == Some("failed"));
            }
            "plan" => {
                let plan = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|entry| {
                        format!(
                            "- [{}] {}",
                            entry
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("pending"),
                            entry.get("content").and_then(Value::as_str).unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !plan.is_empty() && plan != last_plan {
                    conversation
                        .items
                        .push(Item::Note(format!("Plan:\n{plan}")));
                    last_plan = plan;
                }
            }
            "subagent_finished" => {
                let output = update
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if !output.is_empty() {
                    conversation.items.push(Item::Note(format!(
                        "A subagent finished and reported:\n{output}"
                    )));
                }
            }
            "auto_compact_completed" => conversation
                .items
                .push(Item::Note("Grok compacted its context here.".into())),
            "turn_completed"
                if update.get("stop_reason").and_then(Value::as_str) == Some("cancelled") =>
            {
                conversation
                    .items
                    .push(Item::Note("The user interrupted this turn.".into()));
            }
            _ => {}
        }
    }
    conversation
}

/// A finished Grok tool call's result: its display text when there is one,
/// otherwise whatever the raw output holds.
fn grok_output(update: &Value) -> String {
    let shown = update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| str_at(part, "/content/text"))
        .collect::<Vec<_>>()
        .join("\n");
    if !shown.trim().is_empty() {
        return shown;
    }
    let Some(raw) = update.get("rawOutput") else {
        return String::new();
    };
    if let Some(output) = raw.get("output") {
        if let Some(text) = output.as_str() {
            return text.to_string();
        }
        if let Some(text) = output
            .as_object()
            .and_then(|fields| fields.values().find_map(Value::as_str))
        {
            return text.to_string();
        }
    }
    // Shell results carry their streams as bytes.
    let bytes = |key: &str| -> Option<String> {
        let list = raw.get(key)?.as_array()?;
        let bytes: Vec<u8> = list
            .iter()
            .filter_map(Value::as_u64)
            .filter_map(|byte| u8::try_from(byte).ok())
            .collect();
        Some(String::from_utf8_lossy(&bytes).into_owned())
    };
    let streams: Vec<String> = ["stdout", "stderr"]
        .iter()
        .filter_map(|key| bytes(key))
        .filter(|text| !text.trim().is_empty())
        .collect();
    if !streams.is_empty() {
        return streams.join("\n");
    }
    serde_json::to_string_pretty(raw).unwrap_or_default()
}

// ---------------------------------------------------------------- opencode

/// `opencode export <id>`: the session and its messages, each with its parts.
pub fn opencode(text: &str) -> Result<Conversation, String> {
    // The export logs a line to stderr, but be lenient about anything ahead
    // of the JSON on stdout too.
    let start = text
        .find('{')
        .ok_or("opencode didn't export the session.")?;
    let export: Value = serde_json::from_str(&text[start..])
        .map_err(|err| format!("opencode's export couldn't be read: {err}"))?;
    let mut conversation = Conversation {
        title: str_at(&export, "/info/title").map(str::to_owned),
        ..Conversation::default()
    };
    for message in export
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let info = message.get("info").cloned().unwrap_or(Value::Null);
        let role = info.get("role").and_then(Value::as_str).unwrap_or("");
        if let Some(model) = info.get("modelID").and_then(Value::as_str) {
            conversation.model = Some(model.to_string());
        }
        let compaction_summary = info.get("summary").and_then(Value::as_bool) == Some(true);
        let mut said = Vec::new();
        for part in message
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if part.get("synthetic").and_then(Value::as_bool) == Some(true)
                || part.get("ignored").and_then(Value::as_bool) == Some(true)
            {
                continue;
            }
            match part.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => said.push(
                    part.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ),
                "file" => said.push(format!(
                    "[file: {}]",
                    part.get("filename")
                        .and_then(Value::as_str)
                        .unwrap_or("attachment")
                )),
                "reasoning" => {
                    flush(&mut conversation, role, compaction_summary, &mut said);
                    let text = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if text.is_empty() {
                        conversation.hidden_thoughts += 1;
                    } else {
                        conversation.items.push(Item::Thinking(text.to_string()));
                    }
                }
                "tool" => {
                    flush(&mut conversation, role, compaction_summary, &mut said);
                    let state = part.get("state").cloned().unwrap_or(Value::Null);
                    let status = state.get("status").and_then(Value::as_str);
                    let output = state
                        .get("output")
                        .or_else(|| state.get("error"))
                        .map(show_output);
                    conversation.items.push(Item::Tool(Tool {
                        name: part
                            .get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                        input: show_input(state.get("input")),
                        output,
                        failed: status == Some("error"),
                    }));
                }
                "compaction" => {
                    flush(&mut conversation, role, compaction_summary, &mut said);
                    conversation
                        .items
                        .push(Item::Note("opencode compacted its context here.".into()));
                }
                "patch" => {
                    flush(&mut conversation, role, compaction_summary, &mut said);
                    let files: Vec<&str> = part
                        .get("files")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect();
                    if !files.is_empty() {
                        conversation
                            .items
                            .push(Item::Note(format!("Files changed: {}", files.join(", "))));
                    }
                }
                _ => {}
            }
        }
        flush(&mut conversation, role, compaction_summary, &mut said);
    }
    Ok(conversation)
}

/// Text gathered from a message's parts, as one item, before whatever comes
/// next so order is kept.
fn flush(conversation: &mut Conversation, role: &str, summary: bool, said: &mut Vec<String>) {
    let text = said.join("\n").trim().to_string();
    said.clear();
    if text.is_empty() {
        return;
    }
    conversation.items.push(match (role, summary) {
        (_, true) => Item::Summary(text),
        ("user", _) => Item::User(text),
        _ => Item::Agent(text),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(conversation: &Conversation, index: usize) -> &Tool {
        match &conversation.items[index] {
            Item::Tool(tool) => tool,
            other => panic!("item {index} is {other:?}"),
        }
    }

    #[test]
    fn claude_follows_the_live_branch_through_compaction() {
        let transcript = [
            r#"{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"Fix the login bug"}}"#,
            r#"{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"model":"claude-opus-5-5","content":[{"type":"thinking","thinking":"The token check is inverted.","signature":"s"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pnpm test"}}]}}"#,
            r#"{"type":"user","uuid":"r1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"1 failing","is_error":true}]}}"#,
            // An abandoned branch: the user edited this prompt and went on from u1.
            r#"{"type":"user","uuid":"dead","parentUuid":"r1","message":{"role":"user","content":"never mind"}}"#,
            r#"{"type":"system","subtype":"compact_boundary","uuid":"cb","parentUuid":null,"logicalParentUuid":"r1","content":"Conversation compacted"}"#,
            r#"{"type":"user","uuid":"s1","parentUuid":"cb","isCompactSummary":true,"message":{"role":"user","content":"Summary: fixing login; test fails."}}"#,
            r#"{"type":"user","uuid":"m1","parentUuid":"s1","isMeta":true,"message":{"role":"user","content":"Caveat: meta"}}"#,
            r#"{"type":"attachment","uuid":"q1","parentUuid":"m1","attachment":{"type":"queued_command","prompt":"also update the docs"}}"#,
            r#"{"type":"attachment","uuid":"n1","parentUuid":"q1","attachment":{"type":"nested_memory","path":"C:\\code\\CLAUDE.md","content":{"content":"Use pnpm."}}}"#,
            r#"{"type":"user","uuid":"u2","parentUuid":"n1","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-args>opus</command-args>"}}"#,
            r#"{"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"content":[{"type":"thinking","thinking":"","signature":"enc"},{"type":"text","text":"Fixed it."}]}}"#,
            r#"{"type":"user","uuid":"u3","parentUuid":"a2","message":{"role":"user","content":"thanks<system-reminder>harness noise</system-reminder>"}}"#,
            r#"{"type":"ai-title","aiTitle":"Login bug"}"#,
        ]
        .join("\n");
        let conversation = claude(&transcript);
        assert_eq!(conversation.title.as_deref(), Some("Login bug"));
        assert_eq!(conversation.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(conversation.hidden_thoughts, 1);
        assert_eq!(conversation.memories[0].content, "Use pnpm.");
        assert_eq!(
            conversation.items,
            vec![
                Item::User("Fix the login bug".into()),
                Item::Thinking("The token check is inverted.".into()),
                Item::Tool(Tool {
                    name: "Bash".into(),
                    input: "{\n  \"command\": \"pnpm test\"\n}".into(),
                    output: Some("1 failing".into()),
                    failed: true,
                }),
                Item::Note("Claude Code compacted its context here.".into()),
                Item::Summary("Summary: fixing login; test fails.".into()),
                Item::User("also update the docs".into()),
                Item::Note("The user ran /model opus".into()),
                Item::Agent("Fixed it.".into()),
                Item::User("thanks".into()),
            ]
        );
    }

    #[test]
    fn codex_reads_messages_reasoning_tools_and_compaction() {
        let rollout = [
            r#"{"type":"session_meta","payload":{"id":"x","cwd":"C:\\code"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-6-astra"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions>"}]}}"#,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for C:\\code\n\n<INSTRUCTIONS>\nRun tests.\n</INSTRUCTIONS>"},{"type":"input_text","text":"<environment_context>\n<cwd>C:\\code</cwd>\n</environment_context>"}]}}"##,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Make the missiles loft"},{"type":"input_image","image_url":"data:"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"**Checking guidance**"}],"encrypted_content":"e"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"e"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"rg loft"}}"#,
            r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[{"type":"input_text","text":"src/guidance.cpp"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","call_id":"c2","name":"shell","arguments":"{\"command\":[\"ls\"]}"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c2","output":"{\"output\":\"a.txt\",\"metadata\":{}}"}}"#,
            r#"{"type":"compacted","payload":{"message":"","replacement_history":[]}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Lofting now works."}]}}"#,
        ]
        .join("\n");
        let conversation = codex(&rollout);
        assert_eq!(conversation.model.as_deref(), Some("gpt-6-astra"));
        assert_eq!(conversation.hidden_thoughts, 1);
        assert_eq!(
            conversation.memories,
            vec![Memory {
                label: "C:\\code/AGENTS.md".into(),
                path: "C:\\code/AGENTS.md".into(),
                content: "Run tests.".into()
            }]
        );
        assert_eq!(
            conversation.items[0],
            Item::User("Make the missiles loft\n[image]".into())
        );
        assert_eq!(
            conversation.items[1],
            Item::Thinking("**Checking guidance**".into())
        );
        assert_eq!(
            tool(&conversation, 2).output.as_deref(),
            Some("src/guidance.cpp")
        );
        assert_eq!(tool(&conversation, 3).output.as_deref(), Some("a.txt"));
        assert_eq!(
            &conversation.items[4..],
            &[
                Item::Note("Codex compacted its context here.".into()),
                Item::Note("The user interrupted this turn.".into()),
                Item::Agent("Lofting now works.".into()),
            ]
        );
    }

    #[test]
    fn grok_joins_its_stream_and_names_mcp_calls() {
        let update =
            |body: &str| format!(r#"{{"method":"session/update","params":{{"update":{body}}}}}"#);
        let stream = [
            update(r#"{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Why are flares "},"_meta":{"modelId":"grok-4.7"}}"#),
            update(r#"{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"invisible?"}}"#),
            update(r#"{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Check the camera."}}"#),
            update(r#"{"sessionUpdate":"tool_call","toolCallId":"s","title":"search_tool","rawInput":{"query":"keel"},"_meta":{"x.ai/tool":{"name":"search_tool"}}}"#),
            update(r#"{"sessionUpdate":"tool_call_update","toolCallId":"s","status":"completed","content":[{"type":"content","content":{"type":"text","text":"schemas"}}]}"#),
            update(r#"{"sessionUpdate":"tool_call","toolCallId":"u","title":"use_tool","rawInput":{"tool_name":"keel__read_pane","tool_input":{"pane_id":"p1"}},"_meta":{"x.ai/tool":{"name":"use_tool"}}}"#),
            update(r#"{"sessionUpdate":"tool_call_update","toolCallId":"u","status":"completed","rawOutput":{"type":"MCP","output":{"OkayOutput":"screen text"}}}"#),
            update(r#"{"sessionUpdate":"tool_call","toolCallId":"g","title":"grep","rawInput":{"pattern":"flare"},"_meta":{"x.ai/tool":{"name":"grep"}}}"#),
            update(r#"{"sessionUpdate":"tool_call_update","toolCallId":"g","status":"failed","rawOutput":{"stdout":[110,111],"stderr":[]}}"#),
            update(r#"{"sessionUpdate":"plan","entries":[{"content":"Fix camera","status":"in_progress"}]}"#),
            update(r#"{"sessionUpdate":"plan","entries":[{"content":"Fix camera","status":"in_progress"}]}"#),
            update(r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"They fire "}}"#),
            update(r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"downward."}}"#),
            update(r#"{"sessionUpdate":"auto_compact_completed","tokens_before":10}"#),
        ]
        .join("\n");
        let conversation = grok(&stream);
        assert_eq!(conversation.model.as_deref(), Some("grok-4.7"));
        assert_eq!(
            conversation.items[0],
            Item::User("Why are flares invisible?".into())
        );
        assert_eq!(
            conversation.items[1],
            Item::Thinking("Check the camera.".into())
        );
        let pane = tool(&conversation, 2);
        assert_eq!(pane.name, "keel__read_pane");
        assert_eq!(pane.output.as_deref(), Some("screen text"));
        let grep = tool(&conversation, 3);
        assert_eq!(grep.output.as_deref(), Some("no"));
        assert!(grep.failed);
        assert_eq!(
            &conversation.items[4..],
            &[
                Item::Note("Plan:\n- [in_progress] Fix camera".into()),
                Item::Agent("They fire downward.".into()),
                Item::Note("Grok compacted its context here.".into()),
            ]
        );
    }

    #[test]
    fn opencode_reads_its_export() {
        let export = r#"Exporting session: ses_1
{"info":{"id":"ses_1","title":"Conventional commits"},"messages":[
 {"info":{"role":"user"},"parts":[{"type":"text","text":"commit it"},{"type":"text","text":"(context)","synthetic":true}]},
 {"info":{"role":"assistant","modelID":"deepseek-v4.1-flash"},"parts":[
   {"type":"step-start"},
   {"type":"reasoning","text":"Check git status first."},
   {"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"git status"},"output":"clean"}},
   {"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"git push"},"error":"denied"}},
   {"type":"text","text":"Committed."},
   {"type":"patch","files":["a.rs"]}
 ]},
 {"info":{"role":"assistant","summary":true},"parts":[{"type":"text","text":"So far: committed a.rs."}]}
]}"#;
        let conversation = opencode(export).unwrap();
        assert_eq!(conversation.title.as_deref(), Some("Conventional commits"));
        assert_eq!(conversation.model.as_deref(), Some("deepseek-v4.1-flash"));
        assert_eq!(conversation.items[0], Item::User("commit it".into()));
        assert_eq!(
            conversation.items[1],
            Item::Thinking("Check git status first.".into())
        );
        assert_eq!(tool(&conversation, 2).output.as_deref(), Some("clean"));
        assert!(tool(&conversation, 3).failed);
        assert_eq!(
            &conversation.items[4..],
            &[
                Item::Agent("Committed.".into()),
                Item::Note("Files changed: a.rs".into()),
                Item::Summary("So far: committed a.rs.".into()),
            ]
        );
        assert!(opencode("no session").is_err());
    }

    #[test]
    fn reminders_and_tags_are_read_safely() {
        assert_eq!(
            without_reminders("a<system-reminder>x</system-reminder>b"),
            "ab"
        );
        assert_eq!(without_reminders("a<system-reminder>unclosed"), "a");
        assert_eq!(tag("<x> y </x>", "x"), Some("y"));
        assert_eq!(tag("<x>y", "x"), None);
    }
}
