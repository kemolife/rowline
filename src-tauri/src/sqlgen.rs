//! SQL text generation. Identifiers are quoted per dialect, values are always bound parameters.

use crate::error::{AppError, AppResult};
use crate::model::{ChangeSet, PageRequest, RowValues, SqlStatement};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Mysql,
    Sqlite,
}

impl Dialect {
    pub fn quote_ident(self, name: &str) -> String {
        match self {
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
            Dialect::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
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
}

fn where_clause(filter: &Option<String>) -> String {
    match filter.as_deref().map(str::trim) {
        Some(f) if !f.is_empty() => format!(" WHERE {f}"),
        _ => String::new(),
    }
}

pub fn select_page_sql(dialect: Dialect, req: &PageRequest) -> String {
    let mut sql = format!(
        "SELECT * FROM {}{}",
        dialect.qualified(req.database.as_deref(), &req.table),
        where_clause(&req.filter)
    );
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
pub fn common_values_sql(dialect: Dialect, database: Option<&str>, table: &str, column: &str, limit: usize) -> String {
    format!(
        "SELECT v FROM (SELECT {col} AS v FROM {t} WHERE {col} IS NOT NULL LIMIT {SUGGEST_SAMPLE}) s GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT {limit}",
        col = dialect.quote_ident(column),
        t = dialect.qualified(database, table),
    )
}

pub fn count_sql(dialect: Dialect, req: &PageRequest) -> String {
    format!(
        "SELECT COUNT(*) FROM {}{}",
        dialect.qualified(req.database.as_deref(), &req.table),
        where_clause(&req.filter)
    )
}

fn key_condition(dialect: Dialect, key: &RowValues, params: &mut Vec<Value>) -> AppResult<String> {
    if key.is_empty() {
        return Err(AppError::msg("Row key is empty; table needs a primary key for editing"));
    }
    let parts: Vec<String> = key
        .iter()
        .map(|(col, val)| {
            if val.is_null() {
                format!("{} IS NULL", dialect.quote_ident(col))
            } else {
                params.push(val.clone());
                format!("{} = ?", dialect.quote_ident(col))
            }
        })
        .collect();
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
pub fn change_set_statements(
    dialect: Dialect,
    database: Option<&str>,
    table: &str,
    changes: &ChangeSet,
) -> AppResult<Vec<SqlStatement>> {
    let target = dialect.qualified(database, table);
    let mut res = Vec::new();

    for key in &changes.deletes {
        let mut params = Vec::new();
        let cond = key_condition(dialect, key, &mut params)?;
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
        let mut sets: Vec<String> = Vec::new();
        for (col, val) in &upd.values {
            let col = dialect.quote_ident(col);
            match expression(val)? {
                Some("DEFAULT") if dialect == Dialect::Sqlite => {
                    return Err(AppError::msg("SQLite can't reset an existing value to its DEFAULT. Type the value instead."));
                }
                Some(expr) => sets.push(format!("{col} = {expr}")),
                None => {
                    params.push(val.clone());
                    sets.push(format!("{col} = ?"));
                }
            }
        }
        let cond = key_condition(dialect, &upd.key, &mut params)?;
        res.push(SqlStatement {
            sql: format!("UPDATE {target} SET {} WHERE {cond}", sets.join(", ")),
            params,
        });
    }

    for row in &changes.inserts {
        // SQLite has no DEFAULT keyword in VALUES: leaving the column out means the same
        let mut cols = Vec::new();
        let mut marks = Vec::new();
        let mut params = Vec::new();
        for (col, val) in row {
            match expression(val)? {
                Some("DEFAULT") if dialect == Dialect::Sqlite => continue,
                Some(expr) => marks.push(expr.to_string()),
                None => {
                    params.push(val.clone());
                    marks.push("?".into());
                }
            }
            cols.push(dialect.quote_ident(col));
        }
        if cols.is_empty() {
            let sql = match dialect {
                Dialect::Mysql => format!("INSERT INTO {target} () VALUES ()"),
                Dialect::Sqlite => format!("INSERT INTO {target} DEFAULT VALUES"),
            };
            res.push(SqlStatement { sql, params: vec![] });
            continue;
        }
        res.push(SqlStatement {
            sql: format!("INSERT INTO {target} ({}) VALUES ({})", cols.join(", "), marks.join(", ")),
            params,
        });
    }

    Ok(res)
}

/// SQL with parameters inlined as literals — only for showing the user what will run.
pub fn preview_sql(stmt: &SqlStatement) -> String {
    let mut out = String::new();
    let mut params = stmt.params.iter();
    for ch in stmt.sql.chars() {
        if ch == '?' {
            match params.next() {
                Some(v) => out.push_str(&literal(v)),
                None => out.push('?'),
            }
        } else {
            out.push(ch);
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

/// Splits a script on `;`, ignoring semicolons inside quotes, backticks and comments.
/// Offsets are character (not byte) offsets so the editor can use them directly.
pub fn split_statements(sql: &str) -> Vec<StatementRange> {
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

/// True for statements that only read data. Used for the production safety check.
pub fn is_read_only_statement(sql: &str) -> bool {
    let body = strip_leading_comments(sql);
    let keyword: String = body
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    matches!(
        keyword.as_str(),
        "SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "WITH" | "VALUES" | "TABLE"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_values_sample_the_table() {
        assert_eq!(
            common_values_sql(Dialect::Mysql, Some("shop"), "orders", "st`atus", 50),
            "SELECT v FROM (SELECT `st``atus` AS v FROM `shop`.`orders` WHERE `st``atus` IS NOT NULL LIMIT 20000) s GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT 50"
        );
    }
    use crate::model::{RowUpdate, SortSpec};
    use serde_json::json;

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
        let req = PageRequest { database: None, table: "t".into(), filter: Some("  ".into()), sort: vec![], limit: 10, offset: 0 };
        assert_eq!(select_page_sql(Dialect::Sqlite, &req), "SELECT * FROM \"t\" LIMIT 11 OFFSET 0");
    }

    #[test]
    fn expressions_are_written_as_keywords_and_only_from_the_list() {
        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "DEFAULT"}, "at": {"$expr": "current_timestamp"}, "name": "x"} }],
            "inserts": [{ "note": {"$expr": "DEFAULT"}, "day": {"$expr": "CURRENT_DATE"}, "name": "y" }]
        }))
        .unwrap();
        let st = change_set_statements(Dialect::Mysql, None, "t", &changes).unwrap();
        assert!(st[0].sql.contains("`note` = DEFAULT") && st[0].sql.contains("`at` = CURRENT_TIMESTAMP"), "{}", st[0].sql);
        assert_eq!(st[0].params, vec![json!("x"), json!(1)]);
        assert!(st[1].sql.contains("VALUES (DEFAULT, CURRENT_DATE, ?)") || st[1].sql.contains("CURRENT_DATE"), "{}", st[1].sql);
        assert_eq!(st[1].params, vec![json!("y")]);
        assert!(preview_sql(&st[0]).contains("= CURRENT_TIMESTAMP"));

        // SQLite: DEFAULT in an INSERT leaves the column out; in an UPDATE it is refused
        let ins: ChangeSet = serde_json::from_value(json!({ "inserts": [{ "note": {"$expr": "DEFAULT"}, "name": "y" }] })).unwrap();
        let st = change_set_statements(Dialect::Sqlite, None, "t", &ins).unwrap();
        assert_eq!(st[0].sql, "INSERT INTO \"t\" (\"name\") VALUES (?)");
        let only_default: ChangeSet = serde_json::from_value(json!({ "inserts": [{ "note": {"$expr": "DEFAULT"} }] })).unwrap();
        assert_eq!(change_set_statements(Dialect::Sqlite, None, "t", &only_default).unwrap()[0].sql, "INSERT INTO \"t\" DEFAULT VALUES");
        let upd: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "DEFAULT"}} }] })).unwrap();
        assert!(change_set_statements(Dialect::Sqlite, None, "t", &upd).is_err());

        // anything else is refused, never written into SQL
        let evil: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "1; DROP TABLE t"}} }] })).unwrap();
        assert!(change_set_statements(Dialect::Mysql, None, "t", &evil).unwrap_err().to_string().contains("Unsupported"));
    }

    #[test]
    fn change_set_builds_bound_statements_in_order() {
        let changes = ChangeSet {
            updates: vec![RowUpdate { key: row(json!({"id": 1})), values: row(json!({"name": "O'Brien", "note": null})) }],
            inserts: vec![row(json!({"name": "New"}))],
            deletes: vec![row(json!({"id": 7}))],
        };
        let st = change_set_statements(Dialect::Mysql, Some("shop"), "people", &changes).unwrap();
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
        assert_eq!(key_condition(Dialect::Sqlite, &row(json!({"a": null})), &mut params).unwrap(), "\"a\" IS NULL");
        assert!(params.is_empty());
        let changes = ChangeSet { deletes: vec![row(json!({}))], ..Default::default() };
        assert!(change_set_statements(Dialect::Sqlite, None, "t", &changes).is_err());
    }

    #[test]
    fn empty_insert_uses_defaults() {
        let changes = ChangeSet { inserts: vec![row(json!({}))], ..Default::default() };
        assert_eq!(change_set_statements(Dialect::Sqlite, None, "t", &changes).unwrap()[0].sql, "INSERT INTO \"t\" DEFAULT VALUES");
        assert_eq!(change_set_statements(Dialect::Mysql, None, "t", &changes).unwrap()[0].sql, "INSERT INTO `t` () VALUES ()");
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
