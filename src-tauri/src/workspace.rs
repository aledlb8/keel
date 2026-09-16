//! Project files: list, read, write, create, rename, delete, search.
//!
//! Every path is resolved against the project root the frontend already opened.
//! Nothing here follows a `..` out of that folder.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::paths::{
    is_skipped_dir, normalize_rel, rejects_git_component, rejects_git_open, resolve_existing,
    resolve_target, strip_verbatim, to_posix,
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
    pub mtime_ms: u64,
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

/// Sibling of `path`: `.{filename}.{pid}.{nanos}.keel-tmp`. Distinct for
/// `foo.txt` vs `foo.md`, and ignored by the watcher (`ends_with(".keel-tmp")`).
fn keel_tmp_path(path: &Path, pid: u32, nanos: u128) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    parent.join(format!(".{name}.{pid}.{nanos}.keel-tmp"))
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let pid = std::process::id();
    let mut created = None;
    for attempt in 0u32..32 {
        let nanos = now_nanos().saturating_add(u128::from(attempt));
        let candidate = keel_tmp_path(path, pid, nanos);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(opened) => {
                created = Some((candidate, opened));
                break;
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.to_string()),
        }
    }
    let (temp, mut file) =
        created.ok_or_else(|| "Could not create a temporary file.".to_string())?;
    let write = file
        .write_all(contents.as_bytes())
        .and_then(|_| file.flush());
    drop(file);
    if let Err(err) = write {
        let _ = fs::remove_file(&temp);
        return Err(err.to_string());
    }
    fs::rename(&temp, path).map_err(|err| {
        let _ = fs::remove_file(&temp);
        err.to_string()
    })
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
    let root = crate::roots::require(&root)?;
    let dir = resolve_existing(&root, &rel)?;
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
    let root = crate::roots::require(&root)?;
    rejects_git_open(&normalize_rel(&rel)?)?;
    let path = resolve_existing(&root, &rel)?;
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
    let size = meta.len();
    let mtime_ms = mtime_ms(&meta);
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
            mtime_ms,
        });
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContents {
        text,
        binary: false,
        truncated: size > MAX_READ,
        size,
        mtime_ms,
    })
}

#[tauri::command]
pub async fn workspace_write(
    root: String,
    rel: String,
    contents: String,
    expected_mtime_ms: Option<u64>,
) -> Result<u64, String> {
    crate::blocking::run(move || workspace_write_blocking(root, rel, contents, expected_mtime_ms))
        .await
}

fn workspace_write_blocking(
    root: String,
    rel: String,
    contents: String,
    expected_mtime_ms: Option<u64>,
) -> Result<u64, String> {
    let root = crate::roots::require(&root)?;
    rejects_git_component(&normalize_rel(&rel)?)?;
    let path = resolve_target(&root, &rel)?;
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    if path.exists() {
        let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
        if meta.len() > MAX_READ {
            return Err("This file is too large to save from the editor.".into());
        }
        if let Some(expected) = expected_mtime_ms {
            if mtime_ms(&meta) != expected {
                return Err("This file changed on disk. Reload it before saving.".into());
            }
        }
    }
    write_atomic(&path, &contents)?;
    let mtime = fs::metadata(&path)
        .ok()
        .map(|meta| mtime_ms(&meta))
        .unwrap_or(0);
    Ok(mtime)
}

#[tauri::command]
pub async fn workspace_create(root: String, rel: String, kind: String) -> Result<(), String> {
    crate::blocking::run(move || workspace_create_blocking(root, rel, kind)).await
}

fn workspace_create_blocking(root: String, rel: String, kind: String) -> Result<(), String> {
    let root = crate::roots::require(&root)?;
    rejects_git_component(&normalize_rel(&rel)?)?;
    let path = resolve_target(&root, &rel)?;
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
    let root = crate::roots::require(&root)?;
    rejects_git_component(&normalize_rel(&rel)?)?;
    let path = resolve_existing(&root, &rel)?;
    let root_canon = root;
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
    let root = crate::roots::require(&root)?;
    rejects_git_component(&normalize_rel(&from_rel)?)?;
    rejects_git_component(&normalize_rel(&to_rel)?)?;
    let from = resolve_existing(&root, &from_rel)?;
    let to = resolve_target(&root, &to_rel)?;
    let root_canon = root;
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
    let root_path = crate::roots::require(&root)?;
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
    Ok(walk_search(&root_path, &needle))
}

/// Relative posix path of `path` if it still sits under `root` after
/// canonicalize. Anything that resolved to `..` or another drive is dropped.
fn rel_inside(root: &Path, path: &Path) -> Option<String> {
    use std::path::Component;
    let canon = fs::canonicalize(path).map(strip_verbatim).ok()?;
    if canon == *root || !canon.starts_with(root) {
        return None;
    }
    let rel = canon.strip_prefix(root).ok()?;
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let posix = to_posix(rel);
    let normalized = normalize_rel(&posix).ok()?;
    if normalized.as_os_str().is_empty() {
        return None;
    }
    Some(to_posix(&normalized))
}

fn walk_search(root: &Path, needle: &str) -> Vec<WorkspaceEntry> {
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            !(is_dir && is_skipped_dir(&name, false))
        })
        .build();

    let mut hits = Vec::new();
    for result in walker {
        if hits.len() >= MAX_SEARCH {
            break;
        }
        let Ok(entry) = result else {
            continue;
        };
        let Some(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(posix) = rel_inside(root, path) else {
            continue;
        };
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if posix.to_lowercase().contains(needle) || name.to_lowercase().contains(needle) {
            hits.push(WorkspaceEntry {
                name,
                rel: posix,
                kind: "file",
                size: None,
            });
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    fn repo_root() -> std::path::PathBuf {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crate is inside the repo")
            .to_path_buf();
        crate::roots::register(&root).expect("test project root");
        root
    }

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "keel-ws-{label}-{}-{}",
                std::process::id(),
                now_nanos()
            ));
            fs::create_dir_all(&dir).expect("temp project");
            crate::roots::register(&dir).expect("register temp project");
            Self(dir)
        }

        fn root_str(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            crate::roots::unregister(&self.0);
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn block_read(root: &str, rel: &str) -> Result<FileContents, String> {
        tauri::async_runtime::block_on(workspace_read(root.to_string(), rel.into()))
    }

    fn block_write(
        root: &str,
        rel: &str,
        contents: &str,
        expected: Option<u64>,
    ) -> Result<u64, String> {
        tauri::async_runtime::block_on(workspace_write(
            root.to_string(),
            rel.into(),
            contents.into(),
            expected,
        ))
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

    #[test]
    fn rejects_a_folder_that_is_not_an_open_project() {
        let dir = std::env::temp_dir().join(format!(
            "keel-unregistered-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("secret.txt"), "no").unwrap();
        let err = tauri::async_runtime::block_on(workspace_read(
            dir.to_string_lossy().into_owned(),
            "secret.txt".into(),
        ))
        .expect_err("unregistered");
        assert!(
            err.to_lowercase().contains("not an open project"),
            "unexpected error: {err}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncated_read_sets_the_flag() {
        let dir = Scratch::new("trunc");
        let over = (MAX_READ as usize) + 64;
        fs::write(dir.0.join("big.txt"), vec![b'a'; over]).unwrap();
        let file = block_read(&dir.root_str(), "big.txt").expect("read");
        assert!(file.truncated);
        assert!(!file.binary);
        assert_eq!(file.size, over as u64);
        assert_eq!(file.text.len(), MAX_READ as usize);
    }

    #[test]
    fn write_refuses_a_file_larger_than_max_read() {
        let dir = Scratch::new("large-write");
        let over = (MAX_READ as usize) + 8;
        fs::write(dir.0.join("big.txt"), vec![b'b'; over]).unwrap();
        let err = block_write(&dir.root_str(), "big.txt", "nope", None).expect_err("too large");
        assert!(err.contains("too large to save from the editor"), "{err}");
        assert_eq!(fs::read(dir.0.join("big.txt")).unwrap().len(), over);
    }

    #[test]
    fn write_with_stale_mtime_fails() {
        let dir = Scratch::new("mtime");
        fs::write(dir.0.join("a.txt"), "one").unwrap();
        let file = block_read(&dir.root_str(), "a.txt").expect("read");
        let later = SystemTime::UNIX_EPOCH
            + Duration::from_millis(file.mtime_ms.saturating_add(10_000).max(10_000));
        fs::File::options()
            .write(true)
            .open(dir.0.join("a.txt"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        let err =
            block_write(&dir.root_str(), "a.txt", "two", Some(file.mtime_ms)).expect_err("stale");
        assert!(err.contains("changed on disk"), "{err}");
        assert_eq!(fs::read_to_string(dir.0.join("a.txt")).unwrap(), "one");
    }

    #[test]
    fn tmp_names_differ_for_txt_and_md() {
        let txt = keel_tmp_path(Path::new("foo.txt"), 7, 9);
        let md = keel_tmp_path(Path::new("foo.md"), 7, 9);
        assert_ne!(txt, md);
        assert!(txt.to_string_lossy().ends_with(".keel-tmp"));
        assert!(md.to_string_lossy().ends_with(".keel-tmp"));
        let dir = Scratch::new("tmp-names");
        let root = dir.root_str();
        std::thread::scope(|scope| {
            let a = root.clone();
            let b = root.clone();
            scope.spawn(move || block_write(&a, "foo.txt", "txt", None).expect("txt"));
            scope.spawn(move || block_write(&b, "foo.md", "md", None).expect("md"));
        });
        assert_eq!(fs::read_to_string(dir.0.join("foo.txt")).unwrap(), "txt");
        assert_eq!(fs::read_to_string(dir.0.join("foo.md")).unwrap(), "md");
    }

    #[test]
    fn git_hooks_are_rejected() {
        let dir = Scratch::new("git-jail");
        fs::create_dir_all(dir.0.join(".git/hooks")).unwrap();
        fs::write(dir.0.join(".git/hooks/x"), "echo").unwrap();
        fs::write(dir.0.join("ok.txt"), "ok").unwrap();
        let root = dir.root_str();
        let read = block_read(&root, ".git/hooks/x").expect_err("read");
        assert!(read.contains("cannot be opened"), "{read}");
        let write = block_write(&root, ".git/hooks/x", "no", None).expect_err("write");
        assert!(write.contains("cannot be changed"), "{write}");
        let create = tauri::async_runtime::block_on(workspace_create(
            root.clone(),
            ".git/hooks/y".into(),
            "file".into(),
        ))
        .expect_err("create");
        assert!(create.contains("cannot be changed"), "{create}");
        let delete =
            tauri::async_runtime::block_on(workspace_delete(root.clone(), ".git/hooks/x".into()))
                .expect_err("delete");
        assert!(delete.contains("cannot be changed"), "{delete}");
        let rename_from = tauri::async_runtime::block_on(workspace_rename(
            root.clone(),
            ".git/hooks/x".into(),
            "out".into(),
        ))
        .expect_err("rename from");
        assert!(rename_from.contains("cannot be changed"), "{rename_from}");
        let rename_to = tauri::async_runtime::block_on(workspace_rename(
            root,
            "ok.txt".into(),
            ".git/hooks/z".into(),
        ))
        .expect_err("rename to");
        assert!(rename_to.contains("cannot be changed"), "{rename_to}");
        assert_eq!(
            fs::read_to_string(dir.0.join(".git/hooks/x")).unwrap(),
            "echo"
        );
        assert_eq!(fs::read_to_string(dir.0.join("ok.txt")).unwrap(), "ok");
    }

    #[test]
    fn walk_search_does_not_follow_a_symlink_loop() {
        let dir = Scratch::new("symlink");
        fs::write(dir.0.join("needle.txt"), "hi").unwrap();
        let link = dir.0.join("loop");
        let linked = {
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(&dir.0, &link)
            }
            #[cfg(not(windows))]
            {
                std::os::unix::fs::symlink(&dir.0, &link)
            }
        };
        if let Err(err) = linked {
            eprintln!("skipping symlink loop test: {err}");
            return;
        }
        let hits = walk_search(&dir.0, "needle");
        assert!(
            hits.iter().any(|hit| hit.rel == "needle.txt"),
            "expected needle.txt: {hits:?}"
        );
        assert!(
            hits.iter().all(|hit| !hit.rel.contains("loop/loop")),
            "followed the loop: {hits:?}"
        );
    }
}
