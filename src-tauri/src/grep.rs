//! Project-wide content search: where this text appears, not what the file is called.
//!
//! Filename search already lives in `workspace.rs`. This walks the same jail —
//! never following a `..` out of the folder Keel opened — and returns line hits
//! the inspector can jump to. The walk honours gitignore and skips the usual
//! build noise (`node_modules`, `target`, …) so a huge repo cannot flood the UI.

use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use regex::{Regex, RegexBuilder};
use serde::Serialize;

use crate::paths::{canonicalize_dir, is_skipped_dir, normalize_rel, strip_verbatim, to_posix};

const MAX_HITS: usize = 500;
const MAX_FILE: u64 = 1_000_000;
const BINARY_HEAD: usize = 8 * 1024;
const PREVIEW_CHARS: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub rel: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResults {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn preview(line: &str) -> String {
    let mut text = String::new();
    for (count, ch) in line.chars().enumerate() {
        if count >= PREVIEW_CHARS {
            break;
        }
        text.push(ch);
    }
    text
}

/// Relative posix path of `path` if it still sits under `root` after
/// canonicalize. Anything that resolved to `..` or another drive is dropped.
fn rel_inside(root: &Path, path: &Path) -> Option<String> {
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

fn compile_pattern(query: &str, case_sensitive: bool, is_regex: bool) -> Result<Regex, String> {
    let pattern = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .multi_line(false)
        .build()
        .map_err(|_| "That is not a valid search pattern.".into())
}

/// Search one file. Returns true when this file had matches we did not record
/// because the hit cap was already full.
fn grep_file(path: &Path, rel: &str, re: &Regex, hits: &mut Vec<GrepHit>) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > MAX_FILE {
        return false;
    }
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut head = [0u8; BINARY_HEAD];
    let n = match file.read(&mut head) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if looks_binary(&head[..n]) {
        return false;
    }
    let mut bytes = head[..n].to_vec();
    if (n as u64) < meta.len() && file.read_to_end(&mut bytes).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    for (index, line) in text.lines().enumerate() {
        let Some(m) = re.find(line) else {
            continue;
        };
        if hits.len() >= MAX_HITS {
            return true;
        }
        let column = line[..m.start()].chars().count() as u32 + 1;
        hits.push(GrepHit {
            rel: rel.to_string(),
            line: (index + 1) as u32,
            column,
            text: preview(line),
        });
    }
    false
}

#[tauri::command]
pub async fn workspace_grep(
    root: String,
    query: String,
    case_sensitive: bool,
    is_regex: bool,
) -> Result<GrepResults, String> {
    crate::blocking::run(move || workspace_grep_blocking(root, query, case_sensitive, is_regex))
        .await
}

fn workspace_grep_blocking(
    root: String,
    query: String,
    case_sensitive: bool,
    is_regex: bool,
) -> Result<GrepResults, String> {
    let needle = query.trim();
    if needle.len() < 2 {
        return Ok(GrepResults {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let re = compile_pattern(needle, case_sensitive, is_regex)?;
    let root_path = canonicalize_dir(Path::new(&root))?;
    let walker = ignore::WalkBuilder::new(&root_path)
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
    let mut truncated = false;
    for result in walker {
        if hits.len() >= MAX_HITS {
            truncated = true;
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
        let Some(rel) = rel_inside(&root_path, path) else {
            continue;
        };
        if grep_file(path, &rel, &re, &mut hits) {
            truncated = true;
            break;
        }
    }
    Ok(GrepResults { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn repo_root() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crate is inside the repo")
            .to_path_buf()
    }

    fn grep(
        root: &std::path::Path,
        query: &str,
        case_sensitive: bool,
        is_regex: bool,
    ) -> Result<GrepResults, String> {
        tauri::async_runtime::block_on(workspace_grep(
            root.to_string_lossy().into_owned(),
            query.into(),
            case_sensitive,
            is_regex,
        ))
    }

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir()
                .join(format!("keel-grep-{label}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&dir).expect("temp project");
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn workspace_grep_finds_a_known_string() {
        let root = repo_root();
        let results = grep(&root, r#""name": "keel""#, true, false).expect("grep package.json");
        let hit = results
            .hits
            .iter()
            .find(|hit| hit.rel == "package.json")
            .expect("package.json hit");
        assert_eq!(hit.line, 2);
        assert!(
            hit.text.contains(r#""name": "keel""#),
            "preview: {:?}",
            hit.text
        );
        assert!(hit.column >= 1);
        assert!(
            results
                .hits
                .iter()
                .all(|hit| !hit.rel.contains("..") && !hit.rel.starts_with('/')),
            "relative paths only: {:?}",
            results.hits
        );
    }

    #[test]
    fn workspace_grep_rejects_paths_outside_the_root() {
        let token = "keel-grep-probe-7f3a9c";
        let dir = Scratch::new("jail");
        let project = dir.0.join("project");
        fs::create_dir_all(project.join("node_modules")).unwrap();
        fs::create_dir_all(project.join("target")).unwrap();
        fs::write(project.join("inside.txt"), format!("{token} inside")).unwrap();
        fs::write(
            project.join("node_modules").join("secret.txt"),
            format!("{token} secret"),
        )
        .unwrap();
        fs::write(
            project.join("target").join("secret.txt"),
            format!("{token} secret"),
        )
        .unwrap();
        fs::write(dir.0.join("outside.txt"), format!("{token} outside")).unwrap();

        let results = grep(&project, token, true, false).expect("grep jail");
        assert_eq!(
            results
                .hits
                .iter()
                .map(|hit| hit.rel.as_str())
                .collect::<Vec<_>>(),
            vec!["inside.txt"]
        );
        assert!(results.hits.iter().all(|hit| !hit.rel.contains("..")));
    }

    #[test]
    fn workspace_grep_empty_query_returns_no_hits() {
        let root = repo_root();
        for query in ["", " ", "k"] {
            let results = grep(&root, query, false, false).expect("short query");
            assert!(
                results.hits.is_empty() && !results.truncated,
                "query {query:?}: {:?}",
                results.hits
            );
        }
    }

    #[test]
    fn workspace_grep_invalid_regex_returns_err() {
        let root = repo_root();
        let err = grep(&root, "[unterminated", false, true).expect_err("invalid regex");
        assert!(
            err.to_lowercase().contains("not a valid search pattern"),
            "{err}"
        );
    }
}
