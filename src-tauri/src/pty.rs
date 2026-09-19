//! PTY ownership. Every terminal pane in the UI is one entry in [`PtyManager`].
//!
//! Rust owns the process lifecycle; the frontend owns terminal rendering.
//! We spawn the user's *shell* — never the agent directly — then type the agent
//! command into it, so the pane outlives the agent exiting.
//!
//! Output leaves here as raw bytes on a `Channel`, never as JSON events. That is
//! the difference between a terminal that feels native and one that feels laggy.
//!
//! What the shell *says* on the way up is also this file's problem, because it is
//! the only place that knows how the shell was launched. A pane should open
//! silent: no banner, no update nag, and a prompt that is a folder name and a
//! caret rather than an absolute path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::procs;

/// Read buffer per pane. A blocking `read` returns whatever is available up to
/// this size, so a chatty agent naturally coalesces into few large sends.
const READ_BUFFER: usize = 64 * 1024;
/// Reject a single `pty_write` larger than this so a stuck paste cannot pin RAM.
const MAX_PTY_WRITE: usize = 1_048_576;
const WRITE_CHUNK: usize = 64 * 1024;
/// ConPTY / xterm still work at this size; anything larger is a hostile resize.
const PTY_MAX_DIM: u16 = 512;

type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type PtyWriterGuard<'a> = std::sync::MutexGuard<'a, Box<dyn Write + Send>>;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: PtyWriter,
    child: Box<dyn Child + Send + Sync>,
    alive: Arc<AtomicBool>,
    /// Windows job so the shell tree dies with the pane. Held for `Drop`.
    #[allow(dead_code)]
    _job: Option<procs::KillOnCloseJob>,
}

/// Watches a pane whose shell had an agent typed into it, until that agent
/// process tree is gone and the shell is sitting at a prompt again.
struct AgentWatch {
    shell_pid: u32,
    generation: u64,
    alive: Arc<AtomicBool>,
    saw_agent: bool,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    watches: Mutex<HashMap<String, AgentWatch>>,
}

impl PtyManager {
    pub fn shutdown_all(&self) {
        let mut sessions = match self.sessions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (_, mut session) in sessions.drain() {
            session.alive.store(false, Ordering::SeqCst);
            let _ = session.child.kill();
        }
        if let Ok(mut watches) = self.watches.lock() {
            watches.clear();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Frontend-generated pane id. Stable for the life of the pane.
    pub id: String,
    #[serde(default)]
    pub generation: u64,
    /// Shell to run. `None` means "whatever this machine's default is".
    #[serde(default)]
    pub shell: Option<String>,
    /// Working directory the shell starts in.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Typed into the shell once it is up — this is how agents get launched.
    #[serde(default)]
    pub command: Option<String>,
    /// CLI-specific variable that relocates user/auth storage for a named account.
    #[serde(default)]
    pub account_env: Option<String>,
    /// Keel-generated account id. Its directory is resolved server-side.
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub generation: u64,
}

/// The default contents of `shell-init.ps1`.
///
/// Written once and then owned by the user — Keel never rewrites a file that is
/// already there. Delete it to get this back.
const POWERSHELL_INIT: &str = r####"# Keel — how a shell looks inside a Keel pane.
#
# Keel writes this file the first time it opens a PowerShell pane and never
# touches it again. Edit it and every new terminal picks up your version; delete
# it and the next launch writes a fresh copy of this default.
#
# It runs *after* your own PowerShell profile, so anything set here wins.

function global:prompt {
    # $? has to be read before anything else in here runs, or we would be
    # reporting on our own assignments instead of on the command you just ran.
    $ok = $?

    $e = [char]27
    $dim = "$e[38;2;161;161;161m"
    $off = "$e[0m"
    $caret = if ($ok) { "$e[38;2;237;237;237m" } else { "$e[38;2;236;93;94m" }

    # The folder, not the full path: the pane already knows where it is, and the
    # status bar along the bottom of the window is showing it.
    $here = $PWD.Path
    $leaf = Split-Path -Leaf $here
    if ([string]::IsNullOrWhiteSpace($leaf)) { $leaf = $here }

    "$dim$leaf$off $caret$([char]0x276F)$off "
}

# Match PSReadLine's syntax colours to the pane around them. Guarded, because
# PSReadLine is not guaranteed to be loaded and a shell that fails to open is a
# lot worse than one that is the wrong colour.
try {
    Set-PSReadLineOption -ErrorAction Stop -Colors @{
        Command          = '#ededed'
        Parameter        = '#a1a1a1'
        Operator         = '#a1a1a1'
        String           = '#4cc38a'
        Number           = '#e9a23b'
        Comment          = '#6e6e6e'
        Member           = '#c7c7c7'
        Type             = '#3fc1b0'
        Variable         = '#e07fb7'
        InlinePrediction = '#4a4a4a'
    }
} catch {
    # No PSReadLine here. The defaults will do.
}
"####;

/// The contents of `keel-term.ps1`, Keel's terminal integration.
///
/// This file is Keel's, not the user's: it carries no choices of its own — the
/// prompt they stare at lives in `shell-init.ps1` — so Keel keeps it in step
/// with the binary on every launch, and a fix here reaches every machine the
/// moment it ships.
const POWERSHELL_INTEGRATION: &str = r####"# Keel — terminal integration. Keel writes and updates this file; what you
# personalise lives in shell-init.ps1 beside it.
#
# The job: say where the shell is, every time a prompt comes up. Keel then
# reopens a restarted pane in the folder you actually reached, not the one it
# launched in. `9;9` is the ConEmu spelling Windows Terminal reads and takes
# the raw path; `7` is the POSIX one and takes a file URL. Both are escape
# codes the terminal eats — you never see them.
#
# This runs last, so it wraps whichever prompt exists: the one you wrote in
# your profile, or Keel's default. Your prompt stays yours.

if (Get-Command keel-report-cwd -ErrorAction SilentlyContinue) { return }

function global:keel-report-cwd {
    $e = [char]27
    $bell = [char]7
    $here = $PWD.Path
    $where = "$e]9;9;$here$bell"
    try {
        # The property access has to happen inside $() — an interpolation
        # reads `$here` and then stops, leaving `.AbsoluteUri` as words.
        $where += "$e]7;$( ([System.Uri]$here).AbsoluteUri )$bell"
    } catch {
        # Not a filesystem location — a registry drive, say. The raw form
        # above already said where we are; a prompt that fails to print is a
        # lot worse than a missing second spelling.
    }
    # One string. Two returns in an interpolation join with a space, and the
    # space would land inside the terminal's escape soup for no reason.
    $where
}

# Keep the prompt you have and run it after the report. A prompt defined
# later — a `Set-PSReadLineOption`-style module, say — wins over the wrap;
# Keel says where it is, not how your prompt looks.
$global:keelPrompt = if ($function:prompt) { $function:prompt } else { { "PS> " } }
function global:prompt {
    "$(& keel-report-cwd)$(& $global:keelPrompt)"
}
"####;

/// What `keel-term.ps1` should say, given what is already on disk.
///
/// The file is refreshed whenever its contents drift from the binary — a copy
/// from an older build is exactly the case that must catch up. If the write
/// fails the caller simply launches without it: a shell that opens beats an
/// integration that does not.
fn next_terminal_integration(existing: Option<&str>) -> Option<&'static str> {
    match existing {
        Some(content) if content == POWERSHELL_INTEGRATION => None,
        _ => Some(POWERSHELL_INTEGRATION),
    }
}

/// A dot-source line for `path`, with the path quoted the way PowerShell
/// quotes: single quotes, and an embedded one doubled.
fn dot_source(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\'', "''");
    format!(". '{}'; ", text)
}

/// Where the per-user shell setup lives, written on first use.
///
/// A pane is chrome the user stares at all day, and stock PowerShell opens it
/// with a copyright banner and then prints an absolute path on every single
/// line. Both go. It is done through a file in the config folder rather than a
/// string baked into the binary so that the prompt stays the user's to change —
/// the same way the agent catalogue is.
///
/// Returns `None` if the file cannot be written, and the caller just launches a
/// plain shell: a stock prompt beats no terminal.
fn powershell_init(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join("shell-init.ps1");
    if !file.is_file() {
        std::fs::write(&file, POWERSHELL_INIT).ok()?;
    }
    Some(file)
}

/// Where Keel's terminal integration lives, kept in step on every launch.
///
/// Returns `None` if it cannot be written; the shell then runs without cwd
/// reporting, which is a missing nicety, not a broken terminal.
fn terminal_integration(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join("keel-term.ps1");
    let existing = std::fs::read_to_string(&file).ok();
    if let Some(content) = next_terminal_integration(existing.as_deref()) {
        std::fs::write(&file, content).ok()?;
    }
    Some(file)
}

/// The shell we drop the user into when a pane does not name one.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 when it is installed, fall back to the one that
        // ships with Windows. `cmd` is deliberately last-resort only.
        if let Some(pwsh) = which("pwsh.exe") {
            return pwsh;
        }
        if let Some(ps) = which("powershell.exe") {
            return ps;
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Minimal PATH lookup — too small a job to take a dependency for.
pub fn which(program: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Letters, digits and underscores, not starting with a digit.
pub fn is_env_name(key: &str) -> bool {
    !key.is_empty()
        && key.chars().enumerate().all(|(index, ch)| {
            ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || !ch.is_ascii_digit())
        })
}

/// `CreateProcess` / portable-pty abort on NUL in an environment value.
pub fn is_env_value(value: &str) -> bool {
    !value.as_bytes().contains(&0)
}

fn clamp_pty_dims(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(1, PTY_MAX_DIM), rows.clamp(1, PTY_MAX_DIM))
}

fn write_pty_bytes(writer: &mut dyn Write, data: &[u8]) -> Result<(), String> {
    for chunk in data.chunks(WRITE_CHUNK) {
        writer.write_all(chunk).map_err(|err| err.to_string())?;
    }
    writer.flush().map_err(|err| err.to_string())
}

fn pty_write_too_large(len: usize) -> bool {
    len > MAX_PTY_WRITE
}

fn lock_writer(writer: &PtyWriter) -> Result<PtyWriterGuard<'_>, String> {
    writer
        .lock()
        .map_err(|_| "pty writer is poisoned".to_string())
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    options: SpawnOptions,
    on_data: Channel<Response>,
) -> Result<(), String> {
    let pty_system = portable_pty::native_pty_system();
    let (cols, rows) = clamp_pty_dims(options.cols, options.rows);
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|err| format!("could not open a pty: {err}"))?;

    let shell = options.shell.clone().unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);

    // A login shell on unix so the PATH matches the user's own terminal — agent
    // CLIs live in places only the shell profile knows about.
    let shell_base = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell.as_str());
    let shell_base_lower = shell_base.to_ascii_lowercase();
    let shell_stem = shell_base_lower
        .strip_suffix(".exe")
        .unwrap_or(shell_base_lower.as_str());

    #[cfg(not(windows))]
    if shell_stem == "bash" || shell_stem == "zsh" || shell_stem == "fish" {
        cmd.arg("-l");
    }

    // Everything PowerShell says before you have typed anything, silenced. Same
    // idea as the unix `-l` above, and decided server-side so the webview never
    // gets to pass freeform shell arguments.
    if shell_stem == "pwsh" || shell_stem == "powershell" {
        // The version banner and copyright line.
        cmd.arg("-NoLogo");
        // "A new PowerShell stable release is available" — a nag in a pane that
        // is about to have an agent typed into it.
        cmd.env("POWERSHELL_UPDATECHECK", "Off");
        // Dot-sourced in order — profile, the user's prompt setup, then Keel's
        // integration — and then an ordinary interactive session. The
        // integration loads last so it wraps whichever prompt exists.
        let user_init = powershell_init(&app);
        let integration = terminal_integration(&app);
        if user_init.is_some() || integration.is_some() {
            let mut script = String::new();
            for path in [user_init, integration].into_iter().flatten() {
                script.push_str(&dot_source(&path));
            }
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(script.trim_end());
        }
    }

    let cwd = options
        .cwd
        .as_deref()
        .filter(|cwd| crate::roots::is_under_registered(Path::new(cwd)))
        .map(PathBuf::from)
        .or_else(home_dir);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    for (key, value) in &options.env {
        if is_env_name(key) && is_env_value(value) {
            cmd.env(key, value);
        }
    }
    if let (Some(key), Some(account_id)) = (&options.account_env, &options.account_id) {
        let valid_key = is_env_name(key);
        let valid_id = account_id
            .chars()
            .all(|ch| ch == '_' || ch == '-' || ch.is_ascii_alphanumeric());
        if !valid_key || !valid_id {
            return Err("invalid account profile metadata".to_string());
        }
        let account_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| format!("no config directory: {err}"))?
            .join("accounts")
            .join(account_id);
        std::fs::create_dir_all(&account_dir).map_err(|err| err.to_string())?;
        cmd.env(key, account_dir);
    }
    // Agents read these to decide how much colour they are allowed to use.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Private OpenVPN tunnel: only this pane's processes should use it.
    if let Some(vpn) = app.try_state::<crate::vpn::VpnManager>() {
        for (key, value) in vpn.proxy_env() {
            cmd.env(key, value);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("could not start `{shell}`: {err}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("could not read from the pty: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("could not write to the pty: {err}"))?;
    let writer: PtyWriter = Arc::new(Mutex::new(writer));

    let alive = Arc::new(AtomicBool::new(true));
    let job = child.process_id().and_then(procs::adopt_kill_on_close);

    {
        let id = options.id.clone();
        let generation = options.generation;
        let alive = Arc::clone(&alive);
        let app = app.clone();
        std::thread::Builder::new()
            .name(format!("keel-pty-{id}"))
            .spawn(move || {
                let mut buffer = vec![0u8; READ_BUFFER];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if !alive.load(Ordering::SeqCst) {
                                break;
                            }
                            if on_data.send(Response::new(buffer[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                alive.store(false, Ordering::SeqCst);
                // A pane that is relaunched or switches profile gets a fresh
                // session under the same id before this old reader winds down.
                // Only report an exit if this reader's session is still the one
                // on record; otherwise the new, live shell gets marked as dead.
                let still_current = app
                    .state::<PtyManager>()
                    .sessions
                    .lock()
                    .map(|sessions| {
                        sessions
                            .get(&id)
                            .is_some_and(|session| Arc::ptr_eq(&session.alive, &alive))
                    })
                    .unwrap_or(false);
                if still_current {
                    let _ = app.emit("pty:exit", PtyExit { id, generation });
                }
            })
            .map_err(|err| format!("could not start the reader thread: {err}"))?;
    }

    let session = PtySession {
        master: pair.master,
        writer: Arc::clone(&writer),
        child,
        alive: Arc::clone(&alive),
        _job: job,
    };
    let shell_pid = session.child.process_id();

    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "pty state is poisoned".to_string())?;
    if let Some(mut previous) = sessions.insert(options.id.clone(), session) {
        previous.alive.store(false, Ordering::SeqCst);
        let _ = previous.child.kill();
    }
    drop(sessions);

    // Typed in, not exec'd, so the shell is still there when the agent quits.
    // Writer lock only — never the session map — so a blocked stdin cannot
    // freeze resize/kill of other panes.
    let typed_command = options
        .command
        .as_ref()
        .filter(|command| !command.trim().is_empty());
    if let Some(command) = typed_command {
        let line = format!("{command}\r");
        let mut guard = lock_writer(&writer)?;
        write_pty_bytes(&mut **guard, line.as_bytes())
            .map_err(|err| format!("could not send the startup command: {err}"))?;
    }
    let typed_command = typed_command.is_some();

    // A pane that launched an agent should reopen as a shell once that agent
    // has exited — otherwise Ctrl+C, close, reopen types `grok` again.
    if typed_command {
        if let Some(pid) = shell_pid {
            watch_agent(
                &manager,
                &app,
                options.id.clone(),
                options.generation,
                pid,
                alive,
            );
        }
    }

    Ok(())
}

/// How often we look at the process tree for typed-in agents that have exited.
const AGENT_WATCH_MS: u64 = 400;

fn watch_agent(
    manager: &PtyManager,
    app: &AppHandle,
    id: String,
    generation: u64,
    shell_pid: u32,
    alive: Arc<AtomicBool>,
) {
    if let Ok(mut watches) = manager.watches.lock() {
        watches.insert(
            id,
            AgentWatch {
                shell_pid,
                generation,
                alive,
                saw_agent: false,
            },
        );
    }
    start_agent_watcher(app.clone());
}

fn start_agent_watcher(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("keel-pty-watch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(AGENT_WATCH_MS));
            let (started, finished) = collect_agent_events(&app);
            for event in started {
                let _ = app.emit("pty:agent-start", event);
            }
            for event in finished {
                // A restart under the same pane id inserts a new watch before
                // we emit; that spawn is a fresh agent and must not be released.
                let replaced = app
                    .state::<PtyManager>()
                    .watches
                    .lock()
                    .map(|watches| watches.contains_key(&event.id))
                    .unwrap_or(true);
                if replaced {
                    continue;
                }
                let _ = app.emit("pty:agent-exit", event);
            }
        });
}

fn collect_agent_events(app: &AppHandle) -> (Vec<PtyExit>, Vec<PtyExit>) {
    let manager = app.state::<PtyManager>();
    let mut watches = match manager.watches.lock() {
        Ok(guard) => guard,
        Err(_) => return (Vec::new(), Vec::new()),
    };
    if watches.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let parents = procs::process_parents();
    if parents.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut started = Vec::new();
    let mut finished = Vec::new();
    watches.retain(|id, watch| {
        if !watch.alive.load(Ordering::SeqCst) {
            return false;
        }
        if !parents.contains_key(&watch.shell_pid) {
            // The shell itself is gone; `pty:exit` is the event that matters.
            return false;
        }
        if procs::has_descendants(&parents, watch.shell_pid) {
            if !watch.saw_agent {
                started.push(PtyExit {
                    id: id.clone(),
                    generation: watch.generation,
                });
            }
            watch.saw_agent = true;
            true
        } else if watch.saw_agent {
            finished.push(PtyExit {
                id: id.clone(),
                generation: watch.generation,
            });
            false
        } else {
            true
        }
    });
    (started, finished)
}

#[tauri::command(async)]
pub async fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    if pty_write_too_large(data.len()) {
        return Err(format!(
            "terminal write is limited to {MAX_PTY_WRITE} bytes"
        ));
    }
    crate::blocking::run(move || {
        let writer = {
            let manager = app.state::<PtyManager>();
            let sessions = manager
                .sessions
                .lock()
                .map_err(|_| "pty state is poisoned".to_string())?;
            let session = sessions
                .get(&id)
                .ok_or_else(|| format!("no terminal named {id}"))?;
            Arc::clone(&session.writer)
        };
        let mut guard = lock_writer(&writer)?;
        write_pty_bytes(&mut **guard, data.as_bytes())
    })
    .await
}

#[tauri::command(async)]
pub async fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let (cols, rows) = clamp_pty_dims(cols, rows);
    crate::blocking::run(move || {
        let manager = app.state::<PtyManager>();
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| "pty state is poisoned".to_string())?;
        let Some(session) = sessions.get(&id) else {
            // Resizes race with closing panes; a missing pane is not an error.
            return Ok(());
        };
        // MasterPty is not cloneable, so resize holds the map lock. It is
        // usually fast; never hold this lock across a write.
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command(async)]
pub async fn pty_kill(app: AppHandle, id: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let session = {
            let manager = app.state::<PtyManager>();
            let mut sessions = manager
                .sessions
                .lock()
                .map_err(|_| "pty state is poisoned".to_string())?;
            sessions.remove(&id)
        };
        let Some(mut session) = session else {
            return Ok(());
        };
        session.alive.store(false, Ordering::SeqCst);
        session.child.kill().map_err(|err| err.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_name_accepts_shell_variables() {
        assert!(is_env_name("PATH"));
        assert!(is_env_name("_"));
        assert!(is_env_name("FOO_BAR"));
        assert!(is_env_name("A1"));
    }

    #[test]
    fn env_name_rejects_empty_digits_and_punctuation() {
        assert!(!is_env_name(""));
        assert!(!is_env_name("1ABC"));
        assert!(!is_env_name("FOO-BAR"));
        assert!(!is_env_name("FOO=BAR"));
        assert!(!is_env_name("FOO\0BAR"));
        assert!(!is_env_name("FOO BAR"));
    }

    #[test]
    fn env_value_rejects_nul() {
        assert!(is_env_value(""));
        assert!(is_env_value(r"C:\Windows\system32"));
        assert!(is_env_value(".EXE;.BAT"));
        assert!(!is_env_value("a\0b"));
        assert!(!is_env_value("\0"));
    }

    #[test]
    fn clamp_pty_dims_floors_and_caps() {
        assert_eq!(clamp_pty_dims(0, 0), (1, 1));
        assert_eq!(clamp_pty_dims(80, 24), (80, 24));
        assert_eq!(clamp_pty_dims(512, 512), (512, 512));
        assert_eq!(clamp_pty_dims(1000, 2000), (512, 512));
        assert_eq!(clamp_pty_dims(u16::MAX, 1), (512, 1));
    }

    #[test]
    fn write_payload_rejects_over_one_mib() {
        assert!(!pty_write_too_large(0));
        assert!(!pty_write_too_large(MAX_PTY_WRITE));
        assert!(pty_write_too_large(MAX_PTY_WRITE + 1));
    }

    #[test]
    fn a_missing_integration_file_is_written() {
        assert_eq!(
            next_terminal_integration(None),
            Some(POWERSHELL_INTEGRATION)
        );
    }

    #[test]
    fn a_current_integration_file_is_left_alone() {
        assert_eq!(
            next_terminal_integration(Some(POWERSHELL_INTEGRATION)),
            None
        );
    }

    #[test]
    fn an_integration_file_from_an_older_build_is_refreshed() {
        assert_eq!(
            next_terminal_integration(Some("an older build's copy")),
            Some(POWERSHELL_INTEGRATION)
        );
    }

    #[test]
    fn dot_source_quotes_the_powershell_way() {
        assert_eq!(
            dot_source(Path::new(r"C:\O'Brien's App\keel-term.ps1")),
            r". 'C:\O''Brien''s App\keel-term.ps1'; "
        );
        assert_eq!(
            dot_source(Path::new(r"C:\My Code\keel-term.ps1")),
            r". 'C:\My Code\keel-term.ps1'; "
        );
    }
}
