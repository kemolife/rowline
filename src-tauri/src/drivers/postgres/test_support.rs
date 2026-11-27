//! Helpers shared by the Postgres tests (they need ROWLINE_TEST_POSTGRES).

use super::{PostgresParams, PostgresSession};
use crate::model::TlsMode;

pub(crate) struct Params {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
}

impl Params {
    pub fn as_params(&self, prod_lock: bool) -> PostgresParams<'_> {
        PostgresParams {
            host: &self.host,
            port: self.port,
            user: &self.user,
            password: Some(&self.password),
            database: Some(&self.database),
            tls: TlsMode::Off,
            prod_lock,
        }
    }
}

pub(crate) fn params() -> Option<Params> {
    let v = std::env::var("ROWLINE_TEST_POSTGRES").ok()?;
    let p: Vec<&str> = v.splitn(5, ':').collect();
    Some(Params { host: p[0].into(), port: p[1].parse().ok()?, user: p[2].into(), password: p[3].into(), database: p[4].into() })
}

/// A session as the test superuser on the `shop` database.
pub(crate) async fn session(prod_lock: bool) -> Option<PostgresSession> {
    let p = params()?;
    Some(PostgresSession::connect(p.as_params(prod_lock)).await.expect("connect"))
}

/// A session as `reader`, the non-superuser role of the init SQL (test-only password).
pub(crate) async fn reader_session() -> Option<PostgresSession> {
    let p = params()?;
    let reader = Params { user: "reader".into(), password: "reader_pw".into(), ..p };
    Some(PostgresSession::connect(reader.as_params(false)).await.expect("connect as reader"))
}
