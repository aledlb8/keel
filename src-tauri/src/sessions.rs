//! Conversation identity validation and a narrowly scoped legacy migration.
//! Live ownership comes only from pane-scoped provider events, never timestamps
//! or discovery in another application's private transcript/database schema.

use std::path::{Component, Path};
use tauri::{AppHandle, Manager};

/// Repair the old Claude-observer replay bug only when the saved ID actually
/// exists in the original Grok account. Never choose a recent/nearby transcript.
pub(crate) fn repair_imported_grok_panes(
    document: &mut serde_json::Value,
    mut exists: impl FnMut(&str, &str, Option<&str>) -> bool,
) {
    let Some(projects) = document.get_mut("projects").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for project in projects {
        let path = project
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let Some(decks) = project.get_mut("decks").and_then(|v| v.as_array_mut()) else {
            continue;
        };
        for deck in decks {
            let Some(panes) = deck.get_mut("panes").and_then(|v| v.as_object_mut()) else {
                continue;
            };
            for pane in panes.values_mut() {
                if pane["agentId"] != "claude"
                    || pane["agentHome"]["agentId"] != "grok"
                    || !pane["accountId"].is_null()
                    || !pane["editor"].is_null()
                {
                    continue;
                }
                let Some(id) = pane["sessionId"].as_str().filter(|id| is_session_id(id)) else {
                    continue;
                };
                let cwd = pane["cwd"].as_str().unwrap_or(&path);
                let account = pane["agentHome"]["accountId"].as_str();
                if !exists(id, cwd, account) {
                    continue;
                }
                let home = pane["agentHome"].clone();
                pane["agentId"] = "grok".into();
                pane["accountId"] = home["accountId"].clone();
                pane["sessionReady"] = true.into();
                // Preserve a later /new chat ID; the saved home may be older.
                if pane["titleLocked"] != true
                    && matches!(pane["title"].as_str(), Some("Claude Code" | "claude"))
                {
                    pane["title"] = home["title"].clone();
                }
                if let Some(object) = pane.as_object_mut() {
                    object.remove("agentHome");
                }
            }
        }
    }
}

pub(crate) fn grok_session_exists(
    app: &AppHandle,
    id: &str,
    cwd: &str,
    account: Option<&str>,
) -> bool {
    if !is_session_id(id) || !cwd_is_listable(cwd) {
        return false;
    }
    let encoded = percent_encode(cwd);
    if !is_encoded_segment(&encoded) || !is_encoded_segment(id) {
        return false;
    }
    let root = if let Some(account) = account {
        if account.is_empty()
            || !account
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return false;
        }
        app.path()
            .app_config_dir()
            .ok()
            .map(|p| p.join("accounts").join(account))
    } else {
        std::env::var_os("GROK_HOME")
            .filter(|v| !v.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| crate::pty::home_dir().map(|p| p.join(".grok")))
    };
    root.is_some_and(|root| root.join("sessions").join(encoded).join(id).is_dir())
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

pub(crate) fn is_session_id(id: &str) -> bool {
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

#[cfg(test)]
mod tests {
    #[test]
    fn repairs_imported_grok_identity_only_with_exact_session_evidence() {
        use serde_json::json;
        let bad = json!({
            "agentId": "claude", "accountId": null, "sessionId": "new-grok-chat",
            "sessionReady": true, "resumeAgent": true, "title": "Claude Code", "cwd": "/code",
            "agentHome": {"agentId": "grok", "accountId": "work", "sessionId": "older-chat", "title": "Grok Build"}
        });
        let mut genuine = bad.clone();
        genuine["sessionId"] = json!("real-claude-chat");
        let mut named = bad.clone();
        named["title"] = json!("fix auth");
        named["titleLocked"] = json!(true);
        let mut document = json!({"projects": [{"path": "/fallback", "decks": [{"panes": {
            "bad": bad, "genuine": genuine.clone(), "named": named
        }}]}]});
        let confirm = |id: &str, cwd: &str, account: Option<&str>| {
            assert_eq!(cwd, "/code");
            assert_eq!(account, Some("work"));
            id == "new-grok-chat"
        };
        super::repair_imported_grok_panes(&mut document, confirm);
        let panes = &document["projects"][0]["decks"][0]["panes"];
        assert_eq!(panes["bad"]["agentId"], "grok");
        assert_eq!(panes["bad"]["accountId"], "work");
        assert_eq!(panes["bad"]["sessionId"], "new-grok-chat");
        assert_eq!(panes["bad"]["title"], "Grok Build");
        assert!(panes["bad"].get("agentHome").is_none());
        assert_eq!(panes["named"]["title"], "fix auth");
        assert_eq!(panes["genuine"], genuine);
        let repaired = document.clone();
        super::repair_imported_grok_panes(&mut document, confirm);
        assert_eq!(document, repaired);
    }

    #[test]
    fn identity_and_path_validation() {
        assert!(super::is_session_id("chat-1_abc"));
        assert!(!super::is_session_id("bad;command"));
        assert!(!super::is_session_id(""));
        assert!(!super::is_encoded_segment(".."));
        assert!(!super::is_encoded_segment("../chat"));
        assert!(!super::cwd_is_listable(""));
        assert_eq!(super::percent_encode("C:\\code"), "C%3A%5Ccode");
    }
}
