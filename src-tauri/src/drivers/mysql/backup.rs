//! MySQL backup to a .sql file and restore from one, done by Rowline itself (no mysqldump).
//! The file is plain SQL that the `mysql` client or any other tool can load too.

use super::MysqlSession;
use super::values::BINARY_CHARSET;
use crate::backup::{AtomicFile, Job, split_script};
use crate::error::{AppError, AppResult};
use crate::sqlgen::Dialect;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Row, Value};
use std::io::Write;

/// Rows per INSERT statement, and the size at which a statement is closed early
const ROWS_PER_INSERT: usize = 500;
const BYTES_PER_INSERT: usize = 1024 * 1024;

fn q(name: &str) -> String {
    Dialect::Mysql.quote_ident(name)
}

/// A string literal with MySQL escaping (the file sets a sql_mode without NO_BACKSLASH_ESCAPES).
fn quote_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{1a}' => out.push_str("\\Z"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn is_numeric(t: ColumnType) -> bool {
    use ColumnType::*;
    matches!(t, MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_INT24 | MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE | MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL | MYSQL_TYPE_YEAR)
}

/// SQL literal for one value read with the text protocol.
fn literal(v: &Value, col: &Column) -> String {
    match v {
        Value::NULL => "NULL".into(),
        Value::Bytes(b) => {
            // dates, JSON and numbers also arrive with the "binary" character set; only these are real bytes
            use ColumnType::*;
            let bytes_type = matches!(
                col.column_type(),
                MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB | MYSQL_TYPE_STRING | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR
            );
            let binary = matches!(col.column_type(), MYSQL_TYPE_BIT | MYSQL_TYPE_GEOMETRY) || (bytes_type && col.character_set() == BINARY_CHARSET);
            if binary {
                if b.is_empty() { "''".into() } else { format!("0x{}", hex::encode(b)) }
            } else if is_numeric(col.column_type()) {
                String::from_utf8_lossy(b).into_owned()
            } else {
                quote_str(&String::from_utf8_lossy(b))
            }
        }
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(d) => d.to_string(),
        other => quote_str(&other.as_sql(true).trim_matches('\'').to_string()),
    }
}

/// Removes `DEFINER=`user`@`host`` so the file can be loaded by another user.
fn strip_definer(sql: &str) -> String {
    let Some(start) = sql.find("DEFINER=") else { return sql.to_string() };
    let rest = &sql[start + "DEFINER=".len()..];
    // `user`@`host` : two backtick-quoted parts joined by @
    let mut end = 0;
    let mut ticks = 0;
    for (i, c) in rest.char_indices() {
        if c == '`' {
            ticks += 1;
            if ticks == 4 {
                end = i + 1;
                break;
            }
        }
    }
    if end == 0 {
        return sql.to_string();
    }
    format!("{}{}", &sql[..start], rest[end..].trim_start())
}

async fn names(c: &mut Conn, sql: &str, db: &str) -> AppResult<Vec<String>> {
    Ok(c.exec::<String, _, _>(sql, (db,)).await?)
}

/// Backs up `database` (all tables, or only `only_tables` — tests use that) into a .sql file.
pub async fn backup(session: &MysqlSession, database: &str, path: &str, only_tables: Option<&[String]>, job: &Job) -> AppResult<()> {
    let mut c = session.dedicated_conn().await?;
    c.query_drop(format!("USE {}", q(database))).await?;
    // every table as it was at one moment, while others keep writing
    c.query_drop("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await?;
    c.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY").await?;
    let res = write_backup(&mut c, database, path, only_tables, job).await;
    let _ = c.query_drop("ROLLBACK").await;
    res
}

async fn write_backup(c: &mut Conn, database: &str, path: &str, only_tables: Option<&[String]>, job: &Job) -> AppResult<()> {
    let keep = |name: &String| only_tables.is_none_or(|t| t.contains(name));
    let tables: Vec<String> = names(c, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", database)
        .await?
        .into_iter()
        .filter(keep)
        .collect();
    let views: Vec<String> = names(c, "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", database).await?.into_iter().filter(keep).collect();
    let triggers: Vec<String> = c
        .exec::<(String, String), _, _>("SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", (database,))
        .await?
        .into_iter()
        .filter(|(_, table)| keep(table))
        .map(|(name, _)| name)
        .collect();
    let routines: Vec<(String, String)> = if only_tables.is_some() {
        Vec::new()
    } else {
        c.exec("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME", (database,)).await?
    };
    job.set_total((tables.len() + views.len() + triggers.len() + routines.len()) as u64);

    let mut file = AtomicFile::create(path)?;
    let w = &mut file.writer;
    writeln!(w, "-- Rowline backup of `{database}`, {}", chrono::Utc::now().to_rfc3339())?;
    writeln!(w, "-- Restore with Rowline (Restore database…) or: mysql -u <user> -p {database} < this-file.sql\n")?;
    writeln!(w, "SET NAMES utf8mb4;")?;
    writeln!(w, "SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;")?;
    writeln!(w, "SET @OLD_UNIQUE_CHECKS = @@UNIQUE_CHECKS, UNIQUE_CHECKS = 0;")?;
    writeln!(w, "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';")?;
    writeln!(w, "SET @OLD_TIME_ZONE = @@TIME_ZONE, TIME_ZONE = '+00:00';\n")?;
    // dates/times in the file are UTC, whatever the server's zone
    c.query_drop("SET SESSION time_zone = '+00:00'").await?;

    let mut step = 0u64;
    for table in &tables {
        job.check()?;
        job.set_label(format!("Table {table}"));
        let create: (String, String) = c.query_first(format!("SHOW CREATE TABLE {}", q(table))).await?.ok_or_else(|| AppError::msg(format!("No CREATE TABLE for {table}")))?;
        writeln!(w, "--\n-- Table {table}\n--\nDROP TABLE IF EXISTS {};\n{};\n", q(table), create.1)?;

        // generated columns can't be inserted
        let cols: Vec<(String, String)> = c
            .exec("SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (database, table))
            .await?;
        let cols: Vec<String> = cols.into_iter().filter(|(_, extra)| !extra.to_uppercase().contains("GENERATED")).map(|(n, _)| q(&n)).collect();
        if cols.is_empty() {
            continue;
        }
        let col_list = cols.join(", ");
        let mut result = c.query_iter(format!("SELECT {col_list} FROM {}", q(table))).await?;
        let columns = result.columns().map(|c| c.to_vec()).unwrap_or_default();
        let mut batch = String::new();
        let mut rows_in_batch = 0;
        let mut rows = 0u64;
        while let Some(row) = result.next().await? {
            let row: Row = row;
            let values: Vec<String> = (0..row.len()).map(|i| literal(row.as_ref(i).unwrap_or(&Value::NULL), &columns[i])).collect();
            if rows_in_batch == 0 {
                batch.push_str(&format!("INSERT INTO {} ({col_list}) VALUES\n", q(table)));
            } else {
                batch.push_str(",\n");
            }
            batch.push('(');
            batch.push_str(&values.join(","));
            batch.push(')');
            rows_in_batch += 1;
            rows += 1;
            if rows_in_batch >= ROWS_PER_INSERT || batch.len() >= BYTES_PER_INSERT {
                writeln!(w, "{batch};")?;
                batch.clear();
                rows_in_batch = 0;
                job.set_label(format!("Table {table} · {rows} rows"));
                if job.cancelled() {
                    drop(result);
                    return Err(AppError::msg("Cancelled."));
                }
            }
        }
        if rows_in_batch > 0 {
            writeln!(w, "{batch};")?;
        }
        writeln!(w)?;
        step += 1;
        job.set_done(step);
    }

    for view in &views {
        job.check()?;
        job.set_label(format!("View {view}"));
        let row: Row = c.query_first(format!("SHOW CREATE VIEW {}", q(view))).await?.ok_or_else(|| AppError::msg(format!("No CREATE VIEW for {view}")))?;
        let create: String = row.get(1).unwrap_or_default();
        writeln!(w, "--\n-- View {view}\n--\nDROP VIEW IF EXISTS {};\n{};\n", q(view), strip_definer(&create))?;
        step += 1;
        job.set_done(step);
    }

    for trigger in &triggers {
        job.check()?;
        job.set_label(format!("Trigger {trigger}"));
        let row: Row = c.query_first(format!("SHOW CREATE TRIGGER {}", q(trigger))).await?.ok_or_else(|| AppError::msg(format!("No CREATE TRIGGER for {trigger}")))?;
        let create: String = row.get(2).unwrap_or_default();
        writeln!(w, "DROP TRIGGER IF EXISTS {};\nDELIMITER ;;\n{} ;;\nDELIMITER ;\n", q(trigger), strip_definer(&create))?;
        step += 1;
        job.set_done(step);
    }

    for (name, kind) in &routines {
        job.check()?;
        job.set_label(format!("{} {name}", if kind == "FUNCTION" { "Function" } else { "Procedure" }));
        let row: Option<Row> = c.query_first(format!("SHOW CREATE {kind} {}", q(name))).await?;
        let create: Option<String> = row.and_then(|r| r.get::<Option<String>, _>(2)).flatten();
        match create {
            Some(create) => writeln!(w, "DROP {kind} IF EXISTS {};\nDELIMITER ;;\n{} ;;\nDELIMITER ;\n", q(name), strip_definer(&create))?,
            None => writeln!(w, "-- {kind} {name} skipped: no permission to read its definition\n")?,
        }
        step += 1;
        job.set_done(step);
    }

    writeln!(w, "SET TIME_ZONE = @OLD_TIME_ZONE;")?;
    writeln!(w, "SET SQL_MODE = @OLD_SQL_MODE;")?;
    writeln!(w, "SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS;")?;
    writeln!(w, "SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;")?;
    job.set_label("Writing the file");
    file.commit()
}

/// Runs a .sql file against `database`, one statement at a time; stops at the first error.
pub async fn restore(session: &MysqlSession, database: &str, path: &str, job: &Job) -> AppResult<()> {
    job.set_label("Reading the file");
    let text = tokio::fs::read_to_string(path).await.map_err(|e| AppError::msg(format!("Could not read {path}: {e}")))?;
    let statements = split_script(&text);
    job.set_total(statements.len() as u64);
    let mut c = session.dedicated_conn().await?;
    c.query_drop(format!("USE {}", q(database))).await?;
    for (i, st) in statements.iter().enumerate() {
        job.check()?;
        if i % 20 == 0 {
            job.set_label(format!("Statement {} of {}", i + 1, statements.len()));
        }
        if let Err(e) = c.query_drop(st.as_str()).await {
            let preview: String = st.chars().take(160).collect();
            return Err(AppError::msg(format!("Statement {} failed: {e}\n{preview}", i + 1)));
        }
        job.set_done(i as u64 + 1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::session;

    #[test]
    fn strips_definer() {
        assert_eq!(
            strip_definer("CREATE ALGORITHM=UNDEFINED DEFINER=`demo`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1"),
            "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1"
        );
        assert_eq!(strip_definer("CREATE VIEW v AS select 1"), "CREATE VIEW v AS select 1");
    }

    #[test]
    fn escapes_strings_for_mysql() {
        assert_eq!(quote_str("it's a \\ path\nnew"), "'it\\'s a \\\\ path\\nnew'");
        assert_eq!(quote_str("a\0b\u{1a}"), "'a\\0b\\Z'");
    }


    async fn snapshot(s: &MysqlSession, db: &str) -> Vec<Vec<Vec<serde_json::Value>>> {
        s.execute(Some(db), "SELECT id, name, price, HEX(raw), CAST(doc AS CHAR), at, total, flag + 0 FROM rowline_bk_parent ORDER BY id; SELECT id, parent_id, note FROM rowline_bk_child ORDER BY id; SELECT * FROM rowline_bk_v ORDER BY id", 100)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.rows)
            .collect()
    }

    /// Backs up two test tables (with tricky values, a generated column, a view and a trigger), changes them,
    /// restores the file, and checks that everything is back.
    #[tokio::test]
    async fn backup_and_restore_round_trip() {
        let Some((s, db)) = session().await else { return };
        let setup = "DROP VIEW IF EXISTS rowline_bk_v; DROP TABLE IF EXISTS rowline_bk_child; DROP TABLE IF EXISTS rowline_bk_parent;
            CREATE TABLE rowline_bk_parent (id INT PRIMARY KEY, name VARCHAR(50), price DECIMAL(10,2), raw VARBINARY(8), doc JSON, at DATETIME(3),
                total DECIMAL(10,2) AS (price * 2) STORED, flag BIT(1));
            CREATE TABLE rowline_bk_child (id INT PRIMARY KEY AUTO_INCREMENT, parent_id INT, note TEXT, FOREIGN KEY (parent_id) REFERENCES rowline_bk_parent(id));
            INSERT INTO rowline_bk_parent (id, name, price, raw, doc, at, flag) VALUES
                (1, 'it''s \\\\ \"q\" ;', 12.50, 0x00FF10, '{\"a\": [1, 2]}', '2026-10-16 10:00:00.123', b'1'),
                (2, NULL, 0, '', NULL, NULL, b'0'),
                (3, 'Ünïcødé 🙂\nline2', -1.25, NULL, '[]', '1999-12-31 23:59:59.000', NULL);
            INSERT INTO rowline_bk_child (parent_id, note) VALUES (1, 'x'), (3, NULL);
            CREATE VIEW rowline_bk_v AS SELECT id, name FROM rowline_bk_parent";
        for st in crate::backup::split_script(setup) {
            s.execute(Some(&db), &st, 10).await.unwrap();
        }
        // a body with `;` inside: sent as one statement
        let mut c = s.dedicated_conn().await.unwrap();
        c.query_drop(format!("USE {}", q(&db))).await.unwrap();
        // creating triggers needs SUPER when binary logging is on; the test user may not have it
        let with_trigger = c
            .query_drop("CREATE TRIGGER rowline_bk_t BEFORE INSERT ON rowline_bk_child FOR EACH ROW BEGIN SET NEW.note = COALESCE(NEW.note, 'auto'); SET @rowline_bk = 1; END")
            .await
            .is_ok();
        drop(c);
        let before = snapshot(&s, &db).await;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shop.sql");
        let only = vec!["rowline_bk_parent".to_string(), "rowline_bk_child".to_string(), "rowline_bk_v".to_string()];
        let job = Job::default();
        backup(&s, &db, file.to_str().unwrap(), Some(&only), &job).await.unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("0x00ff10"), "binary as hex");
        assert!(!text.contains("DEFINER=`"), "definer stripped");
        assert_eq!(text.contains("DELIMITER ;;"), with_trigger, "trigger kept");

        // damage the data, then restore
        s.execute(Some(&db), "DELETE FROM rowline_bk_child; UPDATE rowline_bk_parent SET name = 'broken'", 10).await.unwrap();
        let job = Job::default();
        restore(&s, &db, file.to_str().unwrap(), &job).await.unwrap();
        assert_eq!(snapshot(&s, &db).await, before);
        if with_trigger {
            // the trigger came back too
            s.execute(Some(&db), "INSERT INTO rowline_bk_child (parent_id) VALUES (2)", 10).await.unwrap();
            let note = s.execute(Some(&db), "SELECT note FROM rowline_bk_child WHERE parent_id = 2", 10).await.unwrap();
            assert_eq!(note[0].rows[0][0], "auto");
        }

        for st in ["DROP VIEW rowline_bk_v", "DROP TABLE rowline_bk_child", "DROP TABLE rowline_bk_parent"] {
            s.execute(Some(&db), st, 10).await.unwrap();
        }
    }

    #[tokio::test]
    async fn restore_stops_at_the_first_error_and_cancel_leaves_no_file() {
        let Some((s, db)) = session().await else { return };
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad.sql");
        std::fs::write(&bad, "SELECT 1;\nSELEC oops;\nSELECT 2;\n").unwrap();
        let job = Job::default();
        let err = restore(&s, &db, bad.to_str().unwrap(), &job).await.unwrap_err().to_string();
        assert!(err.starts_with("Statement 2 failed"), "{err}");
        assert_eq!(job.status().done, 1);

        let job = Job::default();
        job.check().unwrap();
        let out = dir.path().join("cancelled.sql");
        // cancel before it starts: no file and no .part file remain
        let cancelled = Job::default();
        cancelled_now(&cancelled);
        assert!(backup(&s, &db, out.to_str().unwrap(), None, &cancelled).await.is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "only bad.sql");
    }

    fn cancelled_now(job: &Job) {
        // Job::cancel is private to the job list; tests reach it through a tiny helper
        job.cancel_for_test();
    }
}
