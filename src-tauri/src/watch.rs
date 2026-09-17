//! Project folder watcher.
//!
//! OS watchers shared by project roots and external Git directories. Debounced
//! events come out as `workspace:changed` so the frontend can refresh the tree
//! and git without polling. Git metadata (including linked worktrees) only
//! flips the `git` flag; it never appears as a changed project file.

use std::collections::{HashMap, HashSet};
use std::io::Read;
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
    roots: Mutex<HashMap<PathBuf, WatchedRoot>>,
    watchers: Mutex<HashMap<PathBuf, FolderDebouncer>>,
}

#[derive(Clone)]
struct WatchedRoot {
    original: String,
    git_dirs: Vec<PathBuf>,
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
                watchers: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn shutdown(&self) {
        {
            let mut slot = match self.inner.watchers.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            slot.clear();
        }
        match self.inner.roots.lock() {
            Ok(mut guard) => guard.clear(),
            Err(poisoned) => poisoned.into_inner().clear(),
        }
    }

    fn lock_roots(&self) -> Result<MutexGuard<'_, HashMap<PathBuf, WatchedRoot>>, String> {
        self.inner
            .roots
            .lock()
            .map_err(|_| "watch state is poisoned".to_string())
    }

    fn lock_watchers(&self) -> Result<MutexGuard<'_, HashMap<PathBuf, FolderDebouncer>>, String> {
        self.inner
            .watchers
            .lock()
            .map_err(|_| "watch state is poisoned".to_string())
    }

    /// Watchers lock first, then roots — `unwatch` uses the same order.
    fn watch(&self, canon: PathBuf, original: String) -> Result<(), String> {
        let mut slot = self.lock_watchers()?;
        let mut roots = self.lock_roots()?;
        if let Some(existing) = roots.get_mut(&canon) {
            existing.original = original;
            return Ok(());
        }
        let mut next = roots.clone();
        let git_dirs = git_directories(&canon);
        next.insert(canon, WatchedRoot { original, git_dirs });
        self.reconcile_watchers(&mut slot, &next)?;
        *roots = next;
        Ok(())
    }

    fn unwatch(&self, root: String, canon: Option<PathBuf>) -> Result<(), String> {
        let mut slot = self.lock_watchers()?;
        let mut roots = self.lock_roots()?;
        let Some(key) = find_watched(&roots, &root, canon.as_deref()) else {
            return Ok(());
        };
        let mut next = roots.clone();
        next.remove(&key);
        self.reconcile_watchers(&mut slot, &next)?;
        *roots = next;
        Ok(())
    }

    /// Retain unchanged watchers and their pending events. Separate native
    /// handles let a nested project outlive its parent without inotify teardown
    /// removing the child's watches. Shared Git directories have one handle.
    fn reconcile_watchers(
        &self,
        watchers: &mut HashMap<PathBuf, FolderDebouncer>,
        roots: &HashMap<PathBuf, WatchedRoot>,
    ) -> Result<(), String> {
        let required: HashSet<_> = watch_paths(roots).into_iter().collect();
        let mut pending: Vec<&PathBuf> = required
            .iter()
            .filter(|path| !watchers.contains_key(*path))
            .collect();
        pending.sort_by_key(|path| !roots.contains_key(*path));

        let mut added = HashMap::new();
        for path in pending {
            if !roots.contains_key(path) && !looks_like_git_dir(path) {
                continue;
            }
            match start_folder_watch(&self.inner, path) {
                Ok(debouncer) => {
                    added.insert(path.clone(), debouncer);
                }
                Err(err) if roots.contains_key(path) => return Err(err),
                Err(_) => {}
            }
        }
        watchers.extend(added);
        watchers.retain(|path, _| required.contains(path));
        Ok(())
    }
}

fn watch_paths(roots: &HashMap<PathBuf, WatchedRoot>) -> Vec<PathBuf> {
    roots
        .iter()
        .flat_map(|(root, info)| {
            std::iter::once(root.clone()).chain(
                info.git_dirs
                    .iter()
                    .filter(|dir| {
                        !is_volume_root(dir)
                            && !path_is_inside(dir, root)
                            && !info
                                .git_dirs
                                .iter()
                                .any(|other| other != *dir && path_is_inside(dir, other))
                    })
                    .cloned(),
            )
        })
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

fn start_folder_watch(inner: &Arc<Inner>, path: &Path) -> Result<FolderDebouncer, String> {
    let inner = Arc::clone(inner);
    let mut debouncer = new_debouncer(DEBOUNCE, move |result| on_debounced(&inner, result))
        .map_err(|err| format!("Could not start the folder watcher: {err}"))?;
    debouncer
        .watcher()
        .watch(path, RecursiveMode::Recursive)
        .map_err(|err| format!("Could not watch {}: {err}", path.display()))?;
    Ok(debouncer)
}

fn read_git_pointer(path: &Path) -> Result<String, String> {
    let mut text = String::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(8192).read_to_string(&mut text))
        .map_err(|err| format!("Could not read {}: {err}", path.display()))?;
    Ok(text.trim().to_string())
}

fn resolve_gitfile(marker: &Path, parent: &Path) -> Result<PathBuf, String> {
    let pointer = read_git_pointer(marker)?;
    let target = pointer
        .strip_prefix("gitdir:")
        .ok_or_else(|| format!("Invalid git directory in {}", marker.display()))?;
    canonicalize_dir(&parent.join(target.trim()))
}

/// Drive/share roots are valid folders, but recursively watching one would
/// flood the debounce thread. Extra git-dir coverage must never include them.
fn is_volume_root(path: &Path) -> bool {
    !strip_verbatim(path.to_path_buf())
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
}

fn looks_like_git_dir(path: &Path) -> bool {
    if is_volume_root(path) {
        return false;
    }
    path.join("HEAD").is_file()
        && (path.join("objects").is_dir() || path.join("commondir").is_file())
}

fn extra_git_dirs(git_dir: PathBuf) -> Vec<PathBuf> {
    if is_volume_root(&git_dir) {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    if looks_like_git_dir(&git_dir) {
        dirs.push(git_dir.clone());
    }
    let common = git_dir.join("commondir");
    if !common.is_file() {
        return dirs;
    }
    let Ok(pointer) = read_git_pointer(&common) else {
        return dirs;
    };
    let Ok(common_dir) = canonicalize_dir(&git_dir.join(pointer)) else {
        return dirs;
    };
    if looks_like_git_dir(&common_dir) && !dirs.iter().any(|dir| paths_equal(dir, &common_dir)) {
        dirs.push(common_dir);
    }
    dirs
}

/// Best-effort git metadata folders for extra watches. A missing or invalid
/// pointer must not prevent watching the project folder itself.
fn git_directories(root: &Path) -> Vec<PathBuf> {
    for parent in root.ancestors() {
        let marker = parent.join(".git");
        if marker.is_dir() {
            return match canonicalize_dir(&marker) {
                Ok(path) => extra_git_dirs(path),
                Err(_) => Vec::new(),
            };
        }
        if marker.is_file() {
            return match resolve_gitfile(&marker, parent) {
                Ok(path) => extra_git_dirs(path),
                Err(_) => Vec::new(),
            };
        }
    }
    Vec::new()
}

/// Start watching a project folder. Already-watched roots are a no-op.
#[tauri::command]
pub async fn workspace_watch(manager: State<'_, WatchManager>, root: String) -> Result<(), String> {
    let manager = WatchManager::clone(&manager);
    crate::blocking::run(move || {
        let canon = crate::roots::require(&root)?;
        manager.watch(canon, root)
    })
    .await
}

/// Stop watching a project folder. A missing root is a no-op.
#[tauri::command]
pub async fn workspace_unwatch(
    manager: State<'_, WatchManager>,
    root: String,
) -> Result<(), String> {
    let manager = WatchManager::clone(&manager);
    crate::blocking::run(move || {
        let canon = canonicalize_dir(Path::new(&root)).ok();
        manager.unwatch(root, canon)
    })
    .await
}

fn on_debounced(inner: &Inner, result: DebounceEventResult) {
    let watched = match inner.roots.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };
    let roots: Vec<_> = watched
        .iter()
        .map(|(path, info)| (path.clone(), info.original.clone()))
        .collect();
    let git_dirs: Vec<_> = watched
        .values()
        .flat_map(|info| {
            info.git_dirs
                .iter()
                .map(|path| (path.clone(), info.original.clone()))
        })
        .collect();
    if roots.is_empty() {
        return;
    }
    let payloads = match result {
        Ok(events) => changes_from_paths(
            &roots,
            &git_dirs,
            events.into_iter().map(|event| event.path),
        ),
        Err(err) => changes_from_error(&roots, &git_dirs, &err),
    };
    for payload in payloads {
        let _ = inner.app.emit("workspace:changed", payload);
    }
}

fn find_watched(
    roots: &HashMap<PathBuf, WatchedRoot>,
    original: &str,
    canon: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(canon) = canon {
        if roots.contains_key(canon) {
            return Some(canon.to_path_buf());
        }
    }
    if let Some((key, _)) = roots.iter().find(|(_, value)| value.original == original) {
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

fn changes_from_error(
    roots: &[(PathBuf, String)],
    git_dirs: &[(PathBuf, String)],
    err: &notify::Error,
) -> Vec<WorkspaceChanged> {
    let mut hit: HashSet<String> = HashSet::new();
    for path in &err.paths {
        for (canon, original) in roots.iter().chain(git_dirs) {
            if path_is_inside(path, canon) {
                hit.insert(original.clone());
            }
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
    git_dirs: &[(PathBuf, String)],
    paths: impl IntoIterator<Item = PathBuf>,
) -> Vec<WorkspaceChanged> {
    let mut grouped: HashMap<String, (HashSet<String>, bool)> = HashMap::new();
    for path in paths {
        for (canon, original) in roots {
            let Some((rel, git_meta)) = classify_event(canon, &path) else {
                continue;
            };
            let entry = grouped.entry(original.clone()).or_default();
            entry.1 = true;
            if !git_meta && !rel.is_empty() {
                entry.0.insert(rel);
            }
        }
        for (git_dir, original) in git_dirs {
            let Some(rel) = strip_prefix_path(&strip_verbatim(path.clone()), git_dir) else {
                continue;
            };
            let parts: Vec<_> = rel
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect();
            if is_git_metadata(&parts) {
                grouped.entry(original.clone()).or_default().1 = true;
            }
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
            return is_git_metadata(rest).then(|| (String::new(), true));
        }
        if skipped_component(part) {
            return None;
        }
    }

    Some((to_posix(rel), false))
}

fn is_git_meta_file(name: &str) -> bool {
    [
        "HEAD",
        "index",
        "packed-refs",
        "config",
        "config.worktree",
        "commondir",
    ]
    .iter()
    .any(|meta| name_eq(name, meta))
}

fn is_git_metadata(parts: &[String]) -> bool {
    match parts {
        [] => true,
        [name] if is_git_meta_file(name) => true,
        [first, rest @ ..] if name_eq(first, "refs") => {
            !rest.iter().any(|name| name.ends_with(".lock"))
        }
        _ => false,
    }
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

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            use std::time::{SystemTime, UNIX_EPOCH};
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("keel-watch-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(canonicalize_dir(&path).unwrap())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seed_git_dir(path: &Path) {
        std::fs::create_dir_all(path.join("objects")).unwrap();
        std::fs::write(path.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn seed_worktree_git(path: &Path, commondir: &str) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(path.join("commondir"), commondir).unwrap();
    }

    fn volume_root_of(path: &Path) -> PathBuf {
        path.ancestors()
            .last()
            .expect("canonical paths have a root")
            .to_path_buf()
    }

    fn write_gitfile(worktree: &Path, git_dir: &Path) {
        std::fs::create_dir_all(worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();
    }

    #[test]
    fn resolves_relative_gitfile_and_common_directory_from_subprojects() {
        let scratch = Scratch::new();
        let common = scratch.0.join("repo/.git");
        let git_dir = common.join("worktrees/branch");
        let worktree = scratch.0.join("worktree");
        seed_git_dir(&common);
        seed_worktree_git(&git_dir, "../..\n");
        std::fs::create_dir_all(worktree.join("src")).unwrap();
        std::fs::write(
            worktree.join(".git"),
            "gitdir: ../repo/.git/worktrees/branch\n",
        )
        .unwrap();
        assert_eq!(
            git_directories(&worktree.join("src")),
            vec![
                canonicalize_dir(&git_dir).unwrap(),
                canonicalize_dir(&common).unwrap()
            ]
        );
    }

    #[test]
    fn finds_an_ordinary_git_directory() {
        let scratch = Scratch::new();
        seed_git_dir(&scratch.0.join(".git"));
        assert_eq!(
            git_directories(&scratch.0),
            vec![canonicalize_dir(&scratch.0.join(".git")).unwrap()]
        );
    }

    #[test]
    fn invalid_gitfile_does_not_surface_as_an_error() {
        let scratch = Scratch::new();
        std::fs::write(scratch.0.join(".git"), "not a git directory\n").unwrap();
        assert!(git_directories(&scratch.0).is_empty());
    }

    #[test]
    fn missing_gitdir_target_does_not_surface_as_an_error() {
        let scratch = Scratch::new();
        std::fs::write(scratch.0.join(".git"), "gitdir: ../does-not-exist\n").unwrap();
        assert!(git_directories(&scratch.0).is_empty());
    }

    #[test]
    fn a_broken_gitfile_does_not_inherit_an_ancestor_repository() {
        let scratch = Scratch::new();
        let repo = scratch.0.join("repo");
        let nested = repo.join("nested/src");
        std::fs::create_dir_all(&nested).unwrap();
        seed_git_dir(&repo.join(".git"));
        std::fs::write(repo.join("nested/.git"), "gitdir: missing\n").unwrap();
        assert!(git_directories(&nested).is_empty());
    }

    #[test]
    fn refuses_a_gitfile_that_points_at_a_volume_root() {
        let scratch = Scratch::new();
        let volume = volume_root_of(&scratch.0);
        write_gitfile(&scratch.0, &volume);
        assert!(git_directories(&scratch.0).is_empty());
    }

    #[test]
    fn refuses_a_gitfile_that_points_at_a_folder_without_git_metadata() {
        let scratch = Scratch::new();
        let decoy = scratch.0.join("decoy");
        std::fs::create_dir_all(&decoy).unwrap();
        std::fs::write(decoy.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        write_gitfile(&scratch.0, &decoy);
        assert!(git_directories(&scratch.0).is_empty());
    }

    #[test]
    fn extra_watches_a_gitfile_that_points_at_a_real_git_directory() {
        let scratch = Scratch::new();
        let git_dir = scratch.0.join("actual.git");
        seed_git_dir(&git_dir);
        let worktree = scratch.0.join("tree");
        write_gitfile(&worktree, &git_dir);
        assert_eq!(
            git_directories(&worktree),
            vec![canonicalize_dir(&git_dir).unwrap()]
        );
    }

    #[test]
    fn ignores_a_commondir_pointer_to_a_volume_root() {
        let scratch = Scratch::new();
        let git_dir = scratch.0.join("worktrees/branch");
        seed_worktree_git(
            &git_dir,
            &format!("{}\n", volume_root_of(&scratch.0).display()),
        );
        let worktree = scratch.0.join("tree");
        write_gitfile(&worktree, &git_dir);
        assert_eq!(
            git_directories(&worktree),
            vec![canonicalize_dir(&git_dir).unwrap()]
        );
    }

    #[test]
    fn volume_roots_have_no_normal_path_components() {
        let scratch = Scratch::new();
        let volume = volume_root_of(&scratch.0);
        assert!(is_volume_root(&volume));
        assert!(!is_volume_root(&volume.join("proj")));
        assert!(!is_volume_root(&scratch.0));
    }

    #[test]
    fn watch_paths_omits_a_volume_root_git_dir() {
        let parent = sample_root();
        let volume = volume_root_of(&parent);
        let roots = HashMap::from([(
            parent.clone(),
            WatchedRoot {
                original: "proj".into(),
                git_dirs: vec![volume.clone()],
            },
        )]);
        assert_eq!(
            watch_paths(&roots).into_iter().collect::<HashSet<_>>(),
            HashSet::from([parent])
        );
    }

    #[test]
    fn shares_external_git_directories_and_skips_local_metadata_watches() {
        let parent = sample_root();
        let roots = HashMap::from([
            (
                parent.clone(),
                WatchedRoot {
                    original: "parent".into(),
                    git_dirs: vec![parent.join(".git")],
                },
            ),
            (
                parent.join("src"),
                WatchedRoot {
                    original: "nested".into(),
                    git_dirs: vec![parent.join(".git")],
                },
            ),
        ]);
        assert_eq!(
            watch_paths(&roots).into_iter().collect::<HashSet<_>>(),
            HashSet::from([parent.clone(), parent.join("src"), parent.join(".git")])
        );
    }

    #[test]
    fn routes_external_index_and_shared_refs_to_their_worktrees() {
        let base = sample_root();
        let common = base.join("repo/.git");
        let index_a = common.join("worktrees/a");
        let index_b = common.join("worktrees/b");
        let roots = vec![(base.join("a"), "a".into()), (base.join("b"), "b".into())];
        let git_dirs = vec![
            (index_a.clone(), "a".into()),
            (index_b, "b".into()),
            (common.clone(), "a".into()),
            (common.clone(), "b".into()),
        ];
        assert_eq!(
            changes_from_paths(&roots, &git_dirs, [index_a.join("index")]),
            vec![WorkspaceChanged {
                root: "a".into(),
                rels: vec![],
                git: true
            }]
        );
        let mut changes =
            changes_from_paths(&roots, &git_dirs, [common.join("refs/remotes/origin/main")]);
        changes.sort_by(|a, b| a.root.cmp(&b.root));
        assert_eq!(
            changes,
            vec![
                WorkspaceChanged {
                    root: "a".into(),
                    rels: vec![],
                    git: true
                },
                WorkspaceChanged {
                    root: "b".into(),
                    rels: vec![],
                    git: true
                },
            ]
        );
        assert!(changes_from_paths(
            &roots,
            &git_dirs,
            [
                common.join("refs/heads/main.lock"),
                common.join("objects/ab/cd")
            ]
        )
        .is_empty());
    }

    #[test]
    fn overflow_refreshes_parent_and_nested_projects() {
        let base = sample_root();
        let roots = vec![
            (base.clone(), "parent".into()),
            (base.join("nested"), "nested".into()),
        ];
        let error = notify::Error::generic("overflow").add_path(base.join("nested/file.ts"));
        let mut changes = changes_from_error(&roots, &[], &error);
        changes.sort_by(|a, b| a.root.cmp(&b.root));
        assert_eq!(
            changes,
            vec![full_refresh("nested"), full_refresh("parent")]
        );
    }

    #[test]
    fn native_watcher_observes_external_worktree_staging() {
        fn git(root: &Path, args: &[&str]) {
            let mut cmd = std::process::Command::new("git");
            cmd.current_dir(root)
                .args([
                    "-c",
                    "user.name=Review",
                    "-c",
                    "user.email=review@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let output = cmd.output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let scratch = Scratch::new();
        let repo = scratch.0.join("repo");
        let worktree = scratch.0.join("branch");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "--template="]);
        std::fs::write(repo.join("a.txt"), "initial\n").unwrap();
        git(&repo, &["add", "a.txt"]);
        git(&repo, &["commit", "-m", "initial"]);
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "review-branch",
                worktree.to_str().unwrap(),
            ],
        );
        std::fs::write(worktree.join("a.txt"), "modified\n").unwrap();
        let metadata = git_directories(&worktree);
        let watched = HashMap::from([(
            worktree.clone(),
            WatchedRoot {
                original: "branch".into(),
                git_dirs: metadata.clone(),
            },
        )]);
        let (send, receive) = std::sync::mpsc::channel();
        let mut watcher = new_debouncer(Duration::from_millis(50), send).unwrap();
        for path in watch_paths(&watched) {
            watcher
                .watcher()
                .watch(&path, RecursiveMode::Recursive)
                .unwrap();
        }
        git(&worktree, &["add", "a.txt"]);
        let roots = vec![(worktree, "branch".into())];
        let git_dirs: Vec<_> = metadata
            .into_iter()
            .map(|path| (path, "branch".into()))
            .collect();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let events = receive
                .recv_timeout(remaining)
                .expect("staging must reach the native watcher")
                .unwrap();
            let changes = changes_from_paths(
                &roots,
                &git_dirs,
                events.into_iter().map(|event| event.path),
            );
            if changes
                .iter()
                .any(|change| change.root == "branch" && change.git && change.rels.is_empty())
            {
                break;
            }
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
            Some((String::new(), true))
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
    fn notifies_every_containing_project() {
        let parent = sample_root();
        let nested = parent.join("nested");
        let roots = vec![
            (parent.clone(), "orig-parent".into()),
            (nested.clone(), "orig-nested".into()),
        ];
        let mut changes = changes_from_paths(
            &roots,
            &[],
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
                    rels: vec!["nested/a.ts".into(), "src/b.ts".into()],
                    git: true,
                },
            ]
        );
    }

    #[test]
    fn git_metadata_alone_asks_for_a_git_refresh() {
        let root = sample_root();
        let roots = vec![(root.clone(), "orig".into())];
        let changes = changes_from_paths(&roots, &[], vec![root.join(".git").join("index")]);
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
        assert_eq!(
            changes_from_error(&roots, &[], &err),
            vec![full_refresh("orig")]
        );
        let unknown = notify::Error::generic("watcher failed");
        assert_eq!(
            changes_from_error(&roots, &[], &unknown),
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
