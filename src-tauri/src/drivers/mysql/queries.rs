//! Reading and changing data on a MySQL session.

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::sqlgen::{self, Dialect};
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Row, Value as MyValue};
use std::time::Instant;
use super::values::*;
use super::MysqlSession;

impl MysqlSession {
    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        let mut c = self.conn().await?;
        let row: Option<(String, Option<String>)> = c.query_first("SELECT VERSION(), DATABASE()").await?;
        let (version, db) = row.unwrap_or_default();
        Ok(ServerInfo { version: format!("MySQL {version}"), current_database: db })
    }

    pub async fn select_page(&self, mut req: PageRequest) -> AppResult<QueryResult> {
        req.database = self.db(req.database.as_deref()).map(str::to_string);
        let sql = sqlgen::select_page_sql(Dialect::Mysql, &req);
        let mut c = self.conn().await?;
        let mut res = self.run_tracked(&mut c, &sql, req.limit as usize).await?;
        res.statement = Some(sql);
        Ok(res)
    }

    /// Most common values of a column (filter suggestions)
    pub async fn common_values(&self, database: Option<&str>, table: &str, column: &str, limit: usize) -> AppResult<Vec<serde_json::Value>> {
        let sql = sqlgen::common_values_sql(Dialect::Mysql, self.db(database), table, column, limit);
        let mut c = self.conn().await?;
        let res = self.run_tracked(&mut c, &sql, limit).await?;
        Ok(res.rows.into_iter().filter_map(|r| r.into_iter().next()).collect())
    }

    pub async fn count(&self, mut req: PageRequest) -> AppResult<u64> {
        req.database = self.db(req.database.as_deref()).map(str::to_string);
        let sql = sqlgen::count_sql(Dialect::Mysql, &req);
        let mut c = self.conn().await?;
        let n: Option<u64> = c.query_first(sql).await?;
        Ok(n.unwrap_or(0))
    }

    pub async fn execute(&self, database: Option<&str>, sql: &str, max_rows: usize) -> AppResult<Vec<QueryResult>> {
        let mut c = self.conn().await?;
        if let Some(db) = self.db(database) {
            c.query_drop(format!("USE {}", Dialect::Mysql.quote_ident(db))).await?;
        }
        let mut results = Vec::new();
        for st in sqlgen::split_statements(sql) {
            let mut res = self.run_tracked(&mut c, &st.text, max_rows).await?;
            res.statement = Some(st.text);
            results.push(res);
        }
        Ok(results)
    }

    /// Runs one statement inside a READ ONLY transaction, limited to readonly::TIMEOUT.
    pub async fn select_read_only(&self, database: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        let timeout = crate::readonly::TIMEOUT;
        let mut c = self.conn().await?;
        if let Some(db) = self.db(database) {
            c.query_drop(format!("USE {}", Dialect::Mysql.quote_ident(db))).await?;
        }
        // MySQL only; MariaDB ignores it (the tokio timeout below still applies)
        let _ = c.query_drop(format!("SET SESSION MAX_EXECUTION_TIME = {}", timeout.as_millis())).await;
        c.query_drop("START TRANSACTION READ ONLY").await?;
        let thread_id = c.id();
        // Untracked on purpose: dropping run_tracked on timeout would leave this thread id in `running`,
        // and a later editor cancel() would then KILL QUERY an unrelated query on the pooled connection.
        let res = match tokio::time::timeout(timeout + std::time::Duration::from_secs(2), run_query(&mut c, sql, max_rows)).await {
            // 3024 = MAX_EXECUTION_TIME reached: same message as the other timeout paths
            Ok(Err(AppError::Mysql(mysql_async::Error::Server(e)))) if e.code == 3024 => {
                Err(AppError::Timeout(format!("the query ran longer than {} s", timeout.as_secs())))
            }
            Ok(r) => r,
            Err(_) => {
                if let Ok(mut killer) = self.conn().await {
                    let _ = killer.query_drop(format!("KILL QUERY {thread_id}")).await;
                }
                Err(AppError::Timeout(format!("the query ran longer than {} s", timeout.as_secs())))
            }
        };
        let _ = c.query_drop("ROLLBACK").await;
        let _ = c.query_drop("SET SESSION MAX_EXECUTION_TIME = 0").await;
        res
    }

    pub async fn apply_changes(&self, database: Option<&str>, table: &str, changes: ChangeSet) -> AppResult<u64> {
        let db = self.db(database).map(str::to_string);
        let statements = sqlgen::change_set_statements(Dialect::Mysql, db.as_deref(), table, &changes)?;
        let mut c = self.conn().await?;
        let mut tx = c.start_transaction(Default::default()).await?;
        let mut total = 0u64;
        for st in &statements {
            let params: Vec<MyValue> = st.params.iter().map(json_to_mysql).collect();
            tx.exec_drop(st.sql.as_str(), params).await?;
            total += tx.affected_rows();
        }
        tx.commit().await?;
        Ok(total)
    }

    /// Stops queries started by this session (KILL QUERY on a separate connection).
    pub async fn cancel(&self) -> AppResult<()> {
        let ids: Vec<u32> = self.running.lock().map(|r| r.clone()).unwrap_or_default();
        if ids.is_empty() {
            return Ok(());
        }
        let mut c = self.conn().await?;
        for id in ids {
            let _ = c.query_drop(format!("KILL QUERY {id}")).await;
        }
        Ok(())
    }

    async fn run_tracked(&self, c: &mut Conn, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        let id = c.id();
        if let Ok(mut r) = self.running.lock() {
            r.push(id);
        }
        let res = run_query(c, sql, max_rows).await;
        if let Ok(mut r) = self.running.lock() {
            r.retain(|x| *x != id);
        }
        res
    }
}

async fn run_query(c: &mut Conn, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
    let start = Instant::now();
    let mut qr = c.query_iter(sql).await?;
    let cols: Vec<Column> = qr.columns_ref().to_vec();
    if cols.is_empty() {
        let affected = qr.affected_rows();
        qr.drop_result().await?;
        return Ok(QueryResult { affected_rows: Some(affected), elapsed_ms: start.elapsed().as_millis() as u64, ..Default::default() });
    }
    let columns: Vec<ResultColumn> = cols
        .iter()
        .map(|col| ResultColumn { name: col.name_str().to_string(), type_name: type_name(col) })
        .collect();
    let mut rows = Vec::new();
    let mut truncated = false;
    qr.for_each(|row: Row| {
        if rows.len() >= max_rows {
            truncated = true;
            return;
        }
        let values = row.unwrap();
        rows.push(values.iter().zip(cols.iter()).map(|(v, col)| mysql_to_json(v, col)).collect());
    })
    .await?;
    Ok(QueryResult { columns, rows, affected_rows: None, elapsed_ms: start.elapsed().as_millis() as u64, truncated, statement: None })
}

#[cfg(test)]
mod tests {
    //! Run with a MySQL server: ROWLINE_TEST_MYSQL="host:port:user:password:database"
    use super::*;
    use super::super::test_support::*;
    use std::time::Duration;
    use serde_json::json;

    #[tokio::test]
    async fn applies_default_and_now_values() {
        let Some((s, db)) = session().await else { return };
        s.execute(Some(&db), "DROP TABLE IF EXISTS rowline_expr_test; CREATE TABLE rowline_expr_test (id INT PRIMARY KEY, note VARCHAR(20) DEFAULT 'dflt', at DATETIME NULL); INSERT INTO rowline_expr_test VALUES (1, 'x', NULL)", 10)
            .await
            .unwrap();
        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 1}, "values": {"note": {"$expr": "DEFAULT"}, "at": {"$expr": "CURRENT_TIMESTAMP"}} }],
            "inserts": [{ "id": 2, "note": {"$expr": "DEFAULT"} }]
        }))
        .unwrap();
        s.apply_changes(Some(&db), "rowline_expr_test", changes).await.unwrap();
        let res = s.execute(Some(&db), "SELECT note, at IS NOT NULL, TIMESTAMPDIFF(SECOND, at, NOW()) < 60 FROM rowline_expr_test ORDER BY id", 10).await.unwrap();
        assert_eq!(res[0].rows[0], vec![json!("dflt"), json!(1), json!(1)]);
        assert_eq!(res[0].rows[1][0], json!("dflt"));
        s.execute(Some(&db), "DROP TABLE rowline_expr_test", 10).await.unwrap();
    }

    #[tokio::test]
    async fn read_only_transaction_blocks_writes() {
        let Some((s, db)) = session().await else { return };
        s.execute(Some(&db), "DROP TABLE IF EXISTS rowline_ro_test; CREATE TABLE rowline_ro_test (id INT PRIMARY KEY); INSERT INTO rowline_ro_test VALUES (1)", 10)
            .await
            .unwrap();
        // skip the SQL check on purpose: the transaction itself must refuse
        let err = s.select_read_only(Some(&db), "DELETE FROM rowline_ro_test", 10).await.unwrap_err().to_string();
        assert!(err.contains("READ ONLY") || err.contains("1792"), "{err}");
        let rows = s.select_read_only(Some(&db), "SELECT id FROM rowline_ro_test", 10).await.unwrap();
        assert_eq!(rows.rows.len(), 1);
        s.execute(Some(&db), "DROP TABLE rowline_ro_test", 10).await.unwrap();
    }

    #[tokio::test]
    async fn full_round_trip() {
        let Some((s, db)) = session().await else {
            eprintln!("ROWLINE_TEST_MYSQL not set, skipping");
            return;
        };
        let t = "rowline_t_people";
        s.execute(Some(&db), &format!(
            "DROP TABLE IF EXISTS {t};
             CREATE TABLE {t} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL, big BIGINT UNSIGNED, price DECIMAL(10,2),
               born DATE, data JSON, pic BLOB, note TEXT, KEY idx_name (name));
             INSERT INTO {t} (name, big, price, born, data, pic, note) VALUES
               ('Ann', 18446744073709551615, 12.50, '2001-02-03', '{{\"a\":1}}', x'CAFE', 'hi;there'),
               ('Bob', 5, NULL, NULL, NULL, NULL, NULL);"
        ), 100).await.unwrap();

        let info = s.server_info().await.unwrap();
        assert!(info.version.starts_with("MySQL "));
        assert!(s.databases().await.unwrap().contains(&db));
        assert!(s.objects(None).await.unwrap().iter().any(|o| o.name == t && o.kind == ObjectKind::Table));

        let cols = s.schema_columns(None).await.unwrap();
        let (_, people_cols) = cols.iter().find(|(name, _)| name == t).expect("table in schema");
        assert_eq!(people_cols[..2], ["id".to_string(), "name".to_string()]);

        let st = s.structure(None, t).await.unwrap();
        assert_eq!(st.columns[0].name, "id");
        assert!(st.columns[0].primary_key && st.columns[0].auto_increment);
        assert_eq!(st.columns[2].data_type, "bigint unsigned");
        assert!(st.indexes.iter().any(|i| i.primary));
        assert!(st.indexes.iter().any(|i| i.name == "idx_name" && !i.unique));
        assert!(st.ddl.unwrap().contains("CREATE TABLE"));

        let req = PageRequest { database: None, table: t.into(), filter: None, sort: vec![SortSpec { column: "id".into(), descending: false }], limit: 1, offset: 0 };
        let page = s.select_page(req.clone()).await.unwrap();
        assert!(page.truncated);
        let r = &page.rows[0];
        assert_eq!(r[0], json!(1));
        assert_eq!(r[1], json!("Ann"));
        assert_eq!(r[2], json!("18446744073709551615"), "big unsigned stays exact as string");
        assert_eq!(r[3], json!("12.50"), "decimal stays exact as string");
        assert_eq!(r[4], json!("2001-02-03"));
        assert_eq!(r[6], json!("0xCAFE"));
        assert_eq!(page.columns[6].type_name, "blob");
        assert_eq!(page.columns[7].type_name, "text");
        assert_eq!(s.count(PageRequest { filter: Some("price IS NULL".into()), ..req }).await.unwrap(), 1);

        let changes: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 2}, "values": {"name": "Bobby", "price": "3.14"} }],
            "inserts": [{ "name": "Cid" }],
            "deletes": [{ "id": 1 }]
        })).unwrap();
        assert_eq!(s.apply_changes(None, t, changes).await.unwrap(), 3);
        let r = s.execute(Some(&db), &format!("select id, name, price from {t} order by id"), 10).await.unwrap();
        assert_eq!(r[0].rows, vec![vec![json!(2), json!("Bobby"), json!("3.14")], vec![json!(3), json!("Cid"), json!(null)]]);

        // failing change set rolls back
        let bad: ChangeSet = serde_json::from_value(json!({
            "updates": [{ "key": {"id": 2}, "values": {"name": "Changed"} }],
            "inserts": [{ "name": null }]
        })).unwrap();
        assert!(s.apply_changes(None, t, bad).await.is_err());
        let r = s.execute(Some(&db), &format!("select name from {t} where id = 2"), 10).await.unwrap();
        assert_eq!(r[0].rows[0][0], json!("Bobby"));

        s.execute(Some(&db), &format!("DROP TABLE {t}"), 1).await.unwrap();
        s.close().await;
    }

    #[tokio::test]
    async fn cancel_stops_a_running_query() {
        let Some((s, db)) = session().await else { return };
        let s = std::sync::Arc::new(s);
        let s2 = s.clone();
        let db2 = db.clone();
        let handle = tokio::spawn(async move { s2.execute(Some(&db2), "SELECT SLEEP(20)", 10).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        let start = Instant::now();
        s.cancel().await.unwrap();
        let res = handle.await.unwrap();
        assert!(start.elapsed() < Duration::from_secs(5), "cancel took too long");
        // SLEEP returns 1 when interrupted, or the query errors — either way it ended early
        if let Ok(r) = res {
            assert_eq!(r[0].rows[0][0], json!(1));
        }
    }
}
