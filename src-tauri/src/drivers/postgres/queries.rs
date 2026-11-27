//! Reading and changing data on a Postgres session.

use super::values::*;
use super::{Access, PostgresSession, SERVER_FILE_ROLES, SUPERUSER_MESSAGE, UNLOCK_MESSAGE, server_role_message};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::sqlgen::{self, Dialect};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{CancelToken, Client, SimpleQueryMessage};

/// Statements that end the transaction a locked prod query runs in (after them, writes would run outside the
/// READ ONLY transaction). `BEGIN` / `START TRANSACTION` inside it are only a warning, so they are not listed.
const TRANSACTION_END: &[&str] = &["COMMIT", "END", "ROLLBACK", "ABORT"];

const NO_LONGER_READ_ONLY: &str = "The script ended the read-only transaction of this prod tab, so it was stopped and rolled back. Use \"Unlock writes\" on this tab to change data.";

const TRANSACTION_REFUSED: &str = "COMMIT, ROLLBACK, END, ABORT and PREPARE TRANSACTION can't run on a read-only prod tab. Use \"Unlock writes\" on this tab to change data.";

impl PostgresSession {
    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        let tx = self.begin(None, None, Access::ReadOnly).await?;
        let res = async {
            let row = tx.c.query_one("SELECT current_setting('server_version'), current_database()::text", &[]).await?;
            let (version, db): (String, String) = (row.get(0), row.get(1));
            Ok(ServerInfo { version: format!("PostgreSQL {version}"), current_database: Some(db) })
        }
        .await;
        tx.finish(res).await
    }

    /// True when the login (or the role set with SET ROLE) is a superuser.
    pub async fn is_superuser(&self, database: Option<&str>) -> AppResult<bool> {
        let tx = self.begin(database, None, Access::ReadOnly).await?;
        let res = superuser(&tx.c).await;
        tx.finish(res).await
    }

    /// Why Claude, MCP and `udb` must not use this login, or None when they may: a superuser (or a member of a
    /// superuser role), or a member of a role that reads/writes server files or runs server programs.
    pub async fn ai_refusal(&self, database: Option<&str>) -> AppResult<Option<String>> {
        let tx = self.begin(database, None, Access::ReadOnly).await?;
        let res = ai_refusal(&tx.c).await;
        tx.finish(res).await
    }

    pub async fn select_page(&self, req: PageRequest, unlocked: bool) -> AppResult<QueryResult> {
        let locked = self.locked(unlocked);
        let sql = sqlgen::select_page_sql(Dialect::Postgres, &req);
        let tx = self.begin(req.database.as_deref(), req.schema.as_deref(), access(locked)).await?;
        // the query asks for one row more than the page: no need to stop the server for that row
        let res = self.run_tracked(&tx.c, &sql, req.limit as usize, false).await.map_err(|e| lock_error(e, locked));
        let mut res = tx.finish(res).await?;
        res.statement = Some(sql);
        Ok(res)
    }

    pub async fn count(&self, req: PageRequest, unlocked: bool) -> AppResult<u64> {
        let locked = self.locked(unlocked);
        let sql = sqlgen::count_sql(Dialect::Postgres, &req);
        let tx = self.begin(req.database.as_deref(), req.schema.as_deref(), access(locked)).await?;
        // tracked, so Cancel stops a slow count on a big table too
        let res = self
            .tracked(tx.c.cancel_token(), tx.c.query_one(sql.as_str(), &[]))
            .await
            .map(|row| row.get::<_, i64>(0).max(0) as u64)
            .map_err(|e| lock_error(e.into(), locked));
        tx.finish(res).await
    }

    /// Most common values of a column (filter suggestions). Always read-only.
    pub async fn common_values(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
        column: &str,
        limit: usize,
    ) -> AppResult<Vec<serde_json::Value>> {
        let sql = sqlgen::common_values_sql(Dialect::Postgres, None, schema, table, column, limit);
        let tx = self.begin(database, schema, Access::ReadOnly).await?;
        let res = self.run_tracked(&tx.c, &sql, limit, true).await;
        let res = tx.finish(res).await?;
        Ok(res.rows.into_iter().filter_map(|r| r.into_iter().next()).collect())
    }

    /// Runs a script (SQL editor) in one transaction. A failing statement keeps the results before it, ends
    /// the script and rolls the whole transaction back. On a locked prod connection the transaction is
    /// READ ONLY and statements that would end it are refused.
    pub async fn execute(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        sql: &str,
        max_rows: usize,
        unlocked: bool,
    ) -> AppResult<Vec<QueryResult>> {
        let locked = self.locked(unlocked);
        let statements = sqlgen::split_statements_for(sql, Dialect::Postgres);
        if statements.is_empty() {
            return Ok(Vec::new());
        }
        if locked && statements.iter().any(|st| ends_transaction(&st.text)) {
            return Err(AppError::msg(TRANSACTION_REFUSED));
        }
        let tx = self.begin(database, schema, access(locked)).await?;
        // locked: after every statement the READ ONLY transaction must still be the one begin() started
        let marker = match locked {
            true => match transaction_marker(&tx.c).await {
                Ok(m) => Some(m),
                Err(e) => return tx.finish(Err(e)).await,
            },
            false => None,
        };
        let mut results = Vec::new();
        let mut first_error = None;
        let mut failed = false;
        for st in statements {
            let ran = self.run_tracked(&tx.c, &st.text, max_rows, true).await;
            if let (Ok(_), Some(m)) = (&ran, &marker) {
                if let Err(e) = still_read_only(&tx.c, m).await {
                    return tx.end(Err(e), false).await;
                }
            }
            match ran {
                Ok(mut res) => {
                    res.statement = Some(st.text);
                    results.push(res);
                }
                Err(e) => {
                    let e = lock_error(e, locked);
                    failed = true;
                    if results.is_empty() {
                        // nothing ran yet: a plain error, as for a single statement
                        first_error = Some(e);
                    } else {
                        results.push(QueryResult::failed(st.text, e.to_string()));
                    }
                    break;
                }
            }
        }
        let res = match first_error {
            Some(e) => Err(e),
            None => Ok(results),
        };
        tx.end(res, !failed).await
    }

    /// Claude, MCP and `udb`: one statement in a READ ONLY transaction with statement_timeout, always rolled
    /// back. Refused for system schemas and for superusers. The caller runs `readonly::check` first.
    pub async fn select_read_only(&self, database: Option<&str>, schema: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        crate::readonly::blocked_schema(schema)?;
        let timeout = crate::readonly::TIMEOUT;
        let tx = self.begin(database, schema, Access::Guarded).await?;
        if let Some(refusal) = ai_refusal(&tx.c).await? {
            return tx.finish(Err(AppError::msg(refusal))).await;
        }
        let token = tx.c.cancel_token();
        let res = match tokio::time::timeout(timeout + Duration::from_secs(2), self.run_tracked(&tx.c, sql, max_rows, true)).await {
            Ok(Err(e)) if is_statement_timeout(&e) => Err(timeout_error(timeout)),
            Ok(r) => r,
            Err(_) => {
                // the client is in the middle of a query: stop it and close the client (tx is dropped)
                let _ = token.cancel_query(self.tls.clone()).await;
                return Err(timeout_error(timeout));
            }
        };
        tx.end(res, false).await
    }

    /// Applies grid edits in one transaction. Values go as text and are cast to the column type on the server.
    pub async fn apply_changes(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
        changes: ChangeSet,
        unlocked: bool,
    ) -> AppResult<u64> {
        let locked = self.locked(unlocked);
        let tx = self.begin(database, schema, access(locked)).await?;
        let res = async {
            let types = column_types(&tx.c, schema, table).await?;
            refuse_bytea(&changes, &types)?;
            let statements = sqlgen::change_set_statements(Dialect::Postgres, None, schema, table, &changes, &types)?;
            let mut total = 0u64;
            for st in &statements {
                let stmt = tx.c.prepare_typed(&st.sql, &vec![Type::TEXT; st.params.len()]).await?;
                let params: Vec<Option<String>> = st.params.iter().map(json_to_text).collect();
                let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
                total += self.tracked(tx.c.cancel_token(), tx.c.execute(&stmt, &refs)).await?;
            }
            Ok(total)
        }
        .await
        .map_err(|e| lock_error(e, locked));
        tx.finish(res).await
    }

    /// Stops running queries: those of one tab with `owner`, else all of them.
    pub async fn cancel(&self, owner: Option<&str>) -> AppResult<()> {
        let tokens: Vec<CancelToken> = super::lock(&self.running)
            .iter()
            .filter(|(_, o, _)| owner.is_none() || o.as_deref() == owner)
            .map(|(_, _, t)| t.clone())
            .collect();
        for t in tokens {
            let _ = t.cancel_query(self.tls.clone()).await;
        }
        Ok(())
    }

    async fn run_tracked(&self, c: &Client, sql: &str, max_rows: usize, stop_early: bool) -> AppResult<QueryResult> {
        self.tracked(c.cancel_token(), self.run_query(c, sql, max_rows, stop_early)).await
    }

    /// Runs `work` with its cancel token in `running` (owned by the current tab, see `owner`), so cancel()
    /// can stop it. The entry goes away even when `work` is dropped half way.
    async fn tracked<T>(&self, token: CancelToken, work: impl std::future::Future<Output = T>) -> T {
        struct Entry<'a>(&'a PostgresSession, u64);
        impl Drop for Entry<'_> {
            fn drop(&mut self) {
                let mut r = super::lock(&self.0.running);
                if let Some(i) = r.iter().position(|(x, _, _)| *x == self.1) {
                    r.remove(i);
                }
            }
        }
        let id = self.next_query.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        super::lock(&self.running).push((id, crate::owner::current(), token));
        let _entry = Entry(self, id);
        work.await
    }

    /// Runs one statement and reads at most `max_rows` rows, all in text format (the server's own text for
    /// every value). Column types come from preparing the statement; preparing also refuses more than one
    /// statement. With `stop_early`, a plain query is read through a cursor, so the server stops after
    /// `max_rows` (cancelling it instead would abort the whole transaction). Other statements with rows
    /// (`INSERT … RETURNING`, data-changing `WITH`) run to the end and the extra rows are dropped.
    async fn run_query(&self, c: &Client, sql: &str, max_rows: usize, stop_early: bool) -> AppResult<QueryResult> {
        let start = Instant::now();
        let stmt = c.prepare(sql).await?;
        let types: Vec<Type> = stmt.columns().iter().map(|col| col.type_().clone()).collect();
        let columns: Vec<ResultColumn> =
            stmt.columns().iter().map(|col| ResultColumn { name: col.name().to_string(), type_name: type_name(col.type_()) }).collect();
        drop(stmt);
        let text = if stop_early && !columns.is_empty() && is_plain_query(sql) {
            // the newline keeps a trailing `--` comment of `sql` away from the next statements
            format!("DECLARE {CURSOR} NO SCROLL CURSOR FOR {sql}\n; FETCH {} FROM {CURSOR}; CLOSE {CURSOR}", max_rows.saturating_add(1))
        } else {
            sql.to_string()
        };
        let stream = c.simple_query_raw(&text).await?;
        let mut stream = std::pin::pin!(stream);
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut affected = None;
        let mut truncated = false;
        while let Some(msg) = stream.next().await {
            match msg? {
                SimpleQueryMessage::Row(r) => {
                    if rows.len() >= max_rows {
                        truncated = true;
                        continue;
                    }
                    rows.push((0..r.len()).map(|i| text_to_json(types.get(i).unwrap_or(&Type::TEXT), r.get(i))).collect());
                }
                SimpleQueryMessage::CommandComplete(n) => affected = Some(n),
                _ => {}
            }
        }
        let elapsed_ms = start.elapsed().as_millis() as u64;
        if columns.is_empty() {
            return Ok(QueryResult { affected_rows: Some(affected.unwrap_or(0)), elapsed_ms, ..Default::default() });
        }
        Ok(QueryResult { columns, rows, affected_rows: None, elapsed_ms, truncated, ..Default::default() })
    }
}

/// Cursor of a row-limited read
const CURSOR: &str = "rowline_fetch";

/// A query a cursor can read: SELECT / VALUES / TABLE / WITH without data-changing parts.
fn is_plain_query(sql: &str) -> bool {
    let w = first_words(sql);
    matches!(w.first().map(String::as_str), Some("SELECT" | "VALUES" | "TABLE" | "WITH")) && sqlgen::is_read_only_statement(sql)
}

fn access(locked: bool) -> Access {
    if locked { Access::ReadOnly } else { Access::ReadWrite }
}

/// A write refused by the READ ONLY transaction of a locked prod call reads as what to do about it.
fn lock_error(e: AppError, locked: bool) -> AppError {
    if locked && e.postgres_code() == Some("25006") { AppError::msg(UNLOCK_MESSAGE) } else { e }
}

fn is_statement_timeout(e: &AppError) -> bool {
    matches!(e, AppError::Postgres(pg) if pg.as_db_error().is_some_and(|d| d.code().code() == "57014" && d.message().contains("statement timeout")))
}

fn timeout_error(timeout: Duration) -> AppError {
    AppError::Timeout(format!("the query ran longer than {} s", timeout.as_secs()))
}

async fn superuser(c: &Client) -> AppResult<bool> {
    let row = c.query_one("SHOW is_superuser", &[]).await?;
    Ok(row.get::<_, String>(0) == "on")
}

/// The message for a login Claude, MCP and `udb` must not use, checked in the caller's transaction.
async fn ai_refusal(c: &Client) -> AppResult<Option<String>> {
    // a member of a superuser role could become it with SET ROLE: treated as a superuser too
    let row = c
        .query_one("SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolsuper AND pg_has_role(current_user, r.oid, 'MEMBER'))", &[])
        .await?;
    if superuser(c).await? || row.get::<_, bool>(0) {
        return Ok(Some(SUPERUSER_MESSAGE.to_string()));
    }
    for role in SERVER_FILE_ROLES {
        // the role is missing on very old servers: then nobody is a member
        let row = c
            .query_one("SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::text) THEN pg_has_role(current_user, $1::text, 'MEMBER') ELSE false END", &[role])
            .await?;
        if row.get::<_, bool>(0) {
            return Ok(Some(server_role_message(role)));
        }
    }
    Ok(None)
}


/// Column -> type without modifiers (`numeric`, `character varying`, `integer[]`), for `$n::type` casts.
/// Without the modifier a too long value is an error instead of being cut by the cast.
async fn column_types(c: &Client, schema: Option<&str>, table: &str) -> AppResult<HashMap<String, String>> {
    let target = Dialect::Postgres.qualified_in(None, schema, table);
    let rows = c
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, NULL) FROM pg_attribute a
             WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped",
            &[&target],
        )
        .await?;
    if rows.is_empty() {
        return Err(AppError::msg(format!("Table not found: {target}")));
    }
    Ok(rows.into_iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// bytea is shown cut (`\x…`) in the grid: writing that text back or matching rows by it would be wrong.
fn refuse_bytea(changes: &ChangeSet, types: &HashMap<String, String>) -> AppResult<()> {
    let is_bytea = |col: &str| types.get(col).is_some_and(|t| t == "bytea");
    let rows = changes
        .deletes
        .iter()
        .chain(changes.inserts.iter())
        .chain(changes.updates.iter().flat_map(|u| [&u.key, &u.values]));
    for row in rows {
        if let Some((col, _)) = row.iter().find(|(col, v)| is_bytea(col) && !v.is_null()) {
            return Err(AppError::msg(format!("Column \"{col}\" is bytea: binary values can't be edited in the grid.")));
        }
    }
    Ok(())
}

/// First keywords of one statement, after whitespace and comments (as Postgres reads them: nested `/* */`,
/// `--` up to \n or \r).
fn first_words(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    let mut words = Vec::new();
    while i < chars.len() && words.len() < 2 {
        i = sqlgen::pg_skip_comments(&chars, i);
        match chars.get(i) {
            Some(c) if c.is_alphabetic() || *c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                    i += 1;
                }
                words.push(chars[start..i].iter().collect::<String>().to_uppercase());
            }
            _ => break,
        }
    }
    words
}

/// What tells the transaction of a locked call apart from any later one: its start time.
async fn transaction_marker(c: &Client) -> AppResult<String> {
    Ok(c.query_one("SELECT transaction_timestamp()::text", &[]).await?.get(0))
}

/// Err when the transaction is no longer the READ ONLY one with `marker` (a statement ended it).
async fn still_read_only(c: &Client, marker: &str) -> AppResult<()> {
    let row = c.query_one("SELECT current_setting('transaction_read_only'), transaction_timestamp()::text", &[]).await?;
    let (read_only, started): (String, String) = (row.get(0), row.get(1));
    if read_only != "on" || started != marker {
        return Err(AppError::msg(NO_LONGER_READ_ONLY));
    }
    Ok(())
}

/// A statement that would end the transaction it runs in.
fn ends_transaction(sql: &str) -> bool {
    let w = first_words(sql);
    match w.first().map(String::as_str) {
        Some(first) if TRANSACTION_END.contains(&first) => true,
        Some("PREPARE") => w.get(1).map(String::as_str) == Some("TRANSACTION"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    //! Run with a Postgres server: ROWLINE_TEST_POSTGRES="host:port:user:password:database"
    use super::super::test_support::*;
    use super::*;
    use serde_json::json;

    fn page(schema: Option<&str>, table: &str) -> PageRequest {
        PageRequest { database: None, schema: schema.map(str::to_string), table: table.into(), filter: None, sort: vec![], limit: 100, offset: 0 }
    }

    #[test]
    fn transaction_end_is_found_behind_comments() {
        for sql in ["commit", "COMMIT AND CHAIN", "end", "rollback", "abort", "/* a /* b */ */ commit", "-- x\n  Rollback to savepoint s", "prepare transaction 'x'", "commit prepared 'x'"] {
            assert!(ends_transaction(sql), "{sql}");
        }
        for sql in ["select 1", "begin", "start transaction", "prepare p as select 1", "select 'commit'", "update t set \"end\" = 1", "savepoint s"] {
            assert!(!ends_transaction(sql), "{sql}");
        }
        // `--` ends at \r too (review PoC: `--x\rCOMMIT\nWORK` hid the COMMIT)
        assert!(ends_transaction("--x\rCOMMIT\nWORK"));
        assert!(ends_transaction("-- x\r\nrollback"));
        assert!(is_plain_query("-- x\nselect 1") && is_plain_query("with a as (select 1) select * from a") && is_plain_query("TABLE t"));
        assert!(!is_plain_query("with a as (delete from t returning *) select * from a"));
        assert!(!is_plain_query("insert into t values (1) returning *") && !is_plain_query("explain select 1"));
    }

    #[tokio::test]
    async fn server_info_names_the_version_and_database() {
        let Some(s) = session(false).await else { return };
        let info = s.server_info().await.unwrap();
        assert!(info.version.starts_with("PostgreSQL "), "{}", info.version);
        assert_eq!(info.current_database.as_deref(), Some("shop"));
    }

    #[tokio::test]
    async fn superuser_check() {
        let Some(s) = session(false).await else { return };
        assert!(s.is_superuser(None).await.unwrap());
        let r = reader_session().await.unwrap();
        assert!(!r.is_superuser(None).await.unwrap());
    }

    #[tokio::test]
    async fn page_of_a_quoted_table_with_filter_and_sort() {
        let Some(s) = session(false).await else { return };
        let req = PageRequest {
            filter: Some("total > 10".into()),
            sort: vec![SortSpec { column: "total".into(), descending: true }],
            limit: 3,
            ..page(Some("public"), "Orders")
        };
        let res = s.select_page(req.clone(), false).await.unwrap();
        assert_eq!(res.rows.len(), 3);
        assert!(res.truncated);
        let total = res.columns.iter().position(|c| c.name == "total").unwrap();
        assert_eq!(res.columns[total].type_name, "numeric");
        assert_eq!(res.rows[0][total], json!("210.00"), "numeric stays exact text");
        let raw = res.columns.iter().position(|c| c.name == "raw").unwrap();
        assert_eq!(res.rows[0][raw], json!("\\x0014"), "bytea as hex");
        let tags = res.columns.iter().position(|c| c.name == "tags").unwrap();
        assert_eq!(res.columns[tags].type_name, "text[]");
        assert_eq!(res.rows[0][tags], json!("{t20,x}"));
        assert_eq!(s.count(req, false).await.unwrap(), 20);
        // a schema other than public
        let inv = s.select_page(page(Some("billing"), "invoices"), false).await.unwrap();
        assert_eq!(inv.rows.len(), 20);
    }

    #[tokio::test]
    async fn script_results_and_search_path() {
        let Some(s) = session(false).await else { return };
        let res = s.execute(None, Some("billing"), "select count(*) from invoices; select 1 as one", 10, false).await.unwrap();
        assert_eq!(res[0].rows[0][0], json!(20));
        assert_eq!(res[0].columns[0].type_name, "int8");
        assert_eq!(res[1].rows[0][0], json!(1));
        assert_eq!(res[1].statement.as_deref(), Some("select 1 as one"));
    }

    #[tokio::test]
    async fn a_failing_statement_keeps_the_results_before_it() {
        let Some(s) = session(false).await else { return };
        let res = s.execute(None, None, "SELECT 1; SELECT 2; SELECT * FROM rowline_test_missing; SELECT 4", 10, false).await.unwrap();
        assert_eq!(res.len(), 3, "stops after the error");
        assert_eq!((res[0].rows[0][0].clone(), res[1].rows[0][0].clone()), (json!(1), json!(2)));
        assert_eq!(res[2].statement.as_deref(), Some("SELECT * FROM rowline_test_missing"));
        assert_eq!(res[2].error.as_deref(), Some("ERROR 42P01: relation \"rowline_test_missing\" does not exist"));
        assert!(s.execute(None, None, "SELECT * FROM rowline_test_missing", 10, false).await.is_err());
        // the client is fine afterwards
        assert_eq!(s.execute(None, None, "SELECT 3", 1, false).await.unwrap()[0].rows[0][0], json!(3));
    }

    #[tokio::test]
    async fn stops_reading_at_the_row_limit() {
        let Some(s) = session(false).await else { return };
        let start = Instant::now();
        // 100,000 slow rows would take far longer than the limit allows
        let r = s
            .execute(None, None, "SELECT g, pg_sleep(0.001) FROM generate_series(1, 100000) g; SELECT 2 AS after", 5, false)
            .await
            .unwrap();
        assert!(start.elapsed() < Duration::from_secs(5), "read past the limit: {:?}", start.elapsed());
        assert_eq!(r[0].rows.len(), 5);
        assert!(r[0].truncated);
        assert_eq!(r[1].rows[0][0], json!(2), "the next statement still works");
        let c = s.execute(None, None, "SELECT * FROM customers", 5, false).await.unwrap();
        assert_eq!((c[0].rows.len(), c[0].truncated), (5, true));
    }

    #[tokio::test]
    async fn types_round_trip_through_the_grid() {
        let Some(s) = session(false).await else { return };
        let t = "rowline_pg_types";
        s.execute(None, None, &format!(
            "DROP TABLE IF EXISTS {t}; CREATE TABLE {t} (id int PRIMARY KEY, total numeric(12,2), meta jsonb, tags text[], token uuid,
               big int8, at timestamptz, raw bytea, short varchar(3), flag bool, f float8, span interval);
             INSERT INTO {t} (id, raw) VALUES (1, '\\xcafe'::bytea)"
        ), 10, false).await.unwrap();
        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 1}, "values": {
                "total": "12.34", "meta": "{\"a\": [1, 2]}", "tags": "{x,\"y z\"}", "token": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                "big": "9007199254740993", "at": "2024-01-02 03:04:05+00", "short": "abc", "flag": true, "f": 1.5, "span": "1 day 02:00:00"
            } }],
            "inserts": [{ "id": 2, "total": null }]
        })).unwrap();
        assert_eq!(s.apply_changes(None, None, t, changes, false).await.unwrap(), 2);
        let r = s.execute(None, None, &format!("SELECT total, meta, tags, token, big, raw, short, flag, f, span, at = '2024-01-02 03:04:05+00' FROM {t} ORDER BY id"), 10, false).await.unwrap();
        assert_eq!(
            r[0].rows[0],
            vec![json!("12.34"), json!("{\"a\": [1, 2]}"), json!("{x,\"y z\"}"), json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
                 json!("9007199254740993"), json!("\\xcafe"), json!("abc"), json!(true), json!(1.5), json!("1 day 02:00:00"), json!(true)]
        );
        assert_eq!(r[0].rows[1][0], json!(null));

        // set NULL, too long for varchar(3) is an error (not cut), bytea can't be edited
        let null: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"meta": null, "tags": null} }] })).unwrap();
        s.apply_changes(None, None, t, null, false).await.unwrap();
        let long: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"short": "abcd"} }] })).unwrap();
        let err = s.apply_changes(None, None, t, long, false).await.unwrap_err().to_string();
        assert!(err.contains("22001"), "{err}");
        let bin: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"raw": "\\x00"} }] })).unwrap();
        assert!(s.apply_changes(None, None, t, bin, false).await.unwrap_err().to_string().contains("bytea"));
        let r = s.execute(None, None, &format!("SELECT meta, tags, short FROM {t} WHERE id = 1"), 10, false).await.unwrap();
        assert_eq!(r[0].rows[0], vec![json!(null), json!(null), json!("abc")]);

        let del: ChangeSet = serde_json::from_value(json!({ "deletes": [{ "id": 2 }] })).unwrap();
        assert_eq!(s.apply_changes(None, None, t, del, false).await.unwrap(), 1);
        s.execute(None, None, &format!("DROP TABLE {t}"), 1, false).await.unwrap();
    }

    #[tokio::test]
    async fn names_with_upper_case_and_dots_are_quoted_everywhere() {
        let Some(s) = session(false).await else { return };
        s.execute(None, None, "DROP SCHEMA IF EXISTS \"rowline_S.x\" CASCADE; CREATE SCHEMA \"rowline_S.x\";
             CREATE TABLE \"rowline_S.x\".\"A.b\" (\"Id\" int PRIMARY KEY, \"Na\"\"me\" text); INSERT INTO \"rowline_S.x\".\"A.b\" VALUES (1, 'x')", 10, false)
            .await
            .unwrap();
        let schema = Some("rowline_S.x");
        let req = PageRequest { filter: Some("\"Id\" = 1".into()), sort: vec![SortSpec { column: "Na\"me".into(), descending: false }], ..page(schema, "A.b") };
        assert_eq!(s.select_page(req.clone(), false).await.unwrap().rows[0], vec![json!(1), json!("x")]);
        assert_eq!(s.count(req, false).await.unwrap(), 1);
        assert_eq!(s.common_values(None, schema, "A.b", "Na\"me", 5).await.unwrap(), vec![json!("x")]);
        let changes: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"Id": 1}, "values": {"Na\"me": "y"} }] })).unwrap();
        assert_eq!(s.apply_changes(None, schema, "A.b", changes, false).await.unwrap(), 1);
        let st = s.structure(None, schema, "A.b").await.unwrap();
        assert!(st.columns[0].primary_key);
        assert!(s.objects(None, schema).await.unwrap().iter().any(|o| o.name == "A.b"));
        s.execute(None, None, "DROP SCHEMA \"rowline_S.x\" CASCADE", 1, false).await.unwrap();
    }

    #[tokio::test]
    async fn read_only_path_refuses_writes_and_superusers() {
        let Some(s) = session(false).await else { return };
        let err = s.select_read_only(None, None, "SELECT 1", 10).await.unwrap_err().to_string();
        assert_eq!(err, SUPERUSER_MESSAGE);
        let r = reader_session().await.unwrap();
        // skip the SQL check on purpose: the transaction itself must refuse
        let err = r.select_read_only(None, None, "delete from customers", 10).await.unwrap_err().to_string();
        assert!(err.contains("25006"), "{err}");
        let err = r.select_read_only(None, None, "set transaction_read_only = off", 10).await.unwrap_err().to_string();
        assert!(err.contains("25001"), "can't switch to read-write: {err}");
        let rows = r.select_read_only(None, Some("billing"), "SELECT id FROM invoices ORDER BY id", 5).await.unwrap();
        assert_eq!((rows.rows.len(), rows.truncated), (5, true));
        assert!(r.select_read_only(None, Some("pg_catalog"), "SELECT 1", 1).await.is_err());
        assert!(r.select_read_only(None, None, "SELECT 1; SELECT 2", 1).await.is_err(), "one statement only");
        let scs = r.select_read_only(None, None, "SHOW standard_conforming_strings", 1).await.unwrap();
        assert_eq!(scs.rows[0][0], json!("on"));
        let to = r.select_read_only(None, None, "SHOW statement_timeout", 1).await.unwrap();
        assert_eq!(to.rows[0][0], json!("30s"));
    }

    #[tokio::test]
    async fn prod_lock_refuses_writes_until_unlocked() {
        let Some(s) = session(true).await else { return };
        let t = "rowline_pg_lock";
        s.execute(None, None, &format!("DROP TABLE IF EXISTS {t}; CREATE TABLE {t} (id int PRIMARY KEY, n int); INSERT INTO {t} VALUES (1, 0)"), 10, true)
            .await
            .unwrap();
        let err = s.execute(None, None, "update customers set name = name", 10, false).await.unwrap_err().to_string();
        assert_eq!(err, UNLOCK_MESSAGE);
        let err = s.execute(None, None, &format!("select 1; update {t} set n = 1"), 10, false).await.unwrap();
        assert_eq!(err[1].error.as_deref(), Some(UNLOCK_MESSAGE));
        // the READ ONLY transaction can't be switched off or ended from the script
        assert!(s.execute(None, None, &format!("set transaction_read_only = off; update {t} set n = 2"), 10, false).await.is_err());
        let err = s.execute(None, None, &format!("commit; update {t} set n = 3"), 10, false).await.unwrap_err().to_string();
        assert!(err.contains("Unlock writes"), "{err}");
        assert!(s.execute(None, None, &format!("/* x */ END; update {t} set n = 4"), 10, false).await.is_err());
        let changes: ChangeSet = serde_json::from_value(json!({ "updates": [{ "key": {"id": 1}, "values": {"n": 5} }] })).unwrap();
        assert_eq!(s.apply_changes(None, None, t, changes.clone(), false).await.unwrap_err().to_string(), UNLOCK_MESSAGE);
        // reads work while locked
        assert_eq!(s.select_page(page(None, t), false).await.unwrap().rows[0], vec![json!(1), json!(0)]);
        assert_eq!(s.count(page(None, t), false).await.unwrap(), 1);
        // unlocked: writes go through
        assert_eq!(s.apply_changes(None, None, t, changes, true).await.unwrap(), 1);
        assert_eq!(s.execute(None, None, &format!("update {t} set n = n + 1"), 10, true).await.unwrap()[0].affected_rows, Some(1));
        assert_eq!(s.execute(None, None, &format!("select n from {t}"), 10, false).await.unwrap()[0].rows[0][0], json!(6));
        s.execute(None, None, &format!("DROP TABLE {t}"), 1, true).await.unwrap();
    }

    #[tokio::test]
    async fn a_comment_ended_by_cr_does_not_hide_commit_on_a_locked_tab() {
        let Some(s) = session(true).await else { return };
        let t = "rowline_pg_cr_commit";
        s.execute(None, None, &format!("DROP TABLE IF EXISTS {t}; CREATE TABLE {t} (id int); INSERT INTO {t} VALUES (1)"), 10, true).await.unwrap();
        let err = s.execute(None, None, &format!("--x\rCOMMIT\nWORK; delete from {t}"), 10, false).await.unwrap_err().to_string();
        assert!(err.contains("Unlock writes"), "{err}");
        assert_eq!(s.count(page(None, t), false).await.unwrap(), 1, "nothing was deleted");
        s.execute(None, None, &format!("DROP TABLE {t}"), 1, true).await.unwrap();
    }

    #[tokio::test]
    async fn a_locked_script_stops_when_its_transaction_is_no_longer_read_only() {
        let Some(s) = session(true).await else { return };
        let tx = s.begin(None, None, Access::ReadOnly).await.unwrap();
        let marker = transaction_marker(&tx.c).await.unwrap();
        assert!(still_read_only(&tx.c, &marker).await.is_ok());
        // a statement the checks before running missed ends the READ ONLY transaction
        tx.c.batch_execute("COMMIT").await.unwrap();
        let err = still_read_only(&tx.c, &marker).await.unwrap_err().to_string();
        assert!(err.contains("read-only transaction"), "{err}");
        let _ = tx.finish(Ok(())).await;
    }

    #[tokio::test]
    async fn a_failed_script_is_rolled_back() {
        let Some(s) = session(false).await else { return };
        let t = "rowline_pg_rollback";
        s.execute(None, None, &format!("DROP TABLE IF EXISTS {t}; CREATE TABLE {t} (id int PRIMARY KEY)"), 10, false).await.unwrap();
        let res = s.execute(None, None, &format!("insert into {t} values (1); insert into {t} values (1)"), 10, false).await.unwrap();
        assert!(res[1].error.as_deref().unwrap().starts_with("ERROR 23505: "));
        assert_eq!(s.count(page(None, t), false).await.unwrap(), 0);
        s.execute(None, None, &format!("DROP TABLE {t}"), 1, false).await.unwrap();
    }

    #[tokio::test]
    async fn session_settings_from_a_filter_do_not_reach_the_next_query() {
        let Some(s) = session(false).await else { return };
        let req = PageRequest { filter: Some("set_config('search_path', 'billing', false) IS NOT NULL".into()), ..page(None, "customers") };
        assert_eq!(s.count(req, false).await.unwrap(), 20);
        let r = s.execute(None, None, "SELECT current_setting('search_path')", 1, false).await.unwrap();
        assert_ne!(r[0].rows[0][0], json!("billing"));
    }

    #[tokio::test]
    async fn session_settings_from_a_script_do_not_reach_the_next_query() {
        let Some(s) = session(false).await else { return };
        s.execute(None, None, "SET ROLE reader; SET search_path = billing; LISTEN rowline_test", 1, false).await.unwrap();
        // one client at a time: the next query gets the same pooled client
        let r = s.execute(None, None, "SELECT current_user::text, current_setting('search_path')", 1, false).await.unwrap();
        assert_ne!(r[0].rows[0][0], json!("reader"));
        assert_ne!(r[0].rows[0][1], json!("billing"));
        assert!(s.is_superuser(None).await.unwrap());
    }

    #[tokio::test]
    async fn cancel_with_an_owner_stops_only_that_tab() {
        let Some(s) = session(false).await else { return };
        let s = std::sync::Arc::new(s);
        let s2 = s.clone();
        let a = tokio::spawn(crate::owner::scope(Some("tab-a".into()), async move { s2.execute(None, None, "SELECT pg_sleep(30)", 1, false).await }));
        let s3 = s.clone();
        let b = tokio::spawn(crate::owner::scope(Some("tab-b".into()), async move {
            let slow = s3.execute(None, None, "SELECT pg_sleep(1.5), 1", 1, false).await;
            let page = s3.select_page(page(None, "customers"), false).await;
            (slow, page)
        }));
        tokio::time::sleep(Duration::from_millis(500)).await;
        let start = Instant::now();
        s.cancel(Some("tab-a")).await.unwrap();
        let ra = a.await.unwrap();
        assert!(start.elapsed() < Duration::from_secs(2), "tab-a was not stopped");
        let err = ra.unwrap_err().to_string();
        assert!(err.contains("57014"), "{err}");
        let (slow, page) = b.await.unwrap();
        assert_eq!(slow.unwrap()[0].rows[0][1], json!(1), "tab-b ran to the end");
        assert_eq!(page.unwrap().rows.len(), 20);
        assert!(s.running.lock().unwrap().is_empty(), "nothing left in the running list");
    }

    #[tokio::test]
    async fn cancel_stops_a_slow_count_too() {
        let Some(s) = session(false).await else { return };
        let s = std::sync::Arc::new(s);
        let s2 = s.clone();
        let req = PageRequest { filter: Some("pg_sleep(30) IS NOT NULL".into()), ..page(None, "customers") };
        let handle = tokio::spawn(async move { s2.count(req, false).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        let start = Instant::now();
        s.cancel(None).await.unwrap();
        assert!(handle.await.unwrap().is_err());
        assert!(start.elapsed() < Duration::from_secs(3), "cancel did not stop the count");
    }
}
