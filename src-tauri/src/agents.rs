//! Agent detection.
//!
//! Keel ships no AI. It finds the CLIs already installed on the machine, wherever
//! the installer, Scoop, Homebrew, npm or pnpm happened to drop them.
//!
//! The catalogue is data, not code: `agents.default.json` is the fallback, and a
//! user file at `<config>/agents.json` replaces it entirely. Adding a new agent is
//! an entry in that file, not a release.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::pty::home_dir;

const BUILTIN_CATALOGUE: &str = include_str!("../agents.default.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    /// Stable key. Saved layouts reference agents by this.
    pub id: String,
    pub name: String,
    /// What gets typed into the shell.
    pub command: String,
    /// Executable names to look for on PATH, in order of preference.
    #[serde(default)]
    pub bins: Vec<String>,
    /// Extra places to look. `{home}` expands to the user's home directory.
    #[serde(default)]
    pub paths: Vec<String>,
    /// Two-or-three letter badge shown in the pane corner.
    #[serde(default)]
    pub short: String,
    /// Accent colour for this agent's panes, as a CSS colour.
    #[serde(default)]
    pub accent: String,
    /// Environment variable used by this CLI to relocate its user/auth storage.
    #[serde(default)]
    pub account_env: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    #[serde(flatten)]
    pub spec: AgentSpec,
    /// Where it actually landed, or `None` when it is not installed.
    pub path: Option<String>,
    pub installed: bool,
}

fn expand(pattern: &str) -> Option<PathBuf> {
    let expanded = if let Some(rest) = pattern.strip_prefix("{home}") {
        let home = home_dir()?;
        home.join(rest.trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(pattern)
    };
    Some(expanded)
}

/// On Windows an "executable" is usually a `.cmd` or `.exe` shim next to the name.
fn executable_candidates(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(name).extension().is_some() {
            return vec![name.to_string()];
        }
        ["", ".exe", ".cmd", ".bat", ".ps1"]
            .iter()
            .map(|ext| format!("{name}{ext}"))
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = Path::new(name);
        vec![name.to_string()]
    }
}

fn locate(spec: &AgentSpec) -> Option<String> {
    for bin in &spec.bins {
        for candidate in executable_candidates(bin) {
            if let Some(found) = crate::pty::which(&candidate) {
                return Some(found);
            }
        }
    }

    for pattern in &spec.paths {
        let Some(base) = expand(pattern) else {
            continue;
        };
        if base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
        // A directory entry means "look inside for any of the binaries".
        if base.is_dir() {
            for bin in &spec.bins {
                for candidate in executable_candidates(bin) {
                    let file = base.join(&candidate);
                    if file.is_file() {
                        return Some(file.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    None
}

fn catalogue(app: &AppHandle) -> Vec<AgentSpec> {
    let user_file = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("agents.json"))
        .filter(|path| path.is_file())
        .and_then(|path| std::fs::read_to_string(path).ok());

    let source = user_file.as_deref().unwrap_or(BUILTIN_CATALOGUE);
    serde_json::from_str(source).unwrap_or_else(|_| {
        serde_json::from_str(BUILTIN_CATALOGUE).expect("builtin agent catalogue is valid json")
    })
}

#[tauri::command]
pub fn detect_agents(app: AppHandle) -> Vec<DetectedAgent> {
    catalogue(&app)
        .into_iter()
        .map(|spec| {
            let path = locate(&spec);
            DetectedAgent {
                spec,
                installed: path.is_some(),
                path,
            }
        })
        .collect()
}

/// Path to the catalogue the user can edit, created from the builtin on first ask.
#[tauri::command]
pub fn agent_catalogue_path(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("no config directory: {err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file = dir.join("agents.json");
    if !file.exists() {
        std::fs::write(&file, BUILTIN_CATALOGUE).map_err(|err| err.to_string())?;
    }
    Ok(file.to_string_lossy().into_owned())
}
