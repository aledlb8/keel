//! Pane-scoped provider events. Terminal bytes are deliberately not involved.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

const MAX_BODY: usize = 1024 * 1024;
type Routes = Arc<Mutex<HashMap<String, Route>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub agent_id: String,
    pub session_id: String,
    pub kind: String,
    pub sequence: u64,
}

struct Route {
    channel: Channel<AgentEvent>,
    sequence: u64,
    alive: Arc<AtomicBool>,
    origin: Option<HookOrigin>,
}

#[derive(Clone)]
struct HookOrigin {
    shell_pid: u32,
    agents: Vec<crate::procs::AgentNeedle>,
}

pub struct HookLease {
    token: String,
    routes: Routes,
    pub port: u16,
    pub alive: Arc<AtomicBool>,
}

impl HookLease {
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn bind_process(&self, shell_pid: u32, agents: Vec<crate::procs::AgentNeedle>) {
        if let Ok(mut routes) = self.routes.lock() {
            if let Some(route) = routes.get_mut(&self.token) {
                route.origin = Some(HookOrigin { shell_pid, agents });
            }
        }
    }
}

impl Drop for HookLease {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(&self.token);
        }
    }
}

struct Server {
    port: u16,
    routes: Routes,
}

pub fn register(channel: Channel<AgentEvent>) -> Result<HookLease, String> {
    static SERVER: OnceLock<Result<Server, String>> = OnceLock::new();
    let server = SERVER
        .get_or_init(start_server)
        .as_ref()
        .map_err(Clone::clone)?;
    let token = uuid::Uuid::new_v4().to_string();
    let alive = Arc::new(AtomicBool::new(true));
    server.routes.lock().map_err(|e| e.to_string())?.insert(
        token.clone(),
        Route {
            channel,
            sequence: 0,
            alive: alive.clone(),
            origin: None,
        },
    );
    Ok(HookLease {
        token,
        routes: server.routes.clone(),
        port: server.port,
        alive,
    })
}

fn start_server() -> Result<Server, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    let worker_routes = routes.clone();
    std::thread::Builder::new().name("keel-agent-hooks".into()).spawn(move || {
        // One FIFO keeps event delivery ordered, with no thread or queue per token.
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
            let accepted = receive(&mut stream, &worker_routes).is_some();
            let status = if accepted { "200 OK" } else { "400 Bad Request" };
            // Observation only: never allow/deny a tool or add model context.
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
        }
    }).map_err(|e| e.to_string())?;
    Ok(Server { port, routes })
}

fn receive(stream: &mut TcpStream, routes: &Routes) -> Option<()> {
    let started = Instant::now();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 8192 || started.elapsed() > Duration::from_secs(2) {
            return None;
        }
        let mut byte = [0];
        stream.read_exact(&mut byte).ok()?;
        header.push(byte[0]);
    }
    let header = std::str::from_utf8(&header).ok()?;
    let mut lines = header.split("\r\n");
    let request = lines.next()?;
    let path = request.strip_prefix("POST /")?.strip_suffix(" HTTP/1.1")?;
    let (token, source) = path.split_once('/')?;
    if !routes.lock().ok()?.contains_key(token) {
        return None;
    }
    let mut length = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                if length.is_some() {
                    return None;
                }
                length = Some(value.trim().parse::<usize>().ok()?);
            }
            if name.eq_ignore_ascii_case("transfer-encoding") {
                return None;
            }
        }
    }
    let length = length.filter(|n| *n <= MAX_BODY)?;
    let mut body = vec![0; length];
    let mut offset = 0;
    while offset < length {
        if started.elapsed() > Duration::from_secs(2) {
            return None;
        }
        let read = stream.read(&mut body[offset..]).ok()?;
        if read == 0 {
            return None;
        }
        offset += read;
    }
    let body: Value = serde_json::from_slice(&body).ok()?;
    // Ignore unsupported/child events successfully so hooks never affect the CLI.
    if let Some(mut event) = normalize(source, &body) {
        let origin = routes.lock().ok()?.get(token)?.origin.clone()?;
        let sender = body
            .get("sender_pid")?
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())?;
        if !crate::procs::hook_source_matches(
            &crate::procs::process_snapshot(),
            origin.shell_pid,
            sender,
            source,
            &origin.agents,
            crate::procs::command_args,
        ) {
            return Some(());
        }
        let mut routes = routes.lock().ok()?;
        let route = routes.get_mut(token)?;
        if !route.alive.load(Ordering::SeqCst) {
            return None;
        }
        route.sequence += 1;
        event.sequence = route.sequence;
        route.channel.send(event).ok()?;
    }
    Some(())
}

pub fn normalize(source: &str, body: &Value) -> Option<AgentEvent> {
    if !matches!(source, "claude" | "codex" | "grok" | "opencode") {
        return None;
    }
    // Child turns must never bind their identity or finish their parent's pane.
    for key in [
        "agent_id",
        "parent_session_id",
        "parentID",
        "subagent_type",
        "subagentType",
    ] {
        if body
            .get(key)
            .is_some_and(|v| !v.is_null() && v.as_str() != Some(""))
        {
            return None;
        }
    }
    let id = body
        .get("session_id")
        .or_else(|| body.get("sessionId"))?
        .as_str()?;
    if !crate::sessions::is_session_id(id) {
        return None;
    }
    let name = body
        .get("hook_event_name")
        .or_else(|| body.get("hookEventName"))
        .or_else(|| body.get("hook_type"))
        .or_else(|| body.get("hookType"))?
        .as_str()?;
    let name = name.replace('_', "").to_ascii_lowercase();
    let kind = match name.as_str() {
        "sessionstart" if body.get("source").and_then(Value::as_str) == Some("compact") => {
            "identity"
        }
        "sessionstart" => "session",
        "sessionidentity" => "identity",
        "userpromptsubmit" => "working",
        "pretooluse" | "posttooluse" | "posttoolusefailure" => "progress",
        "permissionrequest" | "askuserquestion" => "waiting",
        "stop" => "completed",
        "stopcancelled" | "interrupt" => "cancelled",
        "stopfailure" | "sessionerror" => "failed",
        "sessionend" => "ended",
        "postcompact" => "idle",
        _ => return None,
    };
    let kind = if name == "pretooluse"
        && body
            .get("tool_name")
            .and_then(Value::as_str)
            .is_some_and(|name| {
                matches!(
                    name,
                    "AskUserQuestion"
                        | "askuserquestion"
                        | "request_user_input"
                        | "ask_user_question"
                )
            }) {
        "waiting"
    } else {
        kind
    };
    Some(AgentEvent {
        agent_id: source.into(),
        session_id: id.into(),
        kind: kind.into(),
        sequence: 0,
    })
}

/// Invoked by CLI command hooks, before Tauri starts. No agent prompts or output
/// are retained. The environment capability exists only in a Keel-owned shell.
pub fn run_helper() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--keel-agent-hook") {
        return false;
    }
    let _ = forward_hook(args.get(2).map(String::as_str).unwrap_or(""));
    println!("{{}}");
    true
}

fn forward_hook(source: &str) -> Option<()> {
    // Parse exactly one JSON value without waiting for EOF (Grok keeps stdin
    // open). Also accepts pretty-printed input, unlike a read_line parser.
    let mut input = serde_json::Deserializer::from_reader(std::io::stdin().take(MAX_BODY as u64));
    let body = Value::deserialize(&mut input).ok()?;
    // Grok imports ~/.claude/settings.json and runs those commands too. The
    // command's label identifies its config source, not necessarily its caller.
    // Only Grok's native observer may publish a Grok-run event.
    if imported_grok_hook(source, std::env::var_os("GROK_HOOK_EVENT").as_deref()) {
        return None;
    }
    let port: u16 = std::env::var("KEEL_HOOK_PORT").ok()?.parse().ok()?;
    let token = std::env::var("KEEL_HOOK_TOKEN").ok()?;
    uuid::Uuid::parse_str(&token).ok()?;
    if !matches!(source, "claude" | "codex" | "grok") {
        return None;
    }
    let event = normalize(source, &body)?;
    // Send only the lifecycle identity, never prompts/tool arguments/transcripts.
    let normalized = serde_json::json!({
        "sender_pid": std::process::id(),
        "session_id": event.session_id,
        "hook_event_name": match event.kind.as_str() {
            "session" => "SessionStart", "working" => "UserPromptSubmit",
            "identity" => "SessionIdentity",
            "progress" => "PostToolUse",
            "waiting" => "PermissionRequest", "completed" => "Stop",
            "cancelled" => "StopCancelled", "failed" => "StopFailure",
            "ended" => "SessionEnd", _ => "PostCompact",
        }
    });
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?
        .post(format!("http://127.0.0.1:{port}/{token}/{source}"))
        .json(&normalized)
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    Some(())
}

fn imported_grok_hook(source: &str, grok_event: Option<&std::ffi::OsStr>) -> bool {
    source != "grok" && grok_event.is_some_and(|event| !event.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn imported_claude_observer_cannot_publish_grok_as_claude() {
        use std::ffi::OsStr;
        for event in ["session_start", "user_prompt_submit", "stop", "session_end"] {
            assert!(imported_grok_hook("claude", Some(OsStr::new(event))));
            assert!(!imported_grok_hook("grok", Some(OsStr::new(event))));
        }
        assert!(!imported_grok_hook("claude", None));
        assert!(!imported_grok_hook("claude", Some(OsStr::new(""))));
    }

    #[test]
    fn normalizes_provider_identity_and_drops_children() {
        for source in ["claude", "codex", "grok", "opencode"] {
            let body = json!({"session_id":"chat-1", "hook_event_name":"Stop"});
            let event = normalize(source, &body).unwrap();
            assert_eq!(event.session_id, "chat-1");
            assert_eq!(event.kind, "completed");
            for field in ["agent_id", "parent_session_id", "subagentType"] {
                let mut child = body.clone();
                child[field] = json!("child");
                assert!(normalize(source, &child).is_none());
            }
        }
        assert_eq!(
            normalize(
                "grok",
                &json!({"sessionId":"grok-1", "hookEventName":"StopCancelled"})
            )
            .unwrap()
            .kind,
            "cancelled"
        );
        assert!(normalize(
            "claude",
            &json!({"session_id":"bad;command", "hook_event_name":"Stop"})
        )
        .is_none());
        assert!(normalize(
            "claude",
            &json!({"session_id":"chat", "hook_event_name":"SubagentStop"})
        )
        .is_none());
    }

    #[test]
    fn recognizes_permission_tools_and_compaction_without_finishing_a_turn() {
        for tool in ["AskUserQuestion", "request_user_input", "ask_user_question"] {
            let event = normalize(
                "claude",
                &json!({
                    "session_id": "chat", "hook_event_name": "PreToolUse", "tool_name": tool
                }),
            )
            .unwrap();
            assert_eq!(event.kind, "waiting");
        }
        let compact = normalize(
            "claude",
            &json!({
                "session_id": "chat", "hook_event_name": "SessionStart", "source": "compact"
            }),
        )
        .unwrap();
        assert_eq!(compact.kind, "identity");
        let grok = normalize(
            "grok",
            &json!({
                "sessionId": "chat", "hook_type": "user_prompt_submit"
            }),
        )
        .unwrap();
        assert_eq!(grok.kind, "working");
    }

    #[test]
    fn listener_isolates_panes_and_revokes_dead_generations() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let channel = Channel::new(move |event| {
            received.lock().unwrap().push(event);
            Ok(())
        });
        let lease = register(channel).unwrap();
        let rows = crate::procs::process_snapshot();
        let this_process = rows
            .iter()
            .find(|row| row.pid == std::process::id())
            .unwrap();
        lease.bind_process(
            this_process.parent,
            vec![crate::procs::AgentNeedle {
                id: "claude".into(),
                names: vec![crate::procs::executable_stem(&this_process.image)],
            }],
        );
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:{}/{}/claude", lease.port, lease.token());
        let body = json!({"session_id":"chat-a", "hook_event_name":"UserPromptSubmit", "sender_pid": std::process::id()});
        assert!(client
            .post(&url)
            .json(&body)
            .send()
            .unwrap()
            .status()
            .is_success());
        assert_eq!(events.lock().unwrap().len(), 1);
        // An authenticated token is insufficient: the provider must match the
        // invoking process, and the sender must still belong to this pane.
        assert!(client
            .post(url.replace("/claude", "/grok"))
            .json(&body)
            .send()
            .unwrap()
            .status()
            .is_success());
        let mut foreign = body.clone();
        foreign["sender_pid"] = json!(this_process.parent);
        assert!(client
            .post(&url)
            .json(&foreign)
            .send()
            .unwrap()
            .status()
            .is_success());
        assert_eq!(events.lock().unwrap().len(), 1);
        let invalid = format!("http://127.0.0.1:{}/unknown/claude", lease.port);
        assert!(!client
            .post(invalid)
            .json(&body)
            .send()
            .is_ok_and(|response| response.status().is_success()));
        lease.alive.store(false, Ordering::SeqCst);
        assert!(!client
            .post(&url)
            .json(&body)
            .send()
            .is_ok_and(|response| response.status().is_success()));
        drop(lease);
        assert!(!client
            .post(&url)
            .json(&body)
            .send()
            .is_ok_and(|response| response.status().is_success()));
        assert_eq!(events.lock().unwrap().len(), 1);
    }
}
