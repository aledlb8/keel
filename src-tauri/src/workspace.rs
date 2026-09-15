//! Project files: list, read, write, create, rename, delete, search.
//!
//! Every path is resolved against the project root the frontend already opened.
//! Nothing here follows a `..` out of that folder.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::paths::{
    canonicalize_dir, is_skipped_dir, normalize_rel, resolve_existing, resolve_target, to_posix,
};

const MAX_READ: u64 = 2_000_000;
const MAX_SEARCH: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub rel: String,
    pub kind: &'static str,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub text: String,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn sort_entries(entries: &mut [WorkspaceEntry]) {
    entries.sort_by(|a, b| {
        let dir_a = a.kind == "dir";
        let dir_b = b.kind == "dir";
        dir_b
            .cmp(&dir_a)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// Immediate children of a folder inside the project.
#[tauri::command]
pub async fn workspace_list(
    root: String,
    rel: String,
    show_hidden: bool,
) -> Result<Vec<WorkspaceEntry>, String> {
    crate::blocking::run(move || workspace_list_blocking(root, rel, show_hidden)).await
}

fn workspace_list_blocking(
    root: String,
    rel: String,
    show_hidden: bool,
) -> Result<Vec<WorkspaceEntry>, String> {
    let dir = resolve_existing(Path::new(&root), &rel)?;
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let rel_base = normalize_rel(&rel)?;
    let mut entries = Vec::new();
    let reader = fs::read_dir(&dir).map_err(|err| err.to_string())?;
    for entry in reader.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir && is_skipped_dir(&name, show_hidden) {
            continue;
        }
        if !is_dir && !show_hidden && name.starts_with('.') {
            continue;
        }
        let child = if rel_base.as_os_str().is_empty() {
            Path::new(&name).to_path_buf()
        } else {
            rel_base.join(&name)
        };
        let size = if is_dir {
            None
        } else {
            fs::metadata(&path).ok().map(|meta| meta.len())
        };
        entries.push(WorkspaceEntry {
            name,
            rel: to_posix(&child),
            kind: if is_dir { "dir" } else { "file" },
            size,
        });
    }
    sort_entries(&mut entries);
    Ok(entries)
}

/// UTF-8 text, or a binary flag. Truncates huge files rather than loading them.
#[tauri::command]
pub async fn workspace_read(root: String, rel: String) -> Result<FileContents, String> {
    crate::blocking::run(move || workspace_read_blocking(root, rel)).await
}

fn workspace_read_blocking(root: String, rel: String) -> Result<FileContents, String> {
    let path = resolve_existing(Path::new(&root), &rel)?;
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    let size = fs::metadata(&path).map_err(|err| err.to_string())?.len();
    let bytes = if size > MAX_READ {
        let mut file = fs::File::open(&path).map_err(|err| err.to_string())?;
        let mut buf = vec![0u8; MAX_READ as usize];
        use std::io::Read;
        file.read_exact(&mut buf).map_err(|err| err.to_string())?;
        buf
    } else {
        fs::read(&path).map_err(|err| err.to_string())?
    };
    if looks_binary(&bytes) {
        return Ok(FileContents {
            text: String::new(),
            binary: true,
            truncated: size > MAX_READ,
            size,
        });
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContents {
        text,
        binary: false,
        truncated: size > MAX_READ,
        size,
    })
}

#[tauri::command]
pub async fn workspace_write(root: String, rel: String, contents: String) -> Result<(), String> {
    crate::blocking::run(move || workspace_write_blocking(root, rel, contents)).await
}

fn workspace_write_blocking(root: String, rel: String, contents: String) -> Result<(), String> {
    let path = resolve_target(Path::new(&root), &rel)?;
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let temp = path.with_extension("keel-tmp");
    fs::write(&temp, contents).map_err(|err| err.to_string())?;
    fs::rename(&temp, &path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        err.to_string()
    })
}

#[tauri::command]
pub async fn workspace_create(root: String, rel: String, kind: String) -> Result<(), String> {
    crate::blocking::run(move || workspace_create_blocking(root, rel, kind)).await
}

fn workspace_create_blocking(root: String, rel: String, kind: String) -> Result<(), String> {
    let path = resolve_target(Path::new(&root), &rel)?;
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    match kind.as_str() {
        "dir" => fs::create_dir_all(&path).map_err(|err| err.to_string()),
        "file" => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::write(&path, "").map_err(|err| err.to_string())
        }
        _ => Err("Create a file or a folder.".into()),
    }
}

#[tauri::command]
pub async fn workspace_delete(root: String, rel: String) -> Result<(), String> {
    crate::blocking::run(move || workspace_delete_blocking(root, rel)).await
}

fn workspace_delete_blocking(root: String, rel: String) -> Result<(), String> {
    let path = resolve_existing(Path::new(&root), &rel)?;
    let root_canon = canonicalize_dir(Path::new(&root))?;
    if path == root_canon {
        return Err("The project folder cannot be deleted from here.".into());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|err| err.to_string())
    } else {
        fs::remove_file(&path).map_err(|err| err.to_string())
    }
}

#[tauri::command]
pub async fn workspace_rename(
    root: String,
    from_rel: String,
    to_rel: String,
) -> Result<(), String> {
    crate::blocking::run(move || workspace_rename_blocking(root, from_rel, to_rel)).await
}

fn workspace_rename_blocking(root: String, from_rel: String, to_rel: String) -> Result<(), String> {
    let from = resolve_existing(Path::new(&root), &from_rel)?;
    let to = resolve_target(Path::new(&root), &to_rel)?;
    let root_canon = canonicalize_dir(Path::new(&root))?;
    if from == root_canon {
        return Err("The project folder cannot be renamed from here.".into());
    }
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::rename(&from, &to).map_err(|err| err.to_string())
}

/// Filename search. Prefers `git ls-files` so ignored noise stays out; walks
/// the tree otherwise. Caps the result so a huge repo cannot flood the UI.
#[tauri::command]
pub async fn workspace_search(root: String, query: String) -> Result<Vec<WorkspaceEntry>, String> {
    crate::blocking::run(move || workspace_search_blocking(root, query)).await
}

fn workspace_search_blocking(root: String, query: String) -> Result<Vec<WorkspaceEntry>, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Vec::new());
    }
    let root_path = canonicalize_dir(Path::new(&root))?;
    if let Ok(files) = crate::git::ls_files(&root_path) {
        let mut hits = Vec::new();
        for rel in files {
            if !rel.to_lowercase().contains(&needle) {
                continue;
            }
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            hits.push(WorkspaceEntry {
                name,
                rel: rel.clone(),
                kind: "file",
                size: None,
            });
            if hits.len() >= MAX_SEARCH {
                break;
            }
        }
        return Ok(hits);
    }
    let mut hits = Vec::new();
    walk_search(&root_path, Path::new(""), &needle, &mut hits);
    Ok(hits)
}

fn walk_search(root: &Path, rel: &Path, needle: &str, hits: &mut Vec<WorkspaceEntry>) {
    if hits.len() >= MAX_SEARCH {
        return;
    }
    let dir = if rel.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let Ok(reader) = fs::read_dir(&dir) else {
        return;
    };
    for entry in reader.filter_map(Result::ok) {
        if hits.len() >= MAX_SEARCH {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if rel.as_os_str().is_empty() {
            Path::new(&name).to_path_buf()
        } else {
            rel.join(&name)
        };
        let path = entry.path();
        if path.is_dir() {
            if is_skipped_dir(&name, false) {
                continue;
            }
            walk_search(root, &child, needle, hits);
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        let posix = to_posix(&child);
        if posix.to_lowercase().contains(needle) || name.to_lowercase().contains(needle) {
            hits.push(WorkspaceEntry {
                name,
                rel: posix,
                kind: "file",
                size: None,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crate is inside the repo")
            .to_path_buf()
    }

    #[test]
    fn lists_the_project_root() {
        let root = repo_root();
        let entries = tauri::async_runtime::block_on(workspace_list(
            root.to_string_lossy().into_owned(),
            String::new(),
            false,
        ))
        .expect("list root");
        assert!(
            entries
                .iter()
                .any(|entry| entry.name == "src" && entry.kind == "dir"),
            "expected src/: {entries:?}"
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.name == "package.json" && entry.kind == "file"),
            "expected package.json: {entries:?}"
        );
        assert!(!entries.iter().any(|entry| entry.name == ".git"));
        assert!(!entries.iter().any(|entry| entry.name == "node_modules"));
    }

    #[test]
    fn reads_a_source_file() {
        let root = repo_root();
        let file = tauri::async_runtime::block_on(workspace_read(
            root.to_string_lossy().into_owned(),
            "package.json".into(),
        ))
        .expect("read package.json");
        assert!(!file.binary);
        assert!(file.text.contains("\"name\": \"keel\""));
    }

    #[test]
    fn rejects_escape() {
        let root = repo_root();
        let err = tauri::async_runtime::block_on(workspace_read(
            root.to_string_lossy().into_owned(),
            "../secret".into(),
        ))
        .expect_err("escaped");
        assert!(err.to_lowercase().contains("outside"));
    }
}
