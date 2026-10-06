//! Handing a pane's conversation to another agent.
//!
//! A pane that owns a conversation (its id captured from the CLI's hooks) can
//! be handed to any other agent. Keel reads the conversation back out of the
//! CLI that had it (`handoff_read`), gathers the memory and instruction files
//! it worked under, writes both down (`handoff_write`) in a folder inside the
//! pane's working directory, and the window opens the new agent beside it with
//! a prompt pointing there.
//!
//! The folder is `<cwd>/.keel/handoffs/<stamp>/`, inside the workspace so every
//! agent's file tools may open it (Gemini and opencode refuse paths outside
//! it), and ignored by its own `.gitignore` so it never shows up in git.
//! Folders older than a month are cleared when the next one is made.
//!
//! What no file holds is the reasoning providers keep encrypted. For that the
//! window can first ask the agent itself to write notes (`NOTES.md`) while the
//! conversation is still in its head; `handoff_notes_ready` says when it has.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::handoff_read::{self as read, Conversation, Memory};
use crate::handoff_write::{self as write, Context, BRIEF, NOTES, TRANSCRIPT};

/// CLIs whose conversations Keel can read back. Each reports its session id
/// through hooks, which is what ties a pane to one conversation.
pub const SOURCES: &[&str] = &["claude", "codex", "grok", "opencode"];

/// Under the pane's working directory.
const FOLDER: [&str; 2] = [".keel", "handoffs"];
const KEEP: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// A memory file past this size is somebody's data, not a memory.
const MEMORY_BYTES: u64 = 256 * 1024;
const NOTES_CHARS: usize = 40_000;
/// Instruction files agents read from the folders they work in.
const INSTRUCTION_FILES: &[&str] = &[
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub agent_id: String,
    pub agent_name: String,
    #[serde(default)]
    pub account_id: Option<String>,
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    /// The folder's name under `.keel/handoffs`.
    pub name: String,
    /// What to type into the source pane to have it write its notes.
    pub notes_prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// What to type into the new agent's pane.
    pub prompt: String,
    /// The folder, relative to the working directory.
    pub folder: String,
    pub user_messages: usize,
    pub tool_calls: usize,
    pub thoughts: usize,
    pub hidden_thoughts: usize,
    pub memories: usize,
    pub notes: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `20261005-214012` in UTC, for folder names, and a reader's version of it.
fn stamps(secs: u64) -> (String, String) {
    let Ok(at) = time::OffsetDateTime::from_unix_timestamp(secs as i64) else {
        return (secs.to_string(), secs.to_string());
    };
    let (y, mo, d, h, mi, s) = (
        at.year(),
        at.month() as u8,
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
    );
    (
        format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}"),
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02} UTC"),
    )
}

/// Folder names Keel makes: the stamp, then a few hex digits.
fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 20
        && bytes[8] == b'-'
        && bytes[15] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 8 | 15) || b.is_ascii_hexdigit())
}

/// The working directory, only if it's inside a project Keel has open.
fn working_dir(cwd: &str) -> Result<PathBuf, String> {
    let path = Path::new(cwd);
    if cwd.is_empty() || !path.is_dir() || !crate::roots::is_under_registered(path) {
        return Err("That folder isn't part of a project open in Keel.".into());
    }
    Ok(path.to_path_buf())
}

fn handoffs(cwd: &Path) -> PathBuf {
    FOLDER
        .iter()
        .fold(cwd.to_path_buf(), |path, part| path.join(part))
}

fn folder_of(cwd: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("That isn't a handoff Keel made.".into());
    }
    Ok(handoffs(cwd).join(name))
}

fn relative(name: &str) -> String {
    format!("{}/{name}", FOLDER.join("/"))
}

/// Make the folder for one handoff, and clear out ones past their month.
#[tauri::command]
pub async fn handoff_begin(cwd: String, target_name: String) -> Result<Begun, String> {
    crate::blocking::run(move || begin(&cwd, &target_name)).await
}

fn begin(cwd: &str, target: &str) -> Result<Begun, String> {
    let cwd = working_dir(cwd)?;
    let root = handoffs(&cwd);
    std::fs::create_dir_all(&root)
        .map_err(|err| format!("Couldn't make {}: {err}", root.display()))?;
    // Ignores the folder and itself, without touching the project's own
    // .gitignore.
    let ignore = root.join(".gitignore");
    if !ignore.is_file() {
        crate::store::write_atomic(&ignore, "# Keel's agent handoffs. Never committed.\n*\n")?;
    }
    prune(&root, SystemTime::now());

    let (stamp, _) = stamps(now());
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..4];
    let name = format!("{stamp}-{suffix}");
    std::fs::create_dir(root.join(&name)).map_err(|err| err.to_string())?;
    Ok(Begun {
        notes_prompt: write::notes_prompt(target, &format!("{}/{NOTES}", relative(&name))),
        name,
    })
}

fn prune(root: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > KEEP);
        if stale && name.to_str().is_some_and(valid_name) && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The source agent has written its notes.
#[tauri::command]
pub fn handoff_notes_ready(cwd: String, name: String) -> bool {
    working_dir(&cwd)
        .and_then(|cwd| folder_of(&cwd, &name))
        .ok()
        .and_then(|folder| std::fs::metadata(folder.join(NOTES)).ok())
        .is_some_and(|meta| meta.is_file() && meta.len() > 0)
}

/// Read the conversation, write the brief and the transcript.
#[tauri::command]
pub async fn handoff_write(
    app: AppHandle,
    source: Source,
    name: String,
    target_name: String,
) -> Result<Written, String> {
    crate::blocking::run(move || {
        let places = Places::of(&app, &source)?;
        write_handoff(&places, &source, &name, &target_name)
    })
    .await
}

/// Where the source agent keeps its things, worked out from the app once so
/// the rest is plain file work.
struct Places {
    /// The agent's config home: `~/.claude`, `~/.codex`, a profile's folder.
    home: Option<PathBuf>,
    /// opencode's executable, for its export.
    opencode: Option<PathBuf>,
    /// The data home a profile gives opencode.
    data_home: Option<PathBuf>,
    /// The user's home, for files kept under `~/.config`.
    user_home: Option<PathBuf>,
}

impl Places {
    fn of(app: &AppHandle, source: &Source) -> Result<Self, String> {
        let account = source.account_id.as_deref().filter(|id| !id.is_empty());
        if account.is_some_and(|id| {
            !id.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        }) {
            return Err("That profile isn't one Keel made.".into());
        }
        let opencode = source.agent_id == "opencode";
        Ok(Self {
            home: crate::usage::config_home(app, &source.agent_id, account),
            opencode: opencode
                .then(|| crate::agents::executable(app, "opencode").map(|(_, path)| path))
                .flatten(),
            // The same data home the pane's opencode ran with.
            data_home: account.filter(|_| opencode).and_then(|account| {
                app.path()
                    .app_config_dir()
                    .ok()
                    .map(|dir| dir.join("accounts").join(account))
            }),
            user_home: crate::pty::home_dir(),
        })
    }
}

fn write_handoff(
    places: &Places,
    source: &Source,
    name: &str,
    target: &str,
) -> Result<Written, String> {
    if !SOURCES.contains(&source.agent_id.as_str()) {
        return Err(format!(
            "Keel can't read {}'s conversations yet.",
            source.agent_name
        ));
    }
    if !crate::sessions::is_session_id(&source.session_id) {
        return Err("This pane has no conversation linked to it yet.".into());
    }
    let cwd = working_dir(&source.cwd)?;
    let folder = folder_of(&cwd, name)?;
    if !folder.is_dir() {
        return Err("The handoff folder is gone. Try again.".into());
    }

    let (conversation, memories) = read_source(places, source, &cwd)?;
    let notes = std::fs::read_to_string(folder.join(NOTES))
        .ok()
        .filter(|notes| !notes.trim().is_empty())
        .map(|notes| write::cut(&notes, NOTES_CHARS));
    let (_, when) = stamps(now());
    let title = Some(source.title.trim())
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .or_else(|| conversation.title.clone())
        .unwrap_or_else(|| "Untitled".into());
    let context = Context {
        source: &source.agent_name,
        target,
        session_id: &source.session_id,
        cwd: &source.cwd,
        title: &title,
        when: &when,
        git: git_state(&cwd),
        memories,
        notes,
    };
    crate::store::write_atomic(
        &folder.join(TRANSCRIPT),
        &write::transcript(&conversation, &context),
    )?;
    crate::store::write_atomic(&folder.join(BRIEF), &write::brief(&conversation, &context))?;

    let folder = relative(name);
    Ok(Written {
        prompt: write::prompt(&source.agent_name, &folder),
        folder,
        user_messages: conversation.user_messages(),
        tool_calls: conversation.tool_calls(),
        thoughts: conversation.thoughts(),
        hidden_thoughts: conversation.hidden_thoughts,
        memories: write::merged_memories(
            &context.memories,
            &conversation.memories,
            &source.agent_name,
        )
        .len(),
        notes: context.notes.is_some(),
    })
}

/// The conversation, and the memory and instruction files on disk that went
/// with it.
fn read_source(
    places: &Places,
    source: &Source,
    cwd: &Path,
) -> Result<(Conversation, Vec<Memory>), String> {
    let id = source.session_id.as_str();
    let home = places.home.clone();
    let mut memories = project_memories(cwd);
    let missing = || {
        format!(
            "Keel couldn't find this conversation in {}'s saved sessions. It may have been deleted.",
            source.agent_name
        )
    };
    let conversation = match source.agent_id.as_str() {
        "claude" => {
            let home = home.ok_or_else(missing)?;
            let file = claude_transcript(&home, cwd, id).ok_or_else(missing)?;
            user_memory(&mut memories, &home.join("CLAUDE.md"));
            // Claude's own notes on the user and project, kept beside the transcript.
            if let Some(dir) = file.parent() {
                memory_folder(&mut memories, &dir.join("memory"), "Claude Code's memory");
            }
            read::claude(&read_text(&file)?)
        }
        "codex" => {
            let home = home.ok_or_else(missing)?;
            let file = codex_rollout(&home, id).ok_or_else(missing)?;
            user_memory(&mut memories, &home.join("AGENTS.md"));
            read::codex(&read_text(&file)?)
        }
        "grok" => {
            let home = home.ok_or_else(missing)?;
            let file = grok_updates(&home, &source.cwd, id).ok_or_else(missing)?;
            grok_memory(&mut memories, &home, cwd);
            read::grok(&read_text(&file)?)
        }
        "opencode" => {
            if let Some(user) = &places.user_home {
                user_memory(
                    &mut memories,
                    &user.join(".config").join("opencode").join("AGENTS.md"),
                );
            }
            let program = places.opencode.as_deref().ok_or(
                "opencode isn't installed where Keel can find it, so its conversation can't be read.",
            )?;
            read::opencode(&opencode_export(program, places.data_home.as_deref(), id)?)?
        }
        other => return Err(format!("Keel can't read {other}'s conversations yet.")),
    };
    Ok((conversation, memories))
}

fn read_text(file: &Path) -> Result<String, String> {
    std::fs::read(file)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|err| format!("Couldn't read {}: {err}", file.display()))
}

/// Claude names each project's folder after its path, every character that
/// isn't a letter or digit turned into `-`. Look there first, then anywhere:
/// a session may have moved folders with `/cd`.
fn claude_transcript(home: &Path, cwd: &Path, id: &str) -> Option<PathBuf> {
    let projects = home.join("projects");
    let file = format!("{id}.jsonl");
    let encoded: String = cwd
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let first = projects.join(encoded).join(&file);
    if first.is_file() {
        return Some(first);
    }
    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file))
        .find(|path| path.is_file())
}

/// Codex files rollouts by day: `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`,
/// and moves archived ones to `archived_sessions/`.
fn codex_rollout(home: &Path, id: &str) -> Option<PathBuf> {
    // `rollout-` and a 19-character time, then the id: the id compared whole,
    // so one session's id ending another's can't match.
    let wanted = format!("{id}.jsonl");
    let matches = |path: &Path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("rollout-"))
            .and_then(|rest| rest.get(19..))
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|rest| rest == wanted)
    };
    fn walk(dir: &Path, depth: usize, found: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .collect();
        // Newest days first: the conversation is most likely recent.
        entries.sort_unstable_by(|a, b| b.cmp(a));
        for path in entries {
            if path.is_dir() && depth > 0 {
                if let Some(hit) = walk(&path, depth - 1, found) {
                    return Some(hit);
                }
            } else if found(&path) {
                return Some(path);
            }
        }
        None
    }
    walk(&home.join("sessions"), 3, &matches)
        .or_else(|| walk(&home.join("archived_sessions"), 0, &matches))
}

/// `sessions/<cwd, percent-encoded>/<id>/updates.jsonl`, or the same id under
/// any folder if the session started somewhere else.
fn grok_updates(home: &Path, cwd: &str, id: &str) -> Option<PathBuf> {
    let sessions = home.join("sessions");
    let first = sessions
        .join(crate::sessions::percent_encode(cwd))
        .join(id)
        .join("updates.jsonl");
    if first.is_file() {
        return Some(first);
    }
    std::fs::read_dir(&sessions)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(id).join("updates.jsonl"))
        .find(|path| path.is_file())
}

/// opencode keeps sessions in a database whose shape changes between
/// releases; its own export is the stable way out.
fn opencode_export(program: &Path, data_home: Option<&Path>, id: &str) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(["export", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(data_home) = data_home {
        command.env("XDG_DATA_HOME", data_home);
    }
    crate::git::hide_window(&mut command);
    let child = command
        .spawn()
        .map_err(|err| format!("Couldn't run opencode: {err}"))?;
    let output =
        crate::git::wait_output_timeout(child, Duration::from_secs(90), "opencode export")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "opencode couldn't export the conversation: {}",
            detail.lines().last().unwrap_or("no reason given").trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn read_memory(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MEMORY_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

fn add_memory(memories: &mut Vec<Memory>, label: String, path: &Path) {
    // One file can be reached by two names on a case-insensitive disk.
    let key = |path: &Path| {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_lowercase()
    };
    let this = key(path);
    if memories
        .iter()
        .any(|memory| key(Path::new(&memory.path)) == this)
    {
        return;
    }
    if let Some(content) = read_memory(path) {
        memories.push(Memory {
            label,
            path: path.to_string_lossy().into_owned(),
            content,
        });
    }
}

fn user_memory(memories: &mut Vec<Memory>, path: &Path) {
    add_memory(memories, path.to_string_lossy().into_owned(), path);
}

/// Instruction files from the project's root down to the working directory,
/// the order agents read them in.
fn project_memories(cwd: &Path) -> Vec<Memory> {
    // Registered roots are canonical; compare like with like.
    let cwd = crate::paths::canonicalize_dir(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let root = crate::roots::registered()
        .into_iter()
        .filter(|root| cwd.starts_with(root))
        .max_by_key(|root| root.components().count())
        .unwrap_or_else(|| cwd.clone());
    let mut dirs = vec![cwd.clone()];
    let mut dir = cwd.as_path();
    while dir != root {
        match dir.parent() {
            Some(parent) if parent.starts_with(&root) => {
                dirs.push(parent.to_path_buf());
                dir = parent;
            }
            _ => break,
        }
    }
    dirs.reverse();
    let mut memories = Vec::new();
    for dir in dirs {
        for file in INSTRUCTION_FILES {
            let path = file
                .split('/')
                .fold(dir.clone(), |path, part| path.join(part));
            user_memory(&mut memories, &path);
        }
    }
    memories
}

/// Every Markdown file in a memory folder, its index first.
fn memory_folder(memories: &mut Vec<Memory>, dir: &Path, what: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .collect();
    files.sort_by_key(|path| {
        let index = path
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("MEMORY.md"));
        (!index, path.clone())
    });
    for file in files {
        let name = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        add_memory(
            memories,
            format!("{what}: {name} ({})", file.display()),
            &file,
        );
    }
}

/// Grok files what it learns per project in `memory-v2/workspaces/<name>-<hash>`.
/// The hash isn't derivable from outside, so the folder counts only when
/// exactly one is named for this project.
fn grok_memory(memories: &mut Vec<Memory>, home: &Path, cwd: &Path) {
    let Some(project) = cwd
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(home.join("memory-v2").join("workspaces")) else {
        return;
    };
    let named: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.rsplit_once('-'))
                .is_some_and(|(stem, hash)| {
                    stem == project
                        && hash.len() == 8
                        && hash.bytes().all(|b| b.is_ascii_hexdigit())
                })
        })
        .collect();
    if let [workspace] = named.as_slice() {
        memory_folder(memories, workspace, "Grok's memory");
        memory_folder(memories, &workspace.join("topics"), "Grok's memory");
    }
}

/// Branch, changes and recent commits, as git prints them.
fn git_state(cwd: &Path) -> Option<String> {
    let git = |args: &[&str]| -> Option<String> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(cwd)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::git::apply_git_env(&mut command);
        crate::git::hide_window(&mut command);
        let child = command.spawn().ok()?;
        let output = crate::git::wait_output_timeout(child, Duration::from_secs(15), "git").ok()?;
        output
            .status
            .success()
            .then(|| crate::git::redact_git_output(&String::from_utf8_lossy(&output.stdout)))
    };
    let status = git(&["status", "--short", "--branch"])?;
    let mut lines: Vec<&str> = status.lines().collect();
    let more = lines.len().saturating_sub(80);
    lines.truncate(80);
    let mut out = format!("$ git status --short --branch\n{}", lines.join("\n"));
    if more > 0 {
        out.push_str(&format!("\n… and {more} more"));
    }
    if let Some(log) = git(&["log", "--oneline", "-n", "10"]) {
        out.push_str(&format!(
            "\n\n$ git log --oneline -n 10\n{}",
            log.trim_end()
        ));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("keel-handoff-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_handoff_is_written_where_every_agent_can_read_it_and_git_never_sees_it() {
        let scratch = scratch("e2e");
        let cwd = scratch.join("project");
        let home = scratch.join("claude-home");
        let transcripts = home.join("projects").join("somewhere");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(transcripts.join("memory")).unwrap();
        std::fs::write(cwd.join("AGENTS.md"), "Run pnpm check before committing.").unwrap();
        std::fs::write(home.join("CLAUDE.md"), "Never add co-authors.").unwrap();
        std::fs::write(
            transcripts.join("memory").join("MEMORY.md"),
            "- Prefers Codex for UI.",
        )
        .unwrap();
        // The transcript also records loading MEMORY.md, under another spelling.
        let recorded = serde_json::json!({
            "type": "attachment", "uuid": "m1", "parentUuid": null,
            "attachment": {
                "type": "nested_memory",
                "path": transcripts.join("memory").join("MEMORY.md").to_string_lossy().to_uppercase(),
                "content": { "content": "- Prefers Codex for UI." },
            },
        });
        std::fs::write(
            transcripts.join("s1.jsonl"),
            [
                recorded.to_string().as_str(),
                r#"{"type":"user","uuid":"u1","parentUuid":"m1","message":{"role":"user","content":"Add a handoff button"}}"#,
                r#"{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Half done: the header has it."}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let cwd = crate::roots::register(&cwd).unwrap();
        let source = Source {
            agent_id: "claude".into(),
            agent_name: "Claude Code".into(),
            account_id: None,
            session_id: "s1".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            title: "Handoff button".into(),
        };
        let places = Places {
            home: Some(home.clone()),
            opencode: None,
            data_home: None,
            user_home: None,
        };

        let begun = begin(&source.cwd, "Codex").unwrap();
        assert!(begun
            .notes_prompt
            .contains(&format!(".keel/handoffs/{}/NOTES.md", begun.name)));
        let folder = handoffs(&cwd).join(&begun.name);
        // The first agent wrote its notes.
        std::fs::write(folder.join(NOTES), "The menu still needs profiles.").unwrap();
        assert!(handoff_notes_ready(source.cwd.clone(), begun.name.clone()));
        assert!(!handoff_notes_ready(source.cwd.clone(), "../../x".into()));

        let written = write_handoff(&places, &source, &begun.name, "Codex").unwrap();
        assert_eq!(written.folder, format!(".keel/handoffs/{}", begun.name));
        assert!(written.prompt.contains(&written.folder));
        assert_eq!((written.user_messages, written.tool_calls), (1, 0));
        assert_eq!(written.memories, 3);
        assert!(written.notes);

        let brief = std::fs::read_to_string(folder.join(BRIEF)).unwrap();
        for part in [
            "1. Add a handoff button",
            "Half done: the header has it.",
            "The menu still needs profiles.",
            "Run pnpm check before committing.",
            "Never add co-authors.",
            "Prefers Codex for UI.",
        ] {
            assert!(brief.contains(part), "the brief is missing {part:?}");
        }
        assert_eq!(
            brief.matches("Prefers Codex for UI.").count(),
            1,
            "one file, shown once"
        );
        assert!(folder.join(TRANSCRIPT).is_file());
        assert_eq!(
            std::fs::read_to_string(handoffs(&cwd).join(".gitignore"))
                .unwrap()
                .lines()
                .last(),
            Some("*")
        );

        // A session the agent no longer has is said plainly.
        let gone = Source {
            session_id: "s2".into(),
            ..source
        };
        let error = write_handoff(&places, &gone, &begun.name, "Codex").unwrap_err();
        assert!(error.contains("couldn't find this conversation"), "{error}");
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// Hands real sessions off on this machine. Not run by default: set
    /// KEEL_HANDOFF_REAL to `agent=home=session=cwd`, `;`-separated.
    #[test]
    #[ignore]
    fn hand_off_real_sessions() {
        let Ok(list) = std::env::var("KEEL_HANDOFF_REAL") else {
            return;
        };
        for entry in list.split(';') {
            let parts: Vec<&str> = entry.splitn(4, '=').collect();
            let [agent, home, session, cwd] = parts[..] else {
                panic!("bad entry {entry}");
            };
            let cwd = crate::roots::register(Path::new(cwd)).unwrap();
            let source = Source {
                agent_id: agent.into(),
                agent_name: agent.into(),
                account_id: None,
                session_id: session.into(),
                cwd: cwd.to_string_lossy().into_owned(),
                title: String::new(),
            };
            let places = Places {
                home: Some(PathBuf::from(home)),
                opencode: (agent == "opencode").then(|| PathBuf::from(home)),
                data_home: None,
                user_home: crate::pty::home_dir(),
            };
            let begun = begin(&source.cwd, "the next agent").unwrap();
            let written = write_handoff(&places, &source, &begun.name, "the next agent").unwrap();
            println!("{agent}: {written:?}");
        }
    }

    #[test]
    fn folder_names_are_stamps_and_nothing_else() {
        let (stamp, readable) = stamps(1_791_250_812);
        assert_eq!(stamp, "20261006-014012");
        assert_eq!(readable, "2026-10-06 01:40 UTC");
        assert!(valid_name(&format!("{stamp}-a1f0")));
        assert!(!valid_name("../../etc-passwd-xx"));
        assert!(!valid_name(&format!("{stamp}-a1f")));
        assert!(!valid_name(&format!("{stamp}/a1f0")));
        assert_eq!(relative("x"), ".keel/handoffs/x");
    }

    #[test]
    fn old_handoffs_are_cleared_and_nothing_else() {
        let root = scratch("prune");
        let old = root.join("20260101-000000-aaaa");
        let mine = root.join("not-a-handoff");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&mine).unwrap();
        prune(&root, SystemTime::now() + KEEP + Duration::from_secs(60));
        assert!(!old.exists());
        assert!(mine.exists(), "folders Keel didn't make are left alone");
        let fresh = root.join("20260101-000000-bbbb");
        std::fs::create_dir_all(&fresh).unwrap();
        prune(&root, SystemTime::now());
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn transcripts_are_found_by_id() {
        let home = scratch("find");
        let cwd = Path::new("C:\\code\\my app");
        let claude = home.join("projects").join("C--code-my-app");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(claude.join("s1.jsonl"), "{}").unwrap();
        assert_eq!(
            claude_transcript(&home, cwd, "s1"),
            Some(claude.join("s1.jsonl"))
        );
        let moved = home.join("projects").join("elsewhere");
        std::fs::create_dir_all(&moved).unwrap();
        std::fs::write(moved.join("s2.jsonl"), "{}").unwrap();
        assert_eq!(
            claude_transcript(&home, cwd, "s2"),
            Some(moved.join("s2.jsonl"))
        );
        assert_eq!(claude_transcript(&home, cwd, "s3"), None);

        let day = home.join("sessions").join("2026").join("10").join("04");
        std::fs::create_dir_all(&day).unwrap();
        let rollout = day.join("rollout-2026-10-04T18-52-10-01a1091e-1bd9.jsonl");
        std::fs::write(&rollout, "{}").unwrap();
        assert_eq!(codex_rollout(&home, "01a1091e-1bd9"), Some(rollout));
        assert_eq!(
            codex_rollout(&home, "1bd9"),
            None,
            "the id is matched whole"
        );

        let grok = home
            .join("sessions")
            .join(crate::sessions::percent_encode("C:\\code"))
            .join("g1");
        std::fs::create_dir_all(&grok).unwrap();
        std::fs::write(grok.join("updates.jsonl"), "").unwrap();
        assert_eq!(
            grok_updates(&home, "C:\\code", "g1"),
            Some(grok.join("updates.jsonl"))
        );
        assert_eq!(
            grok_updates(&home, "C:\\other", "g1"),
            Some(grok.join("updates.jsonl"))
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn memories_come_from_the_project_and_the_agent() {
        let home = scratch("memory");
        let project = home.join("keel");
        let sub = project.join("site");
        std::fs::create_dir_all(sub.join(".claude")).unwrap();
        std::fs::write(project.join("AGENTS.md"), "Root rules.").unwrap();
        std::fs::write(sub.join("CLAUDE.md"), "Site rules.").unwrap();
        std::fs::write(project.join("GEMINI.md"), "  ").unwrap();
        // With no project open, only the working directory itself is read.
        let memories = project_memories(&sub);
        let contents: Vec<&str> = memories
            .iter()
            .map(|memory| memory.content.as_str())
            .collect();
        assert_eq!(contents, ["Site rules."]);
        // Opened as a project, the walk starts at its root.
        crate::roots::register(&project).unwrap();
        let canonical = crate::paths::canonicalize_dir(&sub).unwrap();
        let contents: Vec<String> = project_memories(&canonical)
            .into_iter()
            .map(|memory| memory.content)
            .collect();
        assert_eq!(
            contents,
            ["Root rules.", "Site rules."],
            "root first, blank files skipped"
        );

        let workspaces = home.join("grok").join("memory-v2").join("workspaces");
        let grok = workspaces.join("site-c941c122");
        std::fs::create_dir_all(grok.join("topics")).unwrap();
        std::fs::write(grok.join("MEMORY.md"), "# index").unwrap();
        std::fs::write(grok.join("topics").join("prefs.md"), "Likes short replies.").unwrap();
        let mut found = Vec::new();
        grok_memory(&mut found, &home.join("grok"), &sub);
        assert_eq!(found.len(), 2);
        assert!(found[0].label.contains("MEMORY.md"));
        // Two projects of the same name: neither is assumed.
        std::fs::create_dir_all(workspaces.join("site-00000000")).unwrap();
        let mut ambiguous = Vec::new();
        grok_memory(&mut ambiguous, &home.join("grok"), &sub);
        assert!(ambiguous.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
