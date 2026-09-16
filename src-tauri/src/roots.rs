//! Allowlist of project folders the user opened.
//!
//! Workspace, git, grep, and watch commands take a `root` string from the
//! webview. That string is not trusted: a compromised frontend could name any
//! folder. Only paths registered here — from a native folder picker or from the
//! layout file Rust itself loaded — are accepted.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::Value;
use tauri::AppHandle;

use crate::paths::{canonicalize_dir, strip_verbatim};

const ERR_UNKNOWN: &str = "That folder is not an open project.";

static ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
/// Paths present in the last document Rust loaded from disk. Persist may keep
/// these even if the folder is temporarily missing (unmounted drive).
static LOADED_PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn lock_roots() -> Result<MutexGuard<'static, HashSet<PathBuf>>, String> {
    ROOTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "root registry is poisoned".to_string())
}

fn lock_loaded() -> Result<MutexGuard<'static, HashSet<String>>, String> {
    LOADED_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| "loaded path set is poisoned".to_string())
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let a = strip_verbatim(a.to_path_buf());
    let b = strip_verbatim(b.to_path_buf());
    #[cfg(windows)]
    {
        a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn path_is_inside(path: &Path, prefix: &Path) -> bool {
    let path = strip_verbatim(path.to_path_buf());
    let prefix = strip_verbatim(prefix.to_path_buf());
    let path_parts: Vec<_> = path.components().collect();
    let prefix_parts: Vec<_> = prefix.components().collect();
    if prefix_parts.len() > path_parts.len() {
        return false;
    }
    path_parts.iter().zip(prefix_parts.iter()).all(|(a, b)| {
        #[cfg(windows)]
        {
            a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
        }
        #[cfg(not(windows))]
        {
            a == b
        }
    })
}

/// Canonicalize `path` and add it to the allowlist. The folder must exist.
pub fn register(path: &Path) -> Result<PathBuf, String> {
    let canon = canonicalize_dir(path)?;
    lock_roots()?.insert(canon.clone());
    Ok(canon)
}

#[allow(dead_code)]
pub fn unregister(path: &Path) {
    let Ok(canon) = canonicalize_dir(path) else {
        return;
    };
    if let Ok(mut roots) = lock_roots() {
        roots.retain(|existing| !paths_equal(existing, &canon));
    }
}

pub fn is_registered(path: &Path) -> bool {
    let Ok(canon) = canonicalize_dir(path) else {
        return false;
    };
    let Ok(roots) = lock_roots() else {
        return false;
    };
    roots.iter().any(|allowed| paths_equal(allowed, &canon))
}

/// True when `path` is a registered root or sits inside one.
pub fn is_under_registered(path: &Path) -> bool {
    let Ok(canon) = canonicalize_dir(path) else {
        return false;
    };
    let Ok(roots) = lock_roots() else {
        return false;
    };
    roots
        .iter()
        .any(|allowed| paths_equal(allowed, &canon) || path_is_inside(&canon, allowed))
}

/// Project root named by the webview. Rejects anything not on the allowlist.
pub fn require(root: &str) -> Result<PathBuf, String> {
    let canon = canonicalize_dir(Path::new(root))?;
    let roots = lock_roots()?;
    if roots.iter().any(|allowed| paths_equal(allowed, &canon)) {
        Ok(canon)
    } else {
        Err(ERR_UNKNOWN.into())
    }
}

/// Folder picker / subdirectory listing: the path must be a registered root
/// or a directory inside one.
pub fn require_inside(path: &str) -> Result<PathBuf, String> {
    let canon = canonicalize_dir(Path::new(path))?;
    if is_under_registered(&canon) {
        Ok(canon)
    } else {
        Err(ERR_UNKNOWN.into())
    }
}

fn project_paths(value: &Value) -> Vec<String> {
    value
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|project| {
            project
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// Remember and register project folders from a document Rust read off disk.
pub fn ingest_loaded_document(value: &Value) {
    let paths = project_paths(value);
    for path in &paths {
        let _ = register(Path::new(path));
    }
    if let Ok(mut loaded) = lock_loaded() {
        loaded.clear();
        loaded.extend(paths);
    }
}

pub fn persistable_project_path(path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    if is_registered(Path::new(path)) {
        return true;
    }
    lock_loaded()
        .map(|loaded| loaded.contains(path))
        .unwrap_or(false)
}

/// Drop project entries whose path was not opened by the user. A compromised
/// webview cannot persist a new root for the next session.
pub fn filter_persisted_state(mut state: Value) -> Value {
    let Some(projects) = state.get_mut("projects").and_then(Value::as_array_mut) else {
        return state;
    };
    projects.retain(|project| {
        project
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(persistable_project_path)
    });
    state
}

/// Native folder picker. The chosen path is registered before it is returned,
/// so the webview never supplies a free-form root of its own.
#[tauri::command]
pub async fn project_pick(app: AppHandle) -> Result<Option<String>, String> {
    crate::blocking::run(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app
            .dialog()
            .file()
            .set_title("Add a project folder")
            .blocking_pick_folder();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|err| err.to_string())?;
        let canon = register(&path)?;
        Ok(Some(canon.to_string_lossy().into_owned()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_clean_registry<T>(work: impl FnOnce() -> T) -> T {
        let _guard = TEST_LOCK.lock().expect("test lock");
        // Do not clear the process-wide allowlist: other crates' tests register
        // their own temp roots and run in parallel. These cases use unique dirs.
        work()
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "keel-roots-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn require_rejects_unregistered_folders() {
        with_clean_registry(|| {
            let dir = temp_dir();
            assert!(require(&dir.to_string_lossy()).is_err());
            register(&dir).expect("register");
            assert_eq!(
                require(&dir.to_string_lossy()).unwrap(),
                canonicalize_dir(&dir).unwrap()
            );
            fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn require_inside_accepts_subdirectories() {
        with_clean_registry(|| {
            let dir = temp_dir();
            let child = dir.join("src");
            fs::create_dir_all(&child).unwrap();
            register(&dir).unwrap();
            assert!(require_inside(&child.to_string_lossy()).is_ok());
            assert!(is_under_registered(&child));
            fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn save_filter_drops_injected_roots() {
        with_clean_registry(|| {
            let dir = temp_dir();
            ingest_loaded_document(&json!({
                "projects": [{ "path": dir.to_string_lossy() }]
            }));
            let filtered = filter_persisted_state(json!({
                "projects": [
                    { "path": dir.to_string_lossy() },
                    { "path": "C:\\Windows\\System32" },
                    { "path": "/etc" }
                ]
            }));
            let kept = filtered["projects"].as_array().unwrap();
            assert_eq!(kept.len(), 1);
            assert_eq!(kept[0]["path"], dir.to_string_lossy().as_ref());
            fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn loaded_missing_folder_is_still_persistable() {
        with_clean_registry(|| {
            ingest_loaded_document(&json!({
                "projects": [{ "path": "/this/folder/does/not/exist" }]
            }));
            assert!(persistable_project_path("/this/folder/does/not/exist"));
            assert!(!persistable_project_path("/etc"));
        });
    }
}
