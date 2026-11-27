//! Reading the catalog of a Postgres database: databases, schemas, tables, structure, the relation diagram.
//! Every read runs in a READ ONLY transaction like the other queries.

use super::{Access, PostgresSession};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::sqlgen::Dialect;
use std::collections::HashMap;
use tokio_postgres::Client;

/// Tables, partitioned tables, views, materialized views, foreign tables
const RELKINDS: &str = "('r','p','v','m','f')";
/// Schemas never listed: every `pg_*` name is reserved by Postgres (pg_catalog, pg_toast*, pg_temp*)
const USER_SCHEMA: &str = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";

fn kind(relkind: &str) -> ObjectKind {
    if matches!(relkind, "v" | "m") { ObjectKind::View } else { ObjectKind::Table }
}

/// Row estimate from the planner statistics; a table never analyzed falls back to the live tuple counter.
const ROW_ESTIMATE: &str = "CASE WHEN c.relkind IN ('r','p','m','f') THEN
    (CASE WHEN c.reltuples >= 0 THEN c.reltuples::int8 ELSE pg_stat_get_live_tuples(c.oid) END) END";

fn fk_action(code: &str) -> String {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_string()
}

/// A referenced table in another schema keeps its schema name.
fn ref_name(own_schema: &str, ref_schema: &str, ref_table: String) -> String {
    if ref_schema == own_schema { ref_table } else { format!("{ref_schema}.{ref_table}") }
}

/// Columns of the tables matched by `filter` (an SQL condition on `c`), with the table name first.
async fn columns(c: &Client, filter: &str, param: &(dyn tokio_postgres::types::ToSql + Sync)) -> AppResult<Vec<(String, ColumnInfo)>> {
    let sql = format!(
        "SELECT c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid),
                COALESCE(a.attnum = ANY(i.indkey::int2[]), false),
                a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false),
                col_description(a.attrelid, a.attnum)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
         WHERE {filter} AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY c.relname, a.attnum"
    );
    let rows = c.query(sql.as_str(), &[param]).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get(0),
                ColumnInfo {
                    name: r.get(1),
                    data_type: r.get(2),
                    nullable: r.get(3),
                    default_value: r.get(4),
                    primary_key: r.get(5),
                    auto_increment: r.get(6),
                    comment: r.get::<_, Option<String>>(7).filter(|c| !c.is_empty()),
                },
            )
        })
        .collect())
}

/// Foreign keys of the tables matched by `filter` (on `con`), with the table name and schema first.
async fn foreign_keys(
    c: &Client,
    filter: &str,
    param: &(dyn tokio_postgres::types::ToSql + Sync),
) -> AppResult<Vec<(String, String, ForeignKeyInfo)>> {
    let sql = format!(
        "SELECT oc.relname::text, onsp.nspname::text, con.conname::text,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, n)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.n),
                rn.nspname::text, rc.relname::text,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, n)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.n),
                con.confupdtype::text, con.confdeltype::text
         FROM pg_constraint con
         JOIN pg_class oc ON oc.oid = con.conrelid
         JOIN pg_namespace onsp ON onsp.oid = oc.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE con.contype = 'f' AND {filter}
         ORDER BY oc.relname, con.conname"
    );
    let rows = c.query(sql.as_str(), &[param]).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let own_schema: String = r.get(1);
            let ref_schema: String = r.get(4);
            let fk = ForeignKeyInfo {
                name: r.get(2),
                columns: r.get(3),
                ref_table: ref_name(&own_schema, &ref_schema, r.get(5)),
                ref_columns: r.get(6),
                on_update: Some(fk_action(r.get(7))),
                on_delete: Some(fk_action(r.get(8))),
            };
            (r.get(0), own_schema, fk)
        })
        .collect())
}

impl PostgresSession {
    /// Databases the user may connect to, without templates.
    pub async fn databases(&self) -> AppResult<Vec<String>> {
        let tx = self.begin(None, None, Access::ReadOnly).await?;
        let res = async {
            let rows = tx
                .c
                .query(
                    "SELECT datname::text FROM pg_database
                     WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT')
                     ORDER BY datname",
                    &[],
                )
                .await?;
            Ok(rows.into_iter().map(|r| r.get(0)).collect())
        }
        .await;
        tx.finish(res).await
    }

    /// User schemas the login may use, `public` first, then by name. Never system schemas.
    pub async fn schemas(&self, database: Option<&str>) -> AppResult<Vec<String>> {
        let tx = self.begin(database, None, Access::ReadOnly).await?;
        let res = async {
            let sql = format!(
                "SELECT n.nspname::text FROM pg_namespace n
                 WHERE {USER_SCHEMA} AND has_schema_privilege(n.oid, 'USAGE')
                 ORDER BY n.nspname <> 'public', n.nspname"
            );
            let rows = tx.c.query(sql.as_str(), &[]).await?;
            Ok(rows.into_iter().map(|r| r.get(0)).collect())
        }
        .await;
        tx.finish(res).await
    }

    /// Tables and views of `schema` (`None` = the current schema), partitions left out.
    pub async fn objects(&self, database: Option<&str>, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        let tx = self.begin(database, schema, Access::ReadOnly).await?;
        let res = async {
            let sql = format!(
                "SELECT c.relname::text, c.relkind::text, {ROW_ESTIMATE}
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = COALESCE($1, current_schema()) AND c.relkind IN {RELKINDS} AND NOT c.relispartition
                 ORDER BY c.relname"
            );
            // the named schema even when it doesn't exist (current_schema() would then be the next one in the path)
            let rows = tx.c.query(sql.as_str(), &[&schema.filter(|s| !s.is_empty())]).await?;
            Ok(rows
                .into_iter()
                .map(|r| DbObject {
                    name: r.get(0),
                    kind: kind(r.get(1)),
                    row_estimate: r.get::<_, Option<i64>>(2).map(|n| n.max(0) as u64),
                })
                .collect())
        }
        .await;
        tx.finish(res).await
    }

    pub async fn structure(&self, database: Option<&str>, schema: Option<&str>, table: &str) -> AppResult<TableStructure> {
        let tx = self.begin(database, schema, Access::ReadOnly).await?;
        let res = self.read_structure(&tx.c, schema, table).await;
        tx.finish(res).await
    }

    async fn read_structure(&self, c: &Client, schema: Option<&str>, table: &str) -> AppResult<TableStructure> {
        let target = Dialect::Postgres.qualified_in(None, schema, table);
        let found = c
            .query_opt(
                "SELECT c.oid, c.relkind::text, n.nspname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.oid = to_regclass($1)",
                &[&target],
            )
            .await?;
        let found = found.ok_or_else(|| AppError::msg(format!("Table not found: {target}")))?;
        let (oid, relkind, nsp): (u32, String, String) = (found.get(0), found.get(1), found.get(2));
        let kind = kind(&relkind);

        let columns: Vec<ColumnInfo> = columns(c, "c.oid = $1", &oid).await?.into_iter().map(|(_, col)| col).collect();

        let idx_rows = c
            .query(
                "SELECT ic.relname::text, i.indisunique, i.indisprimary,
                        ARRAY(SELECT COALESCE(a.attname::text, pg_get_indexdef(i.indexrelid, k.n::int, true))
                              FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                              LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                              ORDER BY k.n)
                 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                 WHERE i.indrelid = $1
                 ORDER BY i.indisprimary DESC, ic.relname",
                &[&oid],
            )
            .await?;
        let indexes = idx_rows
            .into_iter()
            .map(|r| IndexInfo { name: r.get(0), unique: r.get(1), primary: r.get(2), columns: r.get(3) })
            .collect();

        let foreign_keys = foreign_keys(c, "con.conrelid = $1", &oid).await?.into_iter().map(|(_, _, fk)| fk).collect();

        let ddl = Some(ddl(c, oid, &nsp, table, kind == ObjectKind::View, &columns).await?);
        Ok(TableStructure { name: table.to_string(), kind, columns, indexes, foreign_keys, ddl })
    }

    /// All tables of `schema` with their columns and foreign keys (relation diagram). A foreign key to a
    /// table of another schema names it `schema.table`.
    pub async fn schema_graph(&self, database: Option<&str>, schema: Option<&str>) -> AppResult<Vec<SchemaTable>> {
        let tx = self.begin(database, schema, Access::ReadOnly).await?;
        let res = async {
            let c = &tx.c;
            let nsp: String = match schema.filter(|s| !s.is_empty()) {
                Some(s) => s.to_string(),
                None => c.query_one("SELECT current_schema()::text", &[]).await?.get::<_, Option<String>>(0).unwrap_or_default(),
            };
            let sql = format!(
                "SELECT c.relname::text, c.relkind::text, {ROW_ESTIMATE}, obj_description(c.oid, 'pg_class')
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN {RELKINDS} AND NOT c.relispartition
                 ORDER BY c.relname"
            );
            let mut out: Vec<SchemaTable> = c
                .query(sql.as_str(), &[&nsp])
                .await?
                .into_iter()
                .map(|r| {
                    let kind = kind(r.get(1));
                    SchemaTable {
                        name: r.get(0),
                        row_estimate: if kind == ObjectKind::View { None } else { r.get::<_, Option<i64>>(2).map(|n| n.max(0) as u64) },
                        kind,
                        columns: Vec::new(),
                        foreign_keys: Vec::new(),
                        comment: r.get::<_, Option<String>>(3).filter(|c| !c.is_empty()),
                        unique_keys: Vec::new(),
                    }
                })
                .collect();
            let index: HashMap<String, usize> = out.iter().enumerate().map(|(i, t)| (t.name.clone(), i)).collect();
            let in_schema = format!("c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) AND c.relkind IN {RELKINDS}");

            for (table, col) in columns(c, &in_schema, &nsp).await? {
                if let Some(&i) = index.get(&table) {
                    out[i].columns.push(col);
                }
            }
            // unique keys other than the primary key, to tell one-to-one from many-to-one (as for MySQL)
            let uniques = c
                .query(
                    "SELECT c.relname::text,
                            ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.n)
                     FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
                     WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
                       AND i.indisunique AND NOT i.indisprimary AND i.indexprs IS NULL AND i.indpred IS NULL
                     ORDER BY c.relname",
                    &[&nsp],
                )
                .await?;
            for r in uniques {
                if let Some(&i) = index.get(&r.get::<_, String>(0)) {
                    out[i].unique_keys.push(r.get(1));
                }
            }
            for (table, _, fk) in foreign_keys(c, "onsp.nspname = $1", &nsp).await? {
                if let Some(&i) = index.get(&table) {
                    out[i].foreign_keys.push(fk);
                }
            }
            Ok(out)
        }
        .await;
        tx.finish(res).await
    }

    /// table -> column names of every user schema (SQL autocomplete, ⌘K). Keys are `table` for `public`
    /// and `schema.table` otherwise.
    pub async fn schema_columns(&self, database: Option<&str>) -> AppResult<Vec<(String, Vec<String>)>> {
        let tx = self.begin(database, None, Access::ReadOnly).await?;
        let res = async {
            let sql = format!(
                "SELECT CASE WHEN n.nspname = 'public' THEN c.relname::text ELSE n.nspname || '.' || c.relname END, a.attname::text
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE {USER_SCHEMA} AND c.relkind IN {RELKINDS} AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY n.nspname <> 'public', n.nspname, c.relname, a.attnum"
            );
            let rows: Vec<(String, String)> = tx.c.query(sql.as_str(), &[]).await?.into_iter().map(|r| (r.get(0), r.get(1))).collect();
            Ok(crate::drivers::mysql::group_columns(rows))
        }
        .await;
        tx.finish(res).await
    }
}

/// Postgres has no SHOW CREATE TABLE: the DDL is put together from the catalog (columns, constraints,
/// other indexes). Views use pg_get_viewdef.
async fn ddl(c: &Client, oid: u32, schema: &str, table: &str, view: bool, columns: &[ColumnInfo]) -> AppResult<String> {
    let name = Dialect::Postgres.qualified_in(None, Some(schema), table);
    if view {
        let def: Option<String> = c.query_one("SELECT pg_get_viewdef($1::oid, true)", &[&oid]).await?.get(0);
        return Ok(format!("CREATE VIEW {name} AS\n{}", def.unwrap_or_default()));
    }
    let mut lines: Vec<String> = columns
        .iter()
        .map(|col| {
            let mut line = format!("  {} {}", Dialect::Postgres.quote_ident(&col.name), col.data_type);
            if let Some(d) = &col.default_value {
                line.push_str(&format!(" DEFAULT {d}"));
            }
            if !col.nullable {
                line.push_str(" NOT NULL");
            }
            line
        })
        .collect();
    let constraints = c
        .query(
            "SELECT conname::text, pg_get_constraintdef(oid, true) FROM pg_constraint
             WHERE conrelid = $1 AND contype IN ('p','u','f','c','x')
             ORDER BY contype <> 'p', contype, conname",
            &[&oid],
        )
        .await?;
    for r in constraints {
        let (cname, def): (String, String) = (r.get(0), r.get(1));
        lines.push(format!("  CONSTRAINT {} {def}", Dialect::Postgres.quote_ident(&cname)));
    }
    let mut out = format!("CREATE TABLE {name} (\n{}\n);", lines.join(",\n"));
    let indexes = c
        .query(
            "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
             WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p','u','x'))
             ORDER BY ic.relname",
            &[&oid],
        )
        .await?;
    for r in indexes {
        out.push_str(&format!("\n{};", r.get::<_, String>(0)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    //! Run with a Postgres server: ROWLINE_TEST_POSTGRES="host:port:user:password:database"
    use super::super::test_support::*;
    use crate::model::ObjectKind;

    #[tokio::test]
    async fn databases_and_schemas() {
        let Some(s) = session(false).await else { return };
        let dbs = s.databases().await.unwrap();
        assert!(dbs.contains(&"shop".to_string()));
        assert!(!dbs.iter().any(|d| d.starts_with("template")), "{dbs:?}");
        let schemas = s.schemas(None).await.unwrap();
        // other tests may add rowline_* schemas for a moment
        let schemas: Vec<&String> = schemas.iter().filter(|s| !s.starts_with("rowline_")).collect();
        assert_eq!(schemas, ["public", "billing"]);
    }

    #[tokio::test]
    async fn objects_of_a_schema() {
        let Some(s) = session(false).await else { return };
        let objs = s.objects(None, Some("public")).await.unwrap();
        let orders = objs.iter().find(|o| o.name == "Orders").expect("Orders");
        assert_eq!(orders.kind, ObjectKind::Table);
        assert!(orders.row_estimate.is_some());
        let view = objs.iter().find(|o| o.name == "big_orders").expect("big_orders");
        assert_eq!((view.kind.clone(), view.row_estimate), (ObjectKind::View, None));
        assert!(!objs.iter().any(|o| o.name == "invoices"), "only the selected schema");
        assert_eq!(s.objects(None, Some("billing")).await.unwrap().iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["invoices"]);
        // a schema that doesn't exist (or is empty) lists nothing, cleanly
        assert!(s.objects(None, Some("rowline_no_such_schema")).await.unwrap().is_empty());
        assert!(s.schema_graph(None, Some("rowline_no_such_schema")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn structure_of_a_table_and_a_view() {
        let Some(s) = session(false).await else { return };
        let st = s.structure(None, Some("public"), "Orders").await.unwrap();
        assert_eq!(st.columns[0].name, "id");
        assert!(st.columns[0].primary_key && st.columns[0].auto_increment);
        let total = st.columns.iter().find(|c| c.name == "total").unwrap();
        assert_eq!(total.data_type, "numeric(12,2)");
        assert!(total.nullable && !total.primary_key);
        assert_eq!(st.columns.iter().find(|c| c.name == "tags").unwrap().data_type, "text[]");
        assert!(st.indexes.iter().any(|i| i.primary && i.columns == ["id"]));
        let fk = st.foreign_keys.iter().find(|f| f.columns == ["customer_id"]).expect("fk to customers");
        assert_eq!((fk.ref_table.as_str(), fk.ref_columns[0].as_str()), ("customers", "id"));
        assert_eq!(fk.on_delete.as_deref(), Some("NO ACTION"));
        let ddl = st.ddl.unwrap();
        assert!(ddl.starts_with("CREATE TABLE \"public\".\"Orders\" ("), "{ddl}");
        assert!(ddl.contains("PRIMARY KEY (id)"), "{ddl}");

        let inv = s.structure(None, Some("billing"), "invoices").await.unwrap();
        assert_eq!(inv.foreign_keys[0].ref_table, "public.Orders", "another schema keeps its name");

        let view = s.structure(None, Some("public"), "big_orders").await.unwrap();
        assert_eq!(view.kind, ObjectKind::View);
        assert!(view.ddl.unwrap().starts_with("CREATE VIEW \"public\".\"big_orders\" AS"));
        assert!(s.structure(None, Some("public"), "rowline_missing").await.unwrap_err().to_string().contains("Table not found"));
    }

    #[tokio::test]
    async fn schema_graph_and_columns() {
        let Some(s) = session(false).await else { return };
        let graph = s.schema_graph(None, Some("public")).await.unwrap();
        let orders = graph.iter().find(|t| t.name == "Orders").unwrap();
        assert!(orders.columns.iter().any(|c| c.name == "id" && c.primary_key));
        assert_eq!(orders.foreign_keys[0].ref_table, "customers");
        let customers = graph.iter().find(|t| t.name == "customers").unwrap();
        assert!(customers.unique_keys.contains(&vec!["email".to_string()]), "{:?}", customers.unique_keys);
        assert!(graph.iter().any(|t| t.name == "big_orders" && t.kind == ObjectKind::View));
        assert!(!graph.iter().any(|t| t.name == "invoices"));

        let billing = s.schema_graph(None, Some("billing")).await.unwrap();
        assert_eq!(billing[0].foreign_keys[0].ref_table, "public.Orders");

        let cols = s.schema_columns(None).await.unwrap();
        let keys: Vec<&str> = cols.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"customers") && keys.contains(&"Orders") && keys.contains(&"billing.invoices"), "{keys:?}");
        assert!(!keys.iter().any(|k| k.starts_with("pg_") || k.starts_with("information_schema")));
        let (_, inv) = cols.iter().find(|(k, _)| k == "billing.invoices").unwrap();
        assert_eq!(inv, &["id", "order_id", "due"]);
    }
}
