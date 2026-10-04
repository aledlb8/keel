//! Keel as an MCP server, so the main agent can see and drive the app.
//!
//! Streamable HTTP on loopback, answering every request with a single JSON
//! body (the transport allows that instead of an event stream, and every CLI
//! the main agent can be accepts it). A bearer token minted per launch keeps
//! other local programs out.
//!
//! The tools describe and change the workspace, and the workspace is owned by
//! the webview's store. So a call is handed to the window as an event, and the
//! HTTP request waits for the window's answer. `tell_user` is the exception:
//! it goes straight to the phone through the notifier the assistant sets.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const MAX_BODY: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 16;
/// Starting an agent waits for its prompt to be typed; nothing else is close.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);

type Pending = Arc<Mutex<HashMap<String, Sender<Result<String, String>>>>>;
/// Sends the user a message on the phone, for `tell_user`.
pub type Notifier = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
type Notify = Arc<OnceLock<Notifier>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

pub struct McpServer {
    pub port: u16,
    pub token: String,
    pending: Pending,
    /// How many times an agent has asked for the tools, so a turn that never
    /// did can be told apart from one that had them.
    listed: Arc<AtomicUsize>,
    notify: Notify,
}

impl McpServer {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| err.to_string())?;
        let port = listener.local_addr().map_err(|err| err.to_string())?.port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let pending: Pending = Arc::default();
        let open = Arc::new(AtomicUsize::new(0));
        let listed = Arc::new(AtomicUsize::new(0));
        let notify: Notify = Arc::default();

        let worker_token = token.clone();
        let worker_pending = pending.clone();
        let worker_listed = listed.clone();
        let worker_notify = notify.clone();
        std::thread::Builder::new()
            .name("keel-assistant-mcp".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    // A tool call can wait on the window, so each request gets
                    // its own thread — but only a handful at once.
                    if open.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                        continue;
                    }
                    open.fetch_add(1, Ordering::SeqCst);
                    let open = open.clone();
                    let app = app.clone();
                    let token = worker_token.clone();
                    let pending = worker_pending.clone();
                    let listed = worker_listed.clone();
                    let notify = worker_notify.clone();
                    let _ = std::thread::Builder::new()
                        .name("keel-assistant-mcp-call".into())
                        .spawn(move || {
                            serve(stream, &app, &token, &pending, &listed, &notify);
                            open.fetch_sub(1, Ordering::SeqCst);
                        });
                }
            })
            .map_err(|err| err.to_string())?;

        Ok(Self {
            port,
            token,
            pending,
            listed,
            notify,
        })
    }

    /// Where `tell_user` messages go. Set once.
    pub fn set_notifier(&self, notifier: Notifier) {
        let _ = self.notify.set(notifier);
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    /// Times an agent has listed the tools since Keel started.
    pub fn listings(&self) -> usize {
        self.listed.load(Ordering::SeqCst)
    }

    /// Run a tool for Keel itself, not for the agent.
    pub fn ask(&self, app: &AppHandle, call: ToolCall) -> Result<String, String> {
        forward(app, &self.pending, &self.notify, call)
    }

    /// The window's answer to a call it was handed.
    pub fn resolve(&self, call_id: &str, result: Result<String, String>) {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(call_id));
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }
}

struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let started = Instant::now();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16 * 1024 || started.elapsed() > Duration::from_secs(5) {
            return None;
        }
        let mut byte = [0];
        stream.read_exact(&mut byte).ok()?;
        header.push(byte[0]);
    }
    let header = std::str::from_utf8(&header).ok()?;
    let mut lines = header.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();
    let mut length = 0;
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok()?;
        } else if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.to_string());
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return None;
        }
    }
    if length > MAX_BODY {
        return None;
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        authorization,
        body,
    })
}

fn respond(stream: &mut TcpStream, status: &str, body: Option<&Value>) {
    let text = body.map(Value::to_string).unwrap_or_default();
    let content_type = if body.is_some() {
        "Content-Type: application/json\r\n"
    } else {
        ""
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.flush();
}

/// Constant-time, so the token cannot be guessed a byte at a time.
fn token_matches(header: Option<&str>, token: &str) -> bool {
    let Some(given) = header.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    let (given, token) = (given.trim().as_bytes(), token.as_bytes());
    given.len() == token.len()
        && given
            .iter()
            .zip(token)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn serve(
    mut stream: TcpStream,
    app: &AppHandle,
    token: &str,
    pending: &Pending,
    listed: &AtomicUsize,
    notify: &Notify,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let Some(request) = read_request(&mut stream) else {
        respond(&mut stream, "400 Bad Request", None);
        return;
    };
    if request.path.split('?').next() != Some("/mcp") {
        respond(&mut stream, "404 Not Found", None);
        return;
    }
    if !token_matches(request.authorization.as_deref(), token) {
        respond(&mut stream, "401 Unauthorized", None);
        return;
    }
    match request.method.as_str() {
        "POST" => {}
        // No server-initiated stream and no sessions to end.
        "GET" | "DELETE" => {
            respond(&mut stream, "405 Method Not Allowed", None);
            return;
        }
        _ => {
            respond(&mut stream, "405 Method Not Allowed", None);
            return;
        }
    }
    let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
        respond(
            &mut stream,
            "400 Bad Request",
            Some(&rpc_error(Value::Null, -32700, "Parse error")),
        );
        return;
    };
    if message.get("method").and_then(Value::as_str) == Some("tools/list") {
        listed.fetch_add(1, Ordering::SeqCst);
    }
    match handle(message, |call| forward(app, pending, notify, call)) {
        Some(reply) => respond(&mut stream, "200 OK", Some(&reply)),
        None => respond(&mut stream, "202 Accepted", None),
    }
}

fn forward(
    app: &AppHandle,
    pending: &Pending,
    notify: &Notify,
    call: ToolCall,
) -> Result<String, String> {
    if call.name == "tell_user" {
        let text = call
            .arguments
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or("Give the message as `text`.")?;
        let notifier = notify.get().ok_or("Telegram isn't connected.")?;
        notifier(text)?;
        return Ok("Sent. Carry on; your final reply still goes to the user.".into());
    }
    if call.name == "open_project" {
        // The folder allowlist is Rust's: register it here, then let the
        // window add the project the same way a folder pick would.
        let path = call
            .arguments
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Give the project's folder as `path`.")?;
        let canon = crate::roots::register(Path::new(path))?;
        let mut call = call;
        call.arguments["path"] = json!(canon.to_string_lossy());
        return ask_window(app, pending, call);
    }
    ask_window(app, pending, call)
}

fn ask_window(app: &AppHandle, pending: &Pending, call: ToolCall) -> Result<String, String> {
    let (sender, receiver) = mpsc::channel();
    let id = call.call_id.clone();
    pending
        .lock()
        .map_err(|err| err.to_string())?
        .insert(id.clone(), sender);
    if app.emit("assistant:tool", &call).is_err() {
        pending.lock().map_err(|err| err.to_string())?.remove(&id);
        return Err("Keel's window isn't available.".into());
    }
    let answer = receiver.recv_timeout(CALL_TIMEOUT);
    if let Ok(mut pending) = pending.lock() {
        pending.remove(&id);
    }
    answer.unwrap_or_else(|_| Err("Keel didn't answer in time.".into()))
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message in, its reply out. Notifications have no reply.
pub fn handle(
    message: Value,
    call: impl FnOnce(ToolCall) -> Result<String, String>,
) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "keel", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Tools for Keel, the desktop app the user runs their coding agents in.",
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if !tools()
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            {
                return Some(rpc_error(id, -32602, &format!("Unknown tool: {name}")));
            }
            let outcome = call(ToolCall {
                call_id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                arguments: params
                    .get("arguments")
                    .cloned()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({})),
            });
            let (text, is_error) = match outcome {
                Ok(text) => (text, false),
                Err(text) => (text, true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
        }
        _ => return Some(rpc_error(id, -32601, "Method not found")),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        },
    })
}

fn tools() -> Vec<Value> {
    let pane = json!({ "type": "string", "description": "Pane id from list_projects." });
    vec![
        tool(
            "tell_user",
            "Send the user a short message on Telegram right away, without ending your turn. Use it once, at the start of a task that takes work, to confirm in a sentence what you understood and what you're doing now. Not for the final answer.",
            json!({ "text": { "type": "string", "description": "One short sentence." } }),
            &["text"],
        ),
        tool(
            "list_projects",
            "Everything open in Keel: workspaces, projects (name, folder), and every terminal pane in them with its agent, status (working, waiting for input, done, idle) and folder. Call this first to find project and pane ids.",
            json!({}),
            &[],
        ),
        tool(
            "read_pane",
            "The last lines on a terminal pane's screen, as text. Use it to see what an agent is doing or what it answered.",
            json!({
                "pane_id": pane,
                "lines": { "type": "integer", "minimum": 5, "maximum": 400, "description": "How many lines from the bottom. Default 60." },
            }),
            &["pane_id"],
        ),
        tool(
            "start_agent",
            "Open a new terminal pane in a project and start a coding agent in it, optionally typing a first prompt once it is ready. The user can watch it in Keel. When it finishes you will be told and can report back.",
            json!({
                "project": { "type": "string", "description": "Project id, name or folder." },
                "agent": { "type": "string", "description": "Agent id (see list_projects -> agents). Leave out for a plain shell." },
                "prompt": { "type": "string", "description": "First message to give the agent: the user's request in their own words, not rewritten or expanded." },
                "title": { "type": "string", "description": "Short pane name." },
            }),
            &["project"],
        ),
        tool(
            "send_to_pane",
            "Type text into a terminal pane, as if the user typed it, and press Enter unless submit is false. Use it to answer an agent that is waiting, or give it a follow-up instruction.",
            json!({
                "pane_id": pane,
                "text": { "type": "string", "description": "When passing on something the user said, keep their wording." },
                "submit": { "type": "boolean", "description": "Press Enter after the text. Default true." },
            }),
            &["pane_id", "text"],
        ),
        tool(
            "open_project",
            "Add a folder on this computer to Keel as a project.",
            json!({
                "path": { "type": "string", "description": "Absolute folder path." },
                "name": { "type": "string" },
            }),
            &["path"],
        ),
        tool(
            "focus_pane",
            "Bring a pane to the front in Keel's window, switching project and deck if needed.",
            json!({ "pane_id": pane }),
            &["pane_id"],
        ),
        tool(
            "close_pane",
            "Close a pane you started with start_agent, ending whatever runs in it. Panes the user opened can't be closed this way.",
            json!({ "pane_id": pane }),
            &["pane_id"],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_and_lists_tools() {
        let init = handle(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["capabilities"]["tools"].is_object());

        let list = handle(
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            |_| unreachable!(),
        )
        .unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"list_projects"));
        assert!(names.contains(&"start_agent"));
        assert!(names.contains(&"tell_user"));
    }

    #[test]
    fn notifications_get_no_reply() {
        assert!(handle(
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            |_| unreachable!()
        )
        .is_none());
    }

    #[test]
    fn calls_reach_the_window_and_errors_come_back_as_tool_errors() {
        let ok = handle(
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "read_pane", "arguments": { "pane_id": "p1" } } }),
            |call| {
                assert_eq!(call.name, "read_pane");
                assert_eq!(call.arguments["pane_id"], "p1");
                Ok("screen".into())
            },
        )
        .unwrap();
        assert_eq!(ok["result"]["content"][0]["text"], "screen");
        assert_eq!(ok["result"]["isError"], false);

        let failed = handle(
            json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "focus_pane", "arguments": {} } }),
            |_| Err("No such pane.".into()),
        )
        .unwrap();
        assert_eq!(failed["result"]["isError"], true);

        let unknown = handle(
            json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "rm_rf" } }),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
    }

    #[test]
    fn bearer_token_must_match_exactly() {
        assert!(token_matches(Some("Bearer abc"), "abc"));
        assert!(!token_matches(Some("Bearer abd"), "abc"));
        assert!(!token_matches(Some("Bearer ab"), "abc"));
        assert!(!token_matches(Some("abc"), "abc"));
        assert!(!token_matches(None, "abc"));
    }
}
