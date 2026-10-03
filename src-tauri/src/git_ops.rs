//! Git past status and commit: a commit's contents, stashes, tags, branch
//! surgery, merges, and the operations that can stop halfway for conflicts.
//!
//! The rules of `git.rs` hold here too. Subcommands are fixed, and every name
//! or revision that reaches git is checked first so it can never be read as
//! an option.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::git::{
    apply_git_env, default_remote, git, git_dirs, git_ok, hide_window, parse_diff, parse_numstat,
    rel_arg, rels, repo_operation, user_err, valid_remote_name, wait_output_timeout, GitDiff,
    LineStat, GIT_REMOTE_TIMEOUT, GIT_TIMEOUT,
};

const MAX_COMMIT_FILES: usize = 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: String,
    pub stat: Option<LineStat>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub committer: String,
    pub commit_timestamp: i64,
    pub subject: String,
    /// Everything after the subject line, trimmed.
    pub body: String,
    pub parents: Vec<String>,
    pub files: Vec<CommitFile>,
    /// More files changed than are listed.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub index: u32,
    pub hash: String,
    pub message: String,
    pub branch: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    /// The commit it points at, through an annotated tag if there is one.
    pub hash: String,
    pub annotated: bool,
    pub subject: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

/// A branch, tag or other ref name that git will not mistake for an option.
pub(crate) fn checked_ref(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.contains("..")
        || name.contains("@{")
        || name.contains("//")
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        });
    if bad {
        Err(format!("\"{name}\" is not a name git accepts."))
    } else {
        Ok(name)
    }
}

/// A commit named by its hash, or by a ref.
pub(crate) fn checked_rev(rev: &str) -> Result<&str, String> {
    let rev = rev.trim();
    let hex = (4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit());
    if hex {
        Ok(rev)
    } else {
        checked_ref(rev)
    }
}

/// Run git where it might want an editor or stop on conflicts, and say what
/// happened in a sentence rather than as a wall of output.
fn run_git(root: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_git_env(&mut cmd);
    // Nothing here is interactive. Without this, a merge or a `--continue`
    // would open the user's editor — or wait forever for one with no terminal.
    cmd.env("GIT_EDITOR", "true");
    hide_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|err| format!("Could not run git: {err}"))?;
    let output = wait_output_timeout(child, timeout, "git")?;
    let stdout = crate::git::redact_git_output(&String::from_utf8_lossy(&output.stdout));
    let stderr = user_err(&output.stderr);
    if output.status.success() {
        return Ok(stdout.trim().to_string());
    }
    let combined = format!("{stdout}\n{stderr}");
    let conflicts = combined
        .lines()
        .filter(|line| line.starts_with("CONFLICT"))
        .count();
    if conflicts > 0 {
        let files = if conflicts == 1 { "file" } else { "files" };
        return Err(format!(
            "Stopped on conflicts in {conflicts} {files}. Resolve them, then continue."
        ));
    }
    let err = if stderr.is_empty() {
        stdout.trim().to_string()
    } else {
        stderr
    };
    Err(if err.is_empty() {
        format!("git {} failed", args.first().copied().unwrap_or(""))
    } else {
        err
    })
}

// ---- A commit's contents ---------------------------------------------------

#[tauri::command]
pub async fn git_commit_details(root: String, rev: String) -> Result<CommitDetails, String> {
    crate::blocking::run(move || git_commit_details_blocking(root, rev)).await
}

fn git_commit_details_blocking(root: String, rev: String) -> Result<CommitDetails, String> {
    let rev = checked_rev(&rev)?;
    let root = crate::roots::require(&root)?;
    let raw = git_ok(
        &root,
        &[
            "show",
            "-s",
            "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%P%x00%B",
            rev,
            "--",
        ],
    )?;
    let mut bits = raw.splitn(9, '\0');
    let mut next = || bits.next().unwrap_or("").to_string();
    let hash = next();
    let short = next();
    let author = next();
    let email = next();
    let timestamp = next().parse().unwrap_or(0);
    let committer = next();
    let commit_timestamp = next().parse().unwrap_or(0);
    let parents: Vec<String> = next().split_whitespace().map(str::to_string).collect();
    let message = next();
    let (subject, body) = split_message(&message);

    let base = parents.first().cloned();
    let (files, truncated) = changed_files(&root, base.as_deref(), &hash)?;
    Ok(CommitDetails {
        hash,
        short,
        author,
        email,
        timestamp,
        committer,
        commit_timestamp,
        subject,
        body,
        parents,
        files,
        truncated,
    })
}

pub(crate) fn split_message(message: &str) -> (String, String) {
    let message = message.trim();
    match message.split_once('\n') {
        Some((subject, body)) => (subject.trim().to_string(), body.trim().to_string()),
        None => (message.to_string(), String::new()),
    }
}

/// `diff-tree` against the first parent, or against nothing for a root commit.
fn diff_tree_args<'a>(base: Option<&'a str>, rev: &'a str) -> Vec<&'a str> {
    let mut args = vec![
        "diff-tree",
        "-r",
        "-z",
        "-M",
        "--no-commit-id",
        "--no-color",
    ];
    match base {
        Some(base) => args.extend([base, rev]),
        None => args.extend(["--root", rev]),
    }
    args
}

fn changed_files(
    root: &Path,
    base: Option<&str>,
    rev: &str,
) -> Result<(Vec<CommitFile>, bool), String> {
    let mut names = diff_tree_args(base, rev);
    names.push("--name-status");
    let listed = git(root, &names)?;
    if !listed.status.success() {
        return Err(user_err(&listed.stderr));
    }
    let mut stats_args = diff_tree_args(base, rev);
    stats_args.push("--numstat");
    let stats: HashMap<String, LineStat> = git(root, &stats_args)
        .ok()
        .filter(|out| out.status.success())
        .map(|out| parse_numstat(&out.stdout).into_iter().collect())
        .unwrap_or_default();

    let mut files = parse_name_status(&listed.stdout);
    let truncated = files.len() > MAX_COMMIT_FILES;
    files.truncate(MAX_COMMIT_FILES);
    for file in &mut files {
        file.stat = stats.get(&file.path).copied();
    }
    Ok((files, truncated))
}

/// `--name-status -z`: `M\0path\0`, or `R100\0from\0to\0` for a rename or copy.
pub(crate) fn parse_name_status(raw: &[u8]) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut parts = raw
        .split(|b| *b == 0)
        .map(|part| String::from_utf8_lossy(part).replace('\\', "/"));
    while let Some(code) = parts.next() {
        let Some(letter) = code.chars().next() else {
            continue;
        };
        let (orig_path, path) = if matches!(letter, 'R' | 'C') {
            let from = parts.next();
            (from, parts.next())
        } else {
            (None, parts.next())
        };
        let Some(path) = path.filter(|p| !p.is_empty()) else {
            continue;
        };
        let status = match letter {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            'T' => "typechange",
            _ => "modified",
        };
        files.push(CommitFile {
            path,
            orig_path,
            status: status.into(),
            stat: None,
        });
    }
    files
}

/// One file as a commit changed it.
#[tauri::command]
pub async fn git_diff_rev(
    root: String,
    rev: String,
    path: String,
    orig_path: Option<String>,
) -> Result<GitDiff, String> {
    crate::blocking::run(move || git_diff_rev_blocking(root, rev, path, orig_path)).await
}

fn git_diff_rev_blocking(
    root: String,
    rev: String,
    path: String,
    orig_path: Option<String>,
) -> Result<GitDiff, String> {
    let rev = checked_rev(&rev)?;
    let root = crate::roots::require(&root)?;
    let rel = rel_arg(&root, &path)?;
    let orig = orig_path
        .filter(|p| !p.is_empty())
        .map(|p| rel_arg(&root, &p))
        .transpose()?;
    let parent = git_ok(&root, &["rev-parse", "--verify", "-q", &format!("{rev}^1")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut args = diff_tree_args(parent.as_deref(), rev);
    // `-z` is for listings; a patch is read line by line.
    args.retain(|arg| *arg != "-z");
    args.extend(["-p", "--unified=3", "--"]);
    // Both names, so the rename is still found inside the narrowed diff.
    if let Some(orig) = orig.as_deref() {
        args.push(orig);
    }
    args.push(&rel);
    let raw = git_ok(&root, &args)?;
    Ok(parse_diff(&raw, &rel))
}

// ---- Commit, undone -------------------------------------------------------

/// The last commit's message, for amending it.
#[tauri::command]
pub async fn git_head_message(root: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let root = crate::roots::require(&root)?;
        git_ok(&root, &["log", "-1", "--format=%B"]).map(|s| s.trim().to_string())
    })
    .await
}

/// Take the last commit back, keeping its changes staged. Returns its message
/// so it can go back in the box.
#[tauri::command]
pub async fn git_undo_commit(root: String) -> Result<String, String> {
    crate::blocking::run(move || git_undo_commit_blocking(root)).await
}

fn git_undo_commit_blocking(root: String) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    let message = git_ok(&root, &["log", "-1", "--format=%B"])?
        .trim()
        .to_string();
    let has_parent = git_ok(&root, &["rev-parse", "--verify", "-q", "HEAD^1"]).is_ok();
    if has_parent {
        run_git(&root, &["reset", "--soft", "HEAD~1"], GIT_TIMEOUT)?;
    } else {
        // The first commit has nothing to step back to: unborn the branch.
        run_git(&root, &["update-ref", "-d", "HEAD"], GIT_TIMEOUT)?;
    }
    Ok(message)
}

// ---- Stashes ----------------------------------------------------------------

#[tauri::command]
pub async fn git_stash_list(root: String) -> Result<Vec<GitStash>, String> {
    crate::blocking::run(move || git_stash_list_blocking(root)).await
}

fn git_stash_list_blocking(root: String) -> Result<Vec<GitStash>, String> {
    let root = crate::roots::require(&root)?;
    let raw = git_ok(
        &root,
        &["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs"],
    )?;
    Ok(parse_stash_list(&raw))
}

pub(crate) fn parse_stash_list(raw: &str) -> Vec<GitStash> {
    let mut stashes = Vec::new();
    for line in raw.lines() {
        let mut bits = line.trim_end_matches('\r').split('\0');
        let selector = bits.next().unwrap_or("");
        let Some(index) = selector
            .strip_prefix("stash@{")
            .and_then(|rest| rest.strip_suffix('}'))
            .and_then(|n| n.parse().ok())
        else {
            continue;
        };
        let hash = bits.next().unwrap_or("").to_string();
        let timestamp = bits.next().unwrap_or("0").parse().unwrap_or(0);
        let summary = bits.next().unwrap_or("");
        // "WIP on main: 1a2b3c4 subject" or "On main: the message".
        let (branch, message) = summary
            .strip_prefix("WIP on ")
            .or_else(|| summary.strip_prefix("On "))
            .and_then(|rest| rest.split_once(": "))
            .map(|(branch, message)| (Some(branch.to_string()), message.to_string()))
            .unwrap_or((None, summary.to_string()));
        stashes.push(GitStash {
            index,
            hash,
            message,
            branch,
            timestamp,
        });
    }
    stashes
}

#[tauri::command]
pub async fn git_stash_push(
    root: String,
    message: Option<String>,
    include_untracked: bool,
    paths: Option<Vec<String>>,
) -> Result<String, String> {
    crate::blocking::run(move || git_stash_push_blocking(root, message, include_untracked, paths))
        .await
}

fn git_stash_push_blocking(
    root: String,
    message: Option<String>,
    include_untracked: bool,
    paths: Option<Vec<String>>,
) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    let paths = rels(&root, &paths.unwrap_or_default())?;
    let message = message
        .map(|m| m.trim().replace(['\n', '\r'], " "))
        .filter(|m| !m.is_empty());
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(message) = message.as_deref() {
        args.extend(["-m", message]);
    }
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    let out = run_git(&root, &args, GIT_TIMEOUT)?;
    if out.contains("No local changes to save") {
        return Err("There is nothing to stash.".into());
    }
    Ok("Stashed your changes".into())
}

/// The stash at `index`, but only if it is still the one the list showed:
/// indices shift whenever a stash is added or dropped.
fn stash_selector(root: &Path, index: u32, hash: &str) -> Result<String, String> {
    let selector = format!("stash@{{{index}}}");
    let actual = git_ok(root, &["rev-parse", "--verify", "-q", &selector])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if actual.is_empty() || actual != hash.trim() {
        return Err("The stash list changed. Look again and retry.".into());
    }
    Ok(selector)
}

#[tauri::command]
pub async fn git_stash_apply(
    root: String,
    index: u32,
    hash: String,
    pop: bool,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let root = crate::roots::require(&root)?;
        let selector = stash_selector(&root, index, &hash)?;
        let verb = if pop { "pop" } else { "apply" };
        run_git(&root, &["stash", verb, &selector], GIT_TIMEOUT)?;
        Ok(if pop {
            "Popped the stash".into()
        } else {
            "Applied the stash".into()
        })
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(root: String, index: u32, hash: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let root = crate::roots::require(&root)?;
        let selector = stash_selector(&root, index, &hash)?;
        run_git(&root, &["stash", "drop", &selector], GIT_TIMEOUT)?;
        Ok("Dropped the stash".into())
    })
    .await
}

// ---- Tags -------------------------------------------------------------------

#[tauri::command]
pub async fn git_tags(root: String) -> Result<Vec<GitTag>, String> {
    crate::blocking::run(move || {
        let root = crate::roots::require(&root)?;
        let raw = git_ok(
            &root,
            &[
                "for-each-ref",
                "--sort=-creatordate",
                "--count=200",
                "--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(creatordate:unix)%00%(contents:subject)",
                "refs/tags",
            ],
        )?;
        Ok(parse_tags(&raw))
    })
    .await
}

pub(crate) fn parse_tags(raw: &str) -> Vec<GitTag> {
    raw.lines()
        .filter_map(|line| {
            let mut bits = line.trim_end_matches('\r').split('\0');
            let name = bits.next()?.to_string();
            let object = bits.next().unwrap_or("");
            let peeled = bits.next().unwrap_or("");
            let annotated = bits.next().unwrap_or("") == "tag";
            let timestamp = bits.next().unwrap_or("0").parse().unwrap_or(0);
            let subject = bits.next().unwrap_or("").to_string();
            if name.is_empty() {
                return None;
            }
            Some(GitTag {
                name,
                hash: if peeled.is_empty() { object } else { peeled }.to_string(),
                annotated,
                subject,
                timestamp,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_tag_create(
    root: String,
    name: String,
    rev: String,
    message: Option<String>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let name = checked_ref(&name)?;
        let rev = checked_rev(&rev)?;
        let root = crate::roots::require(&root)?;
        let message = message
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        let mut args = vec!["tag"];
        if let Some(message) = message.as_deref() {
            args.extend(["-a", "-m", message]);
        }
        args.extend([name, rev]);
        run_git(&root, &args, GIT_TIMEOUT)?;
        Ok(format!("Tagged {name}"))
    })
    .await
}

#[tauri::command]
pub async fn git_tag_delete(root: String, name: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let name = checked_ref(&name)?;
        let root = crate::roots::require(&root)?;
        run_git(&root, &["tag", "-d", name], GIT_TIMEOUT)?;
        Ok(format!("Deleted the tag {name}"))
    })
    .await
}

#[tauri::command]
pub async fn git_tag_push(root: String, name: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let name = checked_ref(&name)?;
        let root = crate::roots::require(&root)?;
        let remote = default_remote(&root);
        let refspec = format!("refs/tags/{name}");
        run_git(&root, &["push", &remote, &refspec], GIT_REMOTE_TIMEOUT)?;
        Ok(format!("Pushed {name} to {remote}"))
    })
    .await
}

// ---- Branches ---------------------------------------------------------------

#[tauri::command]
pub async fn git_branch_rename(root: String, from: String, to: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let from = checked_ref(&from)?;
        let to = checked_ref(&to)?;
        let root = crate::roots::require(&root)?;
        run_git(&root, &["branch", "-m", from, to], GIT_TIMEOUT)?;
        Ok(format!("Renamed {from} to {to}"))
    })
    .await
}

fn remote_names(root: &Path) -> Vec<String> {
    git_ok(root, &["remote"])
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|name| valid_remote_name(name))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// `origin/feature/x` → (`origin`, `feature/x`), by the remotes that exist —
/// a remote's own name can hold a slash.
fn split_remote_branch(root: &Path, name: &str) -> Result<(String, String), String> {
    let mut remotes = remote_names(root);
    remotes.sort_by_key(|remote| std::cmp::Reverse(remote.len()));
    remotes
        .into_iter()
        .find_map(|remote| {
            name.strip_prefix(&format!("{remote}/"))
                .filter(|branch| !branch.is_empty())
                .map(|branch| (remote.clone(), branch.to_string()))
        })
        .ok_or_else(|| format!("{name} is not on a remote this repository knows."))
}

/// Check out a remote branch as a local one that tracks it.
#[tauri::command]
pub async fn git_checkout_remote(root: String, name: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let name = checked_ref(&name)?.to_string();
        let root = crate::roots::require(&root)?;
        let (_, local) = split_remote_branch(&root, &name)?;
        let exists = git_ok(
            &root,
            &[
                "rev-parse",
                "--verify",
                "-q",
                &format!("refs/heads/{local}"),
            ],
        )
        .is_ok();
        if exists {
            run_git(&root, &["checkout", &local], GIT_TIMEOUT)?;
        } else {
            run_git(
                &root,
                &["checkout", "-b", &local, "--track", &name],
                GIT_TIMEOUT,
            )?;
        }
        Ok(format!("On {local}"))
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_rev(root: String, rev: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let rev = checked_rev(&rev)?;
        let root = crate::roots::require(&root)?;
        run_git(&root, &["checkout", "--detach", rev], GIT_TIMEOUT)?;
        Ok(format!("Checked out {}", &rev[..rev.len().min(7)]))
    })
    .await
}

#[tauri::command]
pub async fn git_branch_delete_remote(root: String, name: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let name = checked_ref(&name)?.to_string();
        let root = crate::roots::require(&root)?;
        let (remote, branch) = split_remote_branch(&root, &name)?;
        run_git(
            &root,
            &["push", &remote, "--delete", &branch],
            GIT_REMOTE_TIMEOUT,
        )?;
        Ok(format!("Deleted {branch} from {remote}"))
    })
    .await
}

// ---- Merge, rebase, pick, revert, reset ---------------------------------------

#[tauri::command]
pub async fn git_merge(root: String, name: String, mode: Option<String>) -> Result<String, String> {
    crate::blocking::run(move || {
        let name = checked_ref(&name)?;
        let root = crate::roots::require(&root)?;
        let mut args = vec!["merge", "--no-edit"];
        match mode.as_deref().unwrap_or("default") {
            "default" => {}
            "no-ff" => args.push("--no-ff"),
            "ff-only" => args.push("--ff-only"),
            "squash" => args.push("--squash"),
            other => return Err(format!("Unknown merge mode: {other}")),
        }
        args.push(name);
        let out = run_git(&root, &args, GIT_TIMEOUT)?;
        if mode.as_deref() == Some("squash") {
            return Ok(format!("Squashed {name} into your staged changes"));
        }
        Ok(if out.contains("Already up to date") {
            "Already up to date".into()
        } else {
            format!("Merged {name}")
        })
    })
    .await
}

#[tauri::command]
pub async fn git_rebase(root: String, onto: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let onto = checked_ref(&onto)?;
        let root = crate::roots::require(&root)?;
        run_git(&root, &["rebase", onto], GIT_TIMEOUT)?;
        Ok(format!("Rebased onto {onto}"))
    })
    .await
}

fn is_merge_commit(root: &Path, rev: &str) -> bool {
    git_ok(root, &["rev-parse", "--verify", "-q", &format!("{rev}^2")]).is_ok()
}

#[tauri::command]
pub async fn git_cherry_pick(root: String, rev: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let rev = checked_rev(&rev)?;
        let root = crate::roots::require(&root)?;
        let mut args = vec!["cherry-pick"];
        // A merge has to say which side it is replaying against.
        if is_merge_commit(&root, rev) {
            args.extend(["-m", "1"]);
        }
        args.push(rev);
        run_git(&root, &args, GIT_TIMEOUT)?;
        Ok(format!("Picked {}", &rev[..rev.len().min(7)]))
    })
    .await
}

#[tauri::command]
pub async fn git_revert(root: String, rev: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let rev = checked_rev(&rev)?;
        let root = crate::roots::require(&root)?;
        let mut args = vec!["revert", "--no-edit"];
        if is_merge_commit(&root, rev) {
            args.extend(["-m", "1"]);
        }
        args.push(rev);
        run_git(&root, &args, GIT_TIMEOUT)?;
        Ok(format!("Reverted {}", &rev[..rev.len().min(7)]))
    })
    .await
}

#[tauri::command]
pub async fn git_reset(root: String, rev: String, mode: String) -> Result<String, String> {
    crate::blocking::run(move || {
        let rev = checked_rev(&rev)?;
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            other => return Err(format!("Unknown reset mode: {other}")),
        };
        let root = crate::roots::require(&root)?;
        run_git(&root, &["reset", flag, rev], GIT_TIMEOUT)?;
        Ok(format!("Reset to {}", &rev[..rev.len().min(7)]))
    })
    .await
}

/// Finish, abandon or step past whatever stopped halfway.
#[tauri::command]
pub async fn git_operation(root: String, action: String) -> Result<String, String> {
    crate::blocking::run(move || git_operation_blocking(root, action)).await
}

fn git_operation_blocking(root: String, action: String) -> Result<String, String> {
    let root = crate::roots::require(&root)?;
    let op = git_dirs(&root)
        .and_then(|(git_dir, _)| repo_operation(&git_dir))
        .ok_or_else(|| "Nothing is in progress.".to_string())?;
    let flag = match action.as_str() {
        "continue" => "--continue",
        "abort" => "--abort",
        "skip" => "--skip",
        other => return Err(format!("Unknown action: {other}")),
    };
    let args: Vec<&str> = match (op.as_str(), flag) {
        // A merge is finished by committing it, with the message git prepared.
        ("merge", "--continue") => vec!["commit", "--no-edit"],
        ("merge", "--skip") => return Err("A merge can't skip; abort it instead.".into()),
        (op, flag) => vec![op, flag],
    };
    run_git(&root, &args, GIT_TIMEOUT)?;
    let done = match action.as_str() {
        "continue" => "Continued",
        "abort" => "Aborted",
        _ => "Skipped",
    };
    Ok(format!("{done} the {op}"))
}

// ---- Conflicts and ignores ------------------------------------------------

/// Settle conflicts by taking one side whole, and mark them resolved.
#[tauri::command]
pub async fn git_resolve(root: String, paths: Vec<String>, side: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let flag = match side.as_str() {
            "ours" => "--ours",
            "theirs" => "--theirs",
            other => return Err(format!("Unknown side: {other}")),
        };
        let root = crate::roots::require(&root)?;
        let paths = rels(&root, &paths)?;
        if paths.is_empty() {
            return Ok(());
        }
        let mut checkout = vec!["checkout", flag, "--"];
        checkout.extend(paths.iter().map(String::as_str));
        run_git(&root, &checkout, GIT_TIMEOUT)?;
        let mut add = vec!["add", "--"];
        add.extend(paths.iter().map(String::as_str));
        run_git(&root, &add, GIT_TIMEOUT)?;
        Ok(())
    })
    .await
}

/// Add a pattern to the project's `.gitignore`, once.
#[tauri::command]
pub async fn git_ignore(root: String, pattern: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let pattern = pattern.trim();
        if pattern.is_empty() || pattern.contains(['\n', '\r', '\0']) {
            return Err("That is not a pattern .gitignore can hold.".into());
        }
        let root = crate::roots::require(&root)?;
        let path = root.join(".gitignore");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        if existing.lines().any(|line| line.trim() == pattern) {
            return Ok(());
        }
        let mut next = existing;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(pattern);
        next.push('\n');
        std::fs::write(&path, next).map_err(|err| format!("Could not write .gitignore: {err}"))
    })
    .await
}

/// Put a folder that isn't under version control yet under it.
#[tauri::command]
pub async fn git_init(root: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let root = crate::roots::require(&root)?;
        run_git(&root, &["init"], GIT_TIMEOUT).map(|_| ())
    })
    .await
}

// ---- Remotes --------------------------------------------------------------

#[tauri::command]
pub async fn git_remotes(root: String) -> Result<Vec<GitRemote>, String> {
    crate::blocking::run(move || {
        let root = crate::roots::require(&root)?;
        let raw = git_ok(&root, &["remote", "-v"])?;
        Ok(parse_remotes(&raw))
    })
    .await
}

pub(crate) fn parse_remotes(raw: &str) -> Vec<GitRemote> {
    let mut remotes: Vec<GitRemote> = Vec::new();
    for line in raw.lines() {
        let mut bits = line.split_whitespace();
        let (Some(name), Some(url)) = (bits.next(), bits.next()) else {
            continue;
        };
        if remotes.iter().any(|remote| remote.name == name) {
            continue;
        }
        remotes.push(GitRemote {
            name: name.to_string(),
            url: strip_userinfo(url),
        });
    }
    remotes
}

/// Drop `user:token@` from an http(s) URL, so credentials never reach the UI.
fn strip_userinfo(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if path.is_empty() {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}/{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_that_look_like_options_are_refused() {
        assert!(checked_ref("--upload-pack=x").is_err());
        assert!(checked_ref("-b").is_err());
        assert!(checked_ref("a..b").is_err());
        assert!(checked_ref("has space").is_err());
        assert!(checked_ref("stash@{0}").is_err());
        assert_eq!(checked_ref("feature/login"), Ok("feature/login"));
        assert_eq!(checked_rev("1a2b3c4"), Ok("1a2b3c4"));
        assert_eq!(checked_rev("origin/main"), Ok("origin/main"));
    }

    #[test]
    fn name_status_reads_renames() {
        let raw = b"M\0src/a.ts\0R087\0old.ts\0new.ts\0A\0b.md\0";
        let files = parse_name_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].status, "renamed");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.ts"));
        assert_eq!(files[1].path, "new.ts");
        assert_eq!(files[2].status, "added");
    }

    #[test]
    fn stash_list_splits_branch_and_message() {
        let raw = "stash@{0}\0abc\x00100\0On main: halfway there\nstash@{1}\0def\x0090\0WIP on dev: 1a2b3c4 subject\n";
        let stashes = parse_stash_list(raw);
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].branch.as_deref(), Some("main"));
        assert_eq!(stashes[0].message, "halfway there");
        assert_eq!(stashes[1].branch.as_deref(), Some("dev"));
        assert_eq!(stashes[1].message, "1a2b3c4 subject");
    }

    #[test]
    fn tags_peel_to_their_commit() {
        let raw = "v1\0aaa\0ccc\0tag\x00100\0Release one\nlight\0bbb\0\0commit\x0090\0subject\n";
        let tags = parse_tags(raw);
        assert_eq!(tags[0].hash, "ccc");
        assert!(tags[0].annotated);
        assert_eq!(tags[1].hash, "bbb");
        assert!(!tags[1].annotated);
    }

    #[test]
    fn remotes_never_carry_credentials() {
        let raw = "origin\thttps://user:tok@github.com/o/r.git (fetch)\norigin\thttps://user:tok@github.com/o/r.git (push)\nup\tgit@github.com:o/r.git (fetch)\n";
        let remotes = parse_remotes(raw);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].url, "https://github.com/o/r.git");
        assert_eq!(remotes[1].url, "git@github.com:o/r.git");
    }

    #[test]
    fn message_splits_subject_from_body() {
        assert_eq!(
            split_message("feat: x\n\nWhy it matters.\n"),
            ("feat: x".to_string(), "Why it matters.".to_string())
        );
        assert_eq!(
            split_message("one line"),
            ("one line".to_string(), String::new())
        );
    }
}
