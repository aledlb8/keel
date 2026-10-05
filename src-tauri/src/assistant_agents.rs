//! How each CLI runs one turn of the main agent without a terminal.
//!
//! Every supported CLI has a headless mode that takes a prompt, works with full
//! tool access, prints machine-readable events and exits — and a way to come
//! back to the same conversation next time. They agree on nothing else, so
//! this file is the table of differences:
//!
//! | CLI      | Prompt | Events                 | Conversation             | Keel tools            |
//! | -------- | ------ | ---------------------- | ------------------------ | --------------------- |
//! | Claude   | stdin  | `stream-json`          | `--session-id`/`--resume`| `--mcp-config` file   |
//! | Codex    | stdin  | `exec --json`          | `exec resume <thread>`   | `-c mcp_servers.…`    |
//! | opencode | stdin  | `run --format json`    | `--session <ses_…>`      | `OPENCODE_CONFIG_CONTENT` |
//! | Pi       | stdin  | `--mode json`          | `--session-id` (upsert)  | `.pi/mcp.json`        |
//! | Grok     | file   | `streaming-json`       | `--session-id`/`--resume`| `.grok/config.toml`   |
//!
//! Images the user sent are attached the way each CLI takes them (`--image`,
//! `--file`, `@path`); Claude and Grok open them from the path in the prompt.
//!
//! Keel's tools reach every one of them as an MCP server over loopback HTTP.
//! Configuration goes in the main agent's own folder or the process
//! environment; the user's global agent settings are never touched.
//!
//! Event shapes were captured from Claude Code 2.1.289, Codex 0.160.0,
//! opencode 1.18.34 and Pi 1.0.0. Grok's come from its headless-mode guide
//! (1.0.46).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Catalogue ids that can be the main agent.
pub const SUPPORTED: &[&str] = &["claude", "codex", "opencode", "pi", "grok"];

pub fn supported(agent_id: &str) -> bool {
    SUPPORTED.contains(&agent_id)
}

pub struct Mcp {
    pub url: String,
    pub token: String,
}

pub struct Turn<'a> {
    pub prompt: &'a str,
    /// Conversation to continue, as this CLI named it.
    pub session: Option<&'a str>,
    /// The main agent's working folder. Keel owns it.
    pub home: &'a Path,
    pub mcp: &'a Mcp,
    /// Project folders the agent may work in.
    pub projects: &'a [PathBuf],
    /// Read once at the start of every turn, as the agent's standing rules.
    pub rules: &'a str,
    /// Images sent with the message, saved in the agent's folder.
    pub images: &'a [PathBuf],
}

#[derive(Debug, Default)]
pub struct Launch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub stdin: Option<String>,
    /// A conversation id Keel chose up front, for CLIs that accept one.
    pub session: Option<String>,
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_string()).collect()
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    crate::store::write_atomic(path, text)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Build the command line for one turn and write any files it reads.
pub fn prepare(agent_id: &str, turn: &Turn) -> Result<Launch, String> {
    let bearer = format!("Bearer {}", turn.mcp.token);
    let mut launch = Launch::default();
    match agent_id {
        "claude" => {
            let config = turn.home.join(".keel").join("claude-mcp.json");
            write(
                &config,
                &json!({ "mcpServers": { "keel": {
                    "type": "http", "url": turn.mcp.url, "headers": { "Authorization": bearer },
                } } })
                .to_string(),
            )?;
            launch.args = args(&[
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--dangerously-skip-permissions",
                "--mcp-config",
            ]);
            launch.args.push(config.to_string_lossy().into_owned());
            // Only Keel's server: the user's own MCP servers are connected
            // before the turn starts, and a slow one held every message.
            launch.args.push("--strict-mcp-config".into());
            launch.args.push("--append-system-prompt".into());
            launch.args.push(turn.rules.into());
            for dir in turn.projects {
                launch.args.push("--add-dir".into());
                launch.args.push(dir.to_string_lossy().into_owned());
            }
            match turn.session {
                Some(id) => launch.args.extend(["--resume".to_string(), id.to_string()]),
                None => {
                    let id = new_id();
                    launch.args.extend(["--session-id".to_string(), id.clone()]);
                    launch.session = Some(id);
                }
            }
            launch.stdin = Some(turn.prompt.into());
        }
        "codex" => {
            launch.args = match turn.session {
                Some(id) => vec!["exec".into(), "resume".into(), id.to_string()],
                None => vec!["exec".into()],
            };
            // `--image` takes several values, so each goes as `--image=` and
            // ahead of the other flags, never before the `-` for stdin.
            for image in turn.images {
                launch.args.push(format!("--image={}", image.display()));
            }
            launch.args.extend(args(&[
                "--json",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
            ]));
            if turn.session.is_none() {
                launch.args.push("-C".into());
                launch.args.push(turn.home.to_string_lossy().into_owned());
            }
            launch.args.extend([
                "-c".to_string(),
                format!("mcp_servers.keel.url=\"{}\"", turn.mcp.url),
                "-c".to_string(),
                "mcp_servers.keel.bearer_token_env_var=\"KEEL_MCP_TOKEN\"".to_string(),
                "-".to_string(),
            ]);
            launch
                .env
                .push(("KEEL_MCP_TOKEN".into(), turn.mcp.token.clone()));
            // Codex reads AGENTS.md, not a system-prompt flag.
            launch.stdin = Some(turn.prompt.into());
        }
        "opencode" => {
            launch.args = args(&["run"]);
            for image in turn.images {
                launch.args.push("--file".into());
                launch.args.push(image.to_string_lossy().into_owned());
            }
            launch.args.extend(args(&["--format", "json", "--auto"]));
            if let Some(id) = turn.session {
                launch
                    .args
                    .extend(["--session".to_string(), id.to_string()]);
            }
            launch.env.push((
                "OPENCODE_CONFIG_CONTENT".into(),
                json!({ "mcp": { "keel": {
                    "type": "remote", "url": turn.mcp.url,
                    "headers": { "Authorization": bearer }, "oauth": false,
                } } })
                .to_string(),
            ));
            launch.stdin = Some(turn.prompt.into());
        }
        "pi" => {
            write(
                &turn.home.join(".pi").join("mcp.json"),
                &json!({ "mcpServers": { "keel": {
                    "url": turn.mcp.url, "headers": { "Authorization": bearer },
                    "exposure": "direct",
                    "description": "Keel, the desktop app the user runs their coding agents in.",
                } } })
                .to_string(),
            )?;
            // `--session-id` creates the conversation when it is missing, so
            // the first turn and every later one use the same flag.
            let id = turn.session.map(str::to_owned).unwrap_or_else(new_id);
            launch.args = args(&["-p", "--mode", "json", "--approve", "--session-id"]);
            launch.args.push(id.clone());
            for image in turn.images {
                launch.args.push(format!("@{}", image.display()));
            }
            if turn.session.is_none() {
                launch.session = Some(id);
            }
            launch.stdin = Some(turn.prompt.into());
        }
        "grok" => {
            write(
                &turn.home.join(".grok").join("config.toml"),
                &format!(
                    "[mcp_servers.keel]\nurl = {}\nenabled = true\n\n[mcp_servers.keel.headers]\nAuthorization = {}\n",
                    toml_string(&turn.mcp.url),
                    toml_string(&bearer)
                ),
            )?;
            let prompt = turn.home.join(".keel").join("prompt.md");
            write(&prompt, turn.prompt)?;
            launch.args = vec![
                "--prompt-file".into(),
                prompt.to_string_lossy().into_owned(),
            ];
            // Grok skips a folder's `.grok/config.toml` until the folder is
            // trusted, which would leave the agent without Keel's tools.
            launch.args.extend(args(&[
                "--output-format",
                "streaming-json",
                "--always-approve",
                "--trust",
                "--rules",
            ]));
            launch.args.push(turn.rules.into());
            match turn.session {
                Some(id) => launch.args.extend(["--resume".to_string(), id.to_string()]),
                None => {
                    let id = new_id();
                    launch.args.extend(["--session-id".to_string(), id.clone()]);
                    launch.session = Some(id);
                }
            }
        }
        other => return Err(format!("{other} can't be the main agent yet.")),
    }
    Ok(launch)
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// What a turn has said so far.
#[derive(Debug, Default)]
pub struct Reading {
    pub session: Option<String>,
    /// The reply as it stands: text since the agent last used a tool.
    reply: String,
    /// A final answer the CLI reported as such, which wins over `reply`.
    result: Option<String>,
    pub error: Option<String>,
    /// The CLI said the turn is over. It may still take a while to exit.
    pub done: bool,
    /// opencode tags each text part with the message it belongs to.
    message: Option<String>,
}

impl Reading {
    pub fn reply(&self) -> String {
        self.result
            .clone()
            .unwrap_or_else(|| self.reply.clone())
            .trim()
            .to_string()
    }

    fn text(&mut self, text: &str) {
        self.reply.push_str(text);
    }

    /// Text the agent wrote before a tool call was narration, not the answer.
    fn tool(&mut self) {
        self.reply.clear();
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// Read one line of a CLI's output. Returns a short label when it shows the
/// agent starting a tool, for the activity log.
pub fn read_line(agent_id: &str, line: &str, reading: &mut Reading) -> Option<String> {
    let event: Value = serde_json::from_str(line.trim()).ok()?;
    let kind = str_at(&event, "/type").unwrap_or("");
    match agent_id {
        "claude" => match kind {
            "system" if str_at(&event, "/subtype") == Some("init") => {
                reading.session = str_at(&event, "/session_id").map(str::to_owned);
                None
            }
            "assistant" => {
                let mut label = None;
                for block in event
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    match str_at(block, "/type") {
                        Some("text") => reading.text(str_at(block, "/text").unwrap_or("")),
                        Some("tool_use") => {
                            reading.tool();
                            let name = str_at(block, "/name").unwrap_or("tool");
                            if name != "ToolSearch" {
                                label = Some(tool_label(name, block.get("input")));
                            }
                        }
                        _ => {}
                    }
                }
                label
            }
            "result" => {
                if let Some(id) = str_at(&event, "/session_id") {
                    reading.session = Some(id.to_owned());
                }
                let text = str_at(&event, "/result").unwrap_or("").to_string();
                if event.get("is_error").and_then(Value::as_bool) == Some(true) {
                    reading.error = Some(if text.is_empty() {
                        str_at(&event, "/subtype").unwrap_or("error").to_string()
                    } else {
                        text
                    });
                } else {
                    reading.result = Some(text);
                    reading.done = true;
                }
                None
            }
            _ => None,
        },
        "codex" => match kind {
            "thread.started" => {
                reading.session = str_at(&event, "/thread_id").map(str::to_owned);
                None
            }
            "item.started" => {
                let item = event.get("item")?;
                match str_at(item, "/type")? {
                    "mcp_tool_call" => {
                        reading.tool();
                        Some(tool_label(str_at(item, "/tool").unwrap_or("tool"), None))
                    }
                    "command_execution" => {
                        reading.tool();
                        Some(format!(
                            "$ {}",
                            short(str_at(item, "/command").unwrap_or(""), 48)
                        ))
                    }
                    "web_search" => {
                        reading.tool();
                        Some("web search".into())
                    }
                    _ => None,
                }
            }
            "item.completed" => {
                let item = event.get("item")?;
                match str_at(item, "/type")? {
                    "agent_message" => {
                        // Each message replaces the last; the final one is the answer.
                        reading.reply = str_at(item, "/text").unwrap_or("").to_string();
                        None
                    }
                    "file_change" => {
                        reading.tool();
                        Some("edit".into())
                    }
                    _ => None,
                }
            }
            "turn.completed" => {
                reading.done = true;
                None
            }
            "turn.failed" => {
                reading.error = str_at(&event, "/error/message").map(str::to_owned);
                None
            }
            "error" => {
                reading.error = str_at(&event, "/message").map(str::to_owned);
                None
            }
            _ => None,
        },
        "opencode" => {
            if let Some(id) = str_at(&event, "/sessionID") {
                reading.session = Some(id.to_owned());
            }
            match kind {
                "text" => {
                    let message = str_at(&event, "/part/messageID").map(str::to_owned);
                    if message != reading.message {
                        reading.reply.clear();
                        reading.message = message;
                    }
                    reading.text(str_at(&event, "/part/text").unwrap_or(""));
                    None
                }
                "tool_use" => {
                    reading.tool();
                    Some(tool_label(
                        str_at(&event, "/part/tool").unwrap_or("tool"),
                        event.pointer("/part/state/input"),
                    ))
                }
                "error" => {
                    reading.error = str_at(&event, "/error/data/message")
                        .or_else(|| str_at(&event, "/error/message"))
                        .or_else(|| str_at(&event, "/error/name"))
                        .map(str::to_owned)
                        .or(Some("opencode reported an error.".into()));
                    None
                }
                _ => None,
            }
        }
        "pi" => match kind {
            "session" => {
                reading.session = str_at(&event, "/id").map(str::to_owned);
                None
            }
            "tool_execution_start" => {
                reading.tool();
                Some(tool_label(
                    str_at(&event, "/toolName").unwrap_or("tool"),
                    event.get("args"),
                ))
            }
            "turn_end" => {
                let message = event.get("message")?;
                if str_at(message, "/stopReason") == Some("error") {
                    reading.error = str_at(message, "/errorMessage")
                        .map(str::to_owned)
                        .or(Some("Pi stopped with an error.".into()));
                }
                let text: String = message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| str_at(block, "/type") == Some("text"))
                    .filter_map(|block| str_at(block, "/text"))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.trim().is_empty() {
                    reading.reply = text;
                }
                None
            }
            _ => None,
        },
        "grok" => match kind {
            "text" => {
                reading.text(str_at(&event, "/data").unwrap_or(""));
                None
            }
            "tool_call" => {
                reading.tool();
                Some(tool_label(
                    str_at(&event, "/toolName")
                        .or_else(|| str_at(&event, "/title"))
                        .unwrap_or("tool"),
                    event.get("rawInput"),
                ))
            }
            "end" => {
                reading.session = str_at(&event, "/sessionId").map(str::to_owned);
                reading.done = true;
                None
            }
            "error" => {
                reading.error = str_at(&event, "/message").map(str::to_owned);
                None
            }
            _ => None,
        },
        _ => None,
    }
}

/// A tool name a person can read: Keel's own tools by what they do, shell
/// commands by the command.
fn tool_label(name: &str, input: Option<&Value>) -> String {
    let bare = name
        .rsplit("__")
        .next()
        .unwrap_or(name)
        .trim_start_matches("keel_");
    let keel = match bare {
        "tell_user" => Some("messaging you"),
        "list_projects" => Some("looking at Keel"),
        "read_pane" => Some("reading a pane"),
        "start_agent" => Some("starting an agent"),
        "send_to_pane" => Some("typing into a pane"),
        "open_project" => Some("opening a project"),
        "focus_pane" => Some("showing a pane"),
        "close_pane" => Some("closing a pane"),
        "send_file" => Some("sending you a file"),
        "press_key" => Some("pressing a key in a pane"),
        "remind_me" => Some("setting a reminder"),
        "list_reminders" => Some("looking at reminders"),
        "cancel_reminder" => Some("cancelling a reminder"),
        "check_usage" => Some("checking usage"),
        _ => None,
    };
    if let Some(label) = keel {
        return label.into();
    }
    let command = input.and_then(|input| {
        input
            .get("command")
            .or_else(|| input.get("cmd"))
            .and_then(Value::as_str)
    });
    match command {
        Some(command) => format!("$ {}", short(command, 48)),
        None => bare.to_string(),
    }
}

fn short(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(max - 1).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(agent: &str, lines: &[&str]) -> (Reading, Vec<String>) {
        let mut reading = Reading::default();
        let labels = lines
            .iter()
            .filter_map(|line| read_line(agent, line, &mut reading))
            .collect();
        (reading, labels)
    }

    #[test]
    fn claude_stream_json() {
        let (reading, labels) = read(
            "claude",
            &[
                r#"{"type":"system","subtype":"init","session_id":"11111111-2222-4333-8444-555555555555","tools":[]}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ToolSearch","input":{}}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check."},{"type":"tool_use","name":"mcp__keel__list_projects","input":{}}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm test\nmore"}}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"All green."}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"All green.","session_id":"11111111-2222-4333-8444-555555555555"}"#,
            ],
        );
        assert_eq!(
            reading.session.as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
        assert_eq!(reading.reply(), "All green.");
        assert_eq!(labels, ["looking at Keel", "$ pnpm test"]);
        assert!(reading.error.is_none());
        assert!(reading.done);
    }

    #[test]
    fn claude_error_result() {
        let (reading, _) = read(
            "claude",
            &[
                r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}"#,
            ],
        );
        assert_eq!(reading.error.as_deref(), Some("error_during_execution"));
        assert!(!reading.done);
    }

    #[test]
    fn codex_exec_json() {
        let (reading, labels) = read(
            "codex",
            &[
                r#"{"type":"thread.started","thread_id":"01a103d7-f067-74f1-9cd4-fadaad643785"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll call keel_ping.\n"}}"#,
                r#"{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"keel","tool":"read_pane","arguments":{},"status":"in_progress"}}"#,
                r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"PINGED-42"}}"#,
                r#"{"type":"turn.completed","usage":{}}"#,
            ],
        );
        assert_eq!(
            reading.session.as_deref(),
            Some("01a103d7-f067-74f1-9cd4-fadaad643785")
        );
        assert_eq!(reading.reply(), "PINGED-42");
        assert_eq!(labels, ["reading a pane"]);
        assert!(reading.done);
    }

    #[test]
    fn codex_failure() {
        let (reading, _) = read(
            "codex",
            &[r#"{"type":"turn.failed","error":{"message":"usage limit reached"}}"#],
        );
        assert_eq!(reading.error.as_deref(), Some("usage limit reached"));
    }

    #[test]
    fn opencode_run_json() {
        let (reading, labels) = read(
            "opencode",
            &[
                r#"{"type":"step_start","sessionID":"ses_efc27c1feffeSi05MgQZuf9bot","part":{"type":"step-start"}}"#,
                r#"{"type":"text","sessionID":"ses_efc27c1feffeSi05MgQZuf9bot","part":{"messageID":"msg_1","type":"text","text":"Checking"}}"#,
                r#"{"type":"tool_use","sessionID":"ses_efc27c1feffeSi05MgQZuf9bot","part":{"type":"tool","tool":"keel_start_agent","state":{"status":"completed","input":{}}}}"#,
                r#"{"type":"text","sessionID":"ses_efc27c1feffeSi05MgQZuf9bot","part":{"messageID":"msg_2","type":"text","text":"Started "}}"#,
                r#"{"type":"text","sessionID":"ses_efc27c1feffeSi05MgQZuf9bot","part":{"messageID":"msg_2","type":"text","text":"Codex."}}"#,
            ],
        );
        assert_eq!(
            reading.session.as_deref(),
            Some("ses_efc27c1feffeSi05MgQZuf9bot")
        );
        assert_eq!(reading.reply(), "Started Codex.");
        assert_eq!(labels, ["starting an agent"]);
        // No end-of-turn event: the reply waits for the output to close.
        assert!(!reading.done);
    }

    #[test]
    fn pi_json_mode() {
        let (reading, labels) = read(
            "pi",
            &[
                r#"{"type":"session","version":3,"id":"31111111-2222-4333-8444-555555555555"}"#,
                r#"{"type":"tool_execution_start","toolName":"mcp__keel__focus_pane","args":{}}"#,
                r#"{"type":"turn_end","message":{"role":"assistant","content":[{"type":"toolCall"}]}}"#,
                r#"{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"pong"}],"stopReason":"stop"}}"#,
            ],
        );
        assert_eq!(
            reading.session.as_deref(),
            Some("31111111-2222-4333-8444-555555555555")
        );
        assert_eq!(reading.reply(), "pong");
        assert_eq!(labels, ["showing a pane"]);
        // One process can end several turns, so none of them is the last.
        assert!(!reading.done);
    }

    #[test]
    fn grok_streaming_json() {
        let (reading, labels) = read(
            "grok",
            &[
                r#"{"type":"text","data":"Let me look"}"#,
                r#"{"type":"tool_call","toolCallId":"call_1","title":"Read","toolName":"read_file","rawInput":{"path":"a"}}"#,
                r#"{"type":"text","data":"Here's "}"#,
                r#"{"type":"text","data":"a summary"}"#,
                r#"{"type":"end","stopReason":"end_turn","sessionId":"abc123"}"#,
            ],
        );
        assert_eq!(reading.session.as_deref(), Some("abc123"));
        assert_eq!(reading.reply(), "Here's a summary");
        assert_eq!(labels, ["read_file"]);
        assert!(reading.done);

        let (failed, _) = read(
            "grok",
            &[r#"{"type":"error","message":"Grok Build usage balance exhausted"}"#],
        );
        assert_eq!(
            failed.error.as_deref(),
            Some("Grok Build usage balance exhausted")
        );
    }

    #[test]
    fn non_json_lines_are_ignored() {
        let (reading, labels) = read(
            "codex",
            &["2026-10-03 ERROR rmcp::transport::worker: closed", ""],
        );
        assert!(labels.is_empty());
        assert_eq!(reading.reply(), "");
    }

    #[test]
    fn prepares_resumable_command_lines() {
        let home = std::env::temp_dir().join(format!("keel-assistant-test-{}", std::process::id()));
        let mcp = Mcp {
            url: "http://127.0.0.1:1/mcp".into(),
            token: "t".into(),
        };
        let projects = [PathBuf::from("C:/code/keel")];
        let images = [PathBuf::from("C:/inbox/1-0.jpg")];
        let turn = |session| Turn {
            prompt: "hi",
            session,
            home: &home,
            mcp: &mcp,
            projects: &projects,
            rules: "be brief",
            images: &[],
        };
        let with_image = |agent| {
            prepare(
                agent,
                &Turn {
                    images: &images,
                    ..turn(None)
                },
            )
            .unwrap()
            .args
        };
        let codex = with_image("codex");
        assert!(codex.contains(&"--image=C:/inbox/1-0.jpg".to_string()));
        assert_eq!(codex.last().map(String::as_str), Some("-"));
        let opencode = with_image("opencode");
        assert_eq!(&opencode[..3], ["run", "--file", "C:/inbox/1-0.jpg"]);
        assert!(with_image("pi").contains(&"@C:/inbox/1-0.jpg".to_string()));

        let first = prepare("claude", &turn(None)).unwrap();
        let chosen = first.session.clone().unwrap();
        assert!(first
            .args
            .windows(2)
            .any(|pair| pair[0] == "--session-id" && pair[1] == chosen));
        assert!(first.args.windows(2).any(|pair| pair[0] == "--add-dir"));
        assert!(first.args.contains(&"--strict-mcp-config".to_string()));
        let again = prepare("claude", &turn(Some(&chosen))).unwrap();
        assert!(again
            .args
            .windows(2)
            .any(|pair| pair[0] == "--resume" && pair[1] == chosen));
        assert!(again.session.is_none());

        let codex = prepare("codex", &turn(Some("thread-1"))).unwrap();
        assert_eq!(&codex.args[..3], ["exec", "resume", "thread-1"]);
        assert_eq!(codex.args.last().map(String::as_str), Some("-"));
        assert!(codex
            .env
            .iter()
            .any(|(key, value)| key == "KEEL_MCP_TOKEN" && value == "t"));

        let pi = prepare("pi", &turn(None)).unwrap();
        let id = pi.session.clone().unwrap();
        assert!(pi.args.contains(&id));
        assert!(home.join(".pi").join("mcp.json").is_file());

        let grok = prepare("grok", &turn(None)).unwrap();
        assert!(grok.args.contains(&"--trust".to_string()));
        assert!(home.join(".grok").join("config.toml").is_file());

        assert!(prepare("aider", &turn(None)).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
