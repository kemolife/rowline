//! SQL text generation. Identifiers are quoted per dialect, values are always bound parameters.

use crate::error::{AppError, AppResult};
use crate::model::{ChangeSet, PageRequest, RowValues, SqlStatement};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Mysql,
    Sqlite,
    Postgres,
}

impl Dialect {
    pub fn quote_ident(self, name: &str) -> String {
        match self {
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
            Dialect::Sqlite | Dialect::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }

    /// `db`.`table` for MySQL when a database is given, otherwise just the table
    pub fn qualified(self, database: Option<&str>, table: &str) -> String {
        match (self, database) {
            (Dialect::Mysql, Some(db)) if !db.is_empty() => {
                format!("{}.{}", self.quote_ident(db), self.quote_ident(table))
            }
            _ => self.quote_ident(table),
        }
    }

    /// Postgres: `"schema"."table"` when a schema is given (the database is never a qualifier there).
    /// MySQL and SQLite ignore the schema and work like `qualified`.
    pub fn qualified_in(self, database: Option<&str>, schema: Option<&str>, table: &str) -> String {
        match (self, schema) {
            (Dialect::Postgres, Some(s)) if !s.is_empty() => {
                format!("{}.{}", self.quote_ident(s), self.quote_ident(table))
            }
            _ => self.qualified(database, table),
        }
    }
}

fn where_clause(filter: &Option<String>) -> String {
    match filter.as_deref().map(str::trim) {
        Some(f) if !f.is_empty() => format!(" WHERE {f}"),
        _ => String::new(),
    }
}

fn page_target(dialect: Dialect, req: &PageRequest) -> String {
    dialect.qualified_in(req.database.as_deref(), req.schema.as_deref(), &req.table)
}

pub fn select_page_sql(dialect: Dialect, req: &PageRequest) -> String {
    let mut sql = format!("SELECT * FROM {}{}", page_target(dialect, req), where_clause(&req.filter));
    if !req.sort.is_empty() {
        let order: Vec<String> = req
            .sort
            .iter()
            .map(|s| {
                format!(
                    "{} {}",
                    dialect.quote_ident(&s.column),
                    if s.descending { "DESC" } else { "ASC" }
                )
            })
            .collect();
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    // one extra row tells whether there is a next page
    sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit + 1, req.offset));
    sql
}

/// Rows sampled for value suggestions, so a huge table stays fast
pub const SUGGEST_SAMPLE: usize = 20_000;

/// Most common values of a column (filter suggestions), counted over a sample of the table
pub fn common_values_sql(
    dialect: Dialect,
    database: Option<&str>,
    schema: Option<&str>,
    table: &str,
    column: &str,
    limit: usize,
) -> String {
    format!(
        "SELECT v FROM (SELECT {col} AS v FROM {t} WHERE {col} IS NOT NULL LIMIT {SUGGEST_SAMPLE}) s GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT {limit}",
        col = dialect.quote_ident(column),
        t = dialect.qualified_in(database, schema, table),
    )
}

pub fn count_sql(dialect: Dialect, req: &PageRequest) -> String {
    format!("SELECT COUNT(*) FROM {}{}", page_target(dialect, req), where_clause(&req.filter))
}

/// Writes bound-parameter marks: `?` for MySQL/SQLite, `$1::type`, `$2::type`… for Postgres.
struct Marks<'a> {
    dialect: Dialect,
    types: &'a HashMap<String, String>,
    n: usize,
}

impl<'a> Marks<'a> {
    fn new(dialect: Dialect, types: &'a HashMap<String, String>) -> Self {
        Marks { dialect, types, n: 0 }
    }

    fn next(&mut self, column: &str) -> AppResult<String> {
        self.n += 1;
        if self.dialect != Dialect::Postgres {
            return Ok("?".into());
        }
        match self.types.get(column) {
            Some(t) => Ok(format!("${}::{}", self.n, checked_type(t)?)),
            None => Ok(format!("${}", self.n)),
        }
    }
}

/// The type name goes into SQL text, so only plain type syntax passes: names (unquoted or `"quoted"`),
/// dots, spaces, number modifiers like `(12,2)` and array brackets `[]` / `[3]`.
fn checked_type(t: &str) -> AppResult<&str> {
    let bad = || AppError::msg(format!("Unsupported column type for editing: {t}"));
    let chars: Vec<char> = t.chars().collect();
    let mut i = 0;
    let mut names = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphabetic() || c == '_' {
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            names += 1;
        } else if c == '"' {
            i += 1;
            loop {
                match chars.get(i) {
                    None => return Err(bad()),
                    Some('"') if chars.get(i + 1) == Some(&'"') => i += 2,
                    Some('"') => break,
                    Some(_) => i += 1,
                }
            }
            i += 1;
            names += 1;
        } else if c == '(' {
            // number modifiers only: (n) or (n, m)
            i += 1;
            let mut digits = false;
            loop {
                match chars.get(i) {
                    Some(d) if d.is_ascii_digit() => digits = true,
                    Some(',') | Some(' ') => {}
                    Some(')') if digits => break,
                    _ => return Err(bad()),
                }
                i += 1;
            }
            i += 1;
        } else if c == '[' {
            i += 1;
            while chars.get(i).is_some_and(|d| d.is_ascii_digit()) {
                i += 1;
            }
            if chars.get(i) != Some(&']') {
                return Err(bad());
            }
            i += 1;
        } else if c == ' ' || c == '.' {
            i += 1;
        } else {
            return Err(bad());
        }
    }
    if names == 0 {
        return Err(bad());
    }
    Ok(t)
}

fn key_condition(key: &RowValues, marks: &mut Marks, params: &mut Vec<Value>) -> AppResult<String> {
    if key.is_empty() {
        return Err(AppError::msg("Row key is empty; table needs a primary key for editing"));
    }
    let mut parts = Vec::new();
    for (col, val) in key {
        let name = marks.dialect.quote_ident(col);
        if val.is_null() {
            parts.push(format!("{name} IS NULL"));
        } else {
            params.push(val.clone());
            parts.push(format!("{name} = {}", marks.next(col)?));
        }
    }
    Ok(parts.join(" AND "))
}

/// Values the grid may set that are SQL keywords, not data: `{"$expr": "DEFAULT"}` etc.
/// Only this fixed list is ever written into SQL text; everything else is a bound parameter.
const EXPRESSIONS: &[&str] = &["DEFAULT", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"];

/// `Some(keyword)` when the value is an allowed SQL keyword marker; an unknown marker is an error.
fn expression(v: &Value) -> AppResult<Option<&'static str>> {
    let Some(obj) = v.as_object() else { return Ok(None) };
    let Some(name) = obj.get("$expr") else { return Ok(None) };
    let name = name.as_str().unwrap_or_default();
    EXPRESSIONS
        .iter()
        .find(|e| e.eq_ignore_ascii_case(name))
        .copied()
        .map(Some)
        .ok_or_else(|| AppError::msg(format!("Unsupported value expression: {name}")))
}

/// Statements for a change set, in order: deletes, updates, inserts.
/// `types` maps a column to its Postgres type name (used for `$n::type` casts); other dialects pass an empty map.
pub fn change_set_statements(
    dialect: Dialect,
    database: Option<&str>,
    schema: Option<&str>,
    table: &str,
    changes: &ChangeSet,
    types: &HashMap<String, String>,
) -> AppResult<Vec<SqlStatement>> {
    let target = dialect.qualified_in(database, schema, table);
    let mut res = Vec::new();

    for key in &changes.deletes {
        let mut params = Vec::new();
        let mut marks = Marks::new(dialect, types);
        let cond = key_condition(key, &mut marks, &mut params)?;
        res.push(SqlStatement {
            sql: format!("DELETE FROM {target} WHERE {cond}"),
            params,
        });
    }

    for upd in &changes.updates {
        if upd.values.is_empty() {
            continue;
        }
        let mut params = Vec::new();
        let mut marks = Marks::new(dialect, types);
        let mut sets: Vec<String> = Vec::new();
        for (col, val) in &upd.values {
            let name = dialect.quote_ident(col);
            match expression(val)? {
                Some("DEFAULT") if dialect == Dialect::Sqlite => {
                    return Err(AppError::msg("SQLite can't reset an existing value to its DEFAULT. Type the value instead."));
                }
                Some(expr) => sets.push(format!("{name} = {expr}")),
                None => {
                    params.push(val.clone());
                    sets.push(format!("{name} = {}", marks.next(col)?));
                }
            }
        }
        let cond = key_condition(&upd.key, &mut marks, &mut params)?;
        res.push(SqlStatement {
            sql: format!("UPDATE {target} SET {} WHERE {cond}", sets.join(", ")),
            params,
        });
    }

    for row in &changes.inserts {
        // SQLite has no DEFAULT keyword in VALUES: leaving the column out means the same
        let mut cols = Vec::new();
        let mut values = Vec::new();
        let mut params = Vec::new();
        let mut marks = Marks::new(dialect, types);
        for (col, val) in row {
            match expression(val)? {
                Some("DEFAULT") if dialect == Dialect::Sqlite => continue,
                Some(expr) => values.push(expr.to_string()),
                None => {
                    params.push(val.clone());
                    values.push(marks.next(col)?);
                }
            }
            cols.push(dialect.quote_ident(col));
        }
        if cols.is_empty() {
            let sql = match dialect {
                Dialect::Mysql => format!("INSERT INTO {target} () VALUES ()"),
                Dialect::Sqlite | Dialect::Postgres => format!("INSERT INTO {target} DEFAULT VALUES"),
            };
            res.push(SqlStatement { sql, params: vec![] });
            continue;
        }
        res.push(SqlStatement {
            sql: format!("INSERT INTO {target} ({}) VALUES ({})", cols.join(", "), values.join(", ")),
            params,
        });
    }

    Ok(res)
}

/// SQL with parameters inlined as literals — only for showing the user what will run.
/// Understands `?` and Postgres `$n`; marks inside quoted names are left alone.
pub fn preview_sql(stmt: &SqlStatement) -> String {
    let chars: Vec<char> = stmt.sql.chars().collect();
    let mut out = String::new();
    let mut params = stmt.params.iter();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '"' | '`' => {
                // copy a quoted name as is (doubled quote = escaped quote)
                out.push(ch);
                i += 1;
                while i < chars.len() {
                    out.push(chars[i]);
                    if chars[i] == ch {
                        if chars.get(i + 1) == Some(&ch) {
                            out.push(ch);
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '?' => {
                match params.next() {
                    Some(v) => out.push_str(&literal(v)),
                    None => out.push('?'),
                }
                i += 1;
            }
            '$' if chars.get(i + 1).is_some_and(|c| c.is_ascii_digit()) => {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && chars[end].is_ascii_digit() {
                    end += 1;
                }
                let n: usize = chars[start..end].iter().collect::<String>().parse().unwrap_or(0);
                match n.checked_sub(1).and_then(|k| stmt.params.get(k)) {
                    Some(v) => out.push_str(&literal(v)),
                    None => out.extend(&chars[i..end]),
                }
                i = end;
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

fn literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatementRange {
    /// Character offsets in the original text
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// First character of a Postgres name: `[A-Za-z_]` or any character from U+0080 up (the server lexer
/// reads every non-ASCII byte as a letter).
pub(crate) fn pg_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || !c.is_ascii()
}

/// Later characters of a Postgres name: also digits and `$`.
pub(crate) fn pg_ident_cont(c: char) -> bool {
    pg_ident_start(c) || c.is_ascii_digit() || c == '$'
}

/// Length of a Postgres dollar-quote opener (`$$` or `$tag$`) at `i`, if there is one.
/// A `$` right after a name character is part of that name (`a$b`, `×$$`), and `$1` is a parameter.
pub(crate) fn dollar_tag_len(chars: &[char], i: usize) -> Option<usize> {
    if i > 0 && pg_ident_cont(chars[i - 1]) {
        return None;
    }
    dollar_opener_len(chars, i)
}

/// Length of `$$` / `$tag$` at `i`, whatever comes before it. Tags: `[A-Za-z_\x80-]` then also digits.
pub(crate) fn dollar_opener_len(chars: &[char], i: usize) -> Option<usize> {
    if chars.get(i) != Some(&'$') {
        return None;
    }
    let mut j = i + 1;
    if chars.get(j).is_some_and(|c| pg_ident_start(*c)) {
        while chars.get(j).is_some_and(|c| pg_ident_start(*c) || c.is_ascii_digit()) {
            j += 1;
        }
    }
    (chars.get(j) == Some(&'$')).then_some(j + 1 - i)
}

/// Index just past the end of the dollar-quoted string that opens at `i` with a tag of `len` chars.
/// Unterminated → the end of the text.
pub(crate) fn skip_dollar_quote(chars: &[char], i: usize, len: usize) -> usize {
    let tag = &chars[i..i + len];
    let mut j = i + len;
    while j + len <= chars.len() {
        if &chars[j..j + len] == tag {
            return j + len;
        }
        j += 1;
    }
    chars.len()
}

/// Splits a script with the MySQL rules (also used for SQLite). See `split_statements_for`.
pub fn split_statements(sql: &str) -> Vec<StatementRange> {
    split_statements_for(sql, Dialect::Mysql)
}

/// Splits a script on `;`, ignoring semicolons inside quotes, comments and dollar quotes.
/// MySQL / SQLite: backslash escapes in '…' and "…", backtick names, `#` comments.
/// Postgres follows its own lexer: backslash escapes only in E'…', no backticks or `#` comments, nested
/// `/* */`, and `--` ends at \r as well as \n.
/// Offsets are character (not byte) offsets so the editor can use them directly.
pub fn split_statements_for(sql: &str, dialect: Dialect) -> Vec<StatementRange> {
    if dialect == Dialect::Postgres {
        return split_postgres(sql);
    }
    let chars: Vec<char> = sql.chars().collect();
    let mut res = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let push = |res: &mut Vec<StatementRange>, s: usize, e: usize| {
        let text: String = chars[s..e].iter().collect();
        let trimmed = text.trim();
        if !trimmed.is_empty() && !is_only_comments(trimmed) {
            let lead = text.chars().take_while(|c| c.is_whitespace()).count();
            let trail = text.chars().rev().take_while(|c| c.is_whitespace()).count();
            res.push(StatementRange {
                start: s + lead,
                end: e - trail,
                text: trimmed.to_string(),
            });
        }
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                // backslash escapes cover MySQL strings and Postgres E'…' strings
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' && c != '`' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == c {
                        // doubled quote = escaped quote
                        if i + 1 < chars.len() && chars[i + 1] == c {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '$' if dollar_tag_len(&chars, i).is_some() => {
                let len = dollar_tag_len(&chars, i).unwrap_or(1);
                i = skip_dollar_quote(&chars, i, len);
            }
            '-' if i + 1 < chars.len() && chars[i + 1] == '-' => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '#' => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            ';' => {
                push(&mut res, start, i);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    push(&mut res, start, chars.len().min(i.max(start)));
    res
}

/// Adds the part `chars[s..e]` unless it is blank or only comments.
fn push_part(res: &mut Vec<StatementRange>, chars: &[char], s: usize, e: usize, only_comments: impl Fn(&str) -> bool) {
    let text: String = chars[s..e].iter().collect();
    let trimmed = text.trim();
    if trimmed.is_empty() || only_comments(trimmed) {
        return;
    }
    let lead = text.chars().take_while(|c| c.is_whitespace()).count();
    let trail = text.chars().rev().take_while(|c| c.is_whitespace()).count();
    res.push(StatementRange { start: s + lead, end: e - trail, text: trimmed.to_string() });
}

/// The Postgres half of `split_statements_for`.
fn split_postgres(sql: &str) -> Vec<StatementRange> {
    let chars: Vec<char> = sql.chars().collect();
    let only_comments = |t: &str| pg_skip_comments(&t.chars().collect::<Vec<_>>(), 0) >= t.chars().count();
    let mut res = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                // E'…' (not part of a longer name) has backslash escapes
                let escapes = i >= 1 && matches!(chars[i - 1], 'e' | 'E') && (i < 2 || !pg_ident_cont(chars[i - 2]));
                i += 1;
                while i < chars.len() {
                    if escapes && chars[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '"' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '"' {
                        if chars.get(i + 1) == Some(&'"') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '$' if dollar_tag_len(&chars, i).is_some() => {
                let len = dollar_tag_len(&chars, i).unwrap_or(1);
                i = skip_dollar_quote(&chars, i, len);
            }
            '-' | '/' if pg_skip_comments(&chars, i) > i => i = pg_skip_comments(&chars, i),
            ';' => {
                push_part(&mut res, &chars, start, i, only_comments);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    push_part(&mut res, &chars, start, chars.len().min(i.max(start)), only_comments);
    res
}

/// Index after the whitespace and Postgres comments that start at `i` (`--` to \n or \r, nested `/* */`).
pub(crate) fn pg_skip_comments(chars: &[char], mut i: usize) -> usize {
    loop {
        match (chars.get(i), chars.get(i + 1)) {
            (Some(c), _) if c.is_whitespace() => i += 1,
            (Some('-'), Some('-')) => {
                while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                    i += 1;
                }
            }
            (Some('/'), Some('*')) => {
                let mut depth = 0;
                while i < chars.len() {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            _ => return i,
        }
    }
}

fn is_only_comments(text: &str) -> bool {
    strip_leading_comments(text).trim().is_empty()
}

fn strip_leading_comments(text: &str) -> &str {
    let mut t = text.trim_start();
    loop {
        if let Some(rest) = t.strip_prefix("--").or_else(|| t.strip_prefix('#')) {
            t = rest.find('\n').map(|p| &rest[p + 1..]).unwrap_or("").trim_start();
        } else if let Some(rest) = t.strip_prefix("/*") {
            t = rest.find("*/").map(|p| &rest[p + 2..]).unwrap_or("").trim_start();
        } else {
            return t;
        }
    }
}

fn first_word(text: &str) -> String {
    text.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase()
}

/// For `EXPLAIN …`: the explained statement when the options include ANALYZE (which runs it), else `None`.
fn explain_analyze_target(after_keyword: &str) -> Option<&str> {
    let mut rest = after_keyword.trim_start();
    let mut analyze = false;
    loop {
        rest = strip_leading_comments(rest);
        if let Some(inner) = rest.strip_prefix('(') {
            // Postgres option list: EXPLAIN (ANALYZE, BUFFERS) …
            let end = inner.find(')').map(|p| p + 1).unwrap_or(inner.len());
            let opts = inner[..end].to_ascii_uppercase();
            if opts.split(|c: char| !c.is_ascii_alphabetic()).any(|w| w == "ANALYZE" || w == "ANALYSE") {
                analyze = true;
            }
            rest = inner[end..].trim_start();
            continue;
        }
        let word = first_word(rest);
        match word.as_str() {
            "ANALYZE" | "ANALYSE" => analyze = true,
            "VERBOSE" => {}
            // MySQL: EXPLAIN FORMAT=TREE …
            "FORMAT" => {
                let after = rest[word.len()..].trim_start().trim_start_matches('=').trim_start();
                let value = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').count();
                rest = &after[value..];
                continue;
            }
            _ => return analyze.then_some(rest),
        }
        rest = rest[word.len()..].trim_start();
    }
}

/// Words that make a WITH statement change data (Postgres data-modifying CTEs, MySQL `WITH … UPDATE`).
const DATA_CHANGE_WORDS: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE"];

/// True for statements that only read data. Used for the production safety check.
pub fn is_read_only_statement(sql: &str) -> bool {
    let body = strip_leading_comments(sql);
    let keyword = first_word(body);
    match keyword.as_str() {
        // EXPLAIN ANALYZE runs the statement it explains
        "EXPLAIN" | "DESCRIBE" | "DESC" => match explain_analyze_target(&body[keyword.len()..]) {
            Some(target) => is_read_only_statement(target),
            None => true,
        },
        "WITH" => !crate::readonly::code_words(body).iter().any(|w| DATA_CHANGE_WORDS.contains(&w.as_str())),
        "SELECT" | "SHOW" | "VALUES" | "TABLE" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_values_sample_the_table() {
        assert_eq!(
            common_values_sql(Dialect::Mysql, Some("shop"), None, "orders", "st`atus", 50),
            "SELECT v FROM (SELECT `st``atus` AS v FROM `shop`.`orders` WHERE `st``atus` IS NOT NULL LIMIT 20000) s GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT 50"
        );
    }
    use crate::model::{RowUpdate, SortSpec};
    use serde_json::json;
    use std::collections::HashMap;

    fn row(v: serde_json::Value) -> RowValues {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(Dialect::Mysql.quote_ident("a`b"), "`a``b`");
        assert_eq!(Dialect::Sqlite.quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(Dialect::Mysql.qualified(Some("shop"), "orders"), "`shop`.`orders`");
        assert_eq!(Dialect::Sqlite.qualified(Some("main"), "orders"), "\"orders\"");
    }

    #[test]
    fn select_page_with_filter_sort_and_extra_row() {
        let req = PageRequest {
            database: Some("shop".into()),
            schema: None,
            table: "orders".into(),
            filter: Some(" status = 'paid' ".into()),
            sort: vec![SortSpec { column: "id".into(), descending: true }],
            limit: 100,
            offset: 200,
        };
        assert_eq!(
            select_page_sql(Dialect::Mysql, &req),
            "SELECT * FROM `shop`.`orders` WHERE status = 'paid' ORDER BY `id` DESC LIMIT 101 OFFSET 200"
        );
        assert_eq!(count_sql(Dialect::Mysql, &req), "SELECT COUNT(*) FROM `shop`.`orders` WHERE status = 'paid'");
    }

    #[test]
    fn empty_filter_has_no_where() {
        let req = PageRequest { database: None, schema: None, table: "t".into(), filter: Some("  ".into()), sort: vec![], limit: 10, offset: 0 };
        assert_eq!(select_page_sql(Dialect::Sqlite, &req), "SELECT * FROM \"t\" LIMIT 11 OFFSET 0");
    }

    #[test]
    fn expressions_are_written_as_keywords_and_only_from_the_list() {
        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "DEFAULT"}, "at": {"$expr": "current_timestamp"}, "name": "x"} }],
            "inserts": [{ "note": {"$expr": "DEFAULT"}, "day": {"$expr": "CURRENT_DATE"}, "name": "y" }]
        }))
        .unwrap();
        let st = change_set_statements(Dialect::Mysql, None, None, "t", &changes, &no_types()).unwrap();
        assert!(st[0].sql.contains("`note` = DEFAULT") && st[0].sql.contains("`at` = CURRENT_TIMESTAMP"), "{}", st[0].sql);
        assert_eq!(st[0].params, vec![json!("x"), json!(1)]);
        assert!(st[1].sql.contains("VALUES (DEFAULT, CURRENT_DATE, ?)") || st[1].sql.contains("CURRENT_DATE"), "{}", st[1].sql);
        assert_eq!(st[1].params, vec![json!("y")]);
        assert!(preview_sql(&st[0]).contains("= CURRENT_TIMESTAMP"));

        // SQLite: DEFAULT in an INSERT leaves the column out; in an UPDATE it is refused
        let ins: ChangeSet = serde_json::from_value(json!({ "inserts": [{ "note": {"$expr": "DEFAULT"}, "name": "y" }] })).unwrap();
        let st = change_set_statements(Dialect::Sqlite, None, None, "t", &ins, &no_types()).unwrap();
        assert_eq!(st[0].sql, "INSERT INTO \"t\" (\"name\") VALUES (?)");
        let only_default: ChangeSet = serde_json::from_value(json!({ "inserts": [{ "note": {"$expr": "DEFAULT"} }] })).unwrap();
        assert_eq!(change_set_statements(Dialect::Sqlite, None, None, "t", &only_default, &no_types()).unwrap()[0].sql, "INSERT INTO \"t\" DEFAULT VALUES");
        let upd: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "DEFAULT"}} }] })).unwrap();
        assert!(change_set_statements(Dialect::Sqlite, None, None, "t", &upd, &no_types()).is_err());

        // anything else is refused, never written into SQL
        let evil: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "1; DROP TABLE t"}} }] })).unwrap();
        assert!(change_set_statements(Dialect::Mysql, None, None, "t", &evil, &no_types()).unwrap_err().to_string().contains("Unsupported"));
    }

    #[test]
    fn change_set_builds_bound_statements_in_order() {
        let changes = ChangeSet {
            updates: vec![RowUpdate { key: row(json!({"id": 1})), values: row(json!({"name": "O'Brien", "note": null})) }],
            inserts: vec![row(json!({"name": "New"}))],
            deletes: vec![row(json!({"id": 7}))],
        };
        let st = change_set_statements(Dialect::Mysql, Some("shop"), None, "people", &changes, &no_types()).unwrap();
        assert_eq!(st.len(), 3);
        assert_eq!(st[0].sql, "DELETE FROM `shop`.`people` WHERE `id` = ?");
        assert_eq!(st[0].params, vec![json!(7)]);
        assert_eq!(st[1].sql, "UPDATE `shop`.`people` SET `name` = ?, `note` = ? WHERE `id` = ?");
        assert_eq!(st[1].params, vec![json!("O'Brien"), json!(null), json!(1)]);
        assert_eq!(st[2].sql, "INSERT INTO `shop`.`people` (`name`) VALUES (?)");
        assert_eq!(preview_sql(&st[1]), "UPDATE `shop`.`people` SET `name` = 'O''Brien', `note` = NULL WHERE `id` = 1");
    }

    #[test]
    fn null_key_uses_is_null_and_empty_key_fails() {
        let mut params = vec![];
        assert_eq!(key_condition(&row(json!({"a": null})), &mut Marks::new(Dialect::Sqlite, &no_types()), &mut params).unwrap(), "\"a\" IS NULL");
        assert!(params.is_empty());
        let changes = ChangeSet { deletes: vec![row(json!({}))], ..Default::default() };
        assert!(change_set_statements(Dialect::Sqlite, None, None, "t", &changes, &no_types()).is_err());
    }

    #[test]
    fn empty_insert_uses_defaults() {
        let changes = ChangeSet { inserts: vec![row(json!({}))], ..Default::default() };
        assert_eq!(change_set_statements(Dialect::Sqlite, None, None, "t", &changes, &no_types()).unwrap()[0].sql, "INSERT INTO \"t\" DEFAULT VALUES");
        assert_eq!(change_set_statements(Dialect::Mysql, None, None, "t", &changes, &no_types()).unwrap()[0].sql, "INSERT INTO `t` () VALUES ()");
    }

    #[test]
    fn splits_statements_ignoring_quotes_and_comments() {
        let sql = "select 'a;b' as x; -- c;\nselect `q;`;/* x; */ select \"d;\"\n;\n  ";
        let parts: Vec<String> = split_statements(sql).into_iter().map(|s| s.text).collect();
        assert_eq!(parts, vec!["select 'a;b' as x", "-- c;\nselect `q;`", "/* x; */ select \"d;\""]);
    }

    #[test]
    fn split_offsets_point_into_original_text() {
        let sql = "  select 1;\nselect 'é';";
        let st = split_statements(sql);
        let chars: Vec<char> = sql.chars().collect();
        for s in &st {
            assert_eq!(chars[s.start..s.end].iter().collect::<String>(), s.text);
        }
        assert_eq!(st.len(), 2);
    }

    #[test]
    fn escaped_quotes_do_not_end_strings() {
        let parts = split_statements("select 'it''s; fine'; select 'a\\';b'; select 2");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].text, "select 'it''s; fine'");
        assert_eq!(parts[1].text, "select 'a\\';b'");
    }

    #[test]
    fn comment_only_script_has_no_statements() {
        assert!(split_statements("-- nothing\n/* here */").is_empty());
    }

    fn no_types() -> HashMap<String, String> {
        HashMap::new()
    }

    fn types(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn postgres_quotes_identifiers_and_schema() {
        assert_eq!(Dialect::Postgres.quote_ident("Orders"), "\"Orders\"");
        assert_eq!(Dialect::Postgres.quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(Dialect::Postgres.quote_ident("a.b"), "\"a.b\"");
        assert_eq!(Dialect::Postgres.qualified_in(Some("shop"), Some("billing"), "invoices"), "\"billing\".\"invoices\"");
        assert_eq!(Dialect::Postgres.qualified_in(Some("shop"), None, "Orders"), "\"Orders\"");
        assert_eq!(Dialect::Postgres.qualified_in(None, Some(""), "t"), "\"t\"");
        assert_eq!(Dialect::Postgres.qualified(Some("shop"), "t"), "\"t\"", "the database is never a qualifier in Postgres");
        // other dialects ignore the schema
        assert_eq!(Dialect::Mysql.qualified_in(Some("shop"), Some("billing"), "orders"), "`shop`.`orders`");
        assert_eq!(Dialect::Sqlite.qualified_in(Some("main"), Some("billing"), "orders"), "\"orders\"");
    }

    #[test]
    fn postgres_page_count_and_values_use_the_schema() {
        let req = PageRequest {
            database: Some("shop".into()),
            schema: Some("public".into()),
            table: "Orders".into(),
            filter: Some("total > 1".into()),
            sort: vec![SortSpec { column: "Total".into(), descending: false }],
            limit: 50,
            offset: 100,
        };
        assert_eq!(
            select_page_sql(Dialect::Postgres, &req),
            "SELECT * FROM \"public\".\"Orders\" WHERE total > 1 ORDER BY \"Total\" ASC LIMIT 51 OFFSET 100"
        );
        assert_eq!(count_sql(Dialect::Postgres, &req), "SELECT COUNT(*) FROM \"public\".\"Orders\" WHERE total > 1");
        assert_eq!(
            common_values_sql(Dialect::Postgres, Some("shop"), Some("billing"), "a.b", "St", 5),
            "SELECT v FROM (SELECT \"St\" AS v FROM \"billing\".\"a.b\" WHERE \"St\" IS NOT NULL LIMIT 20000) s GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT 5"
        );
        // MySQL ignores the schema
        let my = PageRequest { table: "orders".into(), filter: None, sort: vec![], ..req };
        assert_eq!(select_page_sql(Dialect::Mysql, &my), "SELECT * FROM `shop`.`orders` LIMIT 51 OFFSET 100");
    }

    #[test]
    fn page_request_schema_defaults_to_none() {
        let req: PageRequest = serde_json::from_value(json!({"database": "shop", "table": "t", "limit": 1, "offset": 0})).unwrap();
        assert_eq!(req.schema, None);
    }

    #[test]
    fn postgres_change_set_uses_numbered_casts() {
        let changes = ChangeSet {
            updates: vec![RowUpdate { key: row(json!({"id": 5})), values: row(json!({"total": "12.50"})) }],
            ..Default::default()
        };
        let t = types(&[("id", "int8"), ("total", "numeric")]);
        let st = change_set_statements(Dialect::Postgres, Some("shop"), Some("public"), "Orders", &changes, &t).unwrap();
        assert_eq!(st[0].sql, "UPDATE \"public\".\"Orders\" SET \"total\" = $1::numeric WHERE \"id\" = $2::int8");
        assert_eq!(st[0].params, vec![json!("12.50"), json!(5)]);
        assert_eq!(preview_sql(&st[0]), "UPDATE \"public\".\"Orders\" SET \"total\" = '12.50'::numeric WHERE \"id\" = 5::int8");

        let all = ChangeSet {
            deletes: vec![row(json!({"id": 1, "note": null}))],
            updates: vec![RowUpdate { key: row(json!({"id": 2})), values: row(json!({"at": {"$expr": "DEFAULT"}, "tags": "{a,b}"})) }],
            inserts: vec![row(json!({"id": 3, "at": {"$expr": "CURRENT_TIMESTAMP"}, "tags": "{c}"})), row(json!({}))],
        };
        let t = types(&[("id", "integer"), ("tags", "text[]"), ("at", "timestamp with time zone")]);
        let st = change_set_statements(Dialect::Postgres, None, Some("billing"), "t", &all, &t).unwrap();
        assert_eq!(st[0].sql, "DELETE FROM \"billing\".\"t\" WHERE \"id\" = $1::integer AND \"note\" IS NULL");
        assert_eq!(st[1].sql, "UPDATE \"billing\".\"t\" SET \"at\" = DEFAULT, \"tags\" = $1::text[] WHERE \"id\" = $2::integer");
        assert_eq!(st[2].sql, "INSERT INTO \"billing\".\"t\" (\"at\", \"id\", \"tags\") VALUES (CURRENT_TIMESTAMP, $1::integer, $2::text[])");
        assert_eq!(st[3].sql, "INSERT INTO \"billing\".\"t\" DEFAULT VALUES");

        // a column without a known type is bound without a cast
        let st = change_set_statements(Dialect::Postgres, None, None, "t", &ChangeSet { deletes: vec![row(json!({"id": 1}))], ..Default::default() }, &no_types()).unwrap();
        assert_eq!(st[0].sql, "DELETE FROM \"t\" WHERE \"id\" = $1");
    }

    #[test]
    fn postgres_cast_types_are_checked_before_they_go_into_sql() {
        for ok in [
            "numeric(12,2)",
            "character varying(255)",
            "timestamp(3) with time zone",
            "integer[]",
            "int4[][]",
            "public.\"My Enum\"",
            "\"we\"\"ird\"",
            "interval day to second(3)",
        ] {
            let changes = ChangeSet { deletes: vec![row(json!({"c": 1}))], ..Default::default() };
            let st = change_set_statements(Dialect::Postgres, None, None, "t", &changes, &types(&[("c", ok)]));
            assert_eq!(st.unwrap()[0].sql, format!("DELETE FROM \"t\" WHERE \"c\" = $1::{ok}"), "{ok}");
        }
        for bad in [
            "int); DELETE FROM t; --",
            "int), pg_sleep(1), (1",
            "int -- x",
            "int/**/",
            "text'",
            "\"unterminated",
            "numeric(a)",
            "",
            "int;",
        ] {
            let changes = ChangeSet { deletes: vec![row(json!({"c": 1}))], ..Default::default() };
            let err = change_set_statements(Dialect::Postgres, None, None, "t", &changes, &types(&[("c", bad)]));
            assert!(err.is_err(), "should refuse type {bad:?}");
        }
    }

    #[test]
    fn preview_ignores_marks_inside_quoted_names() {
        let st = SqlStatement { sql: "UPDATE \"a$1?\" SET \"b\" = $1::text WHERE \"id\" = $2".into(), params: vec![json!("x"), json!(2)] };
        assert_eq!(preview_sql(&st), "UPDATE \"a$1?\" SET \"b\" = 'x'::text WHERE \"id\" = 2");
    }

    #[test]
    fn splits_postgres_dollar_quotes_and_escape_strings() {
        let parts: Vec<String> = split_statements("select $$a;b$$; select 2").into_iter().map(|s| s.text).collect();
        assert_eq!(parts, vec!["select $$a;b$$", "select 2"]);
        let parts: Vec<String> = split_statements("select $fn$ x; $$ y; $fn$; select 2").into_iter().map(|s| s.text).collect();
        assert_eq!(parts, vec!["select $fn$ x; $$ y; $fn$", "select 2"]);
        assert_eq!(split_statements("select E'it\\'s;'; select 1").len(), 2);
        assert_eq!(split_statements("select e'a\\\\'; select 1").len(), 2);
        // $1 is a parameter and a$b an identifier, not dollar quotes
        assert_eq!(split_statements("select $1; select a$b$ from t; select 3").len(), 3);
    }

    fn pg_parts(sql: &str) -> Vec<String> {
        split_statements_for(sql, Dialect::Postgres).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn postgres_split_follows_the_postgres_lexer() {
        // a backslash escapes only in E'…' strings (standard_conforming_strings = on)
        assert_eq!(pg_parts("select 'C:\\'; select 2"), vec!["select 'C:\\'", "select 2"]);
        assert_eq!(pg_parts("select E'it\\'s;'; select 1"), vec!["select E'it\\'s;'", "select 1"]);
        assert_eq!(pg_parts("select \"a\\\"; select 2"), vec!["select \"a\\\"", "select 2"]);
        // `#` is an operator, backticks are not quotes, block comments nest
        assert_eq!(pg_parts("select 1 # 2; select 3"), vec!["select 1 # 2", "select 3"]);
        assert_eq!(pg_parts("select `a; select 2`"), vec!["select `a", "select 2`"]);
        assert_eq!(pg_parts("select /* a /* b */ ; */ 1; select 2"), vec!["select /* a /* b */ ; */ 1", "select 2"]);
        // `--` ends at \r as well as \n
        assert_eq!(pg_parts("--x\rCOMMIT\nWORK; delete from t"), vec!["--x\rCOMMIT\nWORK", "delete from t"]);
        assert_eq!(pg_parts("select $$a;b$$; select 2"), vec!["select $$a;b$$", "select 2"]);
        // the offsets still point into the text
        let sql = "  select 'é\\';\nselect 2";
        let chars: Vec<char> = sql.chars().collect();
        for s in split_statements_for(sql, Dialect::Postgres) {
            assert_eq!(chars[s.start..s.end].iter().collect::<String>(), s.text);
        }
    }

    #[test]
    fn mysql_and_sqlite_split_as_before() {
        for d in [Dialect::Mysql, Dialect::Sqlite] {
            assert_eq!(split_statements_for("select 'C:\\'; select 2", d).len(), 1, "{d:?}");
            assert_eq!(split_statements_for("select 1 # 2; select 3", d).len(), 1, "{d:?}");
            assert_eq!(split_statements_for("select `a; b`; select 2", d).len(), 2, "{d:?}");
        }
        assert_eq!(split_statements("select 'C:\\'; select 2").len(), 1, "the default is MySQL");
    }

    #[test]
    fn explain_analyze_runs_the_statement() {
        assert!(!is_read_only_statement("explain analyze delete from t"));
        assert!(!is_read_only_statement("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1"));
        assert!(!is_read_only_statement("explain analyse insert into t values (1)"));
        assert!(!is_read_only_statement("explain (analyze true) delete from t"));
        assert!(is_read_only_statement("explain analyze select 1"));
        assert!(is_read_only_statement("explain delete from t"), "plain EXPLAIN does not run the statement");
        assert!(is_read_only_statement("table customers"));
        assert!(is_read_only_statement("values (1)"));
    }

    #[test]
    fn with_that_changes_data_is_not_read_only() {
        assert!(!is_read_only_statement("with d as (delete from t returning *) select * from d"));
        assert!(!is_read_only_statement("WITH x AS (SELECT 1) UPDATE t SET a = 1"));
        assert!(!is_read_only_statement("with x as (select 1) insert into t select * from x"));
        assert!(is_read_only_statement("with x as (select 'delete' as \"update\") select * from x"));
    }

    #[test]
    fn detects_read_only_statements() {
        assert!(is_read_only_statement("  -- hi\n SELECT 1"));
        assert!(is_read_only_statement("/* x */ show tables"));
        assert!(is_read_only_statement("with a as (select 1) select * from a"));
        assert!(!is_read_only_statement("update t set a=1"));
        assert!(!is_read_only_statement("DROP TABLE t"));
        assert!(!is_read_only_statement("pragma journal_mode=wal"));
    }
}
