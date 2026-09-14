//! Persistence.
//!
//! Projects, workspaces, layouts and saved setups live in one JSON file under the
//! app config directory. The *shape* of that document is owned by the frontend —
//! Rust deliberately treats it as an opaque blob so the schema can move without a
//! matching Rust change.

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn state_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("no config directory: {err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("keel.json"))
}

#[tauri::command]
pub fn state_load(app: AppHandle) -> Result<Option<Value>, String> {
    let file = state_file(&app)?;
    if !file.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&file).map_err(|err| err.to_string())?;
    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        // A corrupt file should not brick the app — keep it aside and start fresh.
        Err(_) => {
            let _ = std::fs::rename(&file, file.with_extension("json.broken"));
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn state_save(app: AppHandle, state: Value) -> Result<(), String> {
    let file = state_file(&app)?;
    let text = serde_json::to_string_pretty(&state).map_err(|err| err.to_string())?;
    // Write-then-rename so a crash mid-save cannot leave a half-written file.
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|err| err.to_string())?;
    std::fs::rename(&temp, &file).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn state_path(app: AppHandle) -> Result<String, String> {
    Ok(state_file(&app)?.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

/// Immediate subdirectories of a project root, for picking a pane's working folder.
#[tauri::command]
pub fn list_subdirectories(path: String) -> Result<Vec<DirEntry>, String> {
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&root)
        .map_err(|err| err.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Hidden and vendored folders are noise in a folder picker.
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
}

/// Used to drop stale projects whose folder has been moved or deleted.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
