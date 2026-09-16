//! Git and GitHub CLI, run as the user — their config, credentials and hooks.
//!
//! Subcommands are fixed. The frontend never sends a freeform git string.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::paths::{canonicalize_dir, normalize_rel, resolve_existing, to_posix};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_DIFF_BYTES: u64 = 1_000_000;
const MAX_DIFF_LINES: usize = 4000;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_REMOTE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub git: bool,
    pub repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    pub binary: bool,
    pub hunks: Vec<GitHunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: Option<String>,
    pub detached: bool,
    pub items: Vec<GitBranch>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub subject: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub head: String,
    pub base: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrList {
    pub available: bool,
    pub items: Vec<PullRequest>,
    pub error: Option<String>,
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn apply_git_env(cmd: &mut Command) {
    cmd.env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_LITERAL_PATHSPECS", "1");
}

/// Hide `://user:password@` and `://x-access-token:token@` in git/gh output.
fn redact_git_output(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"://[^/\s@]+:[^/\s@]+@").expect("redact pattern"));
    re.replace_all(s, "://***@").into_owned()
}

fn user_err(bytes: &[u8]) -> String {
    redact_git_output(String::from_utf8_lossy(bytes).trim())
}

fn wait_output_timeout(
    mut child: Child,
    timeout: Duration,
    program: &str,
) -> Result<Output, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} timed out"));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(format!("Could not run {program}: {err}")),
        }
    };

    Ok(Output {
        status,
        stdout: stdout_h.join().unwrap_or_default(),
        stderr: stderr_h.join().unwrap_or_default(),
    })
}

fn run_in_timeout(
    root: &Path,
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_git_env(&mut cmd);
    hide_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|err| format!("Could not run {program}: {err}"))?;
    wait_output_timeout(child, timeout, program)
}

fn run_in(root: &Path, program: &str, args: &[&str]) -> Result<Output, String> {
    run_in_timeout(root, program, args, GIT_TIMEOUT)
}

fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    git_timeout(root, args, GIT_TIMEOUT)
}

fn git_timeout(root: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    run_in_timeout(root, "git", args, timeout)
}

fn git_ok(root: &Path, args: &[&str]) -> Result<String, String> {
    git_ok_timeout(root, args, GIT_TIMEOUT)
}

fn git_ok_timeout(root: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let output = git_timeout(root, args, timeout)?;
    if output.status.success() {
        return Ok(redact_git_output(&String::from_utf8_lossy(&output.stdout)));
    }
    let err = user_err(&output.stderr);
    if err.is_empty() {
        Err(format!(
            "git {} failed",
            args.first().copied().unwrap_or("")
        ))
    } else {
        Err(err)
    }
}

fn git_installed() -> bool {
    let mut cmd = Command::new("git");
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn gh_installed() -> bool {
    let mut cmd = Command::new("gh");
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn empty_status(git: bool, repo: bool) -> GitStatus {
    GitStatus {
        git,
        repo,
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    }
}

fn status_from_xy(x: char, y: char) -> String {
    let letter = if x != '.' && x != ' ' { x } else { y };
    match letter {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        '?' => "untracked",
        _ => "modified",
    }
    .into()
}

fn skip_fields(line: &str, n: usize) -> &str {
    let mut rest = line;
    for _ in 0..n {
        let Some(idx) = rest.find(' ') else {
            return "";
        };
        rest = &rest[idx + 1..];
    }
    rest
}

fn first_token(line: &str) -> &str {
    line.split(' ').next().unwrap_or("")
}

fn is_octal_mode(token: &str) -> bool {
    (token.len() == 5 || token.len() == 6) && token.bytes().all(|b| matches!(b, b'0'..=b'7'))
}

fn is_oid(token: &str) -> bool {
    (token.len() == 40 || token.len() == 64) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_rename_score(token: &str) -> bool {
    let mut chars = token.chars();
    matches!(chars.next(), Some('R' | 'C')) && chars.all(|c| c.is_ascii_digit())
}

/// Path after porcelain v2 metadata. Git prints two or three object names
/// depending on version, so a fixed field count eats the path.
fn v2_xy_and_path(line: &str) -> Option<(char, char, &str)> {
    let bytes = line.as_bytes();
    if bytes.len() < 4 || bytes[1] != b' ' {
        return None;
    }
    let kind = bytes[0];
    let x = bytes[2] as char;
    let y = bytes[3] as char;
    // `1`/`2`/`u`, then XY, then submodule state.
    let mut rest = skip_fields(line, 3);
    while is_octal_mode(first_token(rest)) {
        rest = skip_fields(rest, 1);
    }
    while is_oid(first_token(rest)) {
        rest = skip_fields(rest, 1);
    }
    if kind == b'2' && is_rename_score(first_token(rest)) {
        rest = skip_fields(rest, 1);
    }
    if rest.is_empty() {
        return None;
    }
    Some((x, y, rest))
}

fn parse_ab(value: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in value.split_whitespace() {
        if let Some(rest) = part.strip_prefix('+') {
            ahead = rest.parse().unwrap_or(0);
        } else if let Some(rest) = part.strip_prefix('-') {
            behind = rest.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// `git status --porcelain=v2 -z --branch`.
pub fn parse_status(raw: &[u8]) -> GitStatus {
    let mut status = empty_status(true, true);
    let mut parts = raw.split(|b| *b == 0);
    while let Some(part) = parts.next() {
        if part.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(part);
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                status.detached = true;
                status.branch = None;
            } else {
                status.branch = Some(rest.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let (ahead, behind) = parse_ab(rest);
            status.ahead = ahead;
            status.behind = behind;
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if let Some(path) = line.strip_prefix("? ") {
            status.files.push(GitFile {
                path: path.replace('\\', "/"),
                orig_path: None,
                status: "untracked".into(),
                staged: false,
                unstaged: true,
                untracked: true,
                conflict: false,
            });
            continue;
        }
        if line.starts_with("u ") {
            let Some((_, _, path)) = v2_xy_and_path(&line) else {
                continue;
            };
            status.files.push(GitFile {
                path: path.replace('\\', "/"),
                orig_path: None,
                status: "conflict".into(),
                staged: false,
                unstaged: true,
                untracked: false,
                conflict: true,
            });
            continue;
        }
        if line.starts_with("1 ") || line.starts_with("2 ") {
            let rename = line.starts_with("2 ");
            let Some((x, y, path)) = v2_xy_and_path(&line) else {
                continue;
            };
            let orig = if rename {
                parts
                    .next()
                    .map(|b| String::from_utf8_lossy(b).replace('\\', "/"))
                    .filter(|s| !s.is_empty())
            } else {
                None
            };
            let path = path.replace('\\', "/");
            if path.is_empty() {
                continue;
            }
            let staged = x != '.' && x != ' ';
            let unstaged = y != '.' && y != ' ';
            status.files.push(GitFile {
                path,
                orig_path: orig,
                status: if x == 'U' || y == 'U' {
                    "conflict".into()
                } else {
                    status_from_xy(x, y)
                },
                staged,
                unstaged,
                untracked: false,
                conflict: x == 'U' || y == 'U',
            });
        }
    }
    status
}

fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    // @@ -oldStart,oldLines +newStart,newLines @@
    let rest = header.strip_prefix("@@ ")?;
    let mut old_start = 0u32;
    let mut old_lines = 1u32;
    let mut new_start = 0u32;
    let mut new_lines = 1u32;
    for token in rest.split_whitespace() {
        if let Some(spec) = token.strip_prefix('-') {
            let mut bits = spec.split(',');
            old_start = bits.next()?.parse().ok()?;
            if let Some(n) = bits.next() {
                old_lines = n.parse().ok()?;
            }
        } else if let Some(spec) = token.strip_prefix('+') {
            let mut bits = spec.split(',');
            new_start = bits.next()?.parse().ok()?;
            if let Some(n) = bits.next() {
                new_lines = n.parse().ok()?;
            }
        }
    }
    Some((old_start, old_lines, new_start, new_lines))
}

fn push_diff_line(hunk: &mut GitHunk, total: &mut usize, line: DiffLine) -> bool {
    if *total >= MAX_DIFF_LINES {
        hunk.lines.push(DiffLine {
            kind: "meta".into(),
            text: "diff truncated".into(),
            old_no: None,
            new_no: None,
        });
        return false;
    }
    hunk.lines.push(line);
    *total += 1;
    true
}

pub fn parse_diff(raw: &str, path: &str) -> GitDiff {
    if raw.contains("Binary files ") || raw.contains("GIT binary patch") {
        return GitDiff {
            path: path.to_string(),
            binary: true,
            hunks: Vec::new(),
        };
    }
    let mut hunks = Vec::new();
    let mut current: Option<GitHunk> = None;
    let mut old_no = 0u32;
    let mut new_no = 0u32;
    let mut total = 0usize;
    for line in raw.lines() {
        if line.starts_with("@@ ") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            let (os, ol, ns, nl) = parse_hunk_header(line).unwrap_or((0, 0, 0, 0));
            old_no = os;
            new_no = ns;
            current = Some(GitHunk {
                header: line.to_string(),
                old_start: os,
                old_lines: ol,
                new_start: ns,
                new_lines: nl,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = current.as_mut() else {
            continue;
        };
        let keep = if let Some(text) = line.strip_prefix('+') {
            let ok = push_diff_line(
                hunk,
                &mut total,
                DiffLine {
                    kind: "add".into(),
                    text: text.to_string(),
                    old_no: None,
                    new_no: Some(new_no),
                },
            );
            new_no += 1;
            ok
        } else if let Some(text) = line.strip_prefix('-') {
            let ok = push_diff_line(
                hunk,
                &mut total,
                DiffLine {
                    kind: "del".into(),
                    text: text.to_string(),
                    old_no: Some(old_no),
                    new_no: None,
                },
            );
            old_no += 1;
            ok
        } else if let Some(text) = line.strip_prefix(' ') {
            let ok = push_diff_line(
                hunk,
                &mut total,
                DiffLine {
                    kind: "ctx".into(),
                    text: text.to_string(),
                    old_no: Some(old_no),
                    new_no: Some(new_no),
                },
            );
            old_no += 1;
            new_no += 1;
            ok
        } else if line == "\\ No newline at end of file" {
            push_diff_line(
                hunk,
                &mut total,
                DiffLine {
                    kind: "meta".into(),
                    text: line.to_string(),
                    old_no: None,
                    new_no: None,
                },
            )
        } else {
            true
        };
        if !keep {
            break;
        }
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    GitDiff {
        path: path.to_string(),
        binary: false,
        hunks,
    }
}

fn rel_arg(root: &Path, rel: &str) -> Result<String, String> {
    let _root = canonicalize_dir(root)?;
    let path = normalize_rel(rel)?;
    if path.as_os_str().is_empty() {
        return Err("Pick a file inside the project.".into());
    }
    Ok(to_posix(&path))
}

fn rels(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    paths.iter().map(|p| rel_arg(root, p)).collect()
}

pub fn ls_files(root: &Path) -> Result<Vec<String>, String> {
    let output = git_ok(root, &["ls-files", "-z"])?;
    Ok(output
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('\\', "/"))
        .collect())
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    crate::blocking::run(move || git_status_blocking(root)).await
}

fn git_status_blocking(root: String) -> Result<GitStatus, String> {
    if !git_installed() {
        return Ok(empty_status(false, false));
    }
    let root = crate::roots::require(&root)?;
    let output = git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    if !output.status.success() {
        if not_a_git_repository(&output) {
            return Ok(empty_status(true, false));
        }
        let err = user_err(&output.stderr);
        if err.is_empty() {
            return Err("git status failed".into());
        }
        return Err(err);
    }
    Ok(parse_status(&output.stdout))
}

fn not_a_git_repository(output: &Output) -> bool {
    if output.status.code() != Some(128) {
        return false;
    }
    let err = String::from_utf8_lossy(&output.stderr);
    err.contains("not a git repository") || err.contains("Not a git repository")
}

#[tauri::command]
pub async fn git_diff(root: String, path: String, staged: bool) -> Result<GitDiff, String> {
    crate::blocking::run(move || git_diff_blocking(root, path, staged)).await
}

fn git_diff_blocking(root: String, path: String, staged: bool) -> Result<GitDiff, String> {
    let root = crate::roots::require(&root)?;
    let rel = rel_arg(&root, &path)?;
    let mut args = vec!["diff", "--no-color", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&rel);
    let raw = git_ok(&root, &args)?;
    if raw.trim().is_empty() && !staged {
        // Untracked: show the whole file as added, with size/line caps.
        if let Ok(path) = resolve_existing(&root, &rel) {
            if path.is_file() {
                return Ok(untracked_file_diff(rel, &path));
            }
        }
    }
    Ok(parse_diff(&raw, &rel))
}

fn untracked_file_diff(rel: String, path: &Path) -> GitDiff {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_DIFF_BYTES {
        return GitDiff {
            path: rel,
            binary: true,
            hunks: Vec::new(),
        };
    }
    let bytes = std::fs::read(path).unwrap_or_default();
    if bytes.len() as u64 > MAX_DIFF_BYTES || bytes.contains(&0) {
        return GitDiff {
            path: rel,
            binary: true,
            hunks: Vec::new(),
        };
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = Vec::new();
    let mut truncated = false;
    for (i, line) in text.lines().enumerate() {
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            break;
        }
        lines.push(DiffLine {
            kind: "add".into(),
            text: line.to_string(),
            old_no: None,
            new_no: Some((i as u32) + 1),
        });
    }
    if truncated {
        lines.push(DiffLine {
            kind: "meta".into(),
            text: "diff truncated".into(),
            old_no: None,
            new_no: None,
        });
    }
    let count = lines.iter().filter(|line| line.kind == "add").count() as u32;
    GitDiff {
        path: rel,
        binary: false,
        hunks: vec![GitHunk {
            header: format!("@@ -0,0 +1,{count} @@"),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: count,
            lines,
        }],
    }
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    crate::blocking::run(move || git_stage_blocking(root, paths)).await
}

fn git_stage_blocking(root: String, paths: Vec<String>) -> Result<(), String> {
    let root = crate::roots::require(&root)?;
    let rels = rels(&root, &paths)?;
    if rels.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add", "--"];
    let owned: Vec<&str> = rels.iter().map(String::as_str).collect();
    args.extend(owned);
    git_ok(&root, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    crate::blocking::run(move || git_unstage_blocking(root, paths)).await
}

fn git_unstage_blocking(root: String, paths: Vec<String>) -> Result<(), String> {
    let root = crate::roots::require(&root)?;
    let rels = rels(&root, &paths)?;
    if rels.is_empty() {
        return Ok(());
    }
    let mut args = vec!["restore", "--staged", "--"];
    let owned: Vec<&str> = rels.iter().map(String::as_str).collect();
    args.extend(owned);
    git_ok(&root, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    crate::blocking::run(move || git_discard_blocking(root, paths)).await
}

fn git_discard_blocking(root: String, paths: Vec<String>) -> Result<(), String> {
    let root = crate::roots::require(&root)?;
    let status = git_status_blocking(root.to_string_lossy().into_owned())?;
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for path in paths {
        let rel = rel_arg(&root, &path)?;
        let file = status.files.iter().find(|f| f.path == rel);
        if file.map(|f| f.untracked).unwrap_or(false) {
            untracked.push(rel);
        } else {
            tracked.push(rel);
        }
    }
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
        let owned: Vec<&str> = tracked.iter().map(String::as_str).collect();
        args.extend(owned);
        git_ok(&root, &args)?;
    }
    for rel in untracked {
        delete_untracked(&root, &rel)?;
    }
    Ok(())
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Untracked path, already `rel_arg`-normalized. Deletes the link itself when
/// `rel` is a symlink so we never follow it out of the project.
fn delete_untracked(root: &Path, rel: &str) -> Result<(), String> {
    let joined = root.join(normalize_rel(rel)?);
    let meta = std::fs::symlink_metadata(&joined).map_err(|err| err.to_string())?;
    if is_link(&meta) {
        return delete_untracked_path(&joined, true);
    }
    let path = resolve_existing(root, rel)?;
    delete_untracked_path(&path, false)
}

#[cfg(windows)]
fn delete_untracked_path(path: &Path, _link: bool) -> Result<(), String> {
    recycle_delete(path)
}

#[cfg(not(windows))]
fn delete_untracked_path(path: &Path, link: bool) -> Result<(), String> {
    if link || !path.is_dir() {
        std::fs::remove_file(path).map_err(|err| err.to_string())
    } else {
        std::fs::remove_dir_all(path).map_err(|err| err.to_string())
    }
}

#[cfg(windows)]
fn recycle_delete(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use winapi::um::shellapi::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW,
    };

    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    if from.contains(&0) {
        return Err("That path is not valid.".into());
    }
    from.push(0);
    from.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: ptr::null_mut(),
        wFunc: FO_DELETE as u32,
        pFrom: from.as_ptr(),
        pTo: ptr::null(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT,
        fAnyOperationsAborted: 0,
        hNameMappings: ptr::null_mut(),
        lpszProgressTitle: ptr::null(),
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 || op.fAnyOperationsAborted != 0 {
        Err(format!(
            "Could not move {} to the Recycle Bin.",
            path.display()
        ))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    crate::blocking::run(move || git_commit_blocking(root, message)).await
}

fn git_commit_blocking(root: String, message: String) -> Result<String, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Write a commit message first.".into());
    }
    let root = crate::roots::require(&root)?;
    let mut cmd = Command::new("git");
    cmd.args(["commit", "-F", "-"])
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_git_env(&mut cmd);
    hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("Could not run git: {err}"))?;
    {
        use std::io::Write;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "git did not accept the commit message.".to_string())?;
        stdin
            .write_all(message.as_bytes())
            .map_err(|err| err.to_string())?;
    }
    let output = wait_output_timeout(child, GIT_TIMEOUT, "git")?;
    if !output.status.success() {
        let err = user_err(&output.stderr);
        if err.is_empty() {
            return Err("git commit failed".into());
        }
        return Err(err);
    }
    git_ok(&root, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string())
}

fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

fn pick_remote(listing: &str) -> Option<String> {
    let names: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let chosen = if names.iter().copied().any(|n| n == "origin") {
        "origin"
    } else {
        names.first().copied()?
    };
    valid_remote_name(chosen).then(|| chosen.to_string())
}

fn default_remote(root: &Path) -> String {
    git_ok(root, &["remote"])
        .ok()
        .and_then(|out| pick_remote(&out))
        .unwrap_or_else(|| "origin".into())
}

#[tauri::command]
pub async fn git_push(root: String, set_upstream: bool) -> Result<String, String> {
    crate::blocking::run(move || git_push_blocking(root, set_upstream)).await
}

fn git_push_blocking(root: String, set_upstream: bool) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    let has_upstream = git_ok(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_ok();
    let output = if has_upstream && !set_upstream {
        git_timeout(&root, &["push"], GIT_REMOTE_TIMEOUT)?
    } else {
        let remote = default_remote(&root);
        git_timeout(&root, &["push", "-u", &remote, "HEAD"], GIT_REMOTE_TIMEOUT)?
    };
    let stdout = redact_git_output(&String::from_utf8_lossy(&output.stdout));
    let stderr = user_err(&output.stderr);
    if output.status.success() {
        let msg = if stdout.trim().is_empty() {
            stderr
        } else {
            stdout.trim().to_string()
        };
        Ok(if msg.is_empty() {
            "Pushed.".into()
        } else {
            msg
        })
    } else {
        Err(if stderr.is_empty() {
            "git push failed".into()
        } else {
            stderr
        })
    }
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<String, String> {
    crate::blocking::run(move || git_pull_blocking(root)).await
}

fn git_pull_blocking(root: String) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    git_ok_timeout(&root, &["pull", "--ff-only"], GIT_REMOTE_TIMEOUT).map(|s| {
        let t = s.trim();
        if t.is_empty() {
            "Already up to date.".into()
        } else {
            t.to_string()
        }
    })
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<String, String> {
    crate::blocking::run(move || git_fetch_blocking(root)).await
}

fn git_fetch_blocking(root: String) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    git_ok_timeout(&root, &["fetch", "--all", "--prune"], GIT_REMOTE_TIMEOUT).map(|s| {
        let t = s.trim();
        if t.is_empty() {
            "Fetched.".into()
        } else {
            t.to_string()
        }
    })
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<GitBranches, String> {
    crate::blocking::run(move || git_branches_blocking(root)).await
}

fn git_branches_blocking(root: String) -> Result<GitBranches, String> {
    let root = crate::roots::require(&root)?;
    let detached = git_ok(&root, &["symbolic-ref", "-q", "HEAD"]).is_err();
    let current = git_ok(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s != "HEAD");
    let raw = git_ok(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut items = Vec::new();
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut bits = line.split('\0');
        let name = bits.next().unwrap_or("").to_string();
        let head = bits.next().unwrap_or("");
        let upstream = bits.next().unwrap_or("");
        let refname = bits.next().unwrap_or("");
        if name.is_empty() || name == "origin/HEAD" {
            continue;
        }
        items.push(GitBranch {
            current: head == "*",
            remote: refname.starts_with("refs/remotes/"),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            name,
        });
    }
    Ok(GitBranches {
        current,
        detached,
        items,
    })
}

#[tauri::command]
pub async fn git_checkout(root: String, name: String) -> Result<(), String> {
    crate::blocking::run(move || git_checkout_blocking(root, name)).await
}

fn git_checkout_blocking(root: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains("..") || name.starts_with('-') {
        return Err("That is not a branch name.".into());
    }
    let root = crate::roots::require(&root)?;
    git_ok(&root, &["checkout", name]).map(|_| ())
}

#[tauri::command]
pub async fn git_branch_create(root: String, name: String, checkout: bool) -> Result<(), String> {
    crate::blocking::run(move || git_branch_create_blocking(root, name, checkout)).await
}

fn git_branch_create_blocking(root: String, name: String, checkout: bool) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains("..")
        || name.starts_with('-')
        || name.contains(char::is_whitespace)
    {
        return Err("Pick a branch name without spaces.".into());
    }
    let root = crate::roots::require(&root)?;
    if checkout {
        git_ok(&root, &["checkout", "-b", name]).map(|_| ())
    } else {
        git_ok(&root, &["branch", name]).map(|_| ())
    }
}

#[tauri::command]
pub async fn git_branch_delete(root: String, name: String) -> Result<(), String> {
    crate::blocking::run(move || git_branch_delete_blocking(root, name)).await
}

fn git_branch_delete_blocking(root: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains("..") || name.starts_with('-') {
        return Err("That is not a branch name.".into());
    }
    let root = crate::roots::require(&root)?;
    git_ok(&root, &["branch", "-d", name]).map(|_| ())
}

#[tauri::command]
pub async fn git_log(root: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    crate::blocking::run(move || git_log_blocking(root, limit)).await
}

fn git_log_blocking(root: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    let root = crate::roots::require(&root)?;
    let n = limit.clamp(1, 100).to_string();
    let raw = git_ok(
        &root,
        &[
            "log",
            &format!("-n{n}"),
            "--format=%H%x00%h%x00%an%x00%at%x00%s",
        ],
    )?;
    let mut commits = Vec::new();
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut bits = line.split('\0');
        let hash = bits.next().unwrap_or("").to_string();
        let short = bits.next().unwrap_or("").to_string();
        let author = bits.next().unwrap_or("").to_string();
        let timestamp = bits.next().unwrap_or("0").parse().unwrap_or(0);
        let subject = bits.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash,
            short,
            author,
            subject,
            timestamp,
        });
    }
    Ok(commits)
}

#[derive(Debug, Deserialize)]
struct GhPr {
    number: u32,
    title: String,
    url: String,
    state: String,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(default)]
    author: GhAuthor,
    #[serde(rename = "headRefName", default)]
    head_ref_name: String,
    #[serde(rename = "baseRefName", default)]
    base_ref_name: String,
}

#[derive(Debug, Default, Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: String,
}

#[tauri::command]
pub async fn pr_list(root: String) -> Result<PrList, String> {
    crate::blocking::run(move || pr_list_blocking(root)).await
}

fn pr_list_blocking(root: String) -> Result<PrList, String> {
    if !gh_installed() {
        return Ok(PrList {
            available: false,
            items: Vec::new(),
            error: Some("Install GitHub CLI (gh) to manage pull requests.".into()),
        });
    }
    let root = crate::roots::require(&root)?;
    let output = run_in(
        &root,
        "gh",
        &[
            "pr",
            "list",
            "--json",
            "number,title,url,state,isDraft,author,headRefName,baseRefName",
            "--limit",
            "40",
        ],
    )?;
    if !output.status.success() {
        let err = user_err(&output.stderr);
        return Ok(PrList {
            available: true,
            items: Vec::new(),
            error: Some(if err.is_empty() {
                "gh pr list failed".into()
            } else {
                err
            }),
        });
    }
    let parsed: Vec<GhPr> = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("Could not read pull requests: {err}"))?;
    Ok(PrList {
        available: true,
        items: parsed
            .into_iter()
            .map(|pr| PullRequest {
                number: pr.number,
                title: pr.title,
                url: pr.url,
                state: pr.state,
                draft: pr.is_draft,
                author: pr.author.login,
                head: pr.head_ref_name,
                base: pr.base_ref_name,
            })
            .collect(),
        error: None,
    })
}

#[tauri::command]
pub async fn pr_create(
    root: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: bool,
) -> Result<PullRequest, String> {
    crate::blocking::run(move || pr_create_blocking(root, title, body, base, draft)).await
}

fn pr_create_blocking(
    root: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: bool,
) -> Result<PullRequest, String> {
    if !gh_installed() {
        return Err("Install GitHub CLI (gh) to open a pull request.".into());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("Give the pull request a title.".into());
    }
    let root = crate::roots::require(&root)?;
    let mut args = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        title.to_string(),
        "--body".into(),
        body,
        "--json".into(),
        "number,title,url,state,isDraft,author,headRefName,baseRefName".into(),
    ];
    if let Some(base) = base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--base".into());
        args.push(base.to_string());
    }
    if draft {
        args.push("--draft".into());
    }
    let owned: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_in(&root, "gh", &owned)?;
    if !output.status.success() {
        let err = user_err(&output.stderr);
        return Err(if err.is_empty() {
            "gh pr create failed".into()
        } else {
            err
        });
    }
    let pr: GhPr = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("Opened the pull request, but could not read it back: {err}"))?;
    Ok(PullRequest {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        draft: pr.is_draft,
        author: pr.author.login,
        head: pr.head_ref_name,
        base: pr.base_ref_name,
    })
}

#[tauri::command]
pub async fn pr_checkout(root: String, number: u32) -> Result<(), String> {
    crate::blocking::run(move || pr_checkout_blocking(root, number)).await
}

fn pr_checkout_blocking(root: String, number: u32) -> Result<(), String> {
    if !gh_installed() {
        return Err("Install GitHub CLI (gh) to check out a pull request.".into());
    }
    let root = crate::roots::require(&root)?;
    let n = number.to_string();
    let output = run_in(&root, "gh", &["pr", "checkout", &n])?;
    if output.status.success() {
        Ok(())
    } else {
        let err = user_err(&output.stderr);
        Err(if err.is_empty() {
            "gh pr checkout failed".into()
        } else {
            err
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_files() {
        let raw = b"# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\x001 .M N... 100644 100644 100644 e08dc408d526231a88734b3b57ee5d017db882b3 e08dc408d526231a88734b3b57ee5d017db882b3 src/App.tsx\0? notes.md\0";
        let status = parse_status(raw);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.files.len(), 2);
        assert_eq!(status.files[0].path, "src/App.tsx");
        assert!(status.files[0].unstaged);
        assert!(!status.files[0].staged);
        assert!(status.files[1].untracked);
    }

    #[test]
    fn parses_three_object_names_and_spaces_in_path() {
        let raw = b"1 .M N... 100644 100644 100644 e08dc408d526231a88734b3b57ee5d017db882b3 e08dc408d526231a88734b3b57ee5d017db882b3 92e94d02047ad3b255b04691a4057402b6dd6014 src/my file.ts\0";
        let status = parse_status(raw);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "src/my file.ts");
        assert!(status.files[0].unstaged);
        assert!(!status.files[0].untracked);
    }

    #[test]
    fn status_of_this_repo() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crate is inside the repo")
            .to_path_buf();
        let raw = git(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
        )
        .expect("git status raw")
        .stdout;
        let status = parse_status(&raw);
        let tracked_records = raw
            .split(|b| *b == 0)
            .filter(|part| {
                part.starts_with(b"1 ") || part.starts_with(b"2 ") || part.starts_with(b"u ")
            })
            .count();
        let tracked_files = status.files.iter().filter(|file| !file.untracked).count();
        assert_eq!(
            tracked_files, tracked_records,
            "modified files were dropped; parser saw {tracked_files} of {tracked_records}"
        );
        assert!(status.git);
        assert!(status.repo);
        assert!(status.branch.is_some() || status.detached);
    }

    #[test]
    fn parses_unified_diff() {
        let raw = "--- a/a\n+++ b/a\n@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+added\n keep\n";
        let diff = parse_diff(raw, "a");
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(diff.hunks[0].lines.len(), 5);
        assert_eq!(diff.hunks[0].lines[1].kind, "del");
        assert_eq!(diff.hunks[0].lines[2].kind, "add");
    }

    #[test]
    fn redact_git_output_hides_passwords_in_urls() {
        assert_eq!(
            redact_git_output(
                "fatal: could not read from 'https://user:s3cret@github.com/org/repo.git'"
            ),
            "fatal: could not read from 'https://***@github.com/org/repo.git'"
        );
        assert_eq!(
            redact_git_output("https://x-access-token:ghs_abc@github.com/org/repo"),
            "https://***@github.com/org/repo"
        );
        assert_eq!(
            redact_git_output("https://github.com/org/repo.git"),
            "https://github.com/org/repo.git"
        );
        assert_eq!(
            redact_git_output("from https://alice:one@host/a and https://bob:two@host/b"),
            "from https://***@host/a and https://***@host/b"
        );
    }

    #[test]
    fn remote_names_reject_leading_dash() {
        assert!(valid_remote_name("origin"));
        assert!(valid_remote_name("my_remote.1"));
        assert!(valid_remote_name("upstream-1"));
        assert!(!valid_remote_name(""));
        assert!(!valid_remote_name("-u"));
        assert!(!valid_remote_name("-origin"));
        assert!(!valid_remote_name("origin/main"));
        assert!(!valid_remote_name("foo bar"));
        assert_eq!(pick_remote("-u\n").as_deref(), None);
        assert_eq!(pick_remote("-u\norigin\n").as_deref(), Some("origin"));
        assert_eq!(pick_remote("upstream\n").as_deref(), Some("upstream"));
        assert_eq!(pick_remote("").as_deref(), None);
    }

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir()
                .join(format!("keel-git-{label}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("temp project");
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn untracked_diff_caps_huge_files() {
        let scratch = Scratch::new("diff-size");
        crate::roots::register(&scratch.0).expect("register");
        let path = scratch.0.join("huge.txt");
        std::fs::write(&path, vec![b'a'; (MAX_DIFF_BYTES as usize) + 1]).unwrap();
        let diff = untracked_file_diff("huge.txt".into(), &path);
        assert!(diff.binary);
        assert!(diff.hunks.is_empty());

        git(&scratch.0, &["init", "--quiet"]).expect("git init");
        let via_cmd = git_diff_blocking(
            scratch.0.to_string_lossy().into_owned(),
            "huge.txt".into(),
            false,
        )
        .expect("diff");
        assert!(via_cmd.binary);
        assert!(via_cmd.hunks.is_empty());
    }

    #[test]
    fn untracked_diff_caps_line_count() {
        let scratch = Scratch::new("diff-lines");
        let path = scratch.0.join("many.txt");
        let mut text = String::new();
        for i in 0..(MAX_DIFF_LINES + 80) {
            text.push_str("line ");
            text.push_str(&i.to_string());
            text.push('\n');
        }
        std::fs::write(&path, text).unwrap();
        let diff = untracked_file_diff("many.txt".into(), &path);
        assert!(!diff.binary);
        assert_eq!(diff.hunks.len(), 1);
        let lines = &diff.hunks[0].lines;
        assert_eq!(lines.len(), MAX_DIFF_LINES + 1);
        assert_eq!(lines[MAX_DIFF_LINES].kind, "meta");
        assert_eq!(lines[MAX_DIFF_LINES].text, "diff truncated");
        assert_eq!(
            lines.iter().filter(|line| line.kind == "add").count(),
            MAX_DIFF_LINES
        );
    }
}
