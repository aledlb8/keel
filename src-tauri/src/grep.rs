//! Project-wide content search and replace: where this text appears, not what
//! the file is called.
//!
//! Filename search already lives in `workspace.rs`. This walks the same jail —
//! never following a `..` out of the folder Keel opened — and returns line hits
//! the inspector can jump to, with every match on the line marked so it can be
//! highlighted. The walk honours gitignore and skips the usual build noise
//! (`node_modules`, `target`, …) unless asked to look everywhere, and runs on
//! every core. A newer search stops an older one that is still walking.
//!
//! Replace re-runs the same pattern over the files (or the lines) the panel
//! still shows, so what is written is exactly what was previewed.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use ignore::overrides::{Override, OverrideBuilder};
use ignore::WalkState;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::paths::{
    is_skipped_dir, normalize_rel, rejects_git_component, resolve_existing, strip_verbatim,
    to_posix,
};

const MAX_HITS: usize = 2000;
const MAX_FILE: u64 = 1_000_000;
const BINARY_HEAD: usize = 8 * 1024;
/// How much of a long line a hit shows, in characters.
const PREVIEW_CHARS: usize = 240;
/// Characters kept ahead of the first match when a long line is cut.
const PREVIEW_LEAD: usize = 40;

/// The newest search in each project. A walk that sees a different number
/// there has been replaced by a newer one and stops.
fn latest(root: &str) -> Arc<AtomicU64> {
    static LATEST: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
    let map = LATEST.get_or_init(Default::default);
    let mut map = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(root.to_string()).or_default().clone()
}

/// Claim the newest search in a project, superseding any still running.
fn begin_search(root: &str) -> (Arc<AtomicU64>, u64) {
    let slot = latest(root);
    let id = slot.fetch_add(1, Ordering::SeqCst) + 1;
    (slot, id)
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GrepOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    /// Comma-separated globs; when any are given, only matching files count.
    pub include: String,
    /// Comma-separated globs to leave out.
    pub exclude: String,
    /// Look in hidden, gitignored and build folders too.
    pub include_ignored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub rel: String,
    pub line: u32,
    /// Where the first match starts, 1-based, in UTF-16 units like CodeMirror.
    pub column: u32,
    /// The first match's length, in UTF-16 units, so the editor can select it.
    pub length: u32,
    pub text: String,
    /// Every match, as `[start, end)` UTF-16 offsets into `text`.
    pub ranges: Vec<[u32; 2]>,
    /// What each match becomes, when a replacement was given.
    pub replacements: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResults {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_searched: u32,
    pub elapsed_ms: u64,
    /// A newer search took over before this one finished.
    pub cancelled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub rel: String,
    /// Only these lines; every line when absent.
    pub lines: Option<Vec<u32>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSummary {
    pub files: u32,
    pub replacements: u32,
    /// Files that could not be rewritten, with why.
    pub skipped: Vec<String>,
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
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

fn compile_pattern(query: &str, options: &GrepOptions) -> Result<Regex, String> {
    let mut pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if options.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .multi_line(false)
        .build()
        .map_err(|_| "That is not a valid search pattern.".into())
}

fn split_globs(list: &str) -> impl Iterator<Item = &str> {
    list.split(',')
        .map(str::trim)
        .filter(|glob| !glob.is_empty())
}

/// Include and exclude globs as gitignore-style overrides. A bare folder name
/// (`src`, `docs/`) means everything under it.
fn build_overrides(root: &Path, options: &GrepOptions) -> Result<Override, String> {
    let mut builder = OverrideBuilder::new(root);
    let widen = |glob: &str| -> Vec<String> {
        let glob = glob.trim_start_matches("./");
        if glob.ends_with('/') {
            vec![format!("{glob}**")]
        } else if !glob.contains(['*', '?', '[', '.']) {
            // No wildcard and no extension: a folder or a file, so allow both.
            vec![glob.to_string(), format!("{glob}/**")]
        } else {
            vec![glob.to_string()]
        }
    };
    for glob in split_globs(&options.include) {
        for pattern in widen(glob) {
            builder
                .add(&pattern)
                .map_err(|_| format!("\"{glob}\" is not a pattern Keel understands."))?;
        }
    }
    for glob in split_globs(&options.exclude) {
        for pattern in widen(glob) {
            builder
                .add(&format!("!{pattern}"))
                .map_err(|_| format!("\"{glob}\" is not a pattern Keel understands."))?;
        }
    }
    builder
        .build()
        .map_err(|err| format!("Could not use those file patterns: {err}"))
}

/// A long line, cut to a window that starts a little before its first match,
/// with leading indentation dropped. Returns the text and the byte offset in
/// `line` it starts at.
fn preview_window(line: &str, first_match: usize) -> (String, usize, bool) {
    let indent = line.len() - line.trim_start().len();
    let mut start = indent.min(first_match);
    let chars_before = line[start..first_match].chars().count();
    let mut cut = false;
    if chars_before > PREVIEW_LEAD {
        let skip = chars_before - PREVIEW_LEAD;
        start = line[start..]
            .char_indices()
            .nth(skip)
            .map_or(first_match, |(index, _)| start + index);
        cut = true;
    }
    let text: String = line[start..].chars().take(PREVIEW_CHARS).collect();
    (text, start, cut)
}

/// Search one file into `hits`. Returns false once the cap is full.
fn grep_file(
    path: &Path,
    rel: &str,
    re: &Regex,
    replace: Option<&str>,
    literal: bool,
    hits: &Mutex<Vec<GrepHit>>,
) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return true;
    };
    if !meta.is_file() || meta.len() > MAX_FILE {
        return true;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return true;
    };
    let mut head = [0u8; BINARY_HEAD];
    let Ok(n) = file.read(&mut head) else {
        return true;
    };
    if looks_binary(&head[..n]) {
        return true;
    }
    let mut bytes = head[..n].to_vec();
    if (n as u64) < meta.len() && file.read_to_end(&mut bytes).is_err() {
        return true;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut found = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let matches: Vec<regex::Captures> = re.captures_iter(line).collect();
        let Some(first) = matches.first().and_then(|caps| caps.get(0)) else {
            continue;
        };
        let (preview, offset, cut) = preview_window(line, first.start());
        let lead = if cut { "…" } else { "" };
        let shown = utf16_len(lead);
        let preview_end = offset + preview.len();
        let mut ranges = Vec::new();
        let mut replacements = replace.map(|_| Vec::new());
        for caps in &matches {
            let Some(m) = caps.get(0) else { continue };
            if m.start() >= preview_end {
                break;
            }
            let start = shown + utf16_len(&line[offset..m.start()]);
            let end = shown + utf16_len(&line[offset..m.end().min(preview_end)]);
            ranges.push([start, end.max(start)]);
            if let (Some(list), Some(with)) = (replacements.as_mut(), replace) {
                let mut expanded = String::new();
                if literal {
                    expanded.push_str(with);
                } else {
                    caps.expand(with, &mut expanded);
                }
                list.push(expanded);
            }
        }
        found.push(GrepHit {
            rel: rel.to_string(),
            line: (index + 1) as u32,
            column: utf16_len(&line[..first.start()]) + 1,
            length: utf16_len(first.as_str()),
            text: format!("{lead}{preview}"),
            ranges,
            replacements,
        });
    }
    if found.is_empty() {
        return true;
    }
    let Ok(mut all) = hits.lock() else {
        return false;
    };
    let room = MAX_HITS.saturating_sub(all.len());
    let full = found.len() > room;
    all.extend(found.into_iter().take(room));
    !full && all.len() < MAX_HITS
}

fn walker(root: &Path, options: &GrepOptions) -> Result<ignore::WalkParallel, String> {
    let overrides = build_overrides(root, options)?;
    let respect = !options.include_ignored;
    let everywhere = options.include_ignored;
    Ok(ignore::WalkBuilder::new(root)
        .hidden(respect)
        .ignore(respect)
        .parents(respect)
        .git_ignore(respect)
        .git_global(respect)
        .git_exclude(respect)
        .follow_links(false)
        .overrides(overrides)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if !is_dir {
                return true;
            }
            // `.git` is never searched; build folders only when asked.
            if name == ".git" {
                return false;
            }
            everywhere || !is_skipped_dir(&name, false)
        })
        .build_parallel())
}

#[tauri::command]
pub async fn workspace_grep(
    root: String,
    query: String,
    options: Option<GrepOptions>,
    replace: Option<String>,
) -> Result<GrepResults, String> {
    let options = options.unwrap_or_default();
    // Claimed before the blocking hop, so a search typed later always wins.
    let (slot, id) = begin_search(&root);
    crate::blocking::run(move || workspace_grep_blocking((slot, id), root, query, options, replace))
        .await
}

fn workspace_grep_blocking(
    (slot, id): (Arc<AtomicU64>, u64),
    root: String,
    query: String,
    options: GrepOptions,
    replace: Option<String>,
) -> Result<GrepResults, String> {
    let started = Instant::now();
    let empty = |cancelled| GrepResults {
        hits: Vec::new(),
        truncated: false,
        files_searched: 0,
        elapsed_ms: 0,
        cancelled,
    };
    if query.trim().chars().count() < 2 {
        return Ok(empty(false));
    }
    let re = compile_pattern(&query, &options)?;
    let root_path = crate::roots::require(&root)?;
    let walk = walker(&root_path, &options)?;

    let hits = Mutex::new(Vec::new());
    let searched = AtomicU64::new(0);
    let truncated = AtomicBool::new(false);
    let replace = replace.as_deref();
    let literal = !options.regex;
    walk.run(|| {
        let root = &root_path;
        let re = &re;
        let hits = &hits;
        let searched = &searched;
        let truncated = &truncated;
        let slot = &slot;
        Box::new(move |result| {
            if slot.load(Ordering::Relaxed) != id {
                return WalkState::Quit;
            }
            let Ok(entry) = result else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let Some(rel) = rel_inside(root, path) else {
                return WalkState::Continue;
            };
            searched.fetch_add(1, Ordering::Relaxed);
            if grep_file(path, &rel, re, replace, literal, hits) {
                WalkState::Continue
            } else {
                truncated.store(true, Ordering::Relaxed);
                WalkState::Quit
            }
        })
    });

    if slot.load(Ordering::Relaxed) != id {
        return Ok(empty(true));
    }
    let mut hits = hits
        .into_inner()
        .map_err(|_| "Search failed.".to_string())?;
    // The walk runs on every core, so put the files back in a stable order.
    hits.sort_by(|a, b| a.rel.cmp(&b.rel).then(a.line.cmp(&b.line)));
    Ok(GrepResults {
        hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_searched: searched.load(Ordering::Relaxed) as u32,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled: false,
    })
}

// ---- Replace ------------------------------------------------------------------

#[tauri::command]
pub async fn workspace_replace(
    root: String,
    query: String,
    options: Option<GrepOptions>,
    replacement: String,
    targets: Vec<ReplaceTarget>,
) -> Result<ReplaceSummary, String> {
    let options = options.unwrap_or_default();
    crate::blocking::run(move || {
        workspace_replace_blocking(root, query, options, replacement, targets)
    })
    .await
}

fn workspace_replace_blocking(
    root: String,
    query: String,
    options: GrepOptions,
    replacement: String,
    targets: Vec<ReplaceTarget>,
) -> Result<ReplaceSummary, String> {
    if query.trim().chars().count() < 2 {
        return Err("Search for something first.".into());
    }
    let re = compile_pattern(&query, &options)?;
    let root = crate::roots::require(&root)?;
    let mut summary = ReplaceSummary {
        files: 0,
        replacements: 0,
        skipped: Vec::new(),
    };
    for target in targets {
        match replace_in_file(&root, &target, &re, &replacement, !options.regex) {
            Ok(0) => {}
            Ok(count) => {
                summary.files += 1;
                summary.replacements += count;
            }
            Err(why) => summary.skipped.push(format!("{}: {why}", target.rel)),
        }
    }
    Ok(summary)
}

/// Replace inside one file, line by line, leaving line endings exactly as
/// they were. Returns how many matches were replaced.
fn replace_in_file(
    root: &Path,
    target: &ReplaceTarget,
    re: &Regex,
    replacement: &str,
    literal: bool,
) -> Result<u32, String> {
    rejects_git_component(&normalize_rel(&target.rel)?)?;
    let path = resolve_existing(root, &target.rel)?;
    let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err("too large to rewrite".into());
    }
    let bytes = fs::read(&path).map_err(|err| err.to_string())?;
    if looks_binary(&bytes) {
        return Err("binary".into());
    }
    // Rewriting lossy text would corrupt the bytes it could not read.
    let text = String::from_utf8(bytes).map_err(|_| "not UTF-8 text".to_string())?;
    let wanted = target.lines.as_ref();
    let mut count = 0u32;
    let mut out = String::with_capacity(text.len());
    for (index, chunk) in text.split_inclusive('\n').enumerate() {
        let line_no = (index + 1) as u32;
        let body_end = chunk
            .strip_suffix("\r\n")
            .or_else(|| chunk.strip_suffix('\n'))
            .map_or(chunk.len(), str::len);
        let (body, ending) = chunk.split_at(body_end);
        if wanted.is_some_and(|lines| !lines.contains(&line_no)) {
            out.push_str(chunk);
            continue;
        }
        let found = re.find_iter(body).count() as u32;
        if found == 0 {
            out.push_str(chunk);
            continue;
        }
        count += found;
        if literal {
            out.push_str(&re.replace_all(body, regex::NoExpand(replacement)));
        } else {
            out.push_str(&re.replace_all(body, replacement));
        }
        out.push_str(ending);
    }
    if count > 0 {
        crate::workspace::write_atomic(&path, &out)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn repo_root() -> std::path::PathBuf {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crate is inside the repo")
            .to_path_buf();
        crate::roots::register(&root).expect("test project root");
        root
    }

    fn grep_with(
        root: &std::path::Path,
        query: &str,
        options: GrepOptions,
        replace: Option<&str>,
    ) -> Result<GrepResults, String> {
        crate::roots::register(root).expect("test project root");
        let root = root.to_string_lossy().into_owned();
        // Tests share the repo root and run at once; each takes its own slot so
        // one can't supersede another the way a newer keystroke would.
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let slot = format!("{root}#test{}", NEXT.fetch_add(1, Ordering::SeqCst));
        workspace_grep_blocking(
            begin_search(&slot),
            root,
            query.into(),
            options,
            replace.map(str::to_string),
        )
    }

    fn grep(
        root: &std::path::Path,
        query: &str,
        case_sensitive: bool,
        is_regex: bool,
    ) -> Result<GrepResults, String> {
        grep_with(
            root,
            query,
            GrepOptions {
                case_sensitive,
                regex: is_regex,
                ..GrepOptions::default()
            },
            None,
        )
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
    fn columns_use_codemirror_utf16_offsets() {
        let dir = Scratch::new("unicode");
        fs::write(dir.0.join("unicode.txt"), "😀needle\n日本語needle\n").unwrap();
        let results = grep(&dir.0, "needle", true, false).unwrap();
        assert_eq!(results.hits.len(), 2);
        assert_eq!(results.hits[0].column, 3);
        assert_eq!(results.hits[1].column, 4);
        // The preview is UTF-16 indexed too: the emoji is two units.
        assert_eq!(results.hits[0].ranges, vec![[2, 8]]);
        assert_eq!(results.hits[0].length, 6);
    }

    #[test]
    fn marks_every_match_and_trims_indentation() {
        let dir = Scratch::new("ranges");
        fs::write(dir.0.join("a.ts"), "    foo(foo);\n").unwrap();
        let results = grep(&dir.0, "foo", true, false).unwrap();
        let hit = &results.hits[0];
        assert_eq!(hit.text, "foo(foo);");
        assert_eq!(hit.ranges, vec![[0, 3], [4, 7]]);
        assert_eq!(hit.column, 5);
    }

    #[test]
    fn long_lines_are_cut_before_the_match() {
        let dir = Scratch::new("long");
        let line = format!("{}needle{}", "x".repeat(300), "y".repeat(300));
        fs::write(dir.0.join("long.txt"), &line).unwrap();
        let hit = &grep(&dir.0, "needle", true, false).unwrap().hits[0];
        assert!(hit.text.starts_with('…'));
        let [start, end] = hit.ranges[0];
        let units: Vec<u16> = hit.text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[start as usize..end as usize]).unwrap(),
            "needle"
        );
    }

    #[test]
    fn whole_word_skips_matches_inside_words() {
        let dir = Scratch::new("word");
        fs::write(dir.0.join("w.txt"), "cat\nconcatenate\n").unwrap();
        let options = GrepOptions {
            whole_word: true,
            ..GrepOptions::default()
        };
        let results = grep_with(&dir.0, "cat", options, None).unwrap();
        assert_eq!(results.hits.len(), 1);
        assert_eq!(results.hits[0].line, 1);
    }

    #[test]
    fn include_and_exclude_narrow_the_files() {
        let dir = Scratch::new("globs");
        fs::create_dir_all(dir.0.join("src")).unwrap();
        fs::create_dir_all(dir.0.join("docs")).unwrap();
        fs::write(dir.0.join("src").join("a.ts"), "token").unwrap();
        fs::write(dir.0.join("src").join("b.md"), "token").unwrap();
        fs::write(dir.0.join("docs").join("c.ts"), "token").unwrap();
        let rels = |options: GrepOptions| {
            grep_with(&dir.0, "token", options, None)
                .unwrap()
                .hits
                .into_iter()
                .map(|hit| hit.rel)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            rels(GrepOptions {
                include: "*.ts".into(),
                ..GrepOptions::default()
            }),
            vec!["docs/c.ts", "src/a.ts"]
        );
        assert_eq!(
            rels(GrepOptions {
                exclude: "docs".into(),
                ..GrepOptions::default()
            }),
            vec!["src/a.ts", "src/b.md"]
        );
        assert_eq!(
            rels(GrepOptions {
                include: "src/".into(),
                exclude: "*.md".into(),
                ..GrepOptions::default()
            }),
            vec!["src/a.ts"]
        );
    }

    #[test]
    fn replacement_preview_expands_captures() {
        let dir = Scratch::new("preview");
        fs::write(dir.0.join("p.txt"), "let a = 1; let b = 2;").unwrap();
        let options = GrepOptions {
            regex: true,
            ..GrepOptions::default()
        };
        let hit = &grep_with(&dir.0, r"let (\w)", options, Some("const $1"))
            .unwrap()
            .hits[0];
        assert_eq!(
            hit.replacements.as_deref(),
            Some(&["const a".to_string(), "const b".to_string()][..])
        );
    }

    #[test]
    fn replace_rewrites_only_the_asked_lines_and_keeps_line_endings() {
        let dir = Scratch::new("replace");
        crate::roots::register(&dir.0).unwrap();
        fs::write(dir.0.join("r.txt"), "foo\r\nfoo foo\r\nbar\r\nfoo").unwrap();
        let summary = workspace_replace_blocking(
            dir.0.to_string_lossy().into_owned(),
            "foo".into(),
            GrepOptions::default(),
            "$x".into(),
            vec![ReplaceTarget {
                rel: "r.txt".into(),
                lines: Some(vec![2, 4]),
            }],
        )
        .unwrap();
        assert_eq!(summary.replacements, 3);
        assert_eq!(summary.files, 1);
        // A literal replacement is written as is, `$` and all.
        assert_eq!(
            fs::read_to_string(dir.0.join("r.txt")).unwrap(),
            "foo\r\n$x $x\r\nbar\r\n$x"
        );
    }

    #[test]
    fn regex_replace_uses_captures() {
        let dir = Scratch::new("regex-replace");
        crate::roots::register(&dir.0).unwrap();
        fs::write(dir.0.join("r.ts"), "var a = 1;\nvar b = 2;\n").unwrap();
        let options = GrepOptions {
            regex: true,
            ..GrepOptions::default()
        };
        workspace_replace_blocking(
            dir.0.to_string_lossy().into_owned(),
            r"var (\w)".into(),
            options,
            "const ${1}".into(),
            vec![ReplaceTarget {
                rel: "r.ts".into(),
                lines: None,
            }],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(dir.0.join("r.ts")).unwrap(),
            "const a = 1;\nconst b = 2;\n"
        );
    }

    #[test]
    fn replace_refuses_paths_outside_the_project() {
        let dir = Scratch::new("replace-jail");
        let project = dir.0.join("project");
        fs::create_dir_all(&project).unwrap();
        crate::roots::register(&project).unwrap();
        fs::write(dir.0.join("outside.txt"), "foo").unwrap();
        let summary = workspace_replace_blocking(
            project.to_string_lossy().into_owned(),
            "foo".into(),
            GrepOptions::default(),
            "bar".into(),
            vec![ReplaceTarget {
                rel: "../outside.txt".into(),
                lines: None,
            }],
        )
        .unwrap();
        assert_eq!(summary.replacements, 0);
        assert_eq!(summary.skipped.len(), 1);
        assert_eq!(
            fs::read_to_string(dir.0.join("outside.txt")).unwrap(),
            "foo"
        );
    }

    #[test]
    fn preserves_literal_search_whitespace() {
        let dir = Scratch::new("whitespace");
        fs::write(dir.0.join("text.txt"), "needle\n needle \nneedles\n").unwrap();
        let results = grep(&dir.0, " needle ", true, false).unwrap();
        assert_eq!(results.hits.len(), 1);
        assert_eq!(results.hits[0].line, 2);
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

        // Looking everywhere reaches build folders, but never leaves the project.
        let everywhere = grep_with(
            &project,
            token,
            GrepOptions {
                include_ignored: true,
                ..GrepOptions::default()
            },
            None,
        )
        .unwrap();
        let mut rels: Vec<_> = everywhere.hits.iter().map(|hit| hit.rel.clone()).collect();
        rels.sort();
        assert_eq!(
            rels,
            vec!["inside.txt", "node_modules/secret.txt", "target/secret.txt"]
        );
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
