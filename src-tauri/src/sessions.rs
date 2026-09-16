//! Where coding CLIs keep conversation files, so a pane can reopen *its* chat
//! rather than whatever happened to run last in this folder.

use std::path::{Component, Path, PathBuf};
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

fn is_session_id(id: &str) -> bool {
    let n = id.len();
    (1..=128).contains(&n)
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' | b'.' | b'_' | b'-'))
}

fn cwd_is_listable(cwd: &str) -> bool {
    if cwd.is_empty() || cwd.contains('\0') {
        return false;
    }
    let path = Path::new(cwd);
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return false;
    }
    if path.is_dir() {
        crate::roots::is_under_registered(path)
    } else {
        true
    }
}

fn is_encoded_segment(encoded: &str) -> bool {
    if encoded.is_empty() || encoded.contains('\0') {
        return false;
    }
    let mut parts = Path::new(encoded).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

fn list_dir_ids(dir: &Path) -> Vec<(String, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !is_session_id(&name) {
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
        if !is_session_id(stem) {
            continue;
        }
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

fn session_recent_inner(app: &AppHandle, probe: &SessionProbe) -> Result<Vec<SessionHit>, String> {
    let Some(root) = session_root(app, probe) else {
        return Ok(Vec::new());
    };
    if !cwd_is_listable(&probe.cwd) {
        return Ok(Vec::new());
    }
    let ids = match probe.store.as_str() {
        "grok" => {
            let encoded = percent_encode(&probe.cwd);
            if !is_encoded_segment(&encoded) {
                return Ok(Vec::new());
            }
            list_dir_ids(&root.join("sessions").join(encoded))
        }
        "claude" => {
            let encoded = dash_encode(&probe.cwd);
            if !is_encoded_segment(&encoded) {
                return Ok(Vec::new());
            }
            list_jsonl_ids(&root.join("projects").join(encoded))
        }
        _ => Vec::new(),
    };
    Ok(to_hits(ids))
}

/// Session ids for this store + folder, newest first.
#[tauri::command]
pub async fn session_recent(
    app: AppHandle,
    probe: SessionProbe,
) -> Result<Vec<SessionHit>, String> {
    crate::blocking::run(move || session_recent_inner(&app, &probe)).await
}

#[cfg(test)]
mod tests {
    use super::{
        cwd_is_listable, dash_encode, is_encoded_segment, is_session_id, list_jsonl_ids,
        percent_encode,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "keel-sessions-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

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

    #[test]
    fn is_session_id_matches_the_allowed_charset() {
        assert!(is_session_id("11111111-1111-4111-8111-111111111111"));
        assert!(is_session_id("abc-123"));
        assert!(is_session_id(&"a".repeat(128)));
        assert!(is_session_id(".."));
        assert!(!is_session_id(""));
        assert!(!is_session_id(&"a".repeat(129)));
        assert!(!is_session_id("has space"));
        assert!(!is_session_id("x & calc"));
        assert!(!is_session_id("id;rm"));
        assert!(!is_session_id(";"));
        assert!(!is_session_id("$()"));
        assert!(!is_session_id("$(reboot)"));
    }

    #[test]
    fn list_jsonl_ids_skips_illegal_names() {
        let dir = temp_dir();
        fs::write(dir.join("abc-123.jsonl"), b"").unwrap();
        fs::write(dir.join("x & calc.jsonl"), b"").unwrap();
        let names: Vec<_> = list_jsonl_ids(&dir).into_iter().map(|(id, _)| id).collect();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["abc-123".to_string()]);
    }

    #[test]
    fn cwd_rejects_empty_nul_and_parent() {
        assert!(!cwd_is_listable(""));
        assert!(!cwd_is_listable("foo\0bar"));
        assert!(!cwd_is_listable(".."));
        assert!(!cwd_is_listable("."));
        assert!(cwd_is_listable(
            "/this/folder/does/not/exist-keel-sessions-test"
        ));
        assert!(!is_encoded_segment(""));
        assert!(!is_encoded_segment(".."));
        assert!(!is_encoded_segment("."));
        assert!(is_encoded_segment(
            "C%3A%5CUsers%5Cdeveloper%5CDocuments%5Ccode%5Ckeel"
        ));
    }
}
