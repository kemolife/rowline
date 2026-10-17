//! Guards for queries that Claude runs: one read-only statement, small results.

use crate::error::{AppError, AppResult};
use crate::model::QueryResult;
use crate::sqlgen::{self, Dialect};
use serde_json::Value;
use std::time::Duration;

pub const MAX_ROWS: usize = 200;
pub const MAX_VALUE_CHARS: usize = 2048;
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// Words that never appear in a read-only statement outside quotes and comments.
const WRITE_WORDS: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME",
    "GRANT", "REVOKE", "CALL", "LOAD", "HANDLER", "LOCK", "UNLOCK", "INTO", "ATTACH", "DETACH", "VACUUM", "REINDEX",
    "LOAD_FILE",
];

fn not_read_only() -> AppError {
    AppError::msg("Only read-only queries are allowed (SELECT, SHOW, EXPLAIN, WITH … SELECT).")
}

/// PRAGMAs that only read (SQLite). They must not have an `=`.
const PRAGMA_READS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "database_list",
    "collation_list",
    "function_list",
    "pragma_list",
    "compile_options",
];

fn one_statement() -> AppError {
    AppError::msg("Send one statement at a time.")
}

/// True for `PRAGMA [schema.]name` with a name from the read allowlist and no `=`.
fn is_pragma_read(masked: &str) -> bool {
    if masked.contains('=') {
        return false;
    }
    let rest = match masked.trim_start().get(..6) {
        Some(w) if w.eq_ignore_ascii_case("PRAGMA") => &masked.trim_start()[6..],
        _ => return false,
    };
    let target: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
        .collect();
    let name = target.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    PRAGMA_READS.contains(&name.as_str())
}

/// Words of the masked text; the flag tells if the next non-space char is `(`.
fn words_with_paren(masked: &str) -> Vec<(String, bool)> {
    let chars: Vec<char> = masked.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if is_word(chars[i]) {
            let start = i;
            while i < chars.len() && is_word(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect::<String>().to_ascii_uppercase();
            let paren = chars[i..].iter().find(|c| !c.is_whitespace()) == Some(&'(');
            out.push((word, paren));
        } else {
            i += 1;
        }
    }
    out
}

/// Returns the one statement in `sql` if it only reads data.
pub fn check(sql: &str, dialect: Dialect) -> AppResult<String> {
    let statements = sqlgen::split_statements(sql);
    let text = match statements.as_slice() {
        [] => return Err(AppError::msg("The query is empty.")),
        [one] => one.text.trim().trim_end_matches(';').trim().to_string(),
        _ => return Err(one_statement()),
    };
    let masked = mask(&text, dialect);
    if masked.contains(';') {
        return Err(one_statement());
    }
    let words = words_with_paren(&masked);
    let first = words.first().map(|(w, _)| w.as_str()).unwrap_or("");
    let pragma_read = dialect == Dialect::Sqlite && first == "PRAGMA" && is_pragma_read(&masked);
    if !(sqlgen::is_read_only_statement(&text) || pragma_read) {
        return Err(not_read_only());
    }
    if first != "SHOW" {
        let writes = words.iter().any(|(w, paren)| match w.as_str() {
            "REPLACE" | "INSERT" => !paren,
            _ => WRITE_WORDS.contains(&w.as_str()),
        });
        let joined: Vec<&str> = words.iter().map(|(w, _)| w.as_str()).collect();
        if writes || joined.join(" ").contains("FOR SHARE") {
            return Err(not_read_only());
        }
    }
    Ok(text)
}

/// Blanks out string literals, quoted identifiers and comments, so keywords inside them don't count.
/// Follows the server lexer: MySQL escapes with `\` inside '…' and "…", SQLite never does.
/// MySQL `/*! … */` and MariaDB `/*M! … */` comments are executed by the server, so their content is kept.
fn mask(sql: &str, dialect: Dialect) -> String {
    let mysql = dialect == Dialect::Mysql;
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '[' && !mysql {
            // SQLite `[identifier]`: no escapes, ends at the first `]`
            while i < chars.len() && chars[i] != ']' {
                i += 1;
            }
            out.push(' ');
            i += 1;
        } else if c == '\'' || c == '"' || c == '`' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && mysql && c != '`' {
                    i += 2;
                    continue;
                }
                if chars[i] == c {
                    if chars.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            out.push(' ');
            i += 1;
        } else if (c == '-'
            && next == Some('-')
            && (!mysql || chars.get(i + 2).map_or(true, |d| d.is_whitespace() || d.is_control())))
            || (c == '#' && mysql)
        {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            out.push(' ');
        } else if c == '/'
            && next == Some('*')
            && chars.get(i + 2) != Some(&'!')
            && !(chars.get(i + 2) == Some(&'M') && chars.get(i + 3) == Some(&'!'))
        {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            out.push(' ');
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Cuts text values longer than MAX_VALUE_CHARS, so one row can't flood the chat.
pub fn limit_values(result: &mut QueryResult) {
    for row in &mut result.rows {
        for v in row.iter_mut() {
            if let Value::String(s) = v {
                if s.chars().count() > MAX_VALUE_CHARS {
                    let cut: String = s.chars().take(MAX_VALUE_CHARS).collect();
                    *s = format!("{cut}…");
                }
            }
        }
    }
}

/// Checks, runs and trims one query for Claude.
pub async fn run_select(session: &crate::manager::Session, database: Option<&str>, sql: &str) -> AppResult<QueryResult> {
    let statement = check(sql, session.dialect())?;
    let mut result = session.select_read_only(database, &statement, MAX_ROWS).await?;
    limit_values(&mut result);
    result.statement = Some(statement);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlgen::Dialect::{Mysql, Sqlite};

    use crate::manager::Session;

    async fn sqlite_session(dir: &std::path::Path) -> Session {
        let path = dir.join("ro.sqlite");
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT);").unwrap();
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..250 {
            tx.execute("INSERT INTO t (body) VALUES (?1)", [format!("row {i}")]).unwrap();
        }
        tx.execute("INSERT INTO t (body) VALUES (?1)", ["x".repeat(5000)]).unwrap();
        tx.commit().unwrap();
        let config: crate::model::ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "c1", "name": "ro", "engine": "sqlite", "filePath": path.to_str().unwrap()
        })).unwrap();
        Session::open(&config, None).await.unwrap()
    }

    #[tokio::test]
    async fn run_select_limits_rows() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        let res = run_select(&s, None, "SELECT id, body FROM t").await.unwrap();
        assert_eq!(res.rows.len(), MAX_ROWS);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn long_values_are_cut() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        let res = run_select(&s, None, "SELECT body FROM t ORDER BY length(body) DESC LIMIT 1").await.unwrap();
        let body = res.rows[0][0].as_str().unwrap();
        assert_eq!(body.chars().count(), MAX_VALUE_CHARS + 1);
        assert!(body.ends_with('…'));
    }

    #[tokio::test]
    async fn sqlite_database_layer_blocks_writes() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        // skip the SQL check on purpose: the read-only connection itself must refuse
        let err = s.select_read_only(None, "DELETE FROM t", 10).await.unwrap_err().to_string();
        assert!(err.to_lowercase().contains("readonly") || err.to_lowercase().contains("read-only"), "{err}");
        let n = s.execute(None, "SELECT count(*) FROM t", 10).await.unwrap();
        assert_eq!(n[0].rows[0][0], 251);
        assert!(run_select(&s, None, "DELETE FROM t").await.unwrap_err().to_string().contains("read-only"));
    }

    #[test]
    fn accepts_plain_reads() {
        assert_eq!(check("SELECT * FROM t WHERE a = 1;", Mysql).unwrap(), "SELECT * FROM t WHERE a = 1");
        assert!(check("  -- note\nshow tables", Mysql).is_ok());
        assert!(check("EXPLAIN SELECT 1", Mysql).is_ok());
        assert!(check("WITH x AS (SELECT 1 AS n) SELECT n FROM x", Sqlite).is_ok());
        assert!(check("select `update`, \"delete\" from t where note = 'drop table x'", Mysql).is_ok());
        assert!(check("SELECT updated_at FROM t", Mysql).is_ok());
        assert!(check("PRAGMA table_info(t)", Sqlite).is_ok());
    }

    #[test]
    fn rejects_writes_and_tricks() {
        for sql in [
            "DELETE FROM t",
            "SELECT 1; DELETE FROM t",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "SELECT * INTO @a FROM t",
            "SELECT * FROM t FOR UPDATE",
            "SELECT * FROM t LOCK IN SHARE MODE",
            "SELECT * FROM t FOR SHARE",
            "WITH x AS (SELECT 1) DELETE FROM t",
            "WITH x AS (SELECT 1) UPDATE t SET a = 1",
            "SELECT 1 /*!50000 , (DELETE FROM t) */",
            "PRAGMA journal_mode = WAL",
            "",
            "   ;  ",
        ] {
            assert!(check(sql, Mysql).is_err() || check(sql, Sqlite).is_err(), "should reject: {sql}");
        }
        assert!(check("PRAGMA journal_mode = WAL", Sqlite).is_err());
        assert!(check("PRAGMA table_info(t)", Mysql).is_err(), "PRAGMA is SQLite only");
    }

    #[test]
    fn follows_the_server_lexer() {
        for sql in [
            r#"WITH x AS (SELECT "a\"") DELETE FROM t"#,
            r#"SELECT "a\"" INTO OUTFILE "/tmp/x""#,
            r#"SELECT "a\"" FOR UPDATE"#,
            "SELECT 1--1 INTO OUTFILE '/tmp/x'",
            "SELECT 1--1; DELETE FROM t",
            "SELECT 1 /*M!100000 , (DELETE FROM t) */",
        ] {
            assert!(check(sql, Mysql).is_err(), "should reject: {sql}");
        }
        assert!(check("SELECT 1 -- note", Mysql).is_ok());
        assert!(check(r#"SELECT 'a\'' FROM t"#, Mysql).is_ok());
        assert!(check(r#"SELECT "a\" FROM t"#, Sqlite).is_ok());
    }

    #[test]
    fn sqlite_bracket_identifiers() {
        assert!(check("WITH x AS (SELECT [a']) DELETE FROM t WHERE '1'='1'", Sqlite).is_err());
        assert!(check("SELECT [order] FROM t", Sqlite).is_ok());
    }

    #[test]
    fn pragma_allowlist() {
        assert!(check("PRAGMA table_info(t)", Sqlite).is_ok());
        assert!(check("pragma main.index_list(t)", Sqlite).is_ok());
        for sql in ["PRAGMA user_version(5)", "PRAGMA journal_mode(DELETE)", "PRAGMA wal_checkpoint", "PRAGMA optimize"] {
            assert!(check(sql, Sqlite).is_err(), "should reject: {sql}");
        }
    }

    #[test]
    fn show_and_function_names() {
        for sql in [
            "SHOW CREATE TABLE t",
            "SHOW GRANTS",
            "SELECT REPLACE(name, 'a', 'b') FROM t",
            "SELECT INSERT(name, 1, 2, 'x') FROM t",
        ] {
            assert!(check(sql, Mysql).is_ok(), "should accept: {sql}");
        }
        assert!(check("REPLACE INTO t VALUES (1)", Mysql).is_err());
    }

    #[test]
    fn rejects_reading_server_files() {
        assert!(check("SELECT LOAD_FILE('/etc/passwd')", Mysql).is_err());
        assert!(check("select load_file ('/etc/passwd') as f", Mysql).is_err());
        assert!(check("SELECT 'load_file' AS note", Mysql).is_ok(), "only the function, not text");
    }

    #[test]
    fn error_messages_explain_the_rule() {
        assert!(check("SELECT 1; SELECT 2", Mysql).unwrap_err().to_string().contains("one statement"));
        assert!(check("DELETE FROM t", Mysql).unwrap_err().to_string().contains("read-only"));
    }
}
