//! Saved connections (JSON file, no passwords), query history, and password storage (separate owner-only file).

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, HistoryEntry, SavedQuery, SchemaSnapshot, SchemaTable, VirtualKey};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const HISTORY_LIMIT: usize = 500;
/// schema snapshots kept per database
const SNAPSHOT_LIMIT: usize = 5;

/// Passwords in a JSON file next to connections.json, readable only by the current macOS user (0600).
/// No Keychain: an unsigned app gets a new identity on every build, so the Keychain kept asking for the login password.
pub struct SecretStore {
    path: PathBuf,
}

impl SecretStore {
    pub fn file(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> AppResult<HashMap<String, String>> {
        Ok(read_json(&self.path)?.unwrap_or_default())
    }

    fn save(&self, map: &HashMap<String, String>) -> AppResult<()> {
        write_json(&self.path, map)?;
        set_owner_only(&self.path)
    }

    pub fn get(&self, id: &str) -> AppResult<Option<String>> {
        Ok(self.load()?.remove(id))
    }

    pub fn set(&self, id: &str, password: &str) -> AppResult<()> {
        let mut map = self.load()?;
        map.insert(id.to_string(), password.to_string());
        self.save(&map)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut map = self.load()?;
        if map.remove(id).is_some() {
            self.save(&map)?;
        }
        Ok(())
    }
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> AppResult<()> {
    Ok(())
}

pub struct Store {
    dir: PathBuf,
    pub secrets: SecretStore,
    lock: Mutex<()>,
}

/// Appends a message (with time) to client-errors.log in `dir`; keeps the file below ~1 MB.
pub fn append_log(dir: &Path, message: &str) -> AppResult<()> {
    use std::io::Write;
    let path = dir.join("client-errors.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        std::fs::rename(&path, dir.join("client-errors.old.log"))?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "--- {}\n{}\n", chrono::Utc::now().to_rfc3339(), message)?;
    Ok(())
}

impl Store {
    pub fn new(dir: PathBuf, secrets: SecretStore) -> AppResult<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir, secrets, lock: Mutex::new(()) })
    }

    fn connections_path(&self) -> PathBuf {
        self.dir.join("connections.json")
    }

    fn history_path(&self) -> PathBuf {
        self.dir.join("history.json")
    }

    pub fn connections(&self) -> AppResult<Vec<ConnectionConfig>> {
        Ok(read_json(&self.connections_path())?.unwrap_or_default())
    }

    pub fn connection(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.connections()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::msg(format!("Unknown connection: {id}")))
    }

    pub fn save_connection(&self, config: ConnectionConfig) -> AppResult<()> {
        let _g = self.lock.lock();
        let mut all = self.connections()?;
        match all.iter_mut().find(|c| c.id == config.id) {
            Some(existing) => *existing = config,
            None => all.push(config),
        }
        write_json(&self.connections_path(), &all)
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        let _g = self.lock.lock();
        let all: Vec<ConnectionConfig> = self.connections()?.into_iter().filter(|c| c.id != id).collect();
        write_json(&self.connections_path(), &all)?;
        // its saved queries go too
        if let Some(queries) = read_json::<Vec<SavedQuery>>(&self.queries_path())? {
            write_json(&self.queries_path(), &queries.into_iter().filter(|q| q.connection_id != id).collect::<Vec<_>>())?;
        }
        // its virtual foreign keys
        if let Some(keys) = read_json::<Vec<VirtualKey>>(&self.virtual_keys_path())? {
            write_json(&self.virtual_keys_path(), &keys.into_iter().filter(|k| k.connection_id != id).collect::<Vec<_>>())?;
        }
        // and its schema snapshots
        match std::fs::remove_dir_all(self.snapshots_dir(id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        self.secrets.delete(id)
    }

    /// Appends a frontend error (with time) to client-errors.log; keeps the file below ~1 MB.
    pub fn log_client_error(&self, message: &str) -> AppResult<()> {
        append_log(&self.dir, message)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn queries_path(&self) -> PathBuf {
        self.dir.join("queries.json")
    }

    /// Saved queries of one connection, sorted by name.
    pub fn saved_queries(&self, connection_id: &str) -> AppResult<Vec<SavedQuery>> {
        let all: Vec<SavedQuery> = read_json(&self.queries_path())?.unwrap_or_default();
        let mut list: Vec<SavedQuery> = all.into_iter().filter(|q| q.connection_id == connection_id).collect();
        list.sort_by_key(|q| q.name.to_lowercase());
        Ok(list)
    }

    /// Adds a query (empty id) or replaces the one with the same id.
    pub fn save_query(&self, mut query: SavedQuery) -> AppResult<SavedQuery> {
        let _g = self.lock.lock();
        query.name = query.name.trim().to_string();
        if query.name.is_empty() {
            return Err(AppError::msg("Name is required"));
        }
        if query.id.is_empty() {
            query.id = uuid::Uuid::new_v4().to_string();
        }
        query.updated_at = chrono::Utc::now();
        let mut all: Vec<SavedQuery> = read_json(&self.queries_path())?.unwrap_or_default();
        match all.iter_mut().find(|q| q.id == query.id) {
            Some(existing) => *existing = query.clone(),
            None => all.push(query.clone()),
        }
        write_json(&self.queries_path(), &all)?;
        Ok(query)
    }

    pub fn delete_query(&self, id: &str) -> AppResult<()> {
        let _g = self.lock.lock();
        let all: Vec<SavedQuery> = read_json(&self.queries_path())?.unwrap_or_default();
        write_json(&self.queries_path(), &all.into_iter().filter(|q| q.id != id).collect::<Vec<_>>())
    }

    fn virtual_keys_path(&self) -> PathBuf {
        self.dir.join("virtual_keys.json")
    }

    /// Virtual foreign keys of one database
    pub fn virtual_keys(&self, connection_id: &str, database: Option<&str>) -> AppResult<Vec<VirtualKey>> {
        let all: Vec<VirtualKey> = read_json(&self.virtual_keys_path())?.unwrap_or_default();
        Ok(all.into_iter().filter(|k| k.connection_id == connection_id && k.database.as_deref() == database).collect())
    }

    /// Adds a virtual key (empty id) or replaces the one with the same id. The same columns → table can exist once.
    pub fn save_virtual_key(&self, mut key: VirtualKey) -> AppResult<VirtualKey> {
        let _g = self.lock.lock();
        key.table = key.table.trim().to_string();
        key.ref_table = key.ref_table.trim().to_string();
        if key.table.is_empty() || key.ref_table.is_empty() || key.columns.is_empty() || key.columns.len() != key.ref_columns.len() || key.columns.iter().chain(&key.ref_columns).any(|c| c.trim().is_empty()) {
            return Err(AppError::msg("A virtual foreign key needs a table, columns and the referenced table with the same number of columns"));
        }
        let mut all: Vec<VirtualKey> = read_json(&self.virtual_keys_path())?.unwrap_or_default();
        let same = |k: &VirtualKey| k.connection_id == key.connection_id && k.database == key.database && k.table == key.table && k.columns == key.columns;
        if key.id.is_empty() {
            if let Some(existing) = all.iter().find(|k| same(k)) {
                key.id = existing.id.clone();
            } else {
                key.id = uuid::Uuid::new_v4().to_string();
            }
        }
        match all.iter_mut().find(|k| k.id == key.id) {
            Some(existing) => *existing = key.clone(),
            None => all.push(key.clone()),
        }
        write_json(&self.virtual_keys_path(), &all)?;
        Ok(key)
    }

    pub fn delete_virtual_key(&self, id: &str) -> AppResult<()> {
        let _g = self.lock.lock();
        let all: Vec<VirtualKey> = read_json(&self.virtual_keys_path())?.unwrap_or_default();
        write_json(&self.virtual_keys_path(), &all.into_iter().filter(|k| k.id != id).collect::<Vec<_>>())
    }

    fn snapshots_dir(&self, connection_id: &str) -> PathBuf {
        // connection ids are uuids; keep only safe characters anyway
        let safe: String = connection_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join("schema-snapshots").join(safe)
    }

    fn snapshots_path(&self, connection_id: &str, database: Option<&str>) -> PathBuf {
        let db = database.unwrap_or("main");
        let safe: String = db.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        self.snapshots_dir(connection_id).join(format!("{safe}.json"))
    }

    /// Saved schema snapshots of one database, oldest first.
    pub fn schema_snapshots(&self, connection_id: &str, database: Option<&str>) -> AppResult<Vec<SchemaSnapshot>> {
        Ok(read_json(&self.snapshots_path(connection_id, database))?.unwrap_or_default())
    }

    /// Adds a snapshot ("mark as seen"); keeps the last SNAPSHOT_LIMIT.
    pub fn add_schema_snapshot(&self, connection_id: &str, database: Option<&str>, tables: Vec<SchemaTable>) -> AppResult<SchemaSnapshot> {
        let _g = self.lock.lock();
        let path = self.snapshots_path(connection_id, database);
        std::fs::create_dir_all(path.parent().expect("snapshot dir"))?;
        let mut all: Vec<SchemaSnapshot> = read_json(&path)?.unwrap_or_default();
        let snapshot = SchemaSnapshot { taken_at: chrono::Utc::now(), tables };
        all.push(snapshot.clone());
        let extra = all.len().saturating_sub(SNAPSHOT_LIMIT);
        all.drain(..extra);
        write_json(&path, &all)?;
        Ok(snapshot)
    }

    pub fn history(&self, connection_id: Option<&str>) -> AppResult<Vec<HistoryEntry>> {
        let all: Vec<HistoryEntry> = read_json(&self.history_path())?.unwrap_or_default();
        Ok(all.into_iter().filter(|h| connection_id.is_none_or(|id| h.connection_id == id)).collect())
    }

    pub fn add_history(&self, entry: HistoryEntry) -> AppResult<()> {
        let _g = self.lock.lock();
        let mut all: Vec<HistoryEntry> = read_json(&self.history_path())?.unwrap_or_default();
        all.insert(0, entry);
        all.truncate(HISTORY_LIMIT);
        write_json(&self.history_path(), &all)
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Write to a temp file, then rename, so a crash never leaves a half-written file.
fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Engine, Environment, ObjectKind};

    fn config(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: format!("conn {id}"),
            engine: Engine::Sqlite,
            environment: Environment::Local,
            host: None,
            port: None,
            user: None,
            database: None,
            tls: Default::default(),
            file_path: Some("/tmp/x.sqlite".into()),
            claude_access: None,
            project_folder: None,
        }
    }

    fn query(connection: &str, name: &str) -> SavedQuery {
        SavedQuery { id: String::new(), connection_id: connection.into(), name: name.into(), sql: "SELECT 1".into(), database: None, updated_at: chrono::Utc::now() }
    }

    #[test]
    fn saved_queries_per_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf(), SecretStore::file(dir.path().join("secrets.json"))).unwrap();
        store.save_connection(config("a")).unwrap();
        let q1 = store.save_query(query("a", " zeta ")).unwrap();
        assert!(!q1.id.is_empty());
        assert_eq!(q1.name, "zeta");
        store.save_query(query("a", "Alpha")).unwrap();
        store.save_query(query("b", "other")).unwrap();
        assert_eq!(store.saved_queries("a").unwrap().iter().map(|q| q.name.as_str()).collect::<Vec<_>>(), ["Alpha", "zeta"]);

        let mut renamed = q1.clone();
        renamed.name = "beta".into();
        renamed.sql = "SELECT 2".into();
        store.save_query(renamed).unwrap();
        let list = store.saved_queries("a").unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|q| q.id == q1.id && q.name == "beta" && q.sql == "SELECT 2"));

        assert!(store.save_query(query("a", "   ")).is_err(), "a name is required");
        store.delete_query(&q1.id).unwrap();
        assert_eq!(store.saved_queries("a").unwrap().len(), 1);

        // deleting the connection removes its queries, not the others
        store.delete_connection("a").unwrap();
        assert!(store.saved_queries("a").unwrap().is_empty());
        assert_eq!(store.saved_queries("b").unwrap().len(), 1);
    }

    #[test]
    fn saves_updates_and_deletes_connections_and_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf(), SecretStore::file(dir.path().join("secrets.json"))).unwrap();
        store.save_connection(config("a")).unwrap();
        store.save_connection(config("b")).unwrap();
        store.secrets.set("a", "pw").unwrap();
        let mut a = config("a");
        a.name = "renamed".into();
        store.save_connection(a).unwrap();
        assert_eq!(store.connections().unwrap().iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["renamed", "conn b"]);
        assert_eq!(store.secrets.get("a").unwrap().as_deref(), Some("pw"));
        store.delete_connection("a").unwrap();
        assert_eq!(store.connections().unwrap().len(), 1);
        assert_eq!(store.secrets.get("a").unwrap(), None);
        let text = std::fs::read_to_string(dir.path().join("connections.json")).unwrap();
        assert!(!text.contains("pw"), "password must never be in connections.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("secrets.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "secrets file must be readable only by the owner");
        }
    }

    #[test]
    fn schema_snapshots_keep_the_last_five_and_go_with_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf(), SecretStore::file(dir.path().join("secrets.json"))).unwrap();
        store.save_connection(config("a")).unwrap();
        let table = |name: &str| SchemaTable { name: name.into(), kind: ObjectKind::Table, columns: vec![], foreign_keys: vec![], row_estimate: None, comment: None, unique_keys: vec![] };
        for i in 0..7 {
            store.add_schema_snapshot("a", Some("shop/../x"), vec![table(&format!("t{i}"))]).unwrap();
        }
        let all = store.schema_snapshots("a", Some("shop/../x")).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].tables[0].name, "t2");
        assert_eq!(all[4].tables[0].name, "t6");
        assert!(store.schema_snapshots("a", Some("other")).unwrap().is_empty());
        // the database name never leaves the snapshot folder
        assert!(dir.path().join("schema-snapshots/a/shop____x.json").exists());
        store.delete_connection("a").unwrap();
        assert!(store.schema_snapshots("a", Some("shop/../x")).unwrap().is_empty());
    }

    #[test]
    fn virtual_keys_per_database_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf(), SecretStore::file(dir.path().join("secrets.json"))).unwrap();
        store.save_connection(config("a")).unwrap();
        let key = |table: &str| VirtualKey {
            id: String::new(),
            connection_id: "a".into(),
            database: Some("shop".into()),
            table: table.into(),
            columns: vec!["ds_person_id".into()],
            ref_table: "ds_person".into(),
            ref_columns: vec!["ds_person_id".into()],
        };
        let k1 = store.save_virtual_key(key("visits")).unwrap();
        // saving the same relation again keeps one
        let k2 = store.save_virtual_key(key("visits")).unwrap();
        assert_eq!(k1.id, k2.id);
        store.save_virtual_key(key("notes")).unwrap();
        assert_eq!(store.virtual_keys("a", Some("shop")).unwrap().len(), 2);
        assert!(store.virtual_keys("a", Some("other")).unwrap().is_empty());
        let mut bad = key("x");
        bad.ref_columns.clear();
        assert!(store.save_virtual_key(bad).is_err());
        store.delete_virtual_key(&k1.id).unwrap();
        assert_eq!(store.virtual_keys("a", Some("shop")).unwrap().len(), 1);
        store.delete_connection("a").unwrap();
        assert!(store.virtual_keys("a", Some("shop")).unwrap().is_empty());
    }
}
