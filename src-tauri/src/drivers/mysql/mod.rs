//! MySQL session: connection pool, reconnect after sleep, connection errors.
//! Queries are in `queries.rs`, value conversion in `values.rs`, backup/restore in `backup.rs`.

use crate::error::{AppError, AppResult};
use crate::model::*;
use mysql_async::prelude::*;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, SslOpts};
use std::sync::Mutex;
use std::time::Duration;

pub mod backup;
mod queries;
mod schema;
mod values;
#[cfg(test)]
mod test_support;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A connection unused this long (wall-clock, sleep included) is pinged before use
const STALE_AFTER: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(5);

pub struct MysqlSession {
    /// Replaced by a fresh pool when its idle connections turn out to be dead (e.g. after laptop sleep)
    pool: std::sync::RwLock<Pool>,
    opts: Opts,
    /// Wall-clock time of the last checkout. `Instant` does not count time spent asleep on macOS.
    last_used: Mutex<std::time::SystemTime>,
    /// liveness checks done (tests)
    pings: std::sync::atomic::AtomicU64,
    default_database: Option<String>,
    /// Server thread ids of queries currently running from the SQL editor / grid
    running: Mutex<Vec<u32>>,
}

pub struct MysqlParams<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: Option<&'a str>,
    pub database: Option<&'a str>,
    pub tls: TlsMode,
}

impl MysqlSession {
    pub async fn connect(p: MysqlParams<'_>) -> AppResult<Self> {
        let opts = OptsBuilder::default()
            .ip_or_hostname(p.host)
            .tcp_port(p.port)
            .user(Some(p.user))
            .pass(p.password)
            .db_name(p.database.filter(|d| !d.is_empty()))
            .prefer_socket(false)
            .wait_timeout(Some(28_800))
            .ssl_opts(match p.tls {
                TlsMode::Off => None,
                TlsMode::Required => Some(
                    SslOpts::default()
                        .with_danger_accept_invalid_certs(true)
                        .with_danger_skip_domain_validation(true),
                ),
                TlsMode::Verify => Some(SslOpts::default()),
            });
        let opts = Opts::from(opts);
        let session = Self {
            pool: std::sync::RwLock::new(Pool::new(opts.clone())),
            opts,
            last_used: Mutex::new(std::time::SystemTime::now()),
            pings: std::sync::atomic::AtomicU64::new(0),
            default_database: p.database.filter(|d| !d.is_empty()).map(str::to_string),
            running: Mutex::new(Vec::new()),
        };
        // fail fast on wrong credentials / unreachable host
        let conn = session.conn().await?;
        drop(conn);
        Ok(session)
    }

    fn pool(&self) -> Pool {
        self.pool.read().map(|p| p.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }

    async fn checkout(pool: &Pool) -> AppResult<Conn> {
        tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn())
            .await
            .map_err(|_| AppError::Timeout(format!("could not connect within {} s", CONNECT_TIMEOUT.as_secs())))?
            .map_err(connect_error)
    }

    /// A pooled connection. After a pause (e.g. laptop sleep) idle connections can be dead without the pool
    /// noticing: the network dropped them silently, so the first query would fail with "connection reset".
    /// After `STALE_AFTER` of wall-clock time we ping first; if that fails, the whole pool is replaced
    /// (its other idle connections are just as dead) and a fresh connection is made.
    async fn conn(&self) -> AppResult<Conn> {
        let now = std::time::SystemTime::now();
        let idle = self.last_used.lock().ok().and_then(|t| now.duration_since(*t).ok()).unwrap_or_default();
        let pool = self.pool();
        let mut c = Self::checkout(&pool).await?;
        if idle > STALE_AFTER {
            self.pings.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let alive = matches!(tokio::time::timeout(PING_TIMEOUT, c.ping()).await, Ok(Ok(())));
            if !alive {
                drop(c);
                let fresh = Pool::new(self.opts.clone());
                let old = match self.pool.write() {
                    Ok(mut p) => std::mem::replace(&mut *p, fresh.clone()),
                    Err(p) => std::mem::replace(&mut *p.into_inner(), fresh.clone()),
                };
                tokio::spawn(async move {
                    let _ = old.disconnect().await;
                });
                c = Self::checkout(&fresh).await?;
            }
        }
        if let Ok(mut t) = self.last_used.lock() {
            *t = std::time::SystemTime::now();
        }
        Ok(c)
    }

    /// A connection of its own (backup / restore keep it for a long time).
    pub(crate) async fn dedicated_conn(&self) -> AppResult<Conn> {
        self.conn().await
    }

    #[cfg(test)]
    fn pretend_idle_since(&self, t: std::time::SystemTime) {
        *self.last_used.lock().unwrap() = t;
    }

    fn db<'a>(&'a self, database: Option<&'a str>) -> Option<&'a str> {
        database.filter(|d| !d.is_empty()).or(self.default_database.as_deref())
    }

    fn require_db<'a>(&'a self, database: Option<&'a str>) -> AppResult<&'a str> {
        self.db(database).ok_or_else(|| AppError::msg("No database selected"))
    }


    pub async fn close(self) {
        let _ = self.pool().disconnect().await;
    }
}

const ER_SECURE_TRANSPORT_REQUIRED: u16 = 3159;

/// Connection errors with a hint the user can act on.
fn connect_error(e: mysql_async::Error) -> AppError {
    match &e {
        mysql_async::Error::Server(se) if se.code == ER_SECURE_TRANSPORT_REQUIRED => AppError::msg(
            "This server only accepts encrypted connections. Edit the connection and set TLS to \"Required\".",
        ),
        _ => AppError::from(e),
    }
}

pub(crate) fn group_columns(rows: Vec<(String, String)>) -> Vec<(String, Vec<String>)> {
    let mut res: Vec<(String, Vec<String>)> = Vec::new();
    for (table, column) in rows {
        match res.last_mut() {
            Some((t, cols)) if *t == table => cols.push(column),
            _ => res.push((table, vec![column])),
        }
    }
    res
}

#[cfg(test)]
mod tests {
    //! Run with a MySQL server: ROWLINE_TEST_MYSQL="host:port:user:password:database"
    use super::*;
    use super::test_support::*;

    /// TCP proxy to the test server. `freeze()` turns every connection open at that moment into a silent
    /// black hole (no FIN, nothing forwarded; closed only when the client writes), like a connection that
    /// died while the laptop slept. Connections made after `freeze()` work normally.
    async fn sleepy_proxy(target: (String, u16)) -> (u16, std::sync::Arc<tokio::sync::watch::Sender<u64>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (freeze_tx, freeze_rx) = tokio::sync::watch::channel(0u64);
        tokio::spawn(async move {
            loop {
                let Ok((client, _)) = listener.accept().await else { return };
                let target = target.clone();
                let mut freeze = freeze_rx.clone();
                let born_in = *freeze.borrow();
                tokio::spawn(async move {
                    let Ok(server) = tokio::net::TcpStream::connect(target).await else { return };
                    let (mut cr, mut cw) = client.into_split();
                    let (mut sr, mut sw) = server.into_split();
                    let up = tokio::spawn(async move { tokio::io::copy(&mut cr, &mut sw).await });
                    let down = tokio::spawn(async move { tokio::io::copy(&mut sr, &mut cw).await });
                    // wait until a freeze happens after this connection was made
                    while *freeze.borrow() == born_in {
                        if freeze.changed().await.is_err() {
                            return;
                        }
                    }
                    // stop forwarding without closing anything: the client sees a silent connection, and
                    // its next write goes nowhere and the socket is then reset
                    up.abort();
                    down.abort();
                });
            }
        });
        (port, std::sync::Arc::new(freeze_tx))
    }

    /// Laptop sleep: the pooled connection died silently while the app was asleep.
    #[tokio::test]
    async fn reconnects_after_the_pooled_connection_died_silently() {
        let Some((host, port, user, password, db)) = params() else { return };
        let (proxy_port, freeze) = sleepy_proxy((host, port)).await;
        let s = MysqlSession::connect(MysqlParams { host: "127.0.0.1", port: proxy_port, user: &user, password: Some(&password), database: Some(&db), tls: TlsMode::Off })
            .await
            .expect("connect through the proxy");
        assert_eq!(s.execute(Some(&db), "SELECT 1", 1).await.unwrap()[0].rows[0][0], 1);
        freeze.send_modify(|n| *n += 1); // the laptop sleeps
        s.pretend_idle_since(std::time::SystemTime::now() - std::time::Duration::from_secs(3600));
        let res = tokio::time::timeout(std::time::Duration::from_secs(20), s.execute(Some(&db), "SELECT 2", 1))
            .await
            .expect("must not hang")
            .expect("must reconnect instead of failing");
        assert_eq!(res[0].rows[0][0], 2);
    }

    /// A short pause (no sleep): no extra round trip before the query.
    #[tokio::test]
    async fn recently_used_connections_are_not_pinged() {
        let Some((s, db)) = session().await else { return };
        s.execute(Some(&db), "SELECT 1", 1).await.unwrap();
        let before = s.pings.load(std::sync::atomic::Ordering::SeqCst);
        s.execute(Some(&db), "SELECT 1", 1).await.unwrap();
        assert_eq!(s.pings.load(std::sync::atomic::Ordering::SeqCst), before);
    }

    #[test]
    fn secure_transport_error_explains_the_fix() {
        let e = mysql_async::Error::Server(mysql_async::ServerError {
            code: 3159,
            message: "Connections using insecure transport are prohibited while --require_secure_transport=ON.".into(),
            state: "HY000".into(),
        });
        assert!(connect_error(e).to_string().contains("set TLS to \"Required\""));
        let other = mysql_async::Error::Server(mysql_async::ServerError { code: 1045, message: "Access denied".into(), state: "28000".into() });
        assert!(connect_error(other).to_string().contains("Access denied"));
    }

    #[tokio::test]
    async fn wrong_password_fails_fast() {
        let Some((host, port, user, _, db)) = params() else { return };
        let r = MysqlSession::connect(MysqlParams { host: &host, port, user: &user, password: Some("wrong"), database: Some(&db), tls: TlsMode::Off }).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn tls_required_encrypts_and_verify_rejects_self_signed() {
        let Some((host, port, user, password, db)) = params() else { return };
        let s = MysqlSession::connect(MysqlParams { host: &host, port, user: &user, password: Some(&password), database: Some(&db), tls: TlsMode::Required })
            .await
            .expect("TLS required should connect to a server with a self-signed certificate");
        let r = s.execute(None, "SHOW SESSION STATUS LIKE 'Ssl_cipher'", 1).await.unwrap();
        let cipher = r[0].rows[0][1].as_str().unwrap_or_default().to_string();
        assert!(!cipher.is_empty(), "session must be encrypted");

        let verify = MysqlSession::connect(MysqlParams { host: &host, port, user: &user, password: Some(&password), database: Some(&db), tls: TlsMode::Verify }).await;
        assert!(verify.is_err(), "self-signed certificate must not pass verification");
    }
}
