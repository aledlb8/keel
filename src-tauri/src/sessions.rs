//! Where coding CLIs keep their conversations, so a pane can reopen *its* chat
//! rather than whatever happened to run last in this folder.
//!
//! `grok` and `claude` write one file per conversation. `opencode` and `codex`
//! write rows into SQLite, which is opened read-only — Keel never writes
//! another tool's storage.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::pty::home_dir;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProbe {
    /// `grok`, `claude`, `opencode`, or `codex` — each CLI lays its work out differently.
    pub store: String,
    pub cwd: String,
    #[serde(default)]
    pub account_env: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// How claude names a project folder for a conversation's cwd.
///
/// Every character outside `[A-Za-z0-9]` becomes `-`, one dash per UTF-16 code
/// unit, so spaces, dots, underscores, parentheses and non-ASCII characters all
/// count. A slug longer than 200 units is truncated and suffixed with a base-36
/// hash of the whole path, so two long folders cannot share one directory.
/// Mirrors claude 2.1.x `~/.claude/projects/<slug>/<session>.jsonl`.
const CLAUDE_SLUG_LIMIT: usize = 200;

fn claude_slug(cwd: &str) -> String {
    let mut slug = String::with_capacity(cwd.len());
    for unit in cwd.encode_utf16() {
        match char::from_u32(u32::from(unit)) {
            Some(ch) if ch.is_ascii_alphanumeric() => slug.push(ch),
            _ => slug.push('-'),
        }
    }
    if slug.len() <= CLAUDE_SLUG_LIMIT {
        return slug;
    }
    format!(
        "{}-{}",
        &slug[..CLAUDE_SLUG_LIMIT],
        base36(claude_hash(cwd).unsigned_abs())
    )
}

/// Java's `String.hashCode` over UTF-16 code units — the digest in the suffix.
fn claude_hash(value: &str) -> i32 {
    let mut hash: i32 = 0;
    for unit in value.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    hash
}

fn base36(mut value: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    out.into_iter().map(char::from).collect()
}

/// opencode's data home on every platform, the way its `xdg-basedir`
/// dependency computes it: `XDG_DATA_HOME`, else `~/.local/share`. It does not
/// follow `%APPDATA%` on Windows.
fn opencode_data_home() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(xdg));
    }
    home_dir().map(|home| home.join(".local").join("share"))
}

fn session_root(app: &AppHandle, probe: &SessionProbe) -> Option<PathBuf> {
    if let (Some(_), Some(account_id)) = (&probe.account_env, &probe.account_id) {
        let valid = account_id
            .chars()
            .all(|ch| ch == '_' || ch == '-' || ch.is_ascii_alphanumeric());
        if valid {
            let dir = app
                .path()
                .app_config_dir()
                .ok()?
                .join("accounts")
                .join(account_id);
            // opencode treats `XDG_DATA_HOME` as a home and appends its own
            // directory, so an account's files sit one level below it.
            return Some(if probe.store == "opencode" {
                dir.join("opencode")
            } else {
                dir
            });
        }
    }
    let home = home_dir()?;
    match probe.store.as_str() {
        "grok" => Some(home.join(".grok")),
        "claude" => Some(home.join(".claude")),
        "opencode" => Some(opencode_data_home()?.join("opencode")),
        "codex" => Some(home.join(".codex")),
        _ => None,
    }
}

/// Where opencode keeps its SQLite database inside one data directory.
///
/// `OPENCODE_DB` is the CLI's own override: `:memory:` means nothing on disk,
/// an absolute path is used as-is, and a bare name is relative to the data
/// directory. Without it the official builds name the file `opencode.db`;
/// developer channels name it `opencode-<channel>.db`.
fn opencode_db(data_dir: &Path, forced: Option<&OsStr>) -> Option<PathBuf> {
    if let Some(forced) = forced {
        if forced == ":memory:" {
            return None;
        }
        let forced = PathBuf::from(forced);
        return Some(if forced.is_absolute() {
            forced
        } else {
            data_dir.join(forced)
        });
    }
    let standard = data_dir.join("opencode.db");
    if standard.is_file() {
        return Some(standard);
    }
    let mut channels: Vec<PathBuf> = std::fs::read_dir(data_dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            (name.starts_with("opencode-") && name.ends_with(".db")).then(|| entry.path())
        })
        .collect();
    channels.sort_by_key(|path| {
        path.metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    channels.pop()
}

/// A conversation is minted when the CLI creates it, which for opencode means
/// the first submitted prompt. `time_created` is that moment, in milliseconds.
/// Only top-level sessions count: a subagent's session is not the chat a pane
/// owns and would restore the wrong conversation.
#[cfg(windows)]
const OPENCODE_SESSIONS: &str = "
    SELECT id, time_created FROM session
    WHERE parent_id IS NULL AND REPLACE(directory, '\\', '/') = ?1 COLLATE NOCASE
    ORDER BY time_created DESC
    LIMIT 64";

#[cfg(not(windows))]
const OPENCODE_SESSIONS: &str = "
    SELECT id, time_created FROM session
    WHERE parent_id IS NULL AND directory = ?1
    ORDER BY time_created DESC
    LIMIT 64";

fn list_opencode_ids(data_dir: &Path, cwd: &str) -> Vec<(String, SystemTime)> {
    let Some(db) = opencode_db(data_dir, std::env::var_os("OPENCODE_DB").as_deref()) else {
        return Vec::new();
    };
    if !db.is_file() {
        return Vec::new();
    }
    let Ok(connection) = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    // The database is in WAL mode and a live pane is writing to it. Readers do
    // not block writers, but a checkpoint can still make one wait briefly.
    let _ = connection.busy_timeout(Duration::from_millis(1_000));
    let Ok(mut statement) = connection.prepare(OPENCODE_SESSIONS) else {
        return Vec::new();
    };

    let directory = if cfg!(windows) {
        cwd.replace('\\', "/")
    } else {
        cwd.to_string()
    };
    let Ok(rows) = statement.query_map([directory], |row| {
        let id: String = row.get(0)?;
        let created: i64 = row.get(1)?;
        Ok((id, created))
    }) else {
        return Vec::new();
    };

    rows.flatten()
        .filter(|(id, _)| is_session_id(id))
        .map(|(id, created)| {
            (
                id,
                SystemTime::UNIX_EPOCH + Duration::from_millis(created.max(0) as u64),
            )
        })
        .collect()
}

/// Codex 0.155 stores one row per thread in `state_5.sqlite`. The cwd is the
/// Windows verbatim form (`\\?\C:\...`). Only CLI threads count: a subagent
/// row would resume the wrong conversation.
const CODEX_THREADS: &str = "
    SELECT id, cwd,
           CASE
             WHEN created_at_ms > 100000000000 THEN created_at_ms
             WHEN created_at > 100000000000 THEN created_at
             ELSE created_at * 1000
           END
    FROM threads
    WHERE archived = 0
      AND source = 'cli'
      AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)
    ORDER BY 3 DESC
    LIMIT 256";

const CODEX_THREADS_NO_EDGES: &str = "
    SELECT id, cwd,
           CASE
             WHEN created_at_ms > 100000000000 THEN created_at_ms
             WHEN created_at > 100000000000 THEN created_at
             ELSE created_at * 1000
           END
    FROM threads
    WHERE archived = 0
      AND source = 'cli'
    ORDER BY 3 DESC
    LIMIT 256";

/// `CODEX_SQLITE_HOME` when this is the default install; otherwise the Codex
/// home itself, then `sqlite/state_5.sqlite` for a home that keeps the
/// database one directory down.
fn codex_state_db(home: &Path, isolated_account: bool) -> Option<PathBuf> {
    if !isolated_account {
        if let Some(sqlite_home) =
            std::env::var_os("CODEX_SQLITE_HOME").filter(|value| !value.is_empty())
        {
            let path = PathBuf::from(sqlite_home).join("state_5.sqlite");
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let direct = home.join("state_5.sqlite");
    if direct.is_file() {
        return Some(direct);
    }
    let nested = home.join("sqlite").join("state_5.sqlite");
    nested.is_file().then_some(nested)
}

fn codex_cwd_key(path: &str) -> String {
    let slash = path.replace('/', "\\");
    let stripped = if let Some(rest) = slash.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = slash.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        slash
    };
    let trimmed = stripped.trim_end_matches('\\');
    let text = if trimmed.len() == 2 && trimmed.as_bytes().get(1) == Some(&b':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    };
    text.to_lowercase()
}

fn list_codex_ids(db: &Path, cwd: &str) -> Vec<(String, SystemTime)> {
    if !db.is_file() {
        return Vec::new();
    }
    let Ok(connection) = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = connection.busy_timeout(Duration::from_millis(500));
    let Some(rows) = codex_thread_rows(&connection, CODEX_THREADS)
        .or_else(|| codex_thread_rows(&connection, CODEX_THREADS_NO_EDGES))
    else {
        return Vec::new();
    };
    let wanted = codex_cwd_key(cwd);
    rows.into_iter()
        .filter(|(id, path, _)| is_session_id(id) && codex_cwd_key(path) == wanted)
        .map(|(id, _, created)| {
            (
                id,
                SystemTime::UNIX_EPOCH + Duration::from_millis(created.max(0) as u64),
            )
        })
        .collect()
}

fn codex_thread_rows(connection: &Connection, sql: &str) -> Option<Vec<(String, String, i64)>> {
    let mut statement = connection.prepare(sql).ok()?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let cwd: String = row.get(1)?;
            let created: i64 = row.get(2)?;
            Ok((id, cwd, created))
        })
        .ok()?;
    Some(rows.flatten().collect())
}

fn is_session_id(id: &str) -> bool {
    let n = id.len();
    (1..=128).contains(&n)
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' | b'.' | b'_' | b'-'))
}

fn cwd_is_listable(cwd: &str) -> bool {
    if cwd.is_empty() || cwd.contains('\0') {
        return false;
    }
    let path = Path::new(cwd);
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return false;
    }
    if path.is_dir() {
        crate::roots::is_under_registered(path)
    } else {
        true
    }
}

fn is_encoded_segment(encoded: &str) -> bool {
    if encoded.is_empty() || encoded.contains('\0') {
        return false;
    }
    let mut parts = Path::new(encoded).components();
    matches!(parts.next(), Some(Component::Normal(_))) && parts.next().is_none()
}

fn list_dir_ids(dir: &Path) -> Vec<(String, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !is_session_id(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        found.push((name, mtime));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    found
}

fn list_jsonl_ids(dir: &Path) -> Vec<(String, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if !is_session_id(stem) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        found.push((stem.to_string(), mtime));
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    found
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    pub id: String,
    pub mtime_ms: u64,
}

fn to_hits(ids: Vec<(String, SystemTime)>) -> Vec<SessionHit> {
    ids.into_iter()
        .map(|(id, mtime)| SessionHit {
            id,
            mtime_ms: mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        })
        .collect()
}

fn session_recent_inner(app: &AppHandle, probe: &SessionProbe) -> Result<Vec<SessionHit>, String> {
    let Some(root) = session_root(app, probe) else {
        return Ok(Vec::new());
    };
    if !cwd_is_listable(&probe.cwd) {
        return Ok(Vec::new());
    }
    let ids = match probe.store.as_str() {
        "grok" => {
            let encoded = percent_encode(&probe.cwd);
            if !is_encoded_segment(&encoded) {
                return Ok(Vec::new());
            }
            list_dir_ids(&root.join("sessions").join(encoded))
        }
        "claude" => {
            let encoded = claude_slug(&probe.cwd);
            if !is_encoded_segment(&encoded) {
                return Ok(Vec::new());
            }
            list_jsonl_ids(&root.join("projects").join(encoded))
        }
        "opencode" => list_opencode_ids(&root, &probe.cwd),
        "codex" => {
            let isolated = probe.account_id.is_some() && probe.account_env.is_some();
            let Some(db) = codex_state_db(&root, isolated) else {
                return Ok(Vec::new());
            };
            list_codex_ids(&db, &probe.cwd)
        }
        _ => Vec::new(),
    };
    Ok(to_hits(ids))
}

/// Session ids for this store + folder, newest first.
#[tauri::command]
pub async fn session_recent(
    app: AppHandle,
    probe: SessionProbe,
) -> Result<Vec<SessionHit>, String> {
    crate::blocking::run(move || session_recent_inner(&app, &probe)).await
}

#[cfg(test)]
mod tests {
    use super::{
        claude_slug, codex_cwd_key, cwd_is_listable, is_encoded_segment, is_session_id,
        list_codex_ids, list_jsonl_ids, list_opencode_ids, opencode_db, percent_encode, to_hits,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "keel-sessions-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A SQLite file shaped like the `session` table opencode writes.
    fn opencode_db_with(dir: &Path, rows: &[(&str, Option<&str>, &str, i64)]) -> PathBuf {
        let db = dir.join("opencode.db");
        let connection = rusqlite::Connection::open(&db).expect("open db");
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT,
                    directory TEXT NOT NULL,
                    time_created INTEGER NOT NULL
                );",
            )
            .expect("schema");
        for (id, parent, directory, created) in rows {
            connection
                .execute(
                    "INSERT INTO session (id, parent_id, directory, time_created)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![id, parent, directory, created],
                )
                .expect("insert");
        }
        db
    }

    #[test]
    fn grok_encodes_a_windows_path() {
        assert_eq!(
            percent_encode(r"C:\Users\developer\Documents\code\keel"),
            "C%3A%5CUsers%5Cdeveloper%5CDocuments%5Ccode%5Ckeel"
        );
    }

    #[test]
    fn claude_dashes_a_windows_path() {
        assert_eq!(
            claude_slug(r"C:\Users\developer\Documents\code\keel"),
            "C--Users-developer-Documents-code-keel"
        );
    }

    #[test]
    fn claude_slug_replaces_every_non_alphanumeric() {
        // Verified against claude 2.1.274: the folder it created for this cwd.
        assert_eq!(
            claude_slug(r"C:\Users\alede\AppData\Local\Temp\opencode\keel test.folder"),
            "C--Users-alede-AppData-Local-Temp-opencode-keel-test-folder"
        );
        assert_eq!(
            claude_slug("/Users/developer/code/my_app (v2)"),
            "-Users-developer-code-my-app--v2-"
        );
    }

    #[test]
    fn claude_slug_counts_utf16_units() {
        // One dash for `é`; the rocket is a surrogate pair, so two.
        assert_eq!(
            claude_slug("C:\\Users\\alede\\AppData\\Local\\Temp\\opencode\\probe-émoji-🚀"),
            "C--Users-alede-AppData-Local-Temp-opencode-probe--moji---"
        );
    }

    #[test]
    fn claude_slug_truncates_long_paths_with_the_java_hash() {
        // Verified against claude 2.1.274: the folder it created for this path.
        let long = format!(
            "{}{}",
            r"C:\Users\alede\AppData\Local\Temp\opencode\probe-",
            "b".repeat(160)
        );
        assert_eq!(long.len(), 209);
        let slug = claude_slug(&long);
        assert_eq!(slug.len(), 207);
        assert!(slug.ends_with("-8q2m4q"), "slug was {slug}");
    }

    #[test]
    fn is_session_id_matches_the_allowed_charset() {
        assert!(is_session_id("11111111-1111-4111-8111-111111111111"));
        assert!(is_session_id("abc-123"));
        assert!(is_session_id(&"a".repeat(128)));
        assert!(is_session_id(".."));
        assert!(!is_session_id(""));
        assert!(!is_session_id(&"a".repeat(129)));
        assert!(!is_session_id("has space"));
        assert!(!is_session_id("x & calc"));
        assert!(!is_session_id("id;rm"));
        assert!(!is_session_id(";"));
        assert!(!is_session_id("$()"));
        assert!(!is_session_id("$(reboot)"));
    }

    #[test]
    fn list_jsonl_ids_skips_illegal_names() {
        let dir = temp_dir();
        fs::write(dir.join("abc-123.jsonl"), b"").unwrap();
        fs::write(dir.join("x & calc.jsonl"), b"").unwrap();
        let names: Vec<_> = list_jsonl_ids(&dir).into_iter().map(|(id, _)| id).collect();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["abc-123".to_string()]);
    }

    #[test]
    fn cwd_rejects_empty_nul_and_parent() {
        assert!(!cwd_is_listable(""));
        assert!(!cwd_is_listable("foo\0bar"));
        assert!(!cwd_is_listable(".."));
        assert!(!cwd_is_listable("."));
        assert!(cwd_is_listable(
            "/this/folder/does/not/exist-keel-sessions-test"
        ));
        assert!(!is_encoded_segment(""));
        assert!(!is_encoded_segment(".."));
        assert!(!is_encoded_segment("."));
        assert!(is_encoded_segment(
            "C%3A%5CUsers%5Cdeveloper%5CDocuments%5Ccode%5Ckeel"
        ));
    }

    #[test]
    fn opencode_lists_only_this_folder_top_level_newest_first() {
        let dir = temp_dir();
        opencode_db_with(
            &dir,
            &[
                ("ses_old", None, "C:/code/keel", 1_000),
                ("ses_new", None, "C:/code/keel", 3_000),
                ("ses_other", None, "C:/code/other", 4_000),
                ("ses_child", Some("ses_old"), "C:/code/keel", 5_000),
                ("x & calc", None, "C:/code/keel", 6_000),
            ],
        );
        let hits = to_hits(list_opencode_ids(&dir, "C:/code/keel"));
        let ids: Vec<_> = hits.iter().map(|hit| hit.id.as_str()).collect();
        fs::remove_dir_all(&dir).ok();

        assert_eq!(ids, vec!["ses_new", "ses_old"]);
        assert_eq!(hits[0].id, "ses_new");
        assert_eq!(hits[0].mtime_ms, 3_000);
    }

    #[cfg(windows)]
    #[test]
    fn opencode_matches_a_windows_cwd_across_separators_and_case() {
        let dir = temp_dir();
        opencode_db_with(
            &dir,
            &[("ses_a", None, "c:/users/developer/code/keel", 1_000)],
        );
        let ids: Vec<_> = list_opencode_ids(&dir, r"C:\Users\Developer\Code\Keel")
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(ids, vec!["ses_a".to_string()]);
    }

    #[test]
    fn opencode_without_a_database_is_empty() {
        let dir = temp_dir();
        let ids = list_opencode_ids(&dir, "C:/code/keel");
        fs::remove_dir_all(&dir).ok();
        assert!(ids.is_empty());
    }

    #[test]
    fn opencode_db_follows_the_cli_overrides() {
        let dir = temp_dir();
        let standard = dir.join("opencode.db");
        fs::write(&standard, b"").unwrap();
        assert_eq!(opencode_db(&dir, None), Some(standard.clone()));

        let absolute = dir.join("elsewhere.db");
        assert_eq!(
            opencode_db(&dir, Some(absolute.as_os_str())),
            Some(absolute.clone())
        );
        assert_eq!(
            opencode_db(&dir, Some(std::ffi::OsStr::new("custom.db"))),
            Some(dir.join("custom.db"))
        );
        assert_eq!(
            opencode_db(&dir, Some(std::ffi::OsStr::new(":memory:"))),
            None
        );

        fs::remove_file(&standard).unwrap();
        let channel = dir.join("opencode-local.db");
        fs::write(&channel, b"").unwrap();
        assert_eq!(opencode_db(&dir, None), Some(channel));
        fs::remove_dir_all(&dir).ok();
    }

    fn codex_db_with(dir: &Path, rows: &[(&str, &str, i64, i64, &str)]) -> PathBuf {
        let db = dir.join("state_5.sqlite");
        let connection = rusqlite::Connection::open(&db).expect("open db");
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    cwd TEXT,
                    created_at INTEGER,
                    created_at_ms INTEGER,
                    archived INTEGER,
                    source TEXT
                );
                CREATE TABLE thread_spawn_edges (
                    parent_thread_id TEXT,
                    child_thread_id TEXT,
                    status TEXT
                );",
            )
            .expect("schema");
        for (id, cwd, created_ms, archived, source) in rows {
            connection
                .execute(
                    "INSERT INTO threads (id, cwd, created_at, created_at_ms, archived, source)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![id, cwd, created_ms / 1000, created_ms, archived, source],
                )
                .expect("insert");
        }
        connection
            .execute(
                "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
                 VALUES ('parent-thread', 'child-thread', 'running')",
                [],
            )
            .expect("edge");
        db
    }

    #[test]
    fn codex_cwd_key_strips_the_verbatim_prefix_and_ignores_case() {
        assert_eq!(
            codex_cwd_key(r"\\?\C:\Users\Developer\Code\Keel"),
            r"c:\users\developer\code\keel"
        );
        assert_eq!(
            codex_cwd_key("C:/Users/Developer/Code/Keel/"),
            r"c:\users\developer\code\keel"
        );
        assert_eq!(codex_cwd_key(r"C:\"), r"c:\");
    }

    #[test]
    fn codex_lists_cli_threads_for_this_folder_newest_first() {
        let dir = temp_dir();
        let subagent = r#"{"subagent":{"thread_spawn":{"parent_thread_id":"old-thread"}}}"#;
        codex_db_with(
            &dir,
            &[
                (
                    "old-thread",
                    r"\\?\C:\Users\developer\code\keel",
                    1_000,
                    0,
                    "cli",
                ),
                (
                    "new-thread",
                    r"\\?\C:\Users\Developer\Code\Keel\",
                    3_000,
                    0,
                    "cli",
                ),
                (
                    "other-thread",
                    r"\\?\C:\Users\developer\code\other",
                    4_000,
                    0,
                    "cli",
                ),
                (
                    "vscode-thread",
                    r"C:\Users\developer\code\keel",
                    5_000,
                    0,
                    "vscode",
                ),
                (
                    "archived-thread",
                    r"C:\Users\developer\code\keel",
                    6_000,
                    1,
                    "cli",
                ),
                (
                    "child-thread",
                    r"C:\Users\developer\code\keel",
                    7_000,
                    0,
                    "cli",
                ),
                ("bad id", r"C:\Users\developer\code\keel", 8_000, 0, "cli"),
                (
                    "spawned-thread",
                    r"C:\Users\developer\code\keel",
                    9_000,
                    0,
                    subagent,
                ),
            ],
        );
        let hits = to_hits(list_codex_ids(
            &dir.join("state_5.sqlite"),
            r"C:\Users\developer\code\keel",
        ));
        let ids: Vec<_> = hits.iter().map(|hit| hit.id.as_str()).collect();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(ids, vec!["new-thread", "old-thread"]);
        assert_eq!(hits[0].mtime_ms, 3_000);
    }
}
