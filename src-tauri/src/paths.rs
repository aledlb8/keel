//! Resolve project-relative paths and keep them inside the folder Keel opened.

use std::path::{Component, Path, PathBuf};

fn name_is_git(name: &std::ffi::OsStr) -> bool {
    #[cfg(windows)]
    {
        name.eq_ignore_ascii_case(".git")
    }
    #[cfg(not(windows))]
    {
        name == std::ffi::OsStr::new(".git")
    }
}

/// True when any component is `.git`. Windows compares ASCII-case-insensitively.
pub fn has_git_component(rel: &Path) -> bool {
    rel.components().any(|component| match component {
        Component::Normal(name) => name_is_git(name),
        _ => false,
    })
}

/// The `.git` folder cannot be changed from here.
pub fn rejects_git_component(rel: &Path) -> Result<(), String> {
    if has_git_component(rel) {
        Err("The .git folder cannot be changed from here.".into())
    } else {
        Ok(())
    }
}

/// The `.git` folder cannot be opened from here.
pub fn rejects_git_open(rel: &Path) -> Result<(), String> {
    if has_git_component(rel) {
        Err("The .git folder cannot be opened from here.".into())
    } else {
        Ok(())
    }
}

/// Folders that are noise in a project tree. `.git` is always skipped, even
/// when hidden files are on — it is not a place you edit.
pub fn is_skipped_dir(name: &str, show_hidden: bool) -> bool {
    if name_is_git(std::ffi::OsStr::new(name)) {
        return true;
    }
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".nuxt"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".turbo"
            | "coverage"
            | ".cache"
            | ".pnpm-store"
            | ".idea"
            | ".vscode"
    ) || (!show_hidden && name.starts_with('.'))
}

/// Drop `..`, reject absolute paths, and return a relative path of only
/// normal components. Empty means the project root.
pub fn normalize_rel(rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "./" {
        return Ok(PathBuf::new());
    }
    let mut out = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err("That path sits outside the project.".into());
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Use a path inside the project.".into());
            }
        }
    }
    Ok(out)
}

/// Relative path as `/`-separated, for the frontend.
pub fn to_posix(rel: &Path) -> String {
    rel.iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// `\\?\C:\...` and `\\?\UNC\...` prefixes break `starts_with` against a
/// normal path. Strip them after canonicalize.
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path
}

pub fn canonicalize_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    std::fs::canonicalize(path)
        .map(strip_verbatim)
        .map_err(|err| format!("Could not open {}: {err}", path.display()))
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
    if candidate == root {
        return true;
    }
    candidate.starts_with(root)
}

/// Existing path, canonicalized and confirmed to sit under `root`.
pub fn resolve_existing(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = canonicalize_dir(root)?;
    let rel = normalize_rel(rel)?;
    let joined = if rel.as_os_str().is_empty() {
        root.clone()
    } else {
        root.join(&rel)
    };
    if !joined.exists() {
        return Err(format!("{} does not exist", joined.display()));
    }
    let canon = std::fs::canonicalize(&joined)
        .map(strip_verbatim)
        .map_err(|err| format!("Could not open {}: {err}", joined.display()))?;
    if !is_inside(&root, &canon) {
        return Err("That path sits outside the project.".into());
    }
    Ok(canon)
}

/// Path that may not exist yet (create / rename target). The parent must exist
/// and stay inside the project.
pub fn resolve_target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = canonicalize_dir(root)?;
    let rel = normalize_rel(rel)?;
    if rel.as_os_str().is_empty() {
        return Err("The project folder itself cannot be the target.".into());
    }
    let joined = root.join(&rel);
    if joined.exists() {
        let canon = std::fs::canonicalize(&joined)
            .map(strip_verbatim)
            .map_err(|err| err.to_string())?;
        if !is_inside(&root, &canon) {
            return Err("That path sits outside the project.".into());
        }
        return Ok(canon);
    }
    let parent = joined
        .parent()
        .ok_or_else(|| "That path sits outside the project.".to_string())?;
    if parent.exists() {
        let canon_parent = std::fs::canonicalize(parent)
            .map(strip_verbatim)
            .map_err(|err| err.to_string())?;
        if !is_inside(&root, &canon_parent) {
            return Err("That path sits outside the project.".into());
        }
        let name = joined
            .file_name()
            .ok_or_else(|| "That path sits outside the project.".to_string())?;
        return Ok(canon_parent.join(name));
    }
    Err(format!("{} does not exist", parent.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_drops_dots_and_rejects_escape() {
        assert_eq!(
            normalize_rel("src/../src/lib").unwrap(),
            PathBuf::from("src/lib")
        );
        assert!(normalize_rel("../secret").is_err());
        assert!(normalize_rel("/etc/passwd").is_err());
        assert!(normalize_rel("").unwrap().as_os_str().is_empty());
    }

    #[test]
    fn posix_joins_with_slashes() {
        let path = PathBuf::from("src").join("lib").join("git.ts");
        assert_eq!(to_posix(&path), "src/lib/git.ts");
    }

    #[test]
    fn rejects_git_paths() {
        assert!(rejects_git_component(Path::new(".git")).is_err());
        assert!(rejects_git_component(Path::new(".git/hooks/pre-commit")).is_err());
        assert!(rejects_git_open(Path::new("src/.git/HEAD")).is_err());
        assert!(rejects_git_component(Path::new("src/lib.rs")).is_ok());
        assert!(rejects_git_component(Path::new("file.git")).is_ok());
        #[cfg(windows)]
        {
            assert!(rejects_git_component(Path::new(".GIT/hooks/x")).is_err());
            assert!(rejects_git_open(Path::new("src/.Git/config")).is_err());
        }
    }
}
