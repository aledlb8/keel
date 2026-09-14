//! PTY ownership. Every terminal pane in the UI is one entry in [`PtyManager`].
//!
//! The rule from PLAN.md: Rust owns the process, the frontend owns the pixels.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

/// Read buffer per pane. A blocking `read` returns whatever is available up to
/// this size, so a chatty agent naturally coalesces into few large sends.
const READ_BUFFER: usize = 64 * 1024;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
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
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Frontend-generated pane id. Stable for the life of the pane.
    pub id: String,
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
    $dim = "$e[38;2;148;154;173m"
    $off = "$e[0m"
    $caret = if ($ok) { "$e[38;2;227;229;237m" } else { "$e[38;2;242;119;125m" }

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
        Command          = '#8fbcff'
        Parameter        = '#949aad'
        Operator         = '#949aad'
        String           = '#4fd894'
        Number           = '#e5bd6c'
        Comment          = '#626878'
        Member           = '#b6c1d2'
        Type             = '#5fc7d4'
        Variable         = '#dd8fbc'
        InlinePrediction = '#3a4152'
    }
} catch {
    # No PSReadLine here. The defaults will do.
}
"####;

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
fn powershell_init(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join("shell-init.ps1");
    if !file.is_file() {
        std::fs::write(&file, POWERSHELL_INIT).ok()?;
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

pub fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
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
    let size = PtySize {
        rows: options.rows.max(1),
        cols: options.cols.max(1),
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
        // `-NoExit -File` runs our setup after the user profile and then hands
        // over an ordinary interactive session.
        if let Some(init) = powershell_init(&app) {
            cmd.arg("-NoExit");
            cmd.arg("-File");
            cmd.arg(init);
        }
    }

    let cwd = options
        .cwd
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(home_dir);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    for (key, value) in &options.env {
        cmd.env(key, value);
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

    let alive = Arc::new(AtomicBool::new(true));

    {
        let id = options.id.clone();
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
                    let _ = app.emit("pty:exit", PtyExit { id });
                }
            })
            .map_err(|err| format!("could not start the reader thread: {err}"))?;
    }

    let session = PtySession {
        master: pair.master,
        writer,
        child,
        alive,
    };

    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "pty state is poisoned".to_string())?;
    if let Some(mut previous) = sessions.insert(options.id.clone(), session) {
        previous.alive.store(false, Ordering::SeqCst);
        let _ = previous.child.kill();
    }

    // Typed in, not exec'd, so the shell is still there when the agent quits.
    if let Some(command) = options.command.as_ref().filter(|c| !c.trim().is_empty()) {
        if let Some(session) = sessions.get_mut(&options.id) {
            let line = format!("{command}\r");
            session
                .writer
                .write_all(line.as_bytes())
                .map_err(|err| format!("could not send the startup command: {err}"))?;
            let _ = session.writer.flush();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "pty state is poisoned".to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no terminal named {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|err| err.to_string())?;
    session.writer.flush().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "pty state is poisoned".to_string())?;
    let Some(session) = sessions.get(&id) else {
        // Resizes race with closing panes; a missing pane is not an error.
        return Ok(());
    };
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut sessions = manager
        .sessions
        .lock()
        .map_err(|_| "pty state is poisoned".to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        session.alive.store(false, Ordering::SeqCst);
        session.child.kill().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_alive(manager: State<'_, PtyManager>, id: String) -> Result<bool, String> {
    let sessions = manager
        .sessions
        .lock()
        .map_err(|_| "pty state is poisoned".to_string())?;
    Ok(sessions
        .get(&id)
        .map(|session| session.alive.load(Ordering::SeqCst))
        .unwrap_or(false))
}
