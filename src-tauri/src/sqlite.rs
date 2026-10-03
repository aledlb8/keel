//! A read-only look inside SQLite databases in the project: their tables, a
//! page of rows at a time, and a query box for reads.
//!
//! The connection is opened read-only and cannot attach other files, so a
//! query can neither change the database nor reach outside it. Queries that
//! would write are refused before they run, and every statement gives up after
//! a few seconds instead of tying up a thread.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::limits::Limit;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Statement};
use serde::Serialize;
use serde_json::{json, Value};

use crate::paths::{normalize_rel, rejects_git_open, resolve_existing};

const PAGE_MAX: u32 = 500;
const QUERY_ROWS: usize = 1000;
/// Long text is cut here: a cell is a glance, not a reader.
const TEXT_MAX: usize = 2000;
const TIME_LIMIT: Duration = Duration::from_secs(8);
/// JavaScript numbers are exact up to here; larger integers travel as text.
const SAFE_INTEGER: i64 = (1 << 53) - 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteColumn {
    pub name: String,
    pub decl_type: String,
    pub primary_key: bool,
    pub not_null: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteTable {
    pub name: String,
    pub kind: String,
    pub columns: Vec<SqliteColumn>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// Every row the table holds; `None` for a query.
    pub total: Option<u64>,
    /// A query returned more rows than were sent.
    pub truncated: bool,
}

fn open(root: &str, rel: &str) -> Result<Connection, String> {
    let root = crate::roots::require(root)?;
    rejects_git_open(&normalize_rel(rel)?)?;
    let path = resolve_existing(&root, rel)?;
    if path.is_dir() {
        return Err(format!("{} is a folder", path.display()));
    }
    open_path(&path)
}

fn open_path(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| err.to_string())?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)
        .map_err(|err| err.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|err| err.to_string())?;
    let started = Instant::now();
    conn.progress_handler(10_000, Some(move || started.elapsed() > TIME_LIMIT))
        .map_err(|err| err.to_string())?;
    Ok(conn)
}

fn message(err: rusqlite::Error) -> String {
    match err {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            "This took too long and was stopped.".into()
        }
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::NotADatabase =>
        {
            "This is not a SQLite database, or it is encrypted.".into()
        }
        rusqlite::Error::MultipleStatement => "Run one statement at a time.".into(),
        other => other.to_string(),
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn cell(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(int) if int.abs() <= SAFE_INTEGER => json!(int),
        ValueRef::Integer(int) => Value::String(int.to_string()),
        ValueRef::Real(real) => serde_json::Number::from_f64(real)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(real.to_string())),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            match text.char_indices().nth(TEXT_MAX) {
                Some((cut, _)) => Value::String(format!("{}…", &text[..cut])),
                None => Value::String(text.into_owned()),
            }
        }
        ValueRef::Blob(bytes) => json!({ "blob": bytes.len() }),
    }
}

/// Up to `limit` rows; `truncated` when there were more. No `total`.
fn collect(
    stmt: &mut Statement<'_>,
    params: impl rusqlite::Params,
    limit: usize,
) -> Result<SqliteRows, String> {
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let width = columns.len();
    let mut rows = Vec::new();
    let mut cursor = stmt.query(params).map_err(message)?;
    while let Some(row) = cursor.next().map_err(message)? {
        if rows.len() == limit {
            return Ok(SqliteRows {
                columns,
                rows,
                total: None,
                truncated: true,
            });
        }
        let mut values = Vec::with_capacity(width);
        for index in 0..width {
            values.push(cell(row.get_ref(index).map_err(message)?));
        }
        rows.push(values);
    }
    Ok(SqliteRows {
        columns,
        rows,
        total: None,
        truncated: false,
    })
}

fn tables(conn: &Connection) -> Result<Vec<SqliteTable>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, type FROM sqlite_schema \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY type, name COLLATE NOCASE",
        )
        .map_err(message)?;
    let named: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(message)?
        .collect::<Result<_, _>>()
        .map_err(message)?;
    let mut columns = conn
        .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1)")
        .map_err(message)?;
    named
        .into_iter()
        .map(|(name, kind)| {
            let cols = columns
                .query_map([&name], |row| {
                    Ok(SqliteColumn {
                        name: row.get(0)?,
                        decl_type: row.get(1)?,
                        not_null: row.get::<_, i64>(2)? != 0,
                        primary_key: row.get::<_, i64>(3)? != 0,
                    })
                })
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
                // A view over a table that is gone has no columns to list.
                .unwrap_or_default();
            Ok(SqliteTable {
                name,
                kind,
                columns: cols,
            })
        })
        .collect()
}

fn rows(conn: &Connection, table: &str, offset: u64, limit: u32) -> Result<SqliteRows, String> {
    if !tables(conn)?.iter().any(|known| known.name == table) {
        return Err(format!("There is no table named {table}."));
    }
    let from = quote_ident(table);
    let total: i64 = conn
        .query_row(&format!("SELECT count(*) FROM {from}"), [], |row| {
            row.get(0)
        })
        .map_err(message)?;
    let limit = limit.clamp(1, PAGE_MAX);
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {from} LIMIT ?1 OFFSET ?2"))
        .map_err(message)?;
    let offset = i64::try_from(offset).unwrap_or(i64::MAX);
    let page = collect(&mut stmt, (limit, offset), limit as usize)?;
    Ok(SqliteRows {
        total: Some(total.max(0) as u64),
        truncated: false,
        ..page
    })
}

/// Statements a read-only look may run. `readonly()` has the last word.
fn reads_only(sql: &str) -> bool {
    let first = sql
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|word| !word.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        first.as_str(),
        "select" | "with" | "values" | "explain" | "pragma"
    )
}

fn query(conn: &Connection, sql: &str) -> Result<SqliteRows, String> {
    let sql = sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err("Write a query to run.".into());
    }
    if !reads_only(sql) {
        return Err("Only queries that read run here.".into());
    }
    let mut stmt = conn.prepare(sql).map_err(message)?;
    if !stmt.readonly() {
        return Err("Only queries that read run here.".into());
    }
    collect(&mut stmt, [], QUERY_ROWS)
}

#[tauri::command]
pub async fn sqlite_tables(root: String, rel: String) -> Result<Vec<SqliteTable>, String> {
    crate::blocking::run(move || tables(&open(&root, &rel)?)).await
}

#[tauri::command]
pub async fn sqlite_rows(
    root: String,
    rel: String,
    table: String,
    offset: u64,
    limit: u32,
) -> Result<SqliteRows, String> {
    crate::blocking::run(move || rows(&open(&root, &rel)?, &table, offset, limit)).await
}

#[tauri::command]
pub async fn sqlite_query(root: String, rel: String, sql: String) -> Result<SqliteRows, String> {
    crate::blocking::run(move || query(&open(&root, &rel)?, &sql)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Db(PathBuf);

    impl Db {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "keel-sqlite-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&dir).unwrap();
            let conn = Connection::open(dir.join("app.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar BLOB, big INTEGER);
                 INSERT INTO users (name, avatar, big) VALUES ('ada', x'0102', 9007199254740993);
                 INSERT INTO users (name) VALUES ('grace');
                 INSERT INTO users (name) VALUES ('linus');
                 CREATE TABLE \"odd \"\"name\" (x);
                 CREATE VIEW named AS SELECT name FROM users;",
            )
            .unwrap();
            Self(dir)
        }

        fn conn(&self) -> Connection {
            open_path(&self.0.join("app.db")).unwrap()
        }
    }

    impl Drop for Db {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_tables_and_views_with_columns() {
        let db = Db::new("tables");
        let listed = tables(&db.conn()).unwrap();
        let names: Vec<_> = listed
            .iter()
            .map(|t| (t.name.as_str(), t.kind.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("odd \"name", "table"),
                ("users", "table"),
                ("named", "view")
            ]
        );
        let users = &listed[1];
        assert_eq!(users.columns.len(), 4);
        assert!(users.columns[0].primary_key);
        assert!(users.columns[1].not_null);
        assert_eq!(users.columns[1].decl_type, "TEXT");
    }

    #[test]
    fn pages_rows_and_describes_cells() {
        let db = Db::new("rows");
        let conn = db.conn();
        let page = rows(&conn, "users", 0, 2).unwrap();
        assert_eq!(page.total, Some(3));
        assert_eq!(page.columns, ["id", "name", "avatar", "big"]);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[0][1], json!("ada"));
        assert_eq!(page.rows[0][2], json!({ "blob": 2 }));
        assert_eq!(page.rows[0][3], json!("9007199254740993"));
        assert_eq!(page.rows[1][2], Value::Null);
        let rest = rows(&conn, "users", 2, 2).unwrap();
        assert_eq!(rest.rows.len(), 1);
        assert!(rows(&conn, "odd \"name", 0, 10).is_ok());
        assert!(rows(&conn, "users; DROP TABLE users", 0, 10).is_err());
    }

    #[test]
    fn queries_read_and_nothing_else() {
        let db = Db::new("query");
        let conn = db.conn();
        let found = query(&conn, "SELECT name FROM users WHERE id > 1;").unwrap();
        assert_eq!(found.rows, [[json!("grace")], [json!("linus")]]);
        assert!(!found.truncated);

        for sql in [
            "DELETE FROM users",
            "WITH x AS (SELECT 1) INSERT INTO users (name) SELECT 'no' FROM x",
            "VACUUM INTO 'copy.db'",
            "ATTACH DATABASE 'other.db' AS other",
            "SELECT 1; DROP TABLE users",
        ] {
            assert!(query(&conn, sql).is_err(), "{sql} ran");
        }
        assert_eq!(rows(&conn, "users", 0, 10).unwrap().total, Some(3));
    }

    #[test]
    fn truncates_long_results() {
        let db = Db::new("limits");
        let conn = db.conn();
        let many = query(
            &conn,
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 5000) SELECT x FROM n",
        )
        .unwrap();
        assert_eq!(many.rows.len(), QUERY_ROWS);
        assert!(many.truncated);
    }

    #[test]
    fn rejects_files_that_are_not_databases() {
        let dir = std::env::temp_dir().join(format!("keel-sqlite-not-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.db"), "plain text, not a database at all").unwrap();
        let err = open_path(&dir.join("notes.db"))
            .and_then(|conn| tables(&conn))
            .unwrap_err();
        assert!(err.contains("not a SQLite database"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }
}
