use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Mysql,
    Sqlite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Local,
    Dev,
    Staging,
    Prod,
}

/// MySQL transport security
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TlsMode {
    /// Plain connection (local servers)
    #[default]
    Off,
    /// Encrypted, certificate not checked (works with private CAs such as AWS RDS)
    Required,
    /// Encrypted and the certificate must be trusted by the system
    Verify,
}

/// What Claude may see on a connection
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeAccess {
    /// Tables, columns and rows (SELECT)
    Data,
    /// Tables and columns only
    Schema,
    /// Nothing
    Off,
}

/// Saved connection. The password is never stored here (see store::SecretStore).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    #[serde(default)]
    pub environment: Environment,
    // MySQL
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub tls: TlsMode,
    // SQLite
    #[serde(default)]
    pub file_path: Option<String>,
    // Claude
    /// None = default for the environment (see `claude_access()`)
    #[serde(default)]
    pub claude_access: Option<ClaudeAccess>,
    /// Folder Claude may read (Read, Grep, Glob only)
    #[serde(default)]
    pub project_folder: Option<String>,
    /// Project the connection belongs to: groups connections in the list and the rail
    #[serde(default)]
    pub group: Option<String>,
}

impl ConnectionConfig {
    /// Production defaults to schema only, every other environment to data.
    pub fn claude_access(&self) -> ClaudeAccess {
        self.claude_access.unwrap_or(if self.environment == Environment::Prod { ClaudeAccess::Schema } else { ClaudeAccess::Data })
    }
}

/// Connection config plus password, used for "test" and "save" from the form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    /// None = keep the stored password
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    pub current_database: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    pub kind: ObjectKind,
    pub row_estimate: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

/// One table of the relation diagram: columns and foreign keys, no indexes or DDL.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub name: String,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub row_estimate: Option<u64>,
    pub comment: Option<String>,
    /// columns of the primary key and unique indexes: a foreign key on one of them is one-to-one
    #[serde(default)]
    pub unique_keys: Vec<Vec<String>>,
}

impl From<TableStructure> for SchemaTable {
    fn from(t: TableStructure) -> Self {
        let unique_keys = t.indexes.iter().filter(|i| i.unique || i.primary).map(|i| i.columns.clone()).collect();
        SchemaTable { name: t.name, kind: t.kind, columns: t.columns, foreign_keys: t.foreign_keys, row_estimate: None, comment: None, unique_keys }
    }
}

/// The schema of one database at a moment, kept to show what changed since (see Store::schema_snapshots).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub taken_at: chrono::DateTime<chrono::Utc>,
    pub tables: Vec<SchemaTable>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub name: String,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub database: Option<String>,
    pub table: String,
    /// Raw SQL condition typed by the user, without the WHERE keyword
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub sort: Vec<SortSpec>,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Value>>,
    /// For statements without a result set
    pub affected_rows: Option<u64>,
    pub elapsed_ms: u64,
    /// More rows were available than returned
    pub truncated: bool,
    /// SQL text of the statement (SQL editor results)
    pub statement: Option<String>,
}

/// One row key or row values: column name -> value
pub type RowValues = Map<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    /// Primary key columns with their original values
    pub key: RowValues,
    /// Changed columns with new values
    pub values: RowValues,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    #[serde(default)]
    pub updates: Vec<RowUpdate>,
    #[serde(default)]
    pub inserts: Vec<RowValues>,
    /// Primary key values of deleted rows
    #[serde(default)]
    pub deletes: Vec<RowValues>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatement {
    pub sql: String,
    pub params: Vec<Value>,
}

/// A relation the database does not know (no foreign key) but the user confirmed: used like a foreign key
/// for grid jumps, referencing rows, the diagram and JOIN completion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VirtualKey {
    #[serde(default)]
    pub id: String,
    pub connection_id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// A query the user saved by name (sidebar "Queries" tab)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub database: Option<String>,
    pub sql: String,
    pub executed_at: chrono::DateTime<chrono::Utc>,
    pub elapsed_ms: u64,
    pub ok: bool,
    /// "cli" for queries an agent ran with the `rowline` command; none for the app itself
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// why it failed or was blocked (CLI)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// rows returned (CLI)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<usize>,
}
