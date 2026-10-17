//! Helpers shared by the MySQL tests (they need ROWLINE_TEST_MYSQL).

use super::{MysqlParams, MysqlSession};
use crate::model::TlsMode;

pub(crate) fn params() -> Option<(String, u16, String, String, String)> {
    let v = std::env::var("ROWLINE_TEST_MYSQL").ok()?;
    let p: Vec<&str> = v.splitn(5, ':').collect();
    Some((p[0].into(), p[1].parse().ok()?, p[2].into(), p[3].into(), p[4].into()))
}

pub(crate) async fn session() -> Option<(MysqlSession, String)> {
    let (host, port, user, password, db) = params()?;
    let s = MysqlSession::connect(MysqlParams { host: &host, port, user: &user, password: Some(&password), database: Some(&db), tls: TlsMode::Off })
        .await
        .expect("connect");
    Some((s, db))
}
