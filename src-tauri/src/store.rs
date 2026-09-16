//! Persistence.
//!
//! Projects, workspaces, layouts and saved setups live in one JSON file under the
//! app config directory. The *shape* of that document is owned by the frontend —
//! Rust deliberately treats it as an opaque blob so the schema can move without a
//! matching Rust change.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("no config directory: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("keel.json"))
}

fn quarantine_corrupt(file: &Path) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = file.with_file_name(format!("keel.json.broken-{stamp}"));
    let _ = fs::rename(file, dest);
}

fn unique_temp(file: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    file.with_file_name(format!("keel.{}.{stamp}.json.tmp", std::process::id()))
}

fn write_atomic(file: &Path, text: &str) -> Result<(), String> {
    let temp = unique_temp(file);
    {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut out = opts.open(&temp).map_err(|err| err.to_string())?;
        out.write_all(text.as_bytes()).map_err(|err| {
            let _ = fs::remove_file(&temp);
            err.to_string()
        })?;
        out.sync_all().map_err(|err| {
            let _ = fs::remove_file(&temp);
            err.to_string()
        })?;
    }
    fs::rename(&temp, file).map_err(|err| {
        let _ = fs::remove_file(&temp);
        err.to_string()
    })
}

fn load_from_disk(file: &Path) -> Result<Option<Value>, String> {
    if !file.is_file() {
        return Ok(None);
    }
    let meta = fs::metadata(file).map_err(|err| err.to_string())?;
    if meta.len() > MAX_STATE_BYTES {
        quarantine_corrupt(file);
        return Err("Saved layout is too large.".into());
    }
    let mut text = String::new();
    File::open(file)
        .and_then(|mut f| f.read_to_string(&mut text))
        .map_err(|err| err.to_string())?;
    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            quarantine_corrupt(file);
            Err("Saved layout could not be read.".into())
        }
    }
}

#[tauri::command]
pub async fn state_load(app: AppHandle) -> Result<Option<Value>, String> {
    crate::blocking::run(move || {
        let file = state_file(&app)?;
        let loaded = load_from_disk(&file)?;
        if let Some(ref value) = loaded {
            crate::roots::ingest_loaded_document(value);
        }
        Ok(loaded)
    })
    .await
}

#[tauri::command]
pub async fn state_save(app: AppHandle, state: Value) -> Result<(), String> {
    crate::blocking::run(move || {
        let file = state_file(&app)?;
        let state = crate::roots::filter_persisted_state(state);
        let text = serde_json::to_string_pretty(&state).map_err(|err| err.to_string())?;
        if text.len() as u64 > MAX_STATE_BYTES {
            return Err("Layout is too large to save.".into());
        }
        write_atomic(&file, &text)
    })
    .await
}

#[tauri::command]
pub async fn state_path(app: AppHandle) -> Result<String, String> {
    crate::blocking::run(move || Ok(state_file(&app)?.to_string_lossy().into_owned())).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

/// Immediate subdirectories of an open project, for picking a pane's working folder.
#[tauri::command]
pub async fn list_subdirectories(path: String) -> Result<Vec<DirEntry>, String> {
    crate::blocking::run(move || {
        let root = crate::roots::require_inside(&path)?;
        let mut entries: Vec<DirEntry> = fs::read_dir(&root)
            .map_err(|err| err.to_string())?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    return None;
                }
                Some(DirEntry {
                    name,
                    path: entry.path().to_string_lossy().into_owned(),
                })
            })
            .collect();
        entries.sort_by_key(|entry| entry.name.to_lowercase());
        Ok(entries)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn oversized_and_corrupt_files_are_quarantined() {
        let dir = std::env::temp_dir().join(format!(
            "keel-state-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("keel.json");
        fs::write(&file, "not-json").unwrap();
        let err = load_from_disk(&file).expect_err("corrupt");
        assert!(err.to_lowercase().contains("could not be read"));
        assert!(!file.exists());
        let broken: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(broken
            .iter()
            .any(|name| name.starts_with("keel.json.broken-")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "keel-state-write-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("keel.json");
        write_atomic(&file, "{\"ok\":true}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"ok\":true}");
        fs::remove_dir_all(&dir).ok();
    }
}
