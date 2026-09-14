//! Where coding CLIs keep conversation files, so a pane can reopen *its* chat
//! rather than whatever happened to run last in this folder.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::pty::home_dir;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProbe {
    /// `grok` or `claude` — each CLI lays its transcripts out differently.
    pub store: String,
    pub cwd: String,
    #[serde(default)]
    pub account_env: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn dash_encode(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            ':' | '/' | '\\' => '-',
            other => other,
        })
        .collect()
}

fn session_root(app: &AppHandle, probe: &SessionProbe) -> Option<PathBuf> {
    if let (Some(_), Some(account_id)) = (&probe.account_env, &probe.account_id) {
        let valid = account_id
            .chars()
            .all(|ch| ch == '_' || ch == '-' || ch.is_ascii_alphanumeric());
        if valid {
            return Some(
                app.path()
                    .app_config_dir()
                    .ok()?
                    .join("accounts")
                    .join(account_id),
            );
        }
    }
    let home = home_dir()?;
    match probe.store.as_str() {
        "grok" => Some(home.join(".grok")),
        "claude" => Some(home.join(".claude")),
        _ => None,
    }
}

fn list_dir_ids(dir: &Path) -> Vec<(String, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        found.push((name, mtime));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    found
}

fn list_jsonl_ids(dir: &Path) -> Vec<(String, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        found.push((stem.to_string(), mtime));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    found
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    pub id: String,
    pub mtime_ms: u64,
}

fn to_hits(ids: Vec<(String, SystemTime)>) -> Vec<SessionHit> {
    ids.into_iter()
        .map(|(id, mtime)| SessionHit {
            id,
            mtime_ms: mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        })
        .collect()
}

/// Session ids for this store + folder, newest first.
#[tauri::command]
pub fn session_recent(app: AppHandle, probe: SessionProbe) -> Result<Vec<SessionHit>, String> {
    let Some(root) = session_root(&app, &probe) else {
        return Ok(Vec::new());
    };
    let ids = match probe.store.as_str() {
        "grok" => {
            let dir = root.join("sessions").join(percent_encode(&probe.cwd));
            list_dir_ids(&dir)
        }
        "claude" => {
            let dir = root.join("projects").join(dash_encode(&probe.cwd));
            list_jsonl_ids(&dir)
        }
        _ => Vec::new(),
    };
    Ok(to_hits(ids))
}

#[cfg(test)]
mod tests {
    use super::{dash_encode, percent_encode};

    #[test]
    fn grok_encodes_a_windows_path() {
        assert_eq!(
            percent_encode(r"C:\Users\developer\Documents\code\keel"),
            "C%3A%5CUsers%5Cdeveloper%5CDocuments%5Ccode%5Ckeel"
        );
    }

    #[test]
    fn claude_dashes_a_windows_path() {
        assert_eq!(
            dash_encode(r"C:\Users\developer\Documents\code\keel"),
            "C--Users-developer-Documents-code-keel"
        );
    }
}
