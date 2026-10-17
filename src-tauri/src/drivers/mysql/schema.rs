//! Reading the schema of a MySQL database: databases, tables, structure, the relation diagram.

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::sqlgen::Dialect;
use mysql_async::Row;
use mysql_async::prelude::*;
use super::MysqlSession;

impl MysqlSession {
    pub async fn databases(&self) -> AppResult<Vec<String>> {
        let mut c = self.conn().await?;
        let names: Vec<String> = c.query("SHOW DATABASES").await?;
        Ok(names)
    }

    pub async fn objects(&self, database: Option<&str>) -> AppResult<Vec<DbObject>> {
        let db = self.require_db(database)?.to_string();
        let mut c = self.conn().await?;
        let rows: Vec<(String, String, Option<u64>)> = c
            .exec(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                (db,),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|(name, kind, rows)| DbObject {
                name,
                kind: if kind.eq_ignore_ascii_case("VIEW") { ObjectKind::View } else { ObjectKind::Table },
                row_estimate: rows,
            })
            .collect())
    }

    pub async fn structure(&self, database: Option<&str>, table: &str) -> AppResult<TableStructure> {
        let db = self.require_db(database)?.to_string();
        let mut c = self.conn().await?;

        let kind: Option<String> = c
            .exec_first("SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", (&db, table))
            .await?;
        let kind = kind.ok_or_else(|| AppError::msg(format!("Table not found: {db}.{table}")))?;

        type ColRow = (String, String, String, Option<String>, String, String, String);
        let cols: Vec<ColRow> = c
            .exec(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                (&db, table),
            )
            .await?;
        let columns = cols
            .into_iter()
            .map(|(name, data_type, nullable, default_value, key, extra, comment)| ColumnInfo {
                name,
                data_type,
                nullable: nullable == "YES",
                default_value,
                primary_key: key == "PRI",
                auto_increment: extra.to_lowercase().contains("auto_increment"),
                comment: Some(comment).filter(|c| !c.is_empty()),
            })
            .collect();

        let idx_rows: Vec<(String, String, i64)> = c
            .exec(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX",
                (&db, table),
            )
            .await?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for (name, col, non_unique) in idx_rows {
            match indexes.iter_mut().find(|i| i.name == name) {
                Some(i) => i.columns.push(col),
                None => indexes.push(IndexInfo {
                    primary: name == "PRIMARY",
                    name,
                    columns: vec![col],
                    unique: non_unique == 0,
                }),
            }
        }

        type FkRow = (String, String, String, String, String, String);
        let fk_rows: Vec<FkRow> = c
            .exec(
                "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                (&db, table),
            )
            .await?;
        let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
        for (name, col, ref_table, ref_col, on_update, on_delete) in fk_rows {
            match foreign_keys.iter_mut().find(|f| f.name == name) {
                Some(f) => {
                    f.columns.push(col);
                    f.ref_columns.push(ref_col);
                }
                None => foreign_keys.push(ForeignKeyInfo {
                    name,
                    columns: vec![col],
                    ref_table,
                    ref_columns: vec![ref_col],
                    on_update: Some(on_update),
                    on_delete: Some(on_delete),
                }),
            }
        }

        let is_view = kind.eq_ignore_ascii_case("VIEW");
        let show = format!(
            "SHOW CREATE {} {}",
            if is_view { "VIEW" } else { "TABLE" },
            Dialect::Mysql.qualified(Some(&db), table)
        );
        let ddl_row: Option<Row> = c.query_first(show).await?;
        let ddl = ddl_row.and_then(|r| r.get::<Option<String>, usize>(1).flatten());

        Ok(TableStructure {
            name: table.to_string(),
            kind: if is_view { ObjectKind::View } else { ObjectKind::Table },
            columns,
            indexes,
            foreign_keys,
            ddl,
        })
    }

    /// All tables with their columns and foreign keys (relation diagram), in three queries.
    pub async fn schema_graph(&self, database: Option<&str>) -> AppResult<Vec<SchemaTable>> {
        let db = self.require_db(database)?.to_string();
        let mut c = self.conn().await?;
        let tables: Vec<(String, String, Option<u64>, String)> = c
            .exec(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                (&db,),
            )
            .await?;
        let mut out: Vec<SchemaTable> = tables
            .into_iter()
            .map(|(name, kind, rows, comment)| {
                let view = kind.eq_ignore_ascii_case("VIEW");
                SchemaTable {
                    name,
                    kind: if view { ObjectKind::View } else { ObjectKind::Table },
                    columns: Vec::new(),
                    foreign_keys: Vec::new(),
                    row_estimate: if view { None } else { rows },
                    comment: Some(comment).filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case("VIEW")),
                    unique_keys: Vec::new(),
                }
            })
            .collect();
        let index: std::collections::HashMap<String, usize> = out.iter().enumerate().map(|(i, t)| (t.name.clone(), i)).collect();

        type ColRow = (String, String, String, String, Option<String>, String, String, String);
        let cols: Vec<ColRow> = c
            .exec(
                "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
                (&db,),
            )
            .await?;
        for (table, name, data_type, nullable, default_value, key, extra, comment) in cols {
            let Some(&i) = index.get(&table) else { continue };
            // single-column unique keys, to tell one-to-one from many-to-one. Not read from STATISTICS:
            // on MySQL 8 that view can check index statistics table by table and takes minutes on big schemas.
            if key == "UNI" {
                out[i].unique_keys.push(vec![name.clone()]);
            }
            out[i].columns.push(ColumnInfo {
                name,
                data_type,
                nullable: nullable == "YES",
                default_value,
                primary_key: key == "PRI",
                auto_increment: extra.to_lowercase().contains("auto_increment"),
                comment: Some(comment).filter(|c| !c.is_empty()),
            });
        }

        type FkRow = (String, String, String, String, String, String, String, String);
        let fks: Vec<FkRow> = c
            .exec(
                "SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
                        r.UPDATE_RULE, r.DELETE_RULE
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
                 ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                (&db,),
            )
            .await?;
        for (table, name, col, ref_schema, ref_table, ref_col, on_update, on_delete) in fks {
            let Some(&i) = index.get(&table) else { continue };
            // a table in another database keeps its database name
            let ref_table = if ref_schema == db { ref_table } else { format!("{ref_schema}.{ref_table}") };
            let list = &mut out[i].foreign_keys;
            match list.iter_mut().find(|f| f.name == name) {
                Some(f) => {
                    f.columns.push(col);
                    f.ref_columns.push(ref_col);
                }
                None => list.push(ForeignKeyInfo { name, columns: vec![col], ref_table, ref_columns: vec![ref_col], on_update: Some(on_update), on_delete: Some(on_delete) }),
            }
        }
        Ok(out)
    }

    /// table -> column names, for SQL autocomplete
    pub async fn schema_columns(&self, database: Option<&str>) -> AppResult<Vec<(String, Vec<String>)>> {
        let db = self.require_db(database)?.to_string();
        let mut c = self.conn().await?;
        let rows: Vec<(String, String)> = c
            .exec(
                "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
                (db,),
            )
            .await?;
        Ok(super::group_columns(rows))
    }
}

#[cfg(test)]
mod tests {
    //! Run with a MySQL server: ROWLINE_TEST_MYSQL="host:port:user:password:database"
    use super::super::test_support::*;
    use crate::model::ObjectKind;

    #[tokio::test]
    async fn schema_graph_has_columns_and_foreign_keys() {
        let Some((s, db)) = session().await else { return };
        let graph = s.schema_graph(Some(&db)).await.unwrap();
        let orders = graph.iter().find(|t| t.name == "orders").expect("orders table in the test database");
        assert!(orders.columns.iter().any(|c| c.name == "id" && c.primary_key));
        let fk = orders.foreign_keys.iter().find(|f| f.columns == ["customer_id"]).expect("orders.customer_id foreign key");
        assert_eq!((fk.ref_table.as_str(), fk.ref_columns[0].as_str()), ("customers", "id"));
        assert!(graph.iter().any(|t| t.name == "active_customers" && t.kind == ObjectKind::View));
        let customers = graph.iter().find(|t| t.name == "customers").unwrap();
        assert!(customers.unique_keys.contains(&vec!["email".to_string()]), "{:?}", customers.unique_keys);
        s.close().await;
    }
}
