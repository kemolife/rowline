use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::sqlgen::{self, Dialect};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const BLOB_PREVIEW_BYTES: usize = 256;

pub struct SqliteSession {
    conn: Arc<Mutex<Connection>>,
    interrupt: InterruptHandle,
    path: String,
}

impl SqliteSession {
    pub async fn open(path: &str) -> AppResult<Self> {
        let path = path.to_string();
        let p = path.clone();
        let conn = tokio::task::spawn_blocking(move || {
            if p != ":memory:" && !std::path::Path::new(&p).exists() {
                return Err(AppError::msg(format!("File not found: {p}")));
            }
            let conn = Connection::open_with_flags(
                &p,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            conn.execute_batch("PRAGMA foreign_keys = ON")?;
            Ok(conn)
        })
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
        let interrupt = conn.get_interrupt_handle();
        Ok(Self { conn: Arc::new(Mutex::new(conn)), interrupt, path })
    }

    /// Runs blocking SQLite work off the async runtime.
    async fn with_conn<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
    ) -> AppResult<T> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().map_err(|_| AppError::msg("SQLite connection lock poisoned"))?;
            f(&mut guard)
        })
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
    }

    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        let path = self.path.clone();
        self.with_conn(move |c| {
            let version: String = c.query_row("select sqlite_version()", [], |r| r.get(0))?;
            Ok(ServerInfo { version: format!("SQLite {version}"), current_database: Some(file_label(&path)) })
        })
        .await
    }

    pub async fn objects(&self) -> AppResult<Vec<DbObject>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE",
            )?;
            let rows = stmt.query_map([], |r| {
                let kind: String = r.get(1)?;
                Ok(DbObject {
                    name: r.get(0)?,
                    kind: if kind == "view" { ObjectKind::View } else { ObjectKind::Table },
                    row_estimate: None,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
    }

    /// All tables with their columns and foreign keys (relation diagram)
    pub async fn schema_graph(&self) -> AppResult<Vec<SchemaTable>> {
        let mut out = Vec::new();
        for o in self.objects().await? {
            out.push(self.structure(&o.name).await?.into());
        }
        Ok(out)
    }

    pub async fn structure(&self, table: &str) -> AppResult<TableStructure> {
        let table = table.to_string();
        self.with_conn(move |c| {
            let (kind, ddl): (String, Option<String>) = c
                .query_row("SELECT type, sql FROM sqlite_master WHERE name = ?1", [&table], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| AppError::msg(format!("Table not found: {table}")))?;
            let q = Dialect::Sqlite.quote_ident(&table);
            let ddl_upper = ddl.clone().unwrap_or_default().to_uppercase();

            let mut columns = Vec::new();
            let mut pk_cols = Vec::new();
            {
                let mut stmt = c.prepare(&format!("PRAGMA table_xinfo({q})"))?;
                let mut rows = stmt.query([])?;
                while let Some(r) = rows.next()? {
                    let hidden: i64 = r.get(6).unwrap_or(0);
                    if hidden == 1 {
                        continue;
                    }
                    let name: String = r.get(1)?;
                    let data_type: String = r.get(2)?;
                    let pk: i64 = r.get(5)?;
                    if pk > 0 {
                        pk_cols.push((pk, name.clone()));
                    }
                    let rowid_pk = pk > 0 && data_type.eq_ignore_ascii_case("INTEGER");
                    let auto_increment = rowid_pk && ddl_upper.contains("AUTOINCREMENT");
                    // INTEGER PRIMARY KEY is the rowid and can never be NULL, although SQLite reports notnull = 0
                    let nullable = r.get::<_, i64>(3)? == 0 && !rowid_pk;
                    columns.push(ColumnInfo {
                        name,
                        data_type,
                        nullable,
                        default_value: r.get(4)?,
                        primary_key: pk > 0,
                        auto_increment,
                        comment: None,
                    });
                }
            }
            pk_cols.sort();

            let mut indexes = Vec::new();
            if !pk_cols.is_empty() {
                indexes.push(IndexInfo {
                    name: "PRIMARY".into(),
                    columns: pk_cols.iter().map(|(_, n)| n.clone()).collect(),
                    unique: true,
                    primary: true,
                });
            }
            let index_list: Vec<(String, bool, String)> = {
                let mut stmt = c.prepare(&format!("PRAGMA index_list({q})"))?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(2)? == 1, r.get::<_, String>(3)?)))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (name, unique, origin) in index_list {
                if origin == "pk" {
                    continue;
                }
                let mut stmt = c.prepare(&format!("PRAGMA index_info({})", Dialect::Sqlite.quote_ident(&name)))?;
                let cols = stmt
                    .query_map([], |r| r.get::<_, Option<String>>(2))?
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(|c| c.unwrap_or_else(|| "<expr>".into()))
                    .collect();
                indexes.push(IndexInfo { name, columns: cols, unique, primary: false });
            }

            let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
            {
                let mut stmt = c.prepare(&format!("PRAGMA foreign_key_list({q})"))?;
                let mut rows = stmt.query([])?;
                while let Some(r) = rows.next()? {
                    let id: i64 = r.get(0)?;
                    let name = format!("fk_{table}_{id}");
                    let from: String = r.get(3)?;
                    let to: Option<String> = r.get(4)?;
                    if let Some(fk) = foreign_keys.iter_mut().find(|f| f.name == name) {
                        fk.columns.push(from);
                        fk.ref_columns.push(to.unwrap_or_default());
                    } else {
                        foreign_keys.push(ForeignKeyInfo {
                            name,
                            columns: vec![from],
                            ref_table: r.get(2)?,
                            ref_columns: vec![to.unwrap_or_default()],
                            on_update: r.get(5)?,
                            on_delete: r.get(6)?,
                        });
                    }
                }
            }

            Ok(TableStructure {
                name: table.clone(),
                kind: if kind == "view" { ObjectKind::View } else { ObjectKind::Table },
                columns,
                indexes,
                foreign_keys,
                ddl,
            })
        })
        .await
    }

    /// table -> column names, for SQL autocomplete
    pub async fn schema_columns(&self) -> AppResult<Vec<(String, Vec<String>)>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
                 WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(crate::drivers::mysql::group_columns(rows))
        })
        .await
    }

    pub async fn select_page(&self, req: PageRequest) -> AppResult<QueryResult> {
        let sql = sqlgen::select_page_sql(Dialect::Sqlite, &req);
        let limit = req.limit as usize;
        self.with_conn(move |c| {
            let mut res = run_query(c, &sql, &[], limit)?;
            res.statement = Some(sql);
            Ok(res)
        })
        .await
    }

    /// Most common values of a column (filter suggestions)
    pub async fn common_values(&self, table: &str, column: &str, limit: usize) -> AppResult<Vec<Value>> {
        let sql = sqlgen::common_values_sql(Dialect::Sqlite, None, table, column, limit);
        self.with_conn(move |c| Ok(run_query(c, &sql, &[], limit)?.rows.into_iter().filter_map(|r| r.into_iter().next()).collect()))
            .await
    }

    pub async fn count(&self, req: PageRequest) -> AppResult<u64> {
        let sql = sqlgen::count_sql(Dialect::Sqlite, &req);
        self.with_conn(move |c| Ok(c.query_row(&sql, [], |r| r.get::<_, i64>(0))? as u64)).await
    }

    pub async fn execute(&self, sql: String, max_rows: usize) -> AppResult<Vec<QueryResult>> {
        self.with_conn(move |c| {
            let mut results = Vec::new();
            for st in sqlgen::split_statements(&sql) {
                let mut res = run_query(c, &st.text, &[], max_rows)?;
                res.statement = Some(st.text);
                results.push(res);
            }
            Ok(results)
        })
        .await
    }

    /// Runs one statement on a separate read-only connection, stopped after readonly::TIMEOUT.
    pub async fn select_read_only(&self, sql: String, max_rows: usize) -> AppResult<QueryResult> {
        if self.path == ":memory:" {
            return Err(AppError::msg("Claude can't query an in-memory database."));
        }
        let path = self.path.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<InterruptHandle>();
        let task = tokio::task::spawn_blocking(move || -> AppResult<QueryResult> {
            let c = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            c.execute_batch("PRAGMA query_only = ON")?;
            let _ = tx.send(c.get_interrupt_handle());
            run_query(&c, &sql, &[], max_rows)
        });
        let watchdog = tokio::spawn(async move {
            if let Ok(handle) = rx.await {
                tokio::time::sleep(crate::readonly::TIMEOUT).await;
                handle.interrupt();
            }
        });
        let res = task.await.map_err(|e| AppError::msg(e.to_string()))?;
        watchdog.abort();
        res.map_err(|e| {
            if e.to_string().contains("interrupt") {
                AppError::Timeout(format!("the query ran longer than {} s", crate::readonly::TIMEOUT.as_secs()))
            } else {
                e
            }
        })
    }

    /// Copies the whole database to `dest` with SQLite's online backup (safe while the file is in use).
    pub async fn backup_to(&self, dest: String, job: std::sync::Arc<crate::backup::Job>) -> AppResult<()> {
        if self.path == ":memory:" {
            return Err(AppError::msg("An in-memory database can't be backed up."));
        }
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let src = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
            let file = crate::backup::AtomicFile::create(&dest)?;
            let tmp = file.tmp_path().to_path_buf();
            let mut dst = Connection::open(&tmp)?;
            copy_pages(&src, &mut dst, &job)?;
            drop(dst);
            file.commit()
        })
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
    }

    /// Replaces the contents of this database with the SQLite database in `src` (same open connection).
    pub async fn restore_from(&self, src: String, job: std::sync::Arc<crate::backup::Job>) -> AppResult<()> {
        self.with_conn(move |c| {
            let from = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
            // fails early with a clear message when the file is not an SQLite database
            from.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get::<_, i64>(0))
                .map_err(|_| AppError::msg("This file is not an SQLite database."))?;
            copy_pages(&from, c, &job)
        })
        .await
    }

    pub async fn apply_changes(&self, table: String, changes: ChangeSet) -> AppResult<u64> {
        let statements = sqlgen::change_set_statements(Dialect::Sqlite, None, &table, &changes)?;
        self.with_conn(move |c| {
            let tx = c.transaction()?;
            let mut total = 0u64;
            for st in &statements {
                let params: Vec<rusqlite::types::Value> = st.params.iter().map(json_to_sqlite).collect();
                total += tx.execute(&st.sql, rusqlite::params_from_iter(params))? as u64;
            }
            tx.commit()?;
            Ok(total)
        })
        .await
    }

    pub fn cancel(&self) {
        self.interrupt.interrupt();
    }
}

fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// SQLite online backup from `from` into `to`, in steps, reporting pages and stopping on Cancel.
fn copy_pages(from: &Connection, to: &mut Connection, job: &crate::backup::Job) -> AppResult<()> {
    use rusqlite::backup::{Backup, StepResult};
    let backup = Backup::new(from, to)?;
    loop {
        job.check()?;
        let step = backup.step(256)?;
        let p = backup.progress();
        job.set_total(p.pagecount.max(0) as u64);
        job.set_done((p.pagecount - p.remaining).max(0) as u64);
        match step {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            // another connection holds a lock: wait a moment and try again
            _ => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

fn run_query(c: &Connection, sql: &str, params: &[rusqlite::types::Value], max_rows: usize) -> AppResult<QueryResult> {
    let start = Instant::now();
    let mut stmt = c.prepare(sql)?;
    let column_count = stmt.column_count();
    if column_count == 0 {
        let affected = stmt.execute(rusqlite::params_from_iter(params.iter()))? as u64;
        return Ok(QueryResult { affected_rows: Some(affected), elapsed_ms: start.elapsed().as_millis() as u64, ..Default::default() });
    }
    let columns: Vec<ResultColumn> = stmt
        .columns()
        .iter()
        .map(|col| ResultColumn { name: col.name().to_string(), type_name: col.decl_type().unwrap_or("").to_string() })
        .collect();
    let mut rows_out = Vec::new();
    let mut truncated = false;
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter()))?;
    while let Some(r) = rows.next()? {
        if rows_out.len() >= max_rows {
            truncated = true;
            break;
        }
        let mut out = Vec::with_capacity(column_count);
        for i in 0..column_count {
            out.push(sqlite_to_json(r.get_ref(i)?));
        }
        rows_out.push(out);
    }
    Ok(QueryResult { columns, rows: rows_out, affected_rows: None, elapsed_ms: start.elapsed().as_millis() as u64, truncated, statement: None })
}

pub(crate) fn sqlite_to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::String(f.to_string())),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(b) => Value::String(blob_preview(b)),
    }
}

pub(crate) fn blob_preview(b: &[u8]) -> String {
    let shown = &b[..b.len().min(BLOB_PREVIEW_BYTES)];
    let more = if b.len() > BLOB_PREVIEW_BYTES { "…" } else { "" };
    format!("0x{}{}", hex::encode_upper(shown), more)
}

fn json_to_sqlite(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(V::Integer).unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn test_db() -> (tempfile::TempDir, SqliteSession) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, photo BLOB, score REAL DEFAULT 1.5);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE, total REAL);
             CREATE INDEX idx_orders_customer ON orders(customer_id);
             CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
             INSERT INTO customers (name, email, photo) VALUES ('Ann', 'ann@x.io', x'DEADBEEF'), ('Bob', 'bob@x.io', NULL), ('Cid', NULL, NULL);
             INSERT INTO orders (customer_id, total) VALUES (1, 50), (1, 150.25), (2, 300);",
        )
        .unwrap();
        drop(c);
        let s = SqliteSession::open(path.to_str().unwrap()).await.unwrap();
        (dir, s)
    }

    #[tokio::test]
    async fn lists_objects_and_structure() {
        let (_d, s) = test_db().await;
        let objs = s.objects().await.unwrap();
        let names: Vec<_> = objs.iter().map(|o| (o.name.as_str(), o.kind.clone())).collect();
        assert_eq!(names, vec![("big_orders", ObjectKind::View), ("customers", ObjectKind::Table), ("orders", ObjectKind::Table)]);

        let schema = s.schema_columns().await.unwrap();
        assert_eq!(schema.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(), vec!["big_orders", "customers", "orders"]);
        assert_eq!(schema[1].1, vec!["id", "name", "email", "photo", "score"]);

        let st = s.structure("customers").await.unwrap();
        assert_eq!(st.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id", "name", "email", "photo", "score"]);
        assert!(st.columns[0].primary_key && st.columns[0].auto_increment);
        assert!(!st.columns[0].nullable, "rowid primary key is never NULL");
        assert!(!st.columns[1].nullable);
        assert!(st.columns[2].nullable);
        assert_eq!(st.columns[4].default_value.as_deref(), Some("1.5"));
        assert!(st.indexes.iter().any(|i| i.primary && i.columns == vec!["id"]));
        assert!(st.indexes.iter().any(|i| i.unique && i.columns == vec!["email"]));

        let o = s.structure("orders").await.unwrap();
        assert_eq!(o.foreign_keys.len(), 1);
        assert_eq!(o.foreign_keys[0].ref_table, "customers");
        assert_eq!(o.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
        assert!(o.indexes.iter().any(|i| i.name == "idx_orders_customer"));
    }

    #[tokio::test]
    async fn pages_count_and_value_types() {
        let (_d, s) = test_db().await;
        let req = PageRequest { database: None, table: "customers".into(), filter: None, sort: vec![SortSpec { column: "id".into(), descending: false }], limit: 2, offset: 0 };
        let page = s.select_page(req.clone()).await.unwrap();
        assert_eq!(page.rows.len(), 2);
        assert!(page.truncated);
        assert_eq!(page.rows[0], vec![json!(1), json!("Ann"), json!("ann@x.io"), json!("0xDEADBEEF"), json!(1.5)]);
        assert_eq!(page.columns[3].type_name, "BLOB");
        let last = s.select_page(PageRequest { offset: 2, ..req.clone() }).await.unwrap();
        assert_eq!(last.rows.len(), 1);
        assert!(!last.truncated);
        assert_eq!(s.count(PageRequest { filter: Some("email IS NOT NULL".into()), ..req }).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn backup_and_restore_round_trip() {
        let (dir, s) = test_db().await;
        let file = dir.path().join("copy.sqlite");
        let job = std::sync::Arc::new(crate::backup::Job::default());
        s.backup_to(file.to_str().unwrap().into(), job.clone()).await.unwrap();
        assert!(job.status().total > 0 && job.status().done == job.status().total);
        s.execute("DELETE FROM orders; UPDATE customers SET name = 'broken'".into(), 10).await.unwrap();
        s.restore_from(file.to_str().unwrap().into(), std::sync::Arc::new(crate::backup::Job::default())).await.unwrap();
        let res = s.execute("SELECT count(*) FROM orders; SELECT name FROM customers ORDER BY id".into(), 10).await.unwrap();
        assert_eq!(res[0].rows[0][0], 3);
        assert_eq!(res[1].rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), vec![json!("Ann"), json!("Bob"), json!("Cid")]);

        let not_db = dir.path().join("x.txt");
        std::fs::write(&not_db, "hello").unwrap();
        let err = s.restore_from(not_db.to_str().unwrap().into(), std::sync::Arc::new(crate::backup::Job::default())).await.unwrap_err();
        assert!(err.to_string().contains("not an SQLite database"), "{err}");
    }

    #[tokio::test]
    async fn applies_default_and_now_values() {
        let (_d, s) = test_db().await;
        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 2}, "values": {"name": {"$expr": "CURRENT_DATE"}} }],
            "inserts": [{ "name": "Dee", "score": {"$expr": "DEFAULT"} }]
        }))
        .unwrap();
        assert_eq!(s.apply_changes("customers".into(), changes).await.unwrap(), 2);
        let res = s.execute("SELECT name, score FROM customers WHERE id IN (2, 4) ORDER BY id".into(), 10).await.unwrap();
        let today = s.execute("SELECT date('now')".into(), 1).await.unwrap()[0].rows[0][0].clone();
        assert_eq!(res[0].rows[0][0], today, "CURRENT_DATE is computed by the database");
        assert_eq!(res[0].rows[1], vec![json!("Dee"), json!(1.5)], "DEFAULT takes the column default");
    }

    #[tokio::test]
    async fn applies_change_set_in_one_transaction() {
        let (_d, s) = test_db().await;
        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 2}, "values": {"name": "Bobby", "email": null} }],
            "inserts": [{ "name": "Dee", "score": 9 }],
            "deletes": [{ "id": 3 }]
        }))
        .unwrap();
        assert_eq!(s.apply_changes("customers".into(), changes).await.unwrap(), 3);
        let r = s.execute("select id, name, email, score from customers order by id".into(), 100).await.unwrap();
        assert_eq!(r[0].rows, vec![
            vec![json!(1), json!("Ann"), json!("ann@x.io"), json!(1.5)],
            vec![json!(2), json!("Bobby"), json!(null), json!(1.5)],
            vec![json!(4), json!("Dee"), json!(null), json!(9.0)],
        ]);

        // failing statement rolls back the whole set
        let bad: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 1}, "values": {"name": "Changed"} }],
            "inserts": [{ "name": null }]
        }))
        .unwrap();
        assert!(s.apply_changes("customers".into(), bad).await.is_err());
        let r = s.execute("select name from customers where id = 1".into(), 10).await.unwrap();
        assert_eq!(r[0].rows[0][0], json!("Ann"));
    }

    #[tokio::test]
    async fn executes_scripts_with_multiple_results() {
        let (_d, s) = test_db().await;
        let res = s
            .execute("update orders set total = total + 1 where customer_id = 1; select count(*) as n from orders; select * from big_orders".into(), 1)
            .await
            .unwrap();
        assert_eq!(res.len(), 3);
        assert_eq!(res[0].affected_rows, Some(2));
        assert_eq!(res[1].rows, vec![vec![json!(3)]]);
        assert_eq!(res[2].rows.len(), 1);
        assert!(res[2].truncated);
    }

    #[tokio::test]
    async fn missing_file_is_an_error() {
        assert!(SqliteSession::open("/nonexistent/x.sqlite").await.is_err());
    }
}
