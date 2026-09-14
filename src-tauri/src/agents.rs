//! Agent detection.
//!
//! Keel ships no AI. It finds the CLIs already installed on the machine, wherever
//! the installer, Scoop, Homebrew, npm or pnpm happened to drop them.
//!
//! The catalogue is data, not code: `agents.default.json` provides defaults, and a
//! user file at `<config>/agents.json` can override or extend it. Built-in fields
//! that are absent from an older user entry are inherited automatically.

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
    /// Kept out of the launcher. Built-in agents cannot be deleted, only hidden.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    #[serde(flatten)]
    pub spec: AgentSpec,
    /// Where it actually landed, or `None` when it is not installed.
    pub path: Option<String>,
    pub installed: bool,
    /// Ships with Keel. Built-ins can be reset to defaults; custom agents deleted.
    pub builtin: bool,
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
    // With no executables listed, the command's own first word is the best
    // guess — which is what makes a hand-added agent detectable with no setup.
    let guessed: Vec<String> = spec
        .command
        .split_whitespace()
        .take(1)
        .map(str::to_owned)
        .collect();
    let bins = if spec.bins.is_empty() {
        &guessed
    } else {
        &spec.bins
    };

    for bin in bins {
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
            for bin in bins {
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

fn merged_catalogue(user_source: &str) -> Option<Vec<AgentSpec>> {
    let mut builtin: Vec<serde_json::Value> = serde_json::from_str(BUILTIN_CATALOGUE).ok()?;
    let mut user: Vec<serde_json::Value> = serde_json::from_str(user_source).ok()?;

    for user_entry in &mut user {
        let Some(user_object) = user_entry.as_object_mut() else {
            continue;
        };
        let Some(user_id) = user_object.get("id").and_then(|value| value.as_str()) else {
            continue;
        };

        let Some(builtin_object) = builtin.iter().find_map(|entry| {
            let object = entry.as_object()?;
            (object.get("id").and_then(|value| value.as_str()) == Some(user_id)).then_some(object)
        }) else {
            continue;
        };

        for (key, value) in builtin_object {
            user_object
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }

    for builtin_entry in builtin.drain(..) {
        let builtin_id = builtin_entry
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let already_present = builtin_id.as_deref().is_some_and(|id| {
            user.iter()
                .any(|entry| entry.get("id").and_then(|value| value.as_str()) == Some(id))
        });

        if !already_present {
            user.push(builtin_entry);
        }
    }

    serde_json::from_value(serde_json::Value::Array(user)).ok()
}

fn catalogue(app: &AppHandle) -> Vec<AgentSpec> {
    let user_file = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("agents.json"))
        .filter(|path| path.is_file())
        .and_then(|path| std::fs::read_to_string(path).ok());

    user_file
        .as_deref()
        .and_then(merged_catalogue)
        .unwrap_or_else(builtin_catalogue)
}

fn builtin_catalogue() -> Vec<AgentSpec> {
    serde_json::from_str(BUILTIN_CATALOGUE).expect("builtin agent catalogue is valid json")
}

#[tauri::command]
pub fn detect_agents(app: AppHandle) -> Vec<DetectedAgent> {
    let builtin = builtin_catalogue();
    catalogue(&app)
        .into_iter()
        .map(|spec| {
            let path = locate(&spec);
            DetectedAgent {
                builtin: builtin.iter().any(|entry| entry.id == spec.id),
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

/// The catalogue as it ships, for "reset to defaults".
#[tauri::command]
pub fn agent_catalogue_defaults() -> Vec<AgentSpec> {
    builtin_catalogue()
}

fn trimmed_lines(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize(mut spec: AgentSpec) -> AgentSpec {
    spec.id = spec.id.trim().to_string();
    spec.name = spec.name.trim().to_string();
    spec.command = spec.command.trim().to_string();
    spec.short = spec.short.trim().to_uppercase();
    spec.accent = spec.accent.trim().to_string();
    spec.account_env = spec
        .account_env
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    spec.bins = trimmed_lines(spec.bins);
    spec.paths = trimmed_lines(spec.paths);
    spec
}

fn is_hex_colour(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|hex| {
        (hex.len() == 3 || hex.len() == 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
    })
}

fn validate(agents: &[AgentSpec]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for agent in agents {
        let valid_id = !agent.id.is_empty()
            && agent.id.len() <= 64
            && agent
                .id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
        if !valid_id {
            return Err(format!("`{}` is not a valid agent id", agent.id));
        }
        if !seen.insert(agent.id.as_str()) {
            return Err(format!("two agents share the id `{}`", agent.id));
        }
        if agent.name.is_empty() {
            return Err(format!("agent `{}` needs a name", agent.id));
        }
        if agent.command.is_empty() {
            return Err(format!("{} needs a command", agent.name));
        }
        if agent.command.contains(['\r', '\n']) {
            return Err(format!("{}: the command must be a single line", agent.name));
        }
        if agent.short.chars().count() > 3 {
            return Err(format!(
                "{}: the badge is at most three characters",
                agent.name
            ));
        }
        if !agent.accent.is_empty() && !is_hex_colour(&agent.accent) {
            return Err(format!("{}: the colour must be a hex value", agent.name));
        }
        if let Some(key) = &agent.account_env {
            if !crate::pty::is_env_name(key) {
                return Err(format!(
                    "{}: `{key}` is not a valid variable name",
                    agent.name
                ));
            }
        }
    }
    Ok(())
}

/// What gets written for one agent: everything for a custom agent, but only the
/// fields that differ from the built-in entry of the same id otherwise. That way
/// a default that changes in a later release still reaches every agent the user
/// never touched, and "reset to defaults" leaves nothing but the id behind.
fn overrides(entry: &AgentSpec, builtin: &[AgentSpec]) -> Result<serde_json::Value, String> {
    let value = serde_json::to_value(entry).map_err(|err| err.to_string())?;
    let Some(base) = builtin.iter().find(|candidate| candidate.id == entry.id) else {
        return Ok(value);
    };
    let base = serde_json::to_value(base).map_err(|err| err.to_string())?;
    let (serde_json::Value::Object(fields), serde_json::Value::Object(defaults)) = (value, base)
    else {
        return Err("agent entries must be objects".to_string());
    };

    let mut changed = serde_json::Map::new();
    changed.insert(
        "id".to_string(),
        serde_json::Value::String(entry.id.clone()),
    );
    for (key, field) in fields {
        if key == "id" {
            continue;
        }
        if defaults.get(&key).unwrap_or(&serde_json::Value::Null) != &field {
            changed.insert(key, field);
        }
    }
    Ok(serde_json::Value::Object(changed))
}

/// Replace the user catalogue with `agents`, then detect again.
#[tauri::command]
pub fn agent_catalogue_save(
    app: AppHandle,
    agents: Vec<AgentSpec>,
) -> Result<Vec<DetectedAgent>, String> {
    let agents: Vec<AgentSpec> = agents.into_iter().map(normalize).collect();
    validate(&agents)?;

    let builtin = builtin_catalogue();
    let entries = agents
        .iter()
        .map(|entry| overrides(entry, &builtin))
        .collect::<Result<Vec<_>, _>>()?;
    let json = serde_json::to_string_pretty(&entries).map_err(|err| err.to_string())?;

    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("no config directory: {err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    // Write, then rename over: a crash mid-save never leaves half a catalogue.
    let temp = dir.join("agents.json.tmp");
    std::fs::write(&temp, json).map_err(|err| err.to_string())?;
    std::fs::rename(&temp, dir.join("agents.json")).map_err(|err| err.to_string())?;

    Ok(detect_agents(app))
}
