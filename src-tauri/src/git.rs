//! Git and GitHub CLI, run as the user — their config, credentials and hooks.
//!
//! Subcommands are fixed. The frontend never sends a freeform git string.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
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
pub(crate) const GIT_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const GIT_REMOTE_TIMEOUT: Duration = Duration::from_secs(120);

/// Lines added and removed, as `git diff --numstat` counts them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStat {
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
}

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
    /// The working tree against the index (or the whole file, when untracked).
    pub stat: Option<LineStat>,
    /// The index against HEAD.
    pub staged_stat: Option<LineStat>,
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
    /// Short name of HEAD's commit; `None` before the first commit.
    pub head: Option<String>,
    /// A merge, rebase, cherry-pick or revert waiting to be finished.
    pub operation: Option<String>,
    pub stashes: u32,
    /// When this repository last fetched, in unix seconds.
    pub last_fetch: Option<i64>,
    /// There is somewhere to push to and pull from.
    pub has_remote: bool,
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
    /// The upstream was deleted on the remote.
    pub gone: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Committer date of the tip, unix seconds.
    pub timestamp: i64,
    /// The tip's subject line.
    pub subject: String,
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
    pub email: String,
    pub subject: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    /// Decorations as `git log` prints them: `HEAD -> main`, `origin/main`, `tag: v1`.
    pub refs: Vec<String>,
    /// Not on any remote-tracking branch yet.
    pub unpushed: bool,
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
    pub updated_at: Option<String>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or none.
    pub review: Option<String>,
    pub checks: Option<PrChecks>,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrChecks {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrList {
    pub available: bool,
    pub items: Vec<PullRequest>,
    pub error: Option<String>,
}

pub(crate) fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) fn apply_git_env(cmd: &mut Command) {
    cmd.env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_LITERAL_PATHSPECS", "1");
}

/// Hide `://user:password@` and `://x-access-token:token@` in git/gh output.
pub(crate) fn redact_git_output(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"://[^/\s@]+:[^/\s@]+@").expect("redact pattern"));
    re.replace_all(s, "://***@").into_owned()
}

pub(crate) fn user_err(bytes: &[u8]) -> String {
    redact_git_output(String::from_utf8_lossy(bytes).trim())
}

pub(crate) fn wait_output_timeout(
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

pub(crate) fn run_in(root: &Path, program: &str, args: &[&str]) -> Result<Output, String> {
    run_in_timeout(root, program, args, GIT_TIMEOUT)
}

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    git_timeout(root, args, GIT_TIMEOUT)
}

pub(crate) fn git_timeout(root: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    run_in_timeout(root, "git", args, timeout)
}

pub(crate) fn git_ok(root: &Path, args: &[&str]) -> Result<String, String> {
    git_ok_timeout(root, args, GIT_TIMEOUT)
}

pub(crate) fn git_ok_timeout(
    root: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
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

pub(crate) fn gh_installed() -> bool {
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
        head: None,
        operation: None,
        stashes: 0,
        last_fetch: None,
        has_remote: false,
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
                stat: None,
                staged_stat: None,
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
                stat: None,
                staged_stat: None,
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
                stat: None,
                staged_stat: None,
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

pub(crate) fn parse_diff(raw: &str, path: &str) -> GitDiff {
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

pub(crate) fn rel_arg(root: &Path, rel: &str) -> Result<String, String> {
    let _root = canonicalize_dir(root)?;
    let path = normalize_rel(rel)?;
    if path.as_os_str().is_empty() {
        return Err("Pick a file inside the project.".into());
    }
    Ok(to_posix(&path))
}

pub(crate) fn rels(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
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
    let mut status = git_status_core(&root)?;
    if status.repo {
        enrich_status(&root, &mut status);
    }
    Ok(status)
}

/// Branch and files only — what a discard needs, without the extras.
fn git_status_core(root: &Path) -> Result<GitStatus, String> {
    let output = git(
        root,
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

/// Untracked files this size or smaller get their lines counted.
const MAX_COUNTED_BYTES: u64 = 512 * 1024;
const MAX_COUNTED_FILES: usize = 300;

/// The extras around a status: HEAD, an operation in progress, stashes, the
/// last fetch, and how many lines each change touches.
fn enrich_status(root: &Path, status: &mut GitStatus) {
    status.head = git_ok(root, &["rev-parse", "--verify", "-q", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    status.has_remote = git_ok(root, &["remote"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false);
    if let Some((git_dir, common_dir)) = git_dirs(root) {
        status.operation = repo_operation(&git_dir);
        status.stashes = count_stashes(&common_dir);
        status.last_fetch = modified_secs(&common_dir.join("FETCH_HEAD"));
    }
    apply_numstat(root, status);
}

/// This worktree's git folder and the one its worktrees share.
pub(crate) fn git_dirs(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let out = git_ok(
        root,
        &["rev-parse", "--absolute-git-dir", "--git-common-dir"],
    )
    .ok()?;
    let mut lines = out.lines().map(str::trim).filter(|line| !line.is_empty());
    let git_dir = PathBuf::from(lines.next()?);
    let common = PathBuf::from(lines.next()?);
    let common = if common.is_absolute() {
        common
    } else {
        root.join(common)
    };
    Some((git_dir, common))
}

pub(crate) fn repo_operation(git_dir: &Path) -> Option<String> {
    let op = if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
        "rebase"
    } else if git_dir.join("MERGE_HEAD").is_file() {
        "merge"
    } else if git_dir.join("CHERRY_PICK_HEAD").is_file() {
        "cherry-pick"
    } else if git_dir.join("REVERT_HEAD").is_file() {
        "revert"
    } else {
        return None;
    };
    Some(op.into())
}

fn count_stashes(common_dir: &Path) -> u32 {
    std::fs::read_to_string(common_dir.join("logs").join("refs").join("stash"))
        .map(|log| log.lines().filter(|line| !line.trim().is_empty()).count() as u32)
        .unwrap_or(0)
}

fn modified_secs(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    i64::try_from(secs).ok()
}

/// `git diff --numstat -z`: `added<TAB>removed<TAB>path<NUL>`, or for
/// a rename `added<TAB>removed<TAB><NUL>from<NUL>to<NUL>`. Binary files count `-` for both.
pub(crate) fn parse_numstat(raw: &[u8]) -> Vec<(String, LineStat)> {
    let mut out = Vec::new();
    let mut parts = raw.split(|b| *b == 0);
    while let Some(part) = parts.next() {
        if part.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(part);
        let mut fields = line.splitn(3, '\t');
        let added = fields.next().unwrap_or("");
        let removed = fields.next().unwrap_or("");
        let Some(path) = fields.next() else {
            continue;
        };
        let binary = added == "-" || removed == "-";
        let stat = LineStat {
            added: added.parse().unwrap_or(0),
            removed: removed.parse().unwrap_or(0),
            binary,
        };
        let path = if path.is_empty() {
            // A rename: the source, then the destination, as their own fields.
            let _from = parts.next();
            match parts.next() {
                Some(to) => String::from_utf8_lossy(to).into_owned(),
                None => continue,
            }
        } else {
            path.to_string()
        };
        out.push((path.replace('\\', "/"), stat));
    }
    out
}

fn numstat_map(root: &Path, cached: bool) -> HashMap<String, LineStat> {
    let mut args = vec!["diff", "--numstat", "-z", "-M", "--no-color"];
    if cached {
        args.push("--cached");
    }
    match git(root, &args) {
        Ok(output) if output.status.success() => {
            parse_numstat(&output.stdout).into_iter().collect()
        }
        _ => HashMap::new(),
    }
}

fn count_lines(path: &Path) -> Option<LineStat> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_COUNTED_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return Some(LineStat {
            binary: true,
            ..LineStat::default()
        });
    }
    let mut lines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    if bytes.last().is_some_and(|b| *b != b'\n') {
        lines += 1;
    }
    Some(LineStat {
        added: lines,
        removed: 0,
        binary: false,
    })
}

fn apply_numstat(root: &Path, status: &mut GitStatus) {
    let unstaged = numstat_map(root, false);
    let staged = numstat_map(root, true);
    let mut counted = 0;
    for file in &mut status.files {
        if file.untracked {
            if counted < MAX_COUNTED_FILES {
                counted += 1;
                file.stat = count_lines(&root.join(&file.path));
            }
            continue;
        }
        if file.unstaged {
            file.stat = unstaged.get(&file.path).copied();
        }
        if file.staged {
            file.staged_stat = staged.get(&file.path).copied();
        }
    }
}

fn not_a_git_repository(output: &Output) -> bool {
    if output.status.code() != Some(128) {
        return false;
    }
    let err = String::from_utf8_lossy(&output.stderr);
    err.contains("not a git repository") || err.contains("Not a git repository")
}

#[tauri::command]
pub async fn git_diff(
    root: String,
    path: String,
    staged: bool,
    context: Option<u32>,
) -> Result<GitDiff, String> {
    crate::blocking::run(move || git_diff_blocking(root, path, staged, context)).await
}

/// `--unified=N` for a number of context lines, capped so "the whole file"
/// stays one argument git accepts.
pub(crate) fn unified_arg(context: Option<u32>) -> String {
    format!("--unified={}", context.unwrap_or(3).min(1_000_000))
}

fn git_diff_blocking(
    root: String,
    path: String,
    staged: bool,
    context: Option<u32>,
) -> Result<GitDiff, String> {
    let root = crate::roots::require(&root)?;
    let rel = rel_arg(&root, &path)?;
    let unified = unified_arg(context);
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", unified.as_str()];
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

/// The committed copy of a file, for the editor's change gutter.
///
/// `Some("")` for a file git would pick up but has never committed, so all of
/// it reads as new. `None` when there is nothing to compare with: no repo, an
/// ignored file, or a blob that is binary or too big to diff.
#[tauri::command]
pub async fn git_base(root: String, path: String) -> Result<Option<String>, String> {
    crate::blocking::run(move || git_base_blocking(root, path)).await
}

fn git_base_blocking(root: String, path: String) -> Result<Option<String>, String> {
    let root = crate::roots::require(&root)?;
    let rel = rel_arg(&root, &path)?;
    // `./` resolves against the project folder, which may sit below the repo root.
    let spec = format!("HEAD:./{rel}");
    let output = git(&root, &["cat-file", "blob", &spec])?;
    if output.status.success() {
        let bytes = output.stdout;
        if bytes.len() as u64 > MAX_DIFF_BYTES || bytes.contains(&0) {
            return Ok(None);
        }
        return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
    }
    let listed = git_ok(
        &root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            &rel,
        ],
    );
    Ok(match listed {
        Ok(out) if !out.trim_matches('\0').is_empty() => Some(String::new()),
        _ => None,
    })
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
    let status = git_status_core(&root)?;
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOptions {
    /// Replace the last commit instead of adding one.
    pub amend: bool,
    /// Add a `Signed-off-by` trailer.
    pub signoff: bool,
    /// Skip the pre-commit and commit-msg hooks.
    pub no_verify: bool,
}

#[tauri::command]
pub async fn git_commit(
    root: String,
    message: String,
    options: Option<CommitOptions>,
) -> Result<String, String> {
    let options = options.unwrap_or_default();
    crate::blocking::run(move || git_commit_blocking(root, message, options)).await
}

fn git_commit_blocking(
    root: String,
    message: String,
    options: CommitOptions,
) -> Result<String, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Write a commit message first.".into());
    }
    let root = crate::roots::require(&root)?;
    let mut args = vec!["commit", "-F", "-"];
    if options.amend {
        args.push("--amend");
    }
    if options.signoff {
        args.push("--signoff");
    }
    if options.no_verify {
        args.push("--no-verify");
    }
    let mut cmd = Command::new("git");
    cmd.args(&args)
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

pub(crate) fn valid_remote_name(name: &str) -> bool {
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

pub(crate) fn default_remote(root: &Path) -> String {
    git_ok(root, &["remote"])
        .ok()
        .and_then(|out| pick_remote(&out))
        .unwrap_or_else(|| "origin".into())
}

#[tauri::command]
pub async fn git_push(
    root: String,
    set_upstream: bool,
    force: Option<bool>,
) -> Result<String, String> {
    let force = force.unwrap_or(false);
    crate::blocking::run(move || git_push_blocking(root, set_upstream, force)).await
}

fn git_push_blocking(root: String, set_upstream: bool, force: bool) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    let has_upstream = git_ok(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_ok();
    // A lease rather than a bare force: it refuses if the remote moved since
    // the last fetch, so nobody else's work is thrown away.
    let lease = force.then_some("--force-with-lease");
    let output = if has_upstream && !set_upstream {
        let mut args = vec!["push"];
        args.extend(lease);
        git_timeout(&root, &args, GIT_REMOTE_TIMEOUT)?
    } else {
        let remote = default_remote(&root);
        let mut args = vec!["push", "-u"];
        args.extend(lease);
        args.extend([remote.as_str(), "HEAD"]);
        git_timeout(&root, &args, GIT_REMOTE_TIMEOUT)?
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
pub async fn git_pull(root: String, mode: Option<String>) -> Result<String, String> {
    crate::blocking::run(move || git_pull_blocking(root, mode)).await
}

fn git_pull_blocking(root: String, mode: Option<String>) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    let flag = match mode.as_deref().unwrap_or("ff-only") {
        "ff-only" => "--ff-only",
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        other => return Err(format!("Unknown pull mode: {other}")),
    };
    git_ok_timeout(&root, &["pull", flag], GIT_REMOTE_TIMEOUT).map(|s| {
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
            "--sort=-committerdate",
            "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(refname)%00%(upstream:track)%00%(committerdate:unix)%00%(contents:subject)",
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
        let track = bits.next().unwrap_or("");
        let timestamp = bits.next().unwrap_or("0").parse().unwrap_or(0);
        let subject = bits.next().unwrap_or("").to_string();
        // `refs/remotes/origin/HEAD` is a pointer, not a branch.
        let remote = refname.starts_with("refs/remotes/");
        if name.is_empty() || (remote && refname.ends_with("/HEAD")) {
            continue;
        }
        let (ahead, behind, gone) = parse_track(track);
        items.push(GitBranch {
            current: head == "*",
            remote,
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            gone,
            ahead,
            behind,
            timestamp,
            subject,
            name,
        });
    }
    Ok(GitBranches {
        current,
        detached,
        items,
    })
}

/// `%(upstream:track)`: `[ahead 1, behind 2]`, `[gone]`, or nothing.
pub(crate) fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
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
pub async fn git_branch_create(
    root: String,
    name: String,
    checkout: bool,
    start: Option<String>,
) -> Result<(), String> {
    crate::blocking::run(move || git_branch_create_blocking(root, name, checkout, start)).await
}

fn git_branch_create_blocking(
    root: String,
    name: String,
    checkout: bool,
    start: Option<String>,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains("..")
        || name.starts_with('-')
        || name.contains(char::is_whitespace)
    {
        return Err("Pick a branch name without spaces.".into());
    }
    let start = start
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(crate::git_ops::checked_ref)
        .transpose()?;
    let root = crate::roots::require(&root)?;
    let mut args = if checkout {
        vec!["checkout", "-b", name]
    } else {
        vec!["branch", name]
    };
    args.extend(start);
    git_ok(&root, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_branch_delete(
    root: String,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    let force = force.unwrap_or(false);
    crate::blocking::run(move || git_branch_delete_blocking(root, name, force)).await
}

fn git_branch_delete_blocking(root: String, name: String, force: bool) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.contains("..") || name.starts_with('-') {
        return Err("That is not a branch name.".into());
    }
    let root = crate::roots::require(&root)?;
    // `-D` only when asked: it drops commits no other branch has.
    let flag = if force { "-D" } else { "-d" };
    git_ok(&root, &["branch", flag, name]).map(|_| ())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOptions {
    /// Commits to step over, for paging.
    pub skip: u32,
    /// Every branch, remote and tag rather than just HEAD.
    pub all: bool,
    /// Only commits whose message contains this, ignoring case.
    pub query: Option<String>,
}

/// One record per commit, fields split by NUL, records by RS.
const LOG_FORMAT: &str = "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x1e";

#[tauri::command]
pub async fn git_log(
    root: String,
    limit: u32,
    options: Option<LogOptions>,
) -> Result<Vec<GitCommit>, String> {
    let options = options.unwrap_or_default();
    crate::blocking::run(move || git_log_blocking(root, limit, options)).await
}

fn git_log_blocking(
    root: String,
    limit: u32,
    options: LogOptions,
) -> Result<Vec<GitCommit>, String> {
    let root = crate::roots::require(&root)?;
    let count = format!("-n{}", limit.clamp(1, 5000));
    let skip = format!("--skip={}", options.skip);
    let mut args = vec![
        "log",
        "--date-order",
        count.as_str(),
        skip.as_str(),
        LOG_FORMAT,
    ];
    // Not `--all`: that would walk the stash too and hang it off the graph.
    if options.all {
        args.extend(["--branches", "--remotes", "--tags", "HEAD"]);
    }
    let grep = options
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("--grep={q}"));
    if let Some(grep) = grep.as_deref() {
        args.extend(["-i", "-F", grep]);
    }
    let output = git(&root, &args)?;
    if !output.status.success() {
        let err = user_err(&output.stderr);
        // A fresh repository has no history to show, which is not an error.
        if err.contains("does not have any commits") || err.contains("unknown revision") {
            return Ok(Vec::new());
        }
        return Err(if err.is_empty() {
            "git log failed".into()
        } else {
            err
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let unpushed = unpushed_commits(&root);
    Ok(parse_log(&raw, &unpushed))
}

/// Commits on a local branch that no remote-tracking branch has yet. Empty
/// when there is no remote at all, where "unpushed" would mean nothing.
fn unpushed_commits(root: &Path) -> std::collections::HashSet<String> {
    let has_remote = git_ok(root, &["remote"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false);
    if !has_remote {
        return Default::default();
    }
    git_ok(
        root,
        &["rev-list", "-n1000", "--branches", "--not", "--remotes"],
    )
    .map(|out| out.lines().map(|line| line.trim().to_string()).collect())
    .unwrap_or_default()
}

pub(crate) fn parse_log(raw: &str, unpushed: &std::collections::HashSet<String>) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for record in raw.split('\u{1e}') {
        let record = record.trim_matches(|c| c == '\n' || c == '\r');
        if record.is_empty() {
            continue;
        }
        let mut bits = record.split('\0');
        let hash = bits.next().unwrap_or("").to_string();
        let short = bits.next().unwrap_or("").to_string();
        let author = bits.next().unwrap_or("").to_string();
        let email = bits.next().unwrap_or("").to_string();
        let timestamp = bits.next().unwrap_or("0").parse().unwrap_or(0);
        let parents = bits
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let refs = bits
            .next()
            .unwrap_or("")
            .split(", ")
            .map(str::trim)
            // `origin/HEAD` only says which branch the remote calls its default.
            .filter(|r| !r.is_empty() && !(r.ends_with("/HEAD") && !r.starts_with("tag: ")))
            .map(str::to_string)
            .collect();
        let subject = bits.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            unpushed: unpushed.contains(&hash),
            hash,
            short,
            author,
            email,
            subject,
            timestamp,
            parents,
            refs,
        });
    }
    commits
}

const PR_FIELDS: &str = "number,title,url,state,isDraft,author,headRefName,baseRefName,updatedAt,reviewDecision,statusCheckRollup,additions,deletions";

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
    #[serde(rename = "updatedAt", default)]
    updated_at: Option<String>,
    #[serde(rename = "reviewDecision", default)]
    review_decision: Option<String>,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
}

impl From<GhPr> for PullRequest {
    fn from(pr: GhPr) -> Self {
        PullRequest {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            draft: pr.is_draft,
            author: pr.author.login,
            head: pr.head_ref_name,
            base: pr.base_ref_name,
            updated_at: pr.updated_at.filter(|s| !s.is_empty()),
            review: pr.review_decision.filter(|s| !s.is_empty()),
            checks: pr.status_check_rollup.as_deref().and_then(summarize_checks),
            additions: pr.additions,
            deletions: pr.deletions,
        }
    }
}

/// Check runs report a status and a conclusion; commit statuses a state.
pub(crate) fn summarize_checks(rollup: &[serde_json::Value]) -> Option<PrChecks> {
    if rollup.is_empty() {
        return None;
    }
    let mut checks = PrChecks::default();
    for check in rollup {
        let field = |name: &str| {
            check
                .get(name)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_ascii_uppercase()
        };
        let (status, conclusion, state) = (field("status"), field("conclusion"), field("state"));
        let verdict = if !state.is_empty() {
            state
        } else if status != "COMPLETED" {
            "PENDING".into()
        } else {
            conclusion
        };
        match verdict.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => checks.passed += 1,
            "PENDING" | "EXPECTED" | "QUEUED" | "IN_PROGRESS" | "WAITING" | "" => {
                checks.pending += 1
            }
            _ => checks.failed += 1,
        }
    }
    Some(checks)
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
        &["pr", "list", "--json", PR_FIELDS, "--limit", "40"],
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
        items: parsed.into_iter().map(PullRequest::from).collect(),
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
    // `gh pr create` has no `--json`; it prints the new pull request's URL.
    let url = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| "Opened the pull request, but gh did not say where.".to_string())?;
    let viewed = run_in(&root, "gh", &["pr", "view", &url, "--json", PR_FIELDS])?;
    if !viewed.status.success() {
        return Err(format!("Opened {url}, but could not read it back."));
    }
    let pr: GhPr = serde_json::from_slice(&viewed.stdout)
        .map_err(|err| format!("Opened the pull request, but could not read it back: {err}"))?;
    Ok(pr.into())
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
    fn numstat_reads_counts_renames_and_binaries() {
        let raw = b"3\t1\tsrc/a.ts\x002\t0\t\x00old.ts\x00new.ts\x00-\t-\tlogo.png\x00";
        let stats = parse_numstat(raw);
        assert_eq!(stats.len(), 3);
        assert_eq!(stats[0].0, "src/a.ts");
        assert_eq!((stats[0].1.added, stats[0].1.removed), (3, 1));
        assert_eq!(stats[1].0, "new.ts");
        assert_eq!(stats[1].1.added, 2);
        assert!(stats[2].1.binary);
    }

    #[test]
    fn upstream_track_reads_ahead_behind_and_gone() {
        assert_eq!(parse_track("[ahead 2, behind 3]"), (2, 3, false));
        assert_eq!(parse_track("[behind 1]"), (0, 1, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }

    #[test]
    fn log_reads_parents_refs_and_pushed_state() {
        let raw = "aaa\0a\0Ann\0ann@x\x00100\0bbb ccc\0HEAD -> main, origin/main, origin/HEAD, tag: v1\0Merge\x1e\nbbb\0b\0Bo\0bo@x\x0090\0\0\0First\x1e\n";
        let unpushed = std::collections::HashSet::from(["aaa".to_string()]);
        let commits = parse_log(raw, &unpushed);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(
            commits[0].refs,
            vec!["HEAD -> main", "origin/main", "tag: v1"]
        );
        assert!(commits[0].unpushed);
        assert!(commits[1].parents.is_empty());
        assert!(!commits[1].unpushed);
        assert_eq!(commits[1].subject, "First");
    }

    #[test]
    fn checks_sum_runs_and_statuses() {
        let rollup: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
                {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
                {"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""},
                {"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"},
                {"__typename":"StatusContext","state":"SUCCESS"}
            ]"#,
        )
        .unwrap();
        let checks = summarize_checks(&rollup).unwrap();
        assert_eq!((checks.passed, checks.failed, checks.pending), (2, 1, 1));
        assert!(summarize_checks(&[]).is_none());
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
            None,
        )
        .expect("diff");
        assert!(via_cmd.binary);
        assert!(via_cmd.hunks.is_empty());
    }

    #[test]
    fn base_is_the_committed_copy() {
        let scratch = Scratch::new("base");
        crate::roots::register(&scratch.0).expect("register");
        let root = scratch.0.to_string_lossy().into_owned();
        git(&scratch.0, &["init", "--quiet"]).expect("git init");
        std::fs::create_dir_all(scratch.0.join("src")).unwrap();
        std::fs::write(scratch.0.join("src/kept.txt"), "one\ntwo\n").unwrap();
        std::fs::write(scratch.0.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&scratch.0, &["add", "."]).expect("git add");
        let committed = git(
            &scratch.0,
            &[
                "-c",
                "user.name=Keel",
                "-c",
                "user.email=keel@example.com",
                "commit",
                "--quiet",
                "-m",
                "init",
            ],
        )
        .expect("git commit");
        assert!(
            committed.status.success(),
            "{}",
            user_err(&committed.stderr)
        );

        std::fs::write(scratch.0.join("src/kept.txt"), "one\nchanged\n").unwrap();
        std::fs::write(scratch.0.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(scratch.0.join("ignored.txt"), "secret\n").unwrap();

        assert_eq!(
            git_base_blocking(root.clone(), "src/kept.txt".into()).unwrap(),
            Some("one\ntwo\n".into())
        );
        assert_eq!(
            git_base_blocking(root.clone(), "new.txt".into()).unwrap(),
            Some(String::new())
        );
        assert_eq!(git_base_blocking(root, "ignored.txt".into()).unwrap(), None);

        // A project opened on a folder inside the repo still finds its files.
        let nested = scratch.0.join("src");
        crate::roots::register(&nested).expect("register nested");
        assert_eq!(
            git_base_blocking(nested.to_string_lossy().into_owned(), "kept.txt".into()).unwrap(),
            Some("one\ntwo\n".into())
        );
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
