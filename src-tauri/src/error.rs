use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("Connection not found or closed: {0}")]
    NotConnected(String),
    #[error("{}", mysql_text(.0))]
    Mysql(#[from] mysql_async::Error),
    #[error("{}", postgres_text(.0))]
    Postgres(#[from] tokio_postgres::Error),
    #[error("SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Timeout: {0}")]
    Timeout(String),
}

/// A server error as MySQL itself prints it ("ERROR 1054 (42S22): Unknown column …"); other driver errors keep a "MySQL:" prefix.
fn mysql_text(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => format!("ERROR {} ({}): {}", s.code, s.state, s.message),
        other => format!("MySQL: {other}"),
    }
}

/// A server error as `ERROR <SQLSTATE>: message` with DETAIL / HINT lines (Postgres has no numeric code);
/// other driver errors keep a "PostgreSQL:" prefix.
fn postgres_text(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => postgres_server_text(db.code().code(), db.message(), db.detail(), db.hint()),
        None => format!("PostgreSQL: {e}"),
    }
}

fn postgres_server_text(code: &str, message: &str, detail: Option<&str>, hint: Option<&str>) -> String {
    let mut text = format!("ERROR {code}: {message}");
    if let Some(d) = detail.filter(|d| !d.is_empty()) {
        text.push_str(&format!("\nDETAIL: {d}"));
    }
    if let Some(h) = hint.filter(|h| !h.is_empty()) {
        text.push_str(&format!("\nHINT: {h}"));
    }
    text
}

impl AppError {
    /// SQLSTATE of a Postgres server error.
    pub fn postgres_code(&self) -> Option<&str> {
        match self {
            AppError::Postgres(e) => e.as_db_error().map(|d| d.code().code()),
            _ => None,
        }
    }


    pub fn msg(text: impl Into<String>) -> Self {
        AppError::Message(text.into())
    }
}

/// Errors reach the UI as `{ "message": "..." }`.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 1)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_server_errors_read_like_the_mysql_client() {
        let e = AppError::from(mysql_async::Error::Server(mysql_async::ServerError {
            code: 1054,
            message: "Unknown column 'i.ds_monitoring_info_id' in 'field list'".into(),
            state: "42S22".into(),
        }));
        assert_eq!(e.to_string(), "ERROR 1054 (42S22): Unknown column 'i.ds_monitoring_info_id' in 'field list'");
    }

    #[test]
    fn postgres_server_errors_have_sqlstate_detail_and_hint() {
        assert_eq!(postgres_server_text("42P01", "relation \"x\" does not exist", None, None), "ERROR 42P01: relation \"x\" does not exist");
        assert_eq!(
            postgres_server_text("23505", "duplicate key value", Some("Key (id)=(1) already exists."), Some("Try another id.")),
            "ERROR 23505: duplicate key value\nDETAIL: Key (id)=(1) already exists.\nHINT: Try another id."
        );
    }
}
