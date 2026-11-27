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

/// Functions that do something besides reading: named locks stay on the (pooled) connection after the
/// rollback and can block the application; sleeping and benchmarking only hold a connection and the server.
const BLOCKED_FUNCTIONS: &[&str] = &["GET_LOCK", "RELEASE_LOCK", "RELEASE_ALL_LOCKS", "IS_FREE_LOCK", "IS_USED_LOCK", "SLEEP", "BENCHMARK"];

fn blocked_function(name: &str) -> AppError {
    AppError::msg(format!("{name}() is not allowed: lock, sleep and benchmark functions are refused in read-only queries."))
}

/// MySQL schemas with users, password hashes, grants and other sessions' SQL. A read-only transaction
/// does not hide them, so AI and CLI reads refuse them (and the live process list).
const SYSTEM_SCHEMAS: &[&str] = &["mysql", "performance_schema", "sys"];

fn system_data() -> AppError {
    AppError::msg("This query reads MySQL system data (mysql.*, performance_schema, sys or the process list). It is not allowed for AI and CLI reads.")
}

/// Err when `database` is a MySQL system schema (an unqualified `FROM user` would read `mysql.user`).
pub fn blocked_database(database: Option<&str>) -> AppResult<()> {
    match database {
        Some(db) if SYSTEM_SCHEMAS.iter().any(|s| s.eq_ignore_ascii_case(db.trim())) => Err(system_data()),
        _ => Ok(()),
    }
}

/// True when the statement names a system schema (`mysql.x`, `` `sys`.x ``) or the process list.
fn reads_system_data(sql: &str) -> bool {
    let text = mask_with(sql, Dialect::Mysql, true);
    let chars: Vec<char> = text.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    let mut i = 0;
    while i < chars.len() {
        if !is_word(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        // `db.mysql.x` is not a thing, but `t.mysql` (a column) must not count as a schema
        let after_dot = chars[..start].iter().rev().find(|c| !c.is_whitespace()) == Some(&'.');
        while i < chars.len() && is_word(chars[i]) {
            i += 1;
        }
        let word = chars[start..i].iter().collect::<String>().to_ascii_lowercase();
        let qualifier = chars[i..].iter().find(|c| !c.is_whitespace()) == Some(&'.');
        if word == "processlist" || (qualifier && !after_dot && SYSTEM_SCHEMAS.contains(&word.as_str())) {
            return true;
        }
    }
    false
}

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
    if dialect == Dialect::Postgres && sql.contains('\r') {
        // the server ends `--` comments at \r: refused outright, so no reading of it can differ
        return Err(AppError::msg("Read-only queries can't contain a carriage return (\\r). Use plain line breaks (\\n)."));
    }
    let statements = sqlgen::split_statements_for(sql, dialect);
    let text = match statements.as_slice() {
        [] => return Err(AppError::msg("The query is empty.")),
        [one] => one.text.trim().trim_end_matches(';').trim().to_string(),
        _ => return Err(one_statement()),
    };
    if dialect == Dialect::Postgres {
        return check_postgres(text);
    }
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
    if let Some((name, _)) = words.iter().find(|(w, paren)| *paren && BLOCKED_FUNCTIONS.contains(&w.as_str())) {
        return Err(blocked_function(name));
    }
    if dialect == Dialect::Mysql && reads_system_data(&text) {
        return Err(system_data());
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

/// Upper-case words outside quotes and comments. Read with every lexer we know (backslash escapes on
/// and off), so a word hidden from one reading still counts. Used by `sqlgen::is_read_only_statement`.
pub(crate) fn code_words(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    for dialect in [Dialect::Mysql, Dialect::Sqlite] {
        out.extend(words_with_paren(&mask(sql, dialect)).into_iter().map(|(w, _)| w));
    }
    for backslash in [false, true] {
        out.extend(words_with_next(&mask_postgres(sql, backslash, false).text).into_iter().map(|(w, _)| w));
    }
    out
}

/// Blanks out string literals, quoted identifiers and comments, so keywords inside them don't count.
/// Follows the server lexer: MySQL escapes with `\` inside '…' and "…", SQLite never does.
/// MySQL `/*! … */` and MariaDB `/*M! … */` comments are executed by the server, so their content is kept.
fn mask(sql: &str, dialect: Dialect) -> String {
    mask_with(sql, dialect, false)
}

/// Like `mask`, but MySQL `` `quoted` `` identifiers keep their name (to see which schema a query reads).
fn mask_with(sql: &str, dialect: Dialect, keep_backticks: bool) -> String {
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
            let start = i;
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
            if keep_backticks && c == '`' {
                out.push(' ');
                out.extend(chars[start..i.min(chars.len())].iter().filter(|ch| **ch != '`'));
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

// ---------------------------------------------------------------------------------------------
// PostgreSQL rules. Deny-list on top of the server-side READ ONLY transaction: a read-only
// transaction still lets a query read server files, open network connections (dblink), sleep,
// take advisory locks, bump sequences or send notifications, so those are refused here.

/// First words of statements that only read.
const PG_READ_STARTS: &[&str] = &["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN"];

/// Words that never appear (outside quotes and comments) in a Postgres read: data-changing CTEs,
/// SELECT … INTO, row locks (FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE), EXPLAIN ANALYZE and
/// statements that are not reads at all.
const PG_WRITE_WORDS: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "COPY", "TRUNCATE", "CREATE", "DROP", "ALTER", "GRANT", "REVOKE",
    "CALL", "DO", "LOCK", "SHARE", "ANALYZE", "ANALYSE", "EXECUTE", "PREPARE", "DEALLOCATE", "LISTEN", "NOTIFY",
    "UNLISTEN", "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "DISCARD", "CHECKPOINT", "DECLARE", "SECURITY", "IMPORT",
];

/// Functions (and extension schemas) refused when called (`name(` / `name (` / `schema.name(`) or
/// used as a qualifier (`name.`). Exact names first, then prefixes, then parts of a name.
const PG_BLOCKED_FUNCTIONS: &[&str] = &[
    "PG_STAT_FILE", "LOREAD", "LOWRITE", "NEXTVAL", "SETVAL", "PG_NOTIFY", "SET_CONFIG", "PG_TERMINATE_BACKEND",
    "PG_CANCEL_BACKEND", "PG_RELOAD_CONF", "PG_ROTATE_LOGFILE", "PG_PROMOTE", "PG_SWITCH_WAL", "PG_SWITCH_XLOG",
    "PG_EXPORT_SNAPSHOT", "PG_DROP_REPLICATION_SLOT", "PG_CREATE_RESTORE_POINT", "PG_START_BACKUP", "PG_STOP_BACKUP",
    "PG_LOG_BACKEND_MEMORY_CONTEXTS", "PG_IMPORT_SYSTEM_COLLATIONS", "PG_TRUNCATE_VISIBILITY_MAP", "PG_PREWARM",
    "TS_STAT", "TS_REWRITE", "CONNECTBY", "GIN_CLEAN_PENDING_LIST", "HTTP", "INVOKE", "QUERY_EXPORT_TO_S3",
    "TABLE_IMPORT_FROM_S3", "AWS_S3", "AWS_LAMBDA", "AWS_ML", "AWS_COMMONS", "XPATH_TABLE",
];
const PG_BLOCKED_PREFIXES: &[&str] = &[
    "PG_READ_", "PG_LS_", "PG_SLEEP", "LO_", "DBLINK", "PG_ADVISORY", "PG_TRY_ADVISORY", "PG_LOGICAL_", "PG_CREATE_",
    "PG_REPLICATION_", "PG_COPY_", "TXID_", "PG_CURRENT_XACT_ID", "PG_FILE_", "PG_LOGDIR", "PG_STAT_RESET", "BRIN_",
    "PG_BACKGROUND", "HTTP_", "CROSSTAB", "PG_WAL_REPLAY_", "PG_BACKUP_",
];
/// `query_to_xml`, `table_to_xml`, `cursor_to_xmlschema`… run SQL from a string or a whole table/schema
/// (`xpath_table` of the xml2 extension does too: it is in `PG_BLOCKED_FUNCTIONS`)
const PG_BLOCKED_PARTS: &[&str] = &["_TO_XML"];

fn pg_blocked_function(word: &str) -> bool {
    PG_BLOCKED_FUNCTIONS.contains(&word)
        || PG_BLOCKED_PREFIXES.iter().any(|p| word.starts_with(p))
        || PG_BLOCKED_PARTS.iter().any(|p| word.contains(p))
}

/// Catalogs and views with password hashes, other sessions' SQL, server config files, user mapping
/// options, large objects, column statistics samples and TOAST data. Refused wherever they are named.
const PG_SYSTEM_DATA: &[&str] = &[
    "PG_AUTHID", "PG_SHADOW", "PG_USER_MAPPING", "PG_USER_MAPPINGS", "PG_HBA_FILE_RULES", "PG_IDENT_FILE_MAPPINGS",
    "PG_FILE_SETTINGS", "PG_STAT_ACTIVITY", "PG_STAT_GET_ACTIVITY", "PG_DB_ROLE_SETTING",
];
const PG_SYSTEM_DATA_PREFIXES: &[&str] =
    &["PG_STAT_STATEMENTS", "PG_STAT_GET_BACKEND_", "PG_LARGEOBJECT", "PG_SUBSCRIPTION", "PG_STATISTIC", "PG_TOAST"];

/// Any name with these parts: user mappings hold foreign-server passwords (`pg_user_mapping(s)`,
/// `information_schema.user_mapping_options`, `information_schema._pg_user_mappings`…).
const PG_SYSTEM_DATA_PARTS: &[&str] = &["USER_MAPPING"];

fn pg_system_name(word: &str) -> bool {
    PG_SYSTEM_DATA.contains(&word)
        || PG_SYSTEM_DATA_PREFIXES.iter().any(|p| word.starts_with(p))
        || PG_SYSTEM_DATA_PARTS.iter().any(|p| word.contains(p))
}

fn pg_not_read_only() -> AppError {
    AppError::msg("Only read-only queries are allowed (SELECT, WITH … SELECT, VALUES, TABLE, SHOW, EXPLAIN without ANALYZE).")
}

fn pg_system_data() -> AppError {
    AppError::msg("This query reads PostgreSQL system data (roles and passwords, other sessions' queries, server config, large objects or TOAST data). It is not allowed for AI and CLI reads.")
}

fn pg_blocked(name: &str) -> AppError {
    AppError::msg(format!(
        "{name}() is not allowed: functions that read server files, reach the network, sleep, take locks, change settings or sequences, or run SQL from text are refused in read-only queries."
    ))
}

/// Err when `schema` is a Postgres system schema. Every `pg_*` name is reserved by Postgres, so all of
/// them are refused (pg_catalog, pg_toast*, pg_temp*), plus information_schema.
pub fn blocked_schema(schema: Option<&str>) -> AppResult<()> {
    let Some(s) = schema.map(|s| s.trim().to_ascii_lowercase()) else { return Ok(()) };
    if s.starts_with("pg_") || s == "information_schema" {
        return Err(AppError::msg(
            "PostgreSQL system schemas (pg_catalog, information_schema, pg_toast, pg_temp and other pg_*) can't be used for AI and CLI reads.",
        ));
    }
    Ok(())
}

/// Masked Postgres text and what the lexer saw on the way.
struct PgMasked {
    text: String,
    /// a `U&"…"` identifier: its name can't be read without decoding escapes
    unicode_ident: bool,
    /// a quote, dollar quote or comment that never ends
    unclosed: bool,
    /// a character from U+0080 up outside string literals, quoted names and dollar-quoted bodies
    non_ascii: bool,
    /// a `$$` / `$tag$` right after a number or parameter: the server may open a dollar quote there
    ambiguous_dollar: bool,
}

fn pg_ident_char(c: char) -> bool {
    sqlgen::pg_ident_cont(c)
}

/// True when the `$` at `i` follows a number or a parameter (`1$$`, `$1$$`), not a name.
fn dollar_after_number(chars: &[char], i: usize) -> bool {
    if i == 0 || !pg_ident_char(chars[i - 1]) || sqlgen::dollar_opener_len(chars, i).is_none() {
        return false;
    }
    let mut k = i;
    while k > 0 && pg_ident_char(chars[k - 1]) {
        k -= 1;
    }
    !sqlgen::pg_ident_start(chars[k])
}

/// Postgres lexer: `"ident"` (with `""`), `'…'` (with `''`; backslash escapes only when `backslash`, i.e.
/// `standard_conforming_strings = off`), `E'…'` (always backslash escapes), `$tag$…$tag$`, `--` and nested
/// `/* */` comments. Strings and comments become a space. Quoted identifiers become a space too, or —
/// with `keep_idents` — their name (other characters as spaces), so `"pg_sleep"(1)` is still seen as a call.
fn mask_postgres(sql: &str, backslash: bool, keep_idents: bool) -> PgMasked {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut unicode_ident = false;
    let mut unclosed = false;
    let mut non_ascii = false;
    let mut ambiguous_dollar = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '$' && dollar_after_number(&chars, i) {
            ambiguous_dollar = true;
        }
        if c == '\'' {
            let e_prefix = i >= 1
                && matches!(chars[i - 1], 'e' | 'E')
                && (i < 2 || !pg_ident_char(chars[i - 2]));
            let escapes = backslash || e_prefix;
            i += 1;
            loop {
                match chars.get(i) {
                    None => {
                        unclosed = true;
                        break;
                    }
                    Some('\\') if escapes => i += 2,
                    Some('\'') if chars.get(i + 1) == Some(&'\'') => i += 2,
                    Some('\'') => break,
                    Some(_) => i += 1,
                }
            }
            out.push(' ');
            i += 1;
        } else if c == '"' {
            if i >= 2 && chars[i - 1] == '&' && matches!(chars[i - 2], 'u' | 'U') && (i < 3 || !pg_ident_char(chars[i - 3])) {
                unicode_ident = true;
            }
            i += 1;
            let start = i;
            loop {
                match chars.get(i) {
                    None => {
                        unclosed = true;
                        break;
                    }
                    Some('"') if chars.get(i + 1) == Some(&'"') => i += 2,
                    Some('"') => break,
                    Some(_) => i += 1,
                }
            }
            out.push(' ');
            if keep_idents {
                let end = i.min(chars.len());
                out.extend(chars[start..end].iter().map(|ch| if ch.is_ascii_alphanumeric() || *ch == '_' { *ch } else { ' ' }));
                out.push(' ');
            }
            i += 1;
        } else if let Some(len) = sqlgen::dollar_tag_len(&chars, i) {
            let tag = &chars[i..i + len];
            non_ascii |= !tag.iter().all(char::is_ascii);
            let mut j = i + len;
            loop {
                if j + len > chars.len() {
                    unclosed = true;
                    i = chars.len();
                    break;
                }
                if &chars[j..j + len] == tag {
                    i = j + len;
                    break;
                }
                j += 1;
            }
            out.push(' ');
        } else if c == '-' && next == Some('-') {
            // the server ends a `--` comment at \n or \r
            while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                non_ascii |= !chars[i].is_ascii();
                i += 1;
            }
            out.push(' ');
        } else if c == '/' && next == Some('*') {
            let mut depth = 1;
            i += 2;
            while depth > 0 {
                if chars.get(i).is_some_and(|ch| !ch.is_ascii()) {
                    non_ascii = true;
                }
                match (chars.get(i), chars.get(i + 1)) {
                    (None, _) => {
                        unclosed = true;
                        break;
                    }
                    (Some('/'), Some('*')) => {
                        depth += 1;
                        i += 2;
                    }
                    (Some('*'), Some('/')) => {
                        depth -= 1;
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            out.push(' ');
        } else {
            non_ascii |= !c.is_ascii();
            out.push(c);
            i += 1;
        }
    }
    PgMasked { text: out, unicode_ident, unclosed, non_ascii, ambiguous_dollar }
}

/// Upper-case words of masked text with the next non-space character after each.
fn words_with_next(masked: &str) -> Vec<(String, Option<char>)> {
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
            let word = chars[start..i].iter().collect::<String>().to_ascii_uppercase();
            out.push((word, chars[i..].iter().find(|c| !c.is_whitespace()).copied()));
        } else {
            i += 1;
        }
    }
    out
}

/// The Postgres half of `check`. Every rule runs on both readings of backslashes in '…' strings, so a
/// server with `standard_conforming_strings = off` can't see a statement the checker didn't.
fn check_postgres(text: String) -> AppResult<String> {
    let readings: Vec<(PgMasked, PgMasked)> =
        [false, true].iter().map(|&bs| (mask_postgres(&text, bs, false), mask_postgres(&text, bs, true))).collect();
    for (plain, idents) in &readings {
        if plain.unclosed || idents.unclosed {
            return Err(AppError::msg("The query has an unclosed quote, dollar quote or comment."));
        }
        if plain.text.contains(';') {
            return Err(one_statement());
        }
        if plain.non_ascii || idents.non_ascii {
            return Err(AppError::msg(
                "Non-ASCII characters are only allowed inside quoted strings and \"quoted\" names in read-only queries (not in SQL keywords, plain names or comments).",
            ));
        }
        if plain.ambiguous_dollar || idents.ambiguous_dollar {
            return Err(AppError::msg("A $ right after a number or parameter is not allowed in read-only queries (it may start a dollar quote). Add a space."));
        }
        if idents.unicode_ident {
            return Err(AppError::msg("Unicode-escaped names (U&\"…\") are not allowed in read-only queries."));
        }
    }
    for (plain, _) in &readings {
        let words = words_with_next(&plain.text);
        let first = words.first().map(|(w, _)| w.as_str()).unwrap_or("");
        if !PG_READ_STARTS.contains(&first) || words.iter().any(|(w, _)| PG_WRITE_WORDS.contains(&w.as_str())) {
            return Err(pg_not_read_only());
        }
    }
    for (_, idents) in &readings {
        let words = words_with_next(&idents.text);
        if words.iter().any(|(w, _)| pg_system_name(w)) {
            return Err(pg_system_data());
        }
        if let Some((name, _)) = words.iter().find(|(w, next)| matches!(next, Some('(') | Some('.')) && pg_blocked_function(w)) {
            return Err(pg_blocked(name));
        }
    }
    Ok(text)
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
pub async fn run_select(session: &crate::manager::Session, database: Option<&str>, schema: Option<&str>, sql: &str) -> AppResult<QueryResult> {
    let statement = check(sql, session.dialect())?;
    let mut result = session.select_read_only(database, schema, &statement, MAX_ROWS).await?;
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
        let res = run_select(&s, None, None, "SELECT id, body FROM t").await.unwrap();
        assert_eq!(res.rows.len(), MAX_ROWS);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn long_values_are_cut() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        let res = run_select(&s, None, None, "SELECT body FROM t ORDER BY length(body) DESC LIMIT 1").await.unwrap();
        let body = res.rows[0][0].as_str().unwrap();
        assert_eq!(body.chars().count(), MAX_VALUE_CHARS + 1);
        assert!(body.ends_with('…'));
    }

    #[tokio::test]
    async fn sqlite_database_layer_blocks_writes() {
        let dir = tempfile::tempdir().unwrap();
        let s = sqlite_session(dir.path()).await;
        // skip the SQL check on purpose: the read-only connection itself must refuse
        let err = s.select_read_only(None, None, "DELETE FROM t", 10).await.unwrap_err().to_string();
        assert!(err.to_lowercase().contains("readonly") || err.to_lowercase().contains("read-only"), "{err}");
        let n = s.execute(None, None, "SELECT count(*) FROM t", 10, false).await.unwrap();
        assert_eq!(n[0].rows[0][0], 251);
        assert!(run_select(&s, None, None, "DELETE FROM t").await.unwrap_err().to_string().contains("read-only"));
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
    fn rejects_system_schemas_and_process_list() {
        for sql in [
            "SELECT user, authentication_string FROM mysql.user",
            "SELECT * FROM `mysql`.`user`",
            "select * from MySQL . user",
            "SELECT * FROM t JOIN mysql.db d ON 1",
            "SELECT sql_text FROM performance_schema.events_statements_history",
            "SELECT * FROM `performance_schema`.threads",
            "SELECT * FROM sys.session",
            "SELECT info FROM information_schema.PROCESSLIST",
            "SELECT info FROM information_schema.`processlist`",
            "SHOW PROCESSLIST",
            "SHOW FULL PROCESSLIST",
        ] {
            let err = check(sql, Mysql).expect_err(sql).to_string();
            assert!(err.contains("system"), "{sql}: {err}");
        }
        // the words as text, aliases or column names are fine
        for sql in [
            "SELECT 'mysql.user' AS note",
            "SELECT mysql_version, sys_id FROM t",
            "SELECT u.name FROM users u",
            "SELECT table_name FROM information_schema.tables",
            "SELECT * FROM shop.orders",
        ] {
            assert!(check(sql, Mysql).is_ok(), "should accept: {sql}");
        }
        // SQLite has no such schemas
        assert!(check("SELECT * FROM sys.t", Sqlite).is_ok());
        assert!(blocked_database(Some("mysql")).is_err());
        assert!(blocked_database(Some("Performance_Schema")).is_err());
        assert!(blocked_database(Some("shop")).is_ok());
        assert!(blocked_database(None).is_ok());
    }

    #[test]
    fn rejects_lock_sleep_and_benchmark_functions() {
        for sql in [
            "SELECT GET_LOCK('deploy', 0)",
            "select get_lock ('deploy', 10) AS l",
            "SELECT RELEASE_LOCK('deploy')",
            "SELECT RELEASE_ALL_LOCKS()",
            "SELECT IS_USED_LOCK('x'), IS_FREE_LOCK('x')",
            "SELECT SLEEP(60)",
            "SELECT * FROM t WHERE id = 1 AND SLEEP(5) = 0",
            "SELECT BENCHMARK(100000000, MD5('x'))",
            "SELECT 1 /*!50000 , SLEEP(30) */",
        ] {
            assert!(check(sql, Mysql).is_err(), "should reject: {sql}");
        }
        assert!(check("SELECT SLEEP(1)", Mysql).unwrap_err().to_string().contains("SLEEP() is not allowed"));
        // names as text, columns or aliases are fine
        for sql in ["SELECT 'sleep(5)' AS note", "SELECT sleep_minutes, benchmark FROM t", "SELECT get_lock_count FROM t", "SELECT `sleep` FROM t"] {
            assert!(check(sql, Mysql).is_ok(), "should accept: {sql}");
        }
    }

    use crate::sqlgen::Dialect::Postgres;

    fn pg_ok(sql: &str) {
        if let Err(e) = check(sql, Postgres) {
            panic!("should accept: {sql} — got: {e}");
        }
    }

    fn pg_refused(sql: &str) -> String {
        match check(sql, Postgres) {
            Ok(_) => panic!("should refuse: {sql}"),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn postgres_accepts_plain_reads() {
        for sql in [
            "select 1",
            "with x as (select 1) select * from x",
            "values (1)",
            "table customers",
            "show search_path",
            "explain select 1",
            "select current_setting('TimeZone')",
            "select '$$pg_sleep$$'",
            "select \"pg_read_file\" from t",
            "select t.\"pg_sleep\", \"update\", \"delete\" from t",
            "SELECT * FROM \"public\".\"Orders\" WHERE total > 1;",
            "select replace(name, 'a', 'b') from customers",
            "select count(*) from information_schema.tables",
            "select relname from pg_catalog.pg_class",
            "select now()::date, '{1,2}'::int[]",
            "select * from customers order by id fetch first 5 rows only",
            "select $a$ pg_sleep(1); delete $a$",
            "select E'\\' , pg_sleep(1) --'",
            "select 'it''s'",
            "select 1 -- pg_sleep(1)\n",
            "select /* outer /* pg_sleep(1) */ still comment */ 1",
            "(select 1) union all (select 2)",
            "select pg_size_pretty(pg_total_relation_size('customers'))",
            "select a$b from t",
            "select lo_price, http_status, txid_note from t",
            "with recursive r(n) as (select 1 union all select n + 1 from r where n < 3) select * from r",
        ] {
            pg_ok(sql);
        }
    }

    #[test]
    fn postgres_refuses_non_read_statements() {
        for sql in [
            "explain analyze select 1",
            "explain analyse select 1",
            "explain (analyze) select 1",
            "explain (format json, analyze true) select 1",
            "explain delete from t",
            "copy t to program 'x'",
            "copy t to stdout",
            "do $$ begin end $$",
            "call p()",
            "set role postgres",
            "set local statement_timeout = 0",
            "reset all",
            "discard all",
            "lock t",
            "listen c",
            "notify c",
            "unlisten *",
            "prepare p as select 1",
            "execute p",
            "deallocate p",
            "declare c cursor for select 1",
            "fetch c",
            "begin",
            "commit",
            "rollback",
            "analyze t",
            "vacuum",
            "checkpoint",
            "refresh materialized view v",
            "create table x as select 1",
            "describe t",
            "pragma table_info(t)",
            "delete from t",
            "with d as (delete from t returning *) select * from d",
            "with u as (update t set a = 1 returning *) select * from u",
            "with i as (insert into t values (1) returning *) select * from i",
            "with m as (select 1) merge into t using m on true when matched then delete",
            "select * from t for update",
            "select * from t for no key update",
            "select * from t for share",
            "select * from t for key share",
            "select * into t2 from t",
            "select 1 into temp t2",
        ] {
            let err = pg_refused(sql);
            assert!(err.contains("read-only"), "{sql}: {err}");
        }
    }

    #[test]
    fn postgres_one_statement_only() {
        for sql in [
            "select 1; select 2",
            "select $q$ $q$; delete from t",
            "select 1 # 2; delete from t",
            "select 'a\\'; delete from t; --'",
            "select $$ $x$; delete from t",
        ] {
            assert!(check(sql, Postgres).is_err(), "should refuse: {sql}");
        }
        assert!(pg_refused("select 1; select 2").contains("one statement"));
        assert!(pg_refused("select $q$ $q$; delete from t").contains("one statement"));
    }

    #[test]
    fn postgres_refuses_dangerous_functions() {
        for sql in [
            "select pg_read_file('/etc/passwd')",
            "select pg_read_binary_file('/etc/passwd')",
            "select * from pg_ls_dir('.')",
            "select pg_ls_logdir()",
            "select pg_stat_file('postgresql.conf')",
            "SELECT PG_SLEEP(10)",
            "select pg_sleep_for('1 minute')",
            "select pg_sleep_until(now())",
            "select pg_catalog.pg_sleep(1)",
            "select /* */ pg_sleep(1)",
            "select pg_sleep (1)",
            "select pg_sleep\n(1)",
            "select pg_sleep/**/(1)",
            "select \"pg_sleep\"(1)",
            "select pg_catalog.\"pg_sleep\"(1)",
            "select \"pg_catalog\".\"pg_sleep\"(1)",
            "select * from dblink('host=x', 'select 1') as t(a int)",
            "select dblink_exec('host=x', 'delete from t')",
            "select dblink_connect('x')",
            "select lo_import('/x')",
            "select lo_export(1, '/tmp/x')",
            "select lo_get(1)",
            "select lowrite(0, 'x')",
            "select loread(0, 1)",
            "select nextval('s')",
            "select setval('s', 1)",
            "select pg_notify('c', 'x')",
            "select set_config('a', 'b', false)",
            "select pg_catalog.set_config('a', 'b', false)",
            "select pg_terminate_backend(1)",
            "select pg_cancel_backend(1)",
            "select pg_reload_conf()",
            "select pg_rotate_logfile()",
            "select pg_promote()",
            "select pg_switch_wal()",
            "select pg_advisory_lock(1)",
            "select pg_advisory_xact_lock(1)",
            "select pg_try_advisory_lock_shared(1)",
            "select pg_advisory_unlock_all()",
            "select query_to_xml('delete from t', true, true, '')",
            "select query_to_xmlschema('select 1', true, true, '')",
            "select query_to_xml_and_xmlschema('select 1', true, true, '')",
            "select cursor_to_xml('c', 1, true, true, '')",
            "select table_to_xml('t', true, true, '')",
            "select schema_to_xml('public', true, true, '')",
            "select database_to_xml(true, true, '')",
            "select ts_stat('select v from t')",
            "select ts_rewrite('a'::tsquery, 'select a, b from aliases')",
            "select * from crosstab('select 1, 2, 3') as t(a int, b int)",
            "select * from connectby('t', 'id', 'parent', '1', 0) as t(a int, b int, c int)",
            "select pg_logical_emit_message(true, 'a', 'b')",
            "select pg_create_physical_replication_slot('s')",
            "select pg_create_logical_replication_slot('s', 'pgoutput')",
            "select pg_drop_replication_slot('s')",
            "select pg_replication_origin_create('o')",
            "select pg_copy_physical_replication_slot('a', 'b')",
            "select txid_current()",
            "select pg_current_xact_id()",
            "select pg_export_snapshot()",
            "select pg_file_write('a', 'b', false)",
            "select pg_stat_reset()",
            "select brin_summarize_new_values('i')",
            "select gin_clean_pending_list('i')",
            "select pg_background_launch('delete from t')",
            "select http_get('http://example.com')",
            "select net.http_post('http://example.com')",
            "select aws_lambda.invoke('f', '{}')",
            "select aws_s3.query_export_to_s3('select 1', 'b')",
            "select pg_backup_start('x')",
            "select pg_log_backend_memory_contexts(1)",
            "select pg_import_system_collations('pg_catalog')",
            "select * from xpath_table('id', 'x', 't', '/a', 'true') as t(id int, a text)",
            "select public.xpath_table('id', 'x', 't', '/a', 'true')",
        ] {
            let err = pg_refused(sql);
            assert!(err.contains("is not allowed"), "{sql}: {err}");
        }
        assert!(pg_refused("SELECT PG_SLEEP(10)").contains("PG_SLEEP() is not allowed"));
    }

    #[test]
    fn postgres_refuses_unicode_escaped_names() {
        let err = pg_refused("select U&\"pg\\005fsleep\"(1)");
        assert!(err.contains("U&"), "{err}");
        pg_refused("select u&\"x\" from t");
        pg_ok("select U&'d\\0061ta'");
    }

    #[test]
    fn postgres_refuses_system_data() {
        for sql in [
            "select * from pg_authid",
            "select * from pg_catalog.pg_shadow",
            "select * from \"pg_authid\"",
            "table pg_authid",
            "select * from pg_user_mapping",
            "select * from pg_user_mappings",
            "select * from pg_hba_file_rules",
            "select * from pg_ident_file_mappings",
            "select * from pg_file_settings",
            "select * from pg_stat_activity",
            "select query from pg_stat_statements",
            "select * from pg_stat_get_activity(null)",
            "select pg_stat_get_backend_activity(1)",
            "select * from pg_largeobject",
            "select * from pg_subscription",
            "select * from pg_statistic",
            "select * from pg_toast.pg_toast_1234",
            "select * from information_schema.user_mapping_options",
            "select * from information_schema._pg_user_mappings",
            "select * from information_schema.\"user_mapping_options\"",
            "select * from information_schema.user_mappings",
        ] {
            let err = pg_refused(sql);
            assert!(err.contains("system"), "{sql}: {err}");
        }
    }

    #[test]
    fn postgres_lexer_edge_cases() {
        // unclosed quotes and comments are refused, not guessed
        for sql in ["select $$ x", "select 'x", "select \"x", "select /* /* */ 1", "select E'\\'"] {
            assert!(check(sql, Postgres).is_err(), "should refuse: {sql}");
        }
        // case and spacing of names don't matter
        for sql in ["select \"Pg_Sleep\"(1)", "select pg_catalog . pg_sleep (1)", "select * from t, lateral pg_sleep(1)", "select row_to_json(a) from pg_stat_activity a"] {
            assert!(check(sql, Postgres).is_err(), "should refuse: {sql}");
        }
        // a dollar quote can't open inside a name or hide behind a parameter
        pg_ok("select $1::int");
        pg_refused("select a$$ from t; delete from t");
    }

    /// Review PoCs: each hid a call from the checker that the server would run.
    const LEXER_POCS: &[&str] = &[
        "select 1 --\r, pg_sleep(9), (select count(*) from pg_stat_activity)",
        "select $×$'$×$ , pg_terminate_backend(1) --'",
        "select 1 as ×$$ , pg_sleep(9) as x$$",
        "select ×E'\\' , pg_sleep(9) --'",
    ];

    #[test]
    fn postgres_lexer_reads_cr_and_non_ascii_like_the_server() {
        // `--` ends at \r too; every char >= U+0080 is a name char (dollar tags, `$` after a name, E'…' prefix)
        for sql in LEXER_POCS {
            let masked = mask_postgres(sql, false, false).text;
            assert!(masked.contains("pg_sleep") || masked.contains("pg_terminate_backend"), "hidden from the checker: {sql:?} -> {masked:?}");
        }
        assert_eq!(sqlgen::dollar_tag_len(&"$×$".chars().collect::<Vec<_>>(), 0), Some(3));
        assert_eq!(sqlgen::dollar_tag_len(&"×$$".chars().collect::<Vec<_>>(), 1), None);
    }

    #[test]
    fn postgres_refuses_cr_and_non_ascii_code() {
        for sql in LEXER_POCS {
            pg_refused(sql);
        }
        assert!(pg_refused("select 1 --\r, pg_sleep(9)").contains("carriage return"));
        assert!(pg_refused("select 'a\rb'").contains("carriage return"), "any \\r, even in a string");
        assert!(pg_refused("select 1 as ×").contains("Non-ASCII"));
        assert!(pg_refused("select 1 -- café").contains("Non-ASCII"), "comments too");
        assert!(pg_refused("select 1 /* café */").contains("Non-ASCII"));
        assert!(pg_refused("select $é$ x $é$").contains("Non-ASCII"), "dollar-quote tags too");
        // a `$` right after a number: the server may open a dollar quote there
        pg_refused("select 1$$'$$, pg_sleep(1) --'");
        // non-ASCII inside strings, quoted names and dollar-quoted bodies is fine
        for sql in ["select 'café'", "select \"naïve\" from t", "select $$ünï$$", "select $a$ é $a$", "select E'\\u00e9 é'"] {
            pg_ok(sql);
        }
        pg_ok("select a1$b from t");
    }

    #[test]
    fn postgres_blocked_schema() {
        for s in ["pg_catalog", "PG_CATALOG", " pg_catalog ", "information_schema", "pg_toast", "pg_toast_temp_1", "pg_temp_3", "pg_anything"] {
            assert!(blocked_schema(Some(s)).is_err(), "should refuse schema {s}");
        }
        assert!(blocked_schema(Some("pg_catalog")).unwrap_err().to_string().contains("system"));
        for s in ["public", "billing", "Orders", "pgx"] {
            assert!(blocked_schema(Some(s)).is_ok(), "should accept schema {s}");
        }
        assert!(blocked_schema(None).is_ok());
    }

    #[test]
    fn postgres_rules_do_not_change_mysql_and_sqlite() {
        // Postgres-only names are fine on the other engines
        assert!(check("SELECT pg_sleep FROM t", Mysql).is_ok());
        assert!(check("SELECT nextval FROM t", Sqlite).is_ok());
    }

    #[test]
    fn error_messages_explain_the_rule() {
        assert!(check("SELECT 1; SELECT 2", Mysql).unwrap_err().to_string().contains("one statement"));
        assert!(check("DELETE FROM t", Mysql).unwrap_err().to_string().contains("read-only"));
    }
}
