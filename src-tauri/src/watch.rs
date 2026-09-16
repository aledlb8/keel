//! Project folder watcher.
//!
//! One OS watcher for the process, shared by every open project. Debounced
//! events come out as `workspace:changed` so the frontend can refresh the tree
//! and git without polling. `.git` internals stay quiet except HEAD, index and
//! packed-refs, which flip the `git` flag without listing those as files.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::paths::{canonicalize_dir, is_skipped_dir, strip_verbatim, to_posix};

const DEBOUNCE: Duration = Duration::from_millis(300);

type FolderDebouncer = Debouncer<RecommendedWatcher>;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChanged {
    /// Original root string the frontend passed to [`workspace_watch`].
    pub root: String,
    /// Posix relative paths. `""` means refresh everything.
    pub rels: Vec<String>,
    /// True if `.git/HEAD`, `.git/index`, packed-refs, or worktree files changed.
    pub git: bool,
}

struct Inner {
    app: AppHandle,
    /// Canonical path → original frontend root.
    roots: Mutex<HashMap<PathBuf, String>>,
    debouncer: Mutex<Option<FolderDebouncer>>,
}

#[derive(Clone)]
pub struct WatchManager {
    inner: Arc<Inner>,
}

impl WatchManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                app,
                roots: Mutex::new(HashMap::new()),
                debouncer: Mutex::new(None),
            }),
        }
    }

    pub fn shutdown(&self) {
        {
            let mut slot = match self.inner.debouncer.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            *slot = None;
        }
        match self.inner.roots.lock() {
            Ok(mut guard) => guard.clear(),
            Err(poisoned) => poisoned.into_inner().clear(),
        }
    }

    fn lock_roots(&self) -> Result<MutexGuard<'_, HashMap<PathBuf, String>>, String> {
        self.inner
            .roots
            .lock()
            .map_err(|_| "watch state is poisoned".to_string())
    }

    fn lock_debouncer(&self) -> Result<MutexGuard<'_, Option<FolderDebouncer>>, String> {
        self.inner
            .debouncer
            .lock()
            .map_err(|_| "watch state is poisoned".to_string())
    }

    /// Debouncer lock first, then roots — `unwatch` uses the same order.
    fn watch(&self, canon: PathBuf, original: String) -> Result<(), String> {
        let canon = {
            let mut roots = self.lock_roots()?;
            match roots.entry(canon) {
                Entry::Occupied(mut occupied) => {
                    occupied.insert(original);
                    return Ok(());
                }
                Entry::Vacant(vacant) => vacant.into_key(),
            }
        };

        let mut slot = self.lock_debouncer()?;
        if slot.is_none() {
            let inner = Arc::clone(&self.inner);
            let debouncer = new_debouncer(DEBOUNCE, move |result| {
                on_debounced(&inner, result);
            })
            .map_err(|err| format!("Could not start the folder watcher: {err}"))?;
            *slot = Some(debouncer);
        }

        {
            let Some(debouncer) = slot.as_mut() else {
                return Err("Could not start the folder watcher.".into());
            };
            if let Err(err) = debouncer.watcher().watch(&canon, RecursiveMode::Recursive) {
                let err = format!("Could not watch {}: {err}", canon.display());
                let mut roots = self.lock_roots()?;
                if let Entry::Occupied(mut occupied) = roots.entry(canon) {
                    occupied.insert(original);
                    return Ok(());
                }
                return Err(err);
            }
        }

        self.lock_roots()?.insert(canon, original);
        Ok(())
    }

    fn unwatch(&self, root: String, canon: Option<PathBuf>) -> Result<(), String> {
        let mut slot = self.lock_debouncer()?;
        let mut roots = self.lock_roots()?;
        let Some(key) = find_watched(&roots, &root, canon.as_deref()) else {
            return Ok(());
        };
        roots.remove(&key);
        if roots.is_empty() {
            *slot = None;
        } else if let Some(debouncer) = slot.as_mut() {
            let _ = debouncer.watcher().unwatch(&key);
        }
        Ok(())
    }
}

/// Start watching a project folder. Already-watched roots are a no-op.
#[tauri::command]
pub async fn workspace_watch(manager: State<'_, WatchManager>, root: String) -> Result<(), String> {
    let manager = WatchManager::clone(&manager);
    let original = root.clone();
    let canon = crate::blocking::run(move || crate::roots::require(&root)).await?;
    manager.watch(canon, original)
}

/// Stop watching a project folder. A missing root is a no-op.
#[tauri::command]
pub async fn workspace_unwatch(
    manager: State<'_, WatchManager>,
    root: String,
) -> Result<(), String> {
    let manager = WatchManager::clone(&manager);
    let lookup = root.clone();
    let canon = crate::blocking::run(move || Ok(canonicalize_dir(Path::new(&lookup)).ok())).await?;
    manager.unwatch(root, canon)
}

fn on_debounced(inner: &Inner, result: DebounceEventResult) {
    let roots: Vec<(PathBuf, String)> = match inner.roots.lock() {
        Ok(guard) => guard.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Err(_) => return,
    };
    if roots.is_empty() {
        return;
    }
    let payloads = match result {
        Ok(events) => changes_from_paths(&roots, events.into_iter().map(|event| event.path)),
        Err(err) => changes_from_error(&roots, &err),
    };
    for payload in payloads {
        let _ = inner.app.emit("workspace:changed", payload);
    }
}

fn find_watched(
    roots: &HashMap<PathBuf, String>,
    original: &str,
    canon: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(canon) = canon {
        if roots.contains_key(canon) {
            return Some(canon.to_path_buf());
        }
    }
    if let Some((key, _)) = roots.iter().find(|(_, value)| *value == original) {
        return Some(key.clone());
    }
    let stripped = strip_verbatim(PathBuf::from(original));
    roots
        .keys()
        .find(|key| paths_equal(key, &stripped))
        .cloned()
}

fn full_refresh(root: &str) -> WorkspaceChanged {
    WorkspaceChanged {
        root: root.to_string(),
        rels: vec![String::new()],
        git: true,
    }
}

fn changes_from_error(roots: &[(PathBuf, String)], err: &notify::Error) -> Vec<WorkspaceChanged> {
    let mut hit: HashSet<String> = HashSet::new();
    for path in &err.paths {
        if let Some((_, original)) = longest_root(roots, path) {
            hit.insert(original.clone());
        }
    }
    if hit.is_empty() {
        return roots
            .iter()
            .map(|(_, original)| full_refresh(original))
            .collect();
    }
    hit.into_iter().map(|root| full_refresh(&root)).collect()
}

fn changes_from_paths(
    roots: &[(PathBuf, String)],
    paths: impl IntoIterator<Item = PathBuf>,
) -> Vec<WorkspaceChanged> {
    let mut grouped: HashMap<String, (HashSet<String>, bool)> = HashMap::new();
    for path in paths {
        let Some((canon, original)) = longest_root(roots, &path) else {
            continue;
        };
        let Some((rel, git_meta)) = classify_event(canon, &path) else {
            continue;
        };
        let entry = grouped.entry(original.clone()).or_default();
        entry.1 = true;
        if !git_meta && !rel.is_empty() {
            entry.0.insert(rel);
        }
    }
    grouped
        .into_iter()
        .map(|(root, (rels, git))| {
            let mut rels: Vec<String> = rels.into_iter().collect();
            rels.sort();
            WorkspaceChanged { root, rels, git }
        })
        .collect()
}

fn longest_root<'a>(roots: &'a [(PathBuf, String)], event: &Path) -> Option<&'a (PathBuf, String)> {
    let stripped = strip_verbatim(event.to_path_buf());
    longest_prefix(roots, &stripped).or_else(|| {
        let canon = std::fs::canonicalize(&stripped).ok().map(strip_verbatim)?;
        longest_prefix(roots, &canon)
    })
}

fn longest_prefix<'a>(
    roots: &'a [(PathBuf, String)],
    event: &Path,
) -> Option<&'a (PathBuf, String)> {
    roots
        .iter()
        .filter(|(canon, _)| path_is_inside(event, canon))
        .max_by_key(|(canon, _)| canon.as_os_str().len())
}

/// Map an event path under `root` to a posix relative path and whether it is
/// git metadata. `None` means ignore the event.
fn classify_event(root: &Path, event: &Path) -> Option<(String, bool)> {
    let root = strip_verbatim(root.to_path_buf());
    let event = strip_verbatim(event.to_path_buf());
    let rel = strip_prefix_path(&event, &root)?;
    classify_rel(&rel)
}

fn classify_rel(rel: &Path) -> Option<(String, bool)> {
    if rel.as_os_str().is_empty() {
        return None;
    }
    if is_keel_tmp(rel) {
        return None;
    }

    let parts: Vec<String> = rel
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();

    for (index, part) in parts.iter().enumerate() {
        if name_eq(part, ".git") {
            let rest = &parts[index + 1..];
            return match rest {
                [] => Some((String::new(), true)),
                [name] if is_git_meta_file(name) => Some((String::new(), true)),
                _ => None,
            };
        }
        if skipped_component(part) {
            return None;
        }
    }

    Some((to_posix(rel), false))
}

fn is_git_meta_file(name: &str) -> bool {
    name_eq(name, "HEAD") || name_eq(name, "index") || name_eq(name, "packed-refs")
}

fn is_keel_tmp(rel: &Path) -> bool {
    rel.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().ends_with(".keel-tmp"),
        _ => false,
    })
}

fn skipped_component(name: &str) -> bool {
    #[cfg(windows)]
    {
        is_skipped_dir(&name.to_ascii_lowercase(), true)
    }
    #[cfg(not(windows))]
    {
        is_skipped_dir(name, true)
    }
}

fn name_eq(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn components_equal(a: Component<'_>, b: Component<'_>) -> bool {
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
    path_parts
        .iter()
        .zip(prefix_parts.iter())
        .all(|(a, b)| components_equal(*a, *b))
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let a = strip_verbatim(a.to_path_buf());
    let b = strip_verbatim(b.to_path_buf());
    let a_parts: Vec<_> = a.components().collect();
    let b_parts: Vec<_> = b.components().collect();
    a_parts.len() == b_parts.len()
        && a_parts
            .iter()
            .zip(b_parts.iter())
            .all(|(x, y)| components_equal(*x, *y))
}

fn strip_prefix_path(path: &Path, prefix: &Path) -> Option<PathBuf> {
    let path_parts: Vec<_> = path.components().collect();
    let prefix_parts: Vec<_> = prefix.components().collect();
    if prefix_parts.len() > path_parts.len() {
        return None;
    }
    if !path_parts
        .iter()
        .zip(prefix_parts.iter())
        .all(|(a, b)| components_equal(*a, *b))
    {
        return None;
    }
    let mut out = PathBuf::new();
    for component in &path_parts[prefix_parts.len()..] {
        out.push(component.as_os_str());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_root() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(r"C:\proj")
        }
        #[cfg(not(windows))]
        {
            PathBuf::from("/proj")
        }
    }

    #[test]
    fn maps_a_worktree_file() {
        let root = sample_root();
        assert_eq!(
            classify_event(&root, &root.join("src").join("lib.rs")),
            Some(("src/lib.rs".into(), false))
        );
        assert_eq!(
            classify_event(&root, &root.join(".env")),
            Some((".env".into(), false))
        );
        assert_eq!(
            classify_event(
                &root,
                &root.join(".github").join("workflows").join("ci.yml")
            ),
            Some((".github/workflows/ci.yml".into(), false))
        );
    }

    #[test]
    fn ignores_the_watched_root_itself() {
        let root = sample_root();
        assert_eq!(classify_event(&root, &root), None);
    }

    #[test]
    fn flags_git_metadata_without_a_file_rel() {
        let root = sample_root();
        let git = root.join(".git");
        assert_eq!(
            classify_event(&root, &git.join("HEAD")),
            Some((String::new(), true))
        );
        assert_eq!(
            classify_event(&root, &git.join("index")),
            Some((String::new(), true))
        );
        assert_eq!(
            classify_event(&root, &git.join("packed-refs")),
            Some((String::new(), true))
        );
        assert_eq!(classify_event(&root, &git), Some((String::new(), true)));
        assert_eq!(
            classify_event(&root, &git.join("objects").join("ab").join("cd")),
            None
        );
        assert_eq!(
            classify_event(&root, &git.join("refs").join("heads").join("main")),
            None
        );
    }

    #[test]
    fn ignores_skipped_directories() {
        let root = sample_root();
        assert_eq!(
            classify_event(
                &root,
                &root.join("node_modules").join("pkg").join("index.js")
            ),
            None
        );
        assert_eq!(
            classify_event(&root, &root.join("target").join("debug").join("keel")),
            None
        );
        assert_eq!(
            classify_event(&root, &root.join("src").join("dist").join("out.js")),
            None
        );
        assert_eq!(
            classify_event(&root, &root.join(".next").join("cache")),
            None
        );
    }

    #[test]
    fn ignores_atomic_write_temps() {
        let root = sample_root();
        assert_eq!(
            classify_event(&root, &root.join("src").join("lib.keel-tmp")),
            None
        );
        assert_eq!(classify_event(&root, &root.join("notes.keel-tmp")), None);
    }

    #[test]
    fn ignores_paths_outside_the_root() {
        let root = sample_root();
        let other = root.parent().unwrap().join("other").join("file.rs");
        assert_eq!(classify_event(&root, &other), None);
        assert_eq!(classify_event(&root, Path::new("relative/file.rs")), None);
    }

    #[test]
    fn groups_events_under_the_longest_root() {
        let parent = sample_root();
        let nested = parent.join("nested");
        let roots = vec![
            (parent.clone(), "orig-parent".into()),
            (nested.clone(), "orig-nested".into()),
        ];
        let mut changes = changes_from_paths(
            &roots,
            vec![
                nested.join("a.ts"),
                parent.join("src").join("b.ts"),
                nested.join(".git").join("HEAD"),
                parent.join("node_modules").join("x"),
            ],
        );
        changes.sort_by(|a, b| a.root.cmp(&b.root));
        assert_eq!(
            changes,
            vec![
                WorkspaceChanged {
                    root: "orig-nested".into(),
                    rels: vec!["a.ts".into()],
                    git: true,
                },
                WorkspaceChanged {
                    root: "orig-parent".into(),
                    rels: vec!["src/b.ts".into()],
                    git: true,
                },
            ]
        );
    }

    #[test]
    fn git_metadata_alone_asks_for_a_git_refresh() {
        let root = sample_root();
        let roots = vec![(root.clone(), "orig".into())];
        let changes = changes_from_paths(&roots, vec![root.join(".git").join("index")]);
        assert_eq!(
            changes,
            vec![WorkspaceChanged {
                root: "orig".into(),
                rels: vec![],
                git: true,
            }]
        );
    }

    #[test]
    fn overflow_asks_for_a_full_refresh() {
        let root = sample_root();
        let roots = vec![(root.clone(), "orig".into())];
        let err = notify::Error::generic("buffer overflow").add_path(root.join("src"));
        assert_eq!(changes_from_error(&roots, &err), vec![full_refresh("orig")]);
        let unknown = notify::Error::generic("watcher failed");
        assert_eq!(
            changes_from_error(&roots, &unknown),
            vec![full_refresh("orig")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_strips_verbatim_and_ignores_case() {
        let root = PathBuf::from(r"C:\Proj");
        assert_eq!(
            classify_event(&root, Path::new(r"\\?\C:\proj\Src\lib.rs")),
            Some(("Src/lib.rs".into(), false))
        );
        assert_eq!(
            classify_event(&root, Path::new(r"C:\PROJ\.GIT\HEAD")),
            Some((String::new(), true))
        );
        assert_eq!(
            classify_event(&root, Path::new(r"C:\proj\Node_Modules\pkg")),
            None
        );
    }
}
