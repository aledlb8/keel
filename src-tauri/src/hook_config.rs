//! Install only Keel's observational hooks. Existing provider settings and hook
//! array positions are preserved (Codex trust keys contain those positions).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("PreToolUse", "pre_tool_use"),
    ("PostToolUse", "post_tool_use"),
    ("PermissionRequest", "permission_request"),
    ("Stop", "stop"),
];

pub fn supported(agent: &str) -> bool {
    matches!(agent, "claude" | "codex" | "grok" | "opencode")
}

pub fn install(
    agent: &str,
    account: Option<&Path>,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    static INSTALL_LOCK: Mutex<()> = Mutex::new(());
    let _guard = INSTALL_LOCK.lock().map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let variable = |key: &str| {
        env.get(key)
            .filter(|value| !value.is_empty() && !value.contains('\0'))
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os(key).filter(|v| !v.is_empty()))
    };
    if agent == "opencode" {
        let config = variable("OPENCODE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                variable("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .map(|p| p.join("opencode"))
            })
            .or_else(|| crate::pty::home_dir().map(|p| p.join(".config/opencode")))
            .ok_or("no OpenCode config directory")?;
        return write_changed(
            &config.join("plugins/keel-status.js"),
            include_str!("opencode_hooks.mjs"),
        );
    }
    let (home_variable, folder, filename) = match agent {
        "claude" => ("CLAUDE_CONFIG_DIR", ".claude", "settings.json"),
        "codex" => ("CODEX_HOME", ".codex", "hooks.json"),
        "grok" => ("GROK_HOME", ".grok", "hooks/keel-status.json"),
        _ => return Ok(()),
    };
    let home = account
        .map(Path::to_path_buf)
        .or_else(|| {
            variable(home_variable)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| crate::pty::home_dir().map(|p| p.join(folder)))
        .ok_or("no provider home")?;
    let path = home.join(filename);
    let command = hook_command(&executable, agent);
    let mut config = read_json(&path)?;
    let positions = merge_hooks(&mut config, agent, &command)?;
    // Validate TOML before touching hooks.json. Malformed user config stays intact.
    let trust = if agent == "codex" {
        let config_path = home.join("config.toml");
        let content = read_optional(&config_path)?;
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        let source = std::fs::canonicalize(&home)
            .map_err(|e| e.to_string())?
            .join(filename);
        let source = source
            .to_string_lossy()
            .replace(r"\\?\UNC\", r"\\")
            .replace(r"\\?\", "");
        Some((
            config_path,
            codex_trust(&content, &source, &positions, &command)?,
        ))
    } else {
        None
    };
    write_changed(
        &path,
        &serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )?;
    if let Some((path, content)) = trust {
        write_changed(&path, &content)?;
    }
    Ok(())
}

fn hook_command(executable: &Path, agent: &str) -> String {
    let path = executable.to_string_lossy();
    #[cfg(windows)]
    {
        use base64::Engine;
        // Safe through both PowerShell and Git Bash, including spaces/apostrophes.
        let script = format!("& '{}' --keel-agent-hook {agent}", path.replace('\'', "''"));
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }
    #[cfg(not(windows))]
    format!(
        "'{}' --keel-agent-hook {agent}",
        path.replace('\'', "'\\''")
    )
}

fn merge_hooks(
    config: &mut Value,
    agent: &str,
    command: &str,
) -> Result<Vec<(String, usize)>, String> {
    let object = config
        .as_object_mut()
        .ok_or("hook settings must be an object")?;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("hooks must be an object")?;
    let mut events: Vec<_> = EVENTS
        .iter()
        .copied()
        .filter(|(event, _)| agent != "grok" || *event != "PermissionRequest")
        .collect();
    if agent != "codex" {
        events.extend([
            ("StopFailure", "stop_failure"),
            ("SessionEnd", "session_end"),
        ]);
    }
    if agent == "codex" {
        events.push(("Interrupt", "interrupt"));
    }
    if agent == "grok" {
        events.push(("StopCancelled", "stop_cancelled"));
    }
    let mut positions = Vec::new();
    for (event, label) in events {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("{event} hooks must be an array"))?;
        // A stable statusMessage marks only our own matcher group. Append new
        // groups, never splice user groups or invalidate their Codex approvals.
        let position = groups
            .iter()
            .position(|group| {
                group["hooks"].as_array().is_some_and(|handlers| {
                    handlers.len() == 1 && handlers[0]["statusMessage"] == "Keel activity"
                })
            })
            .unwrap_or(groups.len());
        let definition = json!({"hooks": [{"type": "command", "command": command,
            "timeout": 3, "statusMessage": "Keel activity"}]});
        if position == groups.len() {
            groups.push(definition);
        } else {
            groups[position] = definition;
        }
        positions.push((label.to_string(), position));
    }
    Ok(positions)
}

fn codex_trust(
    content: &str,
    source: &str,
    positions: &[(String, usize)],
    command: &str,
) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = content
        .parse()
        .map_err(|e| format!("invalid Codex config: {e}"))?;
    if let Some(hooks) = doc.get("hooks") {
        let table = hooks.as_table_like().ok_or("Codex hooks must be a table")?;
        if table
            .get("state")
            .is_some_and(|state| state.as_table_like().is_none())
        {
            return Err("Codex hook state must be a table".into());
        }
    }
    for (event, position) in positions {
        let key = format!("{source}:{event}:{position}:0");
        if doc
            .get("hooks")
            .and_then(|hooks| hooks.get("state"))
            .and_then(|state| state.get(&key))
            .is_some_and(|entry| entry.as_table_like().is_none())
        {
            return Err(format!("Codex hook state entry {key} must be a table"));
        }
        // serde_json's default Map sorts keys, matching Codex's canonical hash.
        let identity = json!({"event_name": event, "hooks": [{"type": "command", "command": command,
            "timeout": 3, "async": false, "statusMessage": "Keel activity"}]});
        let hash = format!(
            "sha256:{:x}",
            Sha256::digest(identity.to_string().as_bytes())
        );
        // Respect a user disabling our hook in /hooks.
        doc["hooks"]["state"][&key]["trusted_hash"] = toml_edit::value(hash);
    }
    Ok(doc.to_string())
}

fn read_optional(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = read_optional(path)?;
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

fn write_changed(path: &Path, text: &str) -> Result<(), String> {
    if read_optional(path)? == text {
        return Ok(());
    }
    let parent = path.parent().ok_or("missing config parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Follow an existing symlink instead of replacing a user's dotfile link.
    let path = if path.exists() {
        std::fs::canonicalize(path).map_err(|e| e.to_string())?
    } else {
        path.to_path_buf()
    };
    crate::store::write_atomic(&path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_user_hooks_and_updates_own_group_in_place() {
        let user = json!({"matcher":"Bash", "hooks":[{"type":"command", "command":"user-check"}]});
        let mut config = json!({"permissions":{"defaultMode":"plan"}, "hooks":{"UserPromptSubmit":[user.clone()]}});
        let first = merge_hooks(&mut config, "codex", "keel-v1").unwrap();
        assert_eq!(config["hooks"]["UserPromptSubmit"][0], user);
        assert_eq!(
            first
                .iter()
                .find(|(name, _)| name == "user_prompt_submit")
                .unwrap()
                .1,
            1
        );
        let second = merge_hooks(&mut config, "codex", "keel-v2").unwrap();
        assert_eq!(first, second);
        assert_eq!(
            config["hooks"]["UserPromptSubmit"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(config["permissions"]["defaultMode"], "plan");
        assert_eq!(
            config["hooks"]["UserPromptSubmit"][1]["hooks"][0]["command"],
            "keel-v2"
        );
    }

    #[test]
    fn scoped_codex_trust_preserves_unrelated_settings_and_disabled_hooks() {
        let source = "/home/test/.codex/hooks.json";
        let key = format!("{source}:stop:2:0");
        let content = format!("# user comment\nmodel = 'my-model'\n[hooks.state.'{key}']\nenabled = false\n[hooks.state.user]\ntrusted_hash = 'keep'\n");
        let updated = codex_trust(&content, source, &[("stop".into(), 2)], "observer").unwrap();
        assert!(updated.contains("# user comment"));
        let parsed: toml_edit::DocumentMut = updated.parse().unwrap();
        assert_eq!(parsed["model"].as_str(), Some("my-model"));
        assert_eq!(
            parsed["hooks"]["state"][&key]["enabled"].as_bool(),
            Some(false)
        );
        assert_eq!(
            parsed["hooks"]["state"]["user"]["trusted_hash"].as_str(),
            Some("keep")
        );
        assert!(codex_trust("[bad", source, &[], "observer").is_err());
        let malformed = format!("[hooks.state]\n'{key}' = false\n");
        assert!(codex_trust(&malformed, source, &[("stop".into(), 2)], "observer").is_err());
    }

    #[test]
    fn refuses_invalid_hook_settings() {
        assert!(merge_hooks(&mut json!({"hooks": "custom"}), "claude", "observer").is_err());
        assert!(merge_hooks(&mut json!({"hooks": {"Stop": {}}}), "codex", "observer").is_err());
    }
}
