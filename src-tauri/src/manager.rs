//! Open sessions, one per saved connection.

use crate::drivers::mysql::{MysqlParams, MysqlSession};
use crate::drivers::postgres::{PostgresParams, PostgresSession};
use crate::drivers::sqlite::SqliteSession;
use crate::error::{AppError, AppResult};
use crate::model::*;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub enum Session {
    Mysql(MysqlSession),
    /// boxed: the session is much bigger than the others (pools, cancel tokens)
    Postgres(Box<PostgresSession>),
    Sqlite(SqliteSession),
}

impl Session {
    pub async fn open(config: &ConnectionConfig, password: Option<&str>) -> AppResult<Session> {
        match config.engine {
            Engine::Mysql => {
                let host = config.host.as_deref().filter(|h| !h.is_empty()).unwrap_or("127.0.0.1");
                let user = config.user.as_deref().unwrap_or("root");
                Ok(Session::Mysql(
                    MysqlSession::connect(MysqlParams {
                        host,
                        port: config.port.unwrap_or(3306),
                        user,
                        password,
                        database: config.database.as_deref(),
                        tls: config.tls,
                    })
                    .await?,
                ))
            }
            Engine::Postgres => {
                let host = config.host.as_deref().filter(|h| !h.is_empty()).unwrap_or("127.0.0.1");
                let user = config.user.as_deref().filter(|u| !u.is_empty()).unwrap_or("postgres");
                Ok(Session::Postgres(Box::new(
                    PostgresSession::connect(PostgresParams {
                        host,
                        port: config.port.unwrap_or(5432),
                        user,
                        password,
                        database: config.database.as_deref(),
                        tls: config.tls,
                        // prod: every query of the app runs READ ONLY unless its tab unlocked writes
                        prod_lock: config.environment == Environment::Prod,
                    })
                    .await?,
                )))
            }
            Engine::Sqlite => {
                let path = config.file_path.as_deref().filter(|p| !p.is_empty()).ok_or_else(|| AppError::msg("SQLite file path is empty"))?;
                Ok(Session::Sqlite(SqliteSession::open(&expand_home(path)).await?))
            }
        }
    }

    pub async fn server_info(&self) -> AppResult<ServerInfo> {
        match self {
            Session::Mysql(s) => s.server_info().await,
            Session::Postgres(s) => s.server_info().await,
            Session::Sqlite(s) => s.server_info().await,
        }
    }

    pub async fn databases(&self) -> AppResult<Vec<String>> {
        match self {
            Session::Mysql(s) => s.databases().await,
            Session::Postgres(s) => s.databases().await,
            Session::Sqlite(_) => Ok(vec!["main".into()]),
        }
    }

    /// User schemas of a database (Postgres; MySQL and SQLite have none to choose)
    pub async fn schemas(&self, database: Option<&str>) -> AppResult<Vec<String>> {
        match self {
            Session::Postgres(s) => s.schemas(database).await,
            Session::Mysql(_) | Session::Sqlite(_) => Ok(Vec::new()),
        }
    }

    /// Why Claude, MCP and `udb` must not use this connection's login (Postgres superuser or server-file roles).
    /// None = they may. MySQL and SQLite: always None.
    pub async fn ai_refusal(&self, database: Option<&str>) -> AppResult<Option<String>> {
        match self {
            Session::Postgres(s) => s.ai_refusal(database).await,
            Session::Mysql(_) | Session::Sqlite(_) => Ok(None),
        }
    }

    pub async fn objects(&self, database: Option<&str>, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        match self {
            Session::Mysql(s) => s.objects(database).await,
            Session::Postgres(s) => s.objects(database, schema).await,
            Session::Sqlite(s) => s.objects().await,
        }
    }

    pub async fn structure(&self, database: Option<&str>, schema: Option<&str>, table: &str) -> AppResult<TableStructure> {
        match self {
            Session::Mysql(s) => s.structure(database, table).await,
            Session::Postgres(s) => s.structure(database, schema, table).await,
            Session::Sqlite(s) => s.structure(table).await,
        }
    }

    pub async fn common_values(&self, database: Option<&str>, schema: Option<&str>, table: &str, column: &str, limit: usize) -> AppResult<Vec<serde_json::Value>> {
        match self {
            Session::Mysql(s) => s.common_values(database, table, column, limit).await,
            Session::Postgres(s) => s.common_values(database, schema, table, column, limit).await,
            Session::Sqlite(s) => s.common_values(table, column, limit).await,
        }
    }

    pub async fn schema_graph(&self, database: Option<&str>, schema: Option<&str>) -> AppResult<Vec<SchemaTable>> {
        match self {
            Session::Mysql(s) => s.schema_graph(database).await,
            Session::Postgres(s) => s.schema_graph(database, schema).await,
            Session::Sqlite(s) => s.schema_graph().await,
        }
    }

    /// Postgres: all user schemas, keys `schema.table` outside `public`
    pub async fn schema_columns(&self, database: Option<&str>) -> AppResult<Vec<(String, Vec<String>)>> {
        match self {
            Session::Mysql(s) => s.schema_columns(database).await,
            Session::Postgres(s) => s.schema_columns(database).await,
            Session::Sqlite(s) => s.schema_columns().await,
        }
    }

    /// `unlocked`: the tab unlocked writes on a prod Postgres connection (only the app's own commands pass true)
    pub async fn select_page(&self, req: PageRequest, unlocked: bool) -> AppResult<QueryResult> {
        match self {
            Session::Mysql(s) => s.select_page(req).await,
            Session::Postgres(s) => s.select_page(req, unlocked).await,
            Session::Sqlite(s) => s.select_page(req).await,
        }
    }

    pub async fn count(&self, req: PageRequest, unlocked: bool) -> AppResult<u64> {
        match self {
            Session::Mysql(s) => s.count(req).await,
            Session::Postgres(s) => s.count(req, unlocked).await,
            Session::Sqlite(s) => s.count(req).await,
        }
    }

    pub async fn execute(&self, database: Option<&str>, schema: Option<&str>, sql: &str, max_rows: usize, unlocked: bool) -> AppResult<Vec<QueryResult>> {
        match self {
            Session::Mysql(s) => s.execute(database, sql, max_rows).await,
            Session::Postgres(s) => s.execute(database, schema, sql, max_rows, unlocked).await,
            Session::Sqlite(s) => s.execute(sql.to_string(), max_rows).await,
        }
    }

    /// One read-only statement for Claude, MCP and `udb`. The caller has already run `readonly::check`.
    /// There is no `unlocked` here: these paths can never write.
    pub async fn select_read_only(&self, database: Option<&str>, schema: Option<&str>, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        match self {
            Session::Mysql(s) => s.select_read_only(database, sql, max_rows).await,
            Session::Postgres(s) => s.select_read_only(database, schema, sql, max_rows).await,
            Session::Sqlite(s) => s.select_read_only(sql.to_string(), max_rows).await,
        }
    }

    pub async fn apply_changes(&self, database: Option<&str>, schema: Option<&str>, table: &str, changes: ChangeSet, unlocked: bool) -> AppResult<u64> {
        match self {
            Session::Mysql(s) => s.apply_changes(database, table, changes).await,
            Session::Postgres(s) => s.apply_changes(database, schema, table, changes, unlocked).await,
            Session::Sqlite(s) => s.apply_changes(table.to_string(), changes).await,
        }
    }

    /// Stops running queries: only those of tab `owner` when given (MySQL; SQLite runs one query at a time).
    pub async fn cancel(&self, owner: Option<&str>) -> AppResult<()> {
        match self {
            Session::Mysql(s) => s.cancel(owner).await,
            Session::Postgres(s) => s.cancel(owner).await,
            Session::Sqlite(s) => {
                s.cancel();
                Ok(())
            }
        }
    }

    pub fn dialect(&self) -> crate::sqlgen::Dialect {
        match self {
            Session::Mysql(_) => crate::sqlgen::Dialect::Mysql,
            Session::Postgres(_) => crate::sqlgen::Dialect::Postgres,
            Session::Sqlite(_) => crate::sqlgen::Dialect::Sqlite,
        }
    }
}

fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest).to_string_lossy().to_string()).unwrap_or_else(|| path.to_string()),
        None => path.to_string(),
    }
}

#[derive(Default)]
pub struct Manager {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    /// the database each open connection uses in the app (MySQL, Postgres), for the `rowline` command
    databases: std::sync::Mutex<HashMap<String, String>>,
    /// the schema each open Postgres connection shows in the app, for Claude, MCP and `udb`
    schemas: std::sync::Mutex<HashMap<String, String>>,
}

impl Manager {
    /// Ids of the open connections
    pub async fn open_ids(&self) -> Vec<String> {
        self.sessions.read().await.keys().cloned().collect()
    }

    pub fn set_database(&self, id: &str, database: Option<&str>) {
        let mut m = self.databases.lock().unwrap_or_else(|e| e.into_inner());
        match database.filter(|d| !d.is_empty()) {
            Some(d) => m.insert(id.to_string(), d.to_string()),
            None => m.remove(id),
        };
    }

    /// The database selected in the app, if it told us
    pub fn database(&self, id: &str) -> Option<String> {
        self.databases.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }

    pub fn set_schema(&self, id: &str, schema: Option<&str>) {
        let mut m = self.schemas.lock().unwrap_or_else(|e| e.into_inner());
        match schema.filter(|s| !s.is_empty()) {
            Some(s) => m.insert(id.to_string(), s.to_string()),
            None => m.remove(id),
        };
    }

    /// The schema selected in the app, if it told us
    pub fn schema(&self, id: &str) -> Option<String> {
        self.schemas.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }

    pub async fn insert(&self, id: &str, session: Session) {
        let old = self.sessions.write().await.insert(id.to_string(), Arc::new(session));
        drop(old);
    }

    pub async fn get(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions.read().await.get(id).cloned().ok_or_else(|| AppError::NotConnected(id.to_string()))
    }

    pub async fn remove(&self, id: &str) {
        self.sessions.write().await.remove(id);
        self.set_database(id, None);
        self.set_schema(id, None);
    }
}
