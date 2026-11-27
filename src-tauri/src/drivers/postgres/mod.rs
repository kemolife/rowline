//! Postgres session: a small pool of clients per database, reconnect after sleep, and the transaction every
//! query runs in (prod lock, search_path, time zone). Queries are in `queries.rs`, catalog reads in
//! `schema.rs`, value conversion in `values.rs`.

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::sqlgen::Dialect;
use postgres_native_tls::MakeTlsConnector;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::config::SslMode;
use tokio_postgres::{CancelToken, Client, Config};

mod queries;
mod schema;
#[cfg(test)]
mod test_support;
mod values;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A client unused this long (wall-clock, sleep included) is pinged before use
const STALE_AFTER: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(5);
/// Clients per database
const POOL_SIZE: usize = 4;
/// The idle clients of a database unused this long are closed
const IDLE_POOL_CLOSE: Duration = Duration::from_secs(5 * 60);

/// A write refused by the READ ONLY transaction of a locked prod connection (SQLSTATE 25006).
pub const UNLOCK_MESSAGE: &str = "This prod connection is read-only. Use \"Unlock writes\" on this tab to change data.";
/// Claude, MCP and `udb` never run with a superuser login.
pub const SUPERUSER_MESSAGE: &str =
    "Claude and udb don't run as a Postgres superuser. Connect with a role that is not a superuser.";
/// Built-in roles that give access to the server's files or programs (a READ ONLY transaction does not stop them).
/// Claude, MCP and `udb` never run with a login that is a member of one.
pub const SERVER_FILE_ROLES: &[&str] = &["pg_read_server_files", "pg_write_server_files", "pg_execute_server_program"];

pub fn server_role_message(role: &str) -> String {
    format!("Claude and udb don't run as a member of the Postgres role {role}. Connect with a role that is not a member of it.")
}

pub struct PostgresParams<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: Option<&'a str>,
    /// Default database; `None` or empty = `postgres`
    pub database: Option<&'a str>,
    pub tls: TlsMode,
    /// Prod: every query runs in a READ ONLY transaction unless the call passes `unlocked: true`
    pub prod_lock: bool,
}

struct DbPool {
    idle: Vec<Client>,
    permits: Arc<Semaphore>,
    /// Wall-clock time of the last checkout. `Instant` does not count time spent asleep on macOS.
    last_used: SystemTime,
}

pub struct PostgresSession {
    /// Connection settings without the database name
    config: Config,
    tls: MakeTlsConnector,
    default_database: String,
    /// Prod connection: queries run READ ONLY unless the call is unlocked. Atomic: saving the
    /// connection with another environment changes it without a reconnect (see `set_prod_lock`).
    prod_lock: std::sync::atomic::AtomicBool,
    /// The Mac's IANA time zone, for `SET LOCAL TimeZone` (timestamptz is shown in local time)
    time_zone: Option<String>,
    /// database -> its clients. Pools are made on first use, so other databases stay usable side by side.
    pools: Mutex<HashMap<String, DbPool>>,
    /// liveness checks done (tests)
    pings: AtomicU64,
    next_query: AtomicU64,
    /// Running queries: id, the tab that started them, how to cancel them
    pub(super) running: Mutex<Vec<(u64, Option<String>, CancelToken)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn tls_connector(mode: TlsMode) -> AppResult<MakeTlsConnector> {
    let mut b = native_tls::TlsConnector::builder();
    if mode == TlsMode::Required {
        // encrypted, certificate not checked (private CAs such as AWS RDS), like MySQL "Required"
        b.danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true);
    }
    let connector = b.build().map_err(|e| AppError::msg(format!("TLS: {e}")))?;
    Ok(MakeTlsConnector::new(connector))
}

/// Only plain zone names go into `SET LOCAL TimeZone = '…'`.
fn local_time_zone() -> Option<String> {
    let tz = iana_time_zone::get_timezone().ok()?;
    let plain = !tz.is_empty() && tz.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'));
    plain.then_some(tz)
}

/// `tz` when the server knows that zone, else None. Asked outside a transaction (nothing to roll back).
async fn usable_time_zone(c: &Client, tz: Option<String>) -> Option<String> {
    let tz = tz?;
    c.query_one("SELECT now() AT TIME ZONE $1::text", &[&tz]).await.ok()?;
    Some(tz)
}

impl PostgresSession {
    pub async fn connect(p: PostgresParams<'_>) -> AppResult<Self> {
        Self::connect_with_zone(p, local_time_zone()).await
    }

    /// `connect` with the zone to show timestamptz in. A zone the server does not know is left out: with it,
    /// `SET LOCAL TimeZone` would make every query fail.
    async fn connect_with_zone(p: PostgresParams<'_>, time_zone: Option<String>) -> AppResult<Self> {
        let mut config = Config::new();
        config
            .host(p.host)
            .port(p.port)
            .user(p.user)
            .application_name("uDB")
            .connect_timeout(CONNECT_TIMEOUT)
            .keepalives(true)
            .ssl_mode(if p.tls == TlsMode::Off { SslMode::Disable } else { SslMode::Require });
        if let Some(pw) = p.password {
            config.password(pw);
        }
        let mut session = Self {
            config,
            tls: tls_connector(p.tls)?,
            default_database: p.database.filter(|d| !d.is_empty()).unwrap_or("postgres").to_string(),
            prod_lock: std::sync::atomic::AtomicBool::new(p.prod_lock),
            time_zone: None,
            pools: Mutex::new(HashMap::new()),
            pings: AtomicU64::new(0),
            next_query: AtomicU64::new(1),
            running: Mutex::new(Vec::new()),
        };
        // fail fast on wrong credentials / unreachable host
        let c = session.checkout(&session.default_database).await?;
        let time_zone = usable_time_zone(&c, time_zone).await;
        c.release();
        session.time_zone = time_zone;
        Ok(session)
    }

    fn db(&self, database: Option<&str>) -> String {
        database.filter(|d| !d.is_empty()).unwrap_or(&self.default_database).to_string()
    }

    /// Writes refused unless the call is unlocked (prod connections).
    pub(super) fn locked(&self, unlocked: bool) -> bool {
        self.prod_lock.load(std::sync::atomic::Ordering::SeqCst) && !unlocked
    }

    /// Turns the prod lock on or off for the next queries (the connection's environment changed).
    pub fn set_prod_lock(&self, on: bool) {
        self.prod_lock.store(on, std::sync::atomic::Ordering::SeqCst);
    }

    async fn connect_client(&self, database: &str) -> AppResult<Client> {
        let mut cfg = self.config.clone();
        cfg.dbname(database);
        let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT + Duration::from_secs(1), cfg.connect(self.tls.clone()))
            .await
            .map_err(|_| AppError::Timeout(format!("could not connect within {} s", CONNECT_TIMEOUT.as_secs())))?
            .map_err(connect_error)?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(client)
    }

    /// A client of `database`, at most `POOL_SIZE` at a time per database. After a pause (e.g. laptop sleep)
    /// idle clients can be dead without anyone noticing: after `STALE_AFTER` of wall-clock time the client is
    /// pinged first, and if that fails all idle clients of that database are dropped and a fresh one is made.
    async fn checkout(&self, database: &str) -> AppResult<Pooled<'_>> {
        let now = SystemTime::now();
        let (permits, stale) = {
            let mut pools = lock(&self.pools);
            pools.retain(|name, p| {
                let idle_for = now.duration_since(p.last_used).unwrap_or_default();
                if name != database && idle_for > IDLE_POOL_CLOSE {
                    p.idle.clear();
                    // keep the entry while one of its clients is still checked out
                    return p.permits.available_permits() < POOL_SIZE;
                }
                true
            });
            let p = pools.entry(database.to_string()).or_insert_with(|| DbPool {
                idle: Vec::new(),
                permits: Arc::new(Semaphore::new(POOL_SIZE)),
                last_used: now,
            });
            let idle_for = now.duration_since(p.last_used).unwrap_or_default();
            if idle_for > IDLE_POOL_CLOSE {
                p.idle.clear();
            }
            p.last_used = now;
            (p.permits.clone(), idle_for > STALE_AFTER)
        };
        let permit = permits.acquire_owned().await.map_err(|_| AppError::msg("The connection was closed"))?;
        let reused = {
            let mut pools = lock(&self.pools);
            let mut found = None;
            if let Some(p) = pools.get_mut(database) {
                while let Some(c) = p.idle.pop() {
                    if !c.is_closed() {
                        found = Some(c);
                        break;
                    }
                }
            }
            found
        };
        let client = match reused {
            Some(c) if stale => {
                self.pings.fetch_add(1, Ordering::SeqCst);
                if matches!(tokio::time::timeout(PING_TIMEOUT, c.simple_query("")).await, Ok(Ok(_))) {
                    c
                } else {
                    drop(c);
                    // its idle siblings are just as dead
                    if let Some(p) = lock(&self.pools).get_mut(database) {
                        p.idle.clear();
                    }
                    self.connect_client(database).await?
                }
            }
            Some(c) => c,
            None => self.connect_client(database).await?,
        };
        Ok(Pooled { client: Some(client), session: self, database: database.to_string(), clean: false, _permit: permit })
    }

    #[cfg(test)]
    fn pretend_idle_since(&self, t: SystemTime) {
        for p in lock(&self.pools).values_mut() {
            p.last_used = t;
        }
    }

    /// Starts the transaction a query runs in: `BEGIN` or `BEGIN READ ONLY`, `search_path` = `"<schema>", public`,
    /// the local time zone, standard_conforming_strings and fixed output formats. Every setting is `SET LOCAL` (PgBouncer transaction mode).
    pub(super) async fn begin(&self, database: Option<&str>, schema: Option<&str>, access: Access) -> AppResult<Tx<'_>> {
        let c = self.checkout(&self.db(database)).await?;
        c.batch_execute(&begin_sql(schema, self.time_zone.as_deref(), access)).await?;
        Ok(Tx { c, commit: access == Access::ReadWrite })
    }

    pub async fn close(self) {
        lock(&self.pools).clear();
    }
}

/// The SQL that starts a transaction (see `PostgresSession::begin`).
fn begin_sql(schema: Option<&str>, time_zone: Option<&str>, access: Access) -> String {
    let read_only = access != Access::ReadWrite;
    let mut sql = String::from(if read_only { "BEGIN READ ONLY" } else { "BEGIN" });
    if let Some(s) = schema.filter(|s| !s.is_empty()) {
        sql.push_str(&format!("; SET LOCAL search_path = {}, public", Dialect::Postgres.quote_ident(s)));
    }
    if let Some(tz) = time_zone {
        sql.push_str(&format!("; SET LOCAL TimeZone = '{tz}'"));
    }
    // every transaction: '…' strings read as the checker and the splitter read them (no backslash escapes)
    sql.push_str("; SET LOCAL bytea_output = 'hex'; SET LOCAL DateStyle = 'ISO, MDY'; SET LOCAL IntervalStyle = 'postgres'; SET LOCAL standard_conforming_strings = on");
    if access == Access::Guarded {
        sql.push_str(&format!("; SET LOCAL statement_timeout = {}", crate::readonly::TIMEOUT.as_millis()));
    }
    if read_only {
        // takes the first snapshot: from here on the transaction can't be switched to read-write
        // (`SET transaction_read_only = off` is refused after the first query)
        sql.push_str("; SELECT 1");
    }
    sql
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    ReadWrite,
    /// Server-side READ ONLY transaction, rolled back at the end
    ReadOnly,
    /// Claude, MCP, `udb`: READ ONLY plus statement_timeout
    Guarded,
}

/// A client checked out of a pool. It goes back to the pool only when marked clean (the transaction ended
/// normally); otherwise it is closed, and the server rolls back whatever was left open.
pub(super) struct Pooled<'a> {
    client: Option<Client>,
    session: &'a PostgresSession,
    database: String,
    clean: bool,
    _permit: OwnedSemaphorePermit,
}

impl Pooled<'_> {
    /// Back to the pool as it is (no transaction was started).
    fn release(mut self) {
        self.clean = true;
    }
}

impl std::ops::Deref for Pooled<'_> {
    type Target = Client;
    fn deref(&self) -> &Client {
        self.client.as_ref().expect("client present until drop")
    }
}

impl Drop for Pooled<'_> {
    fn drop(&mut self) {
        let Some(c) = self.client.take() else { return };
        if !self.clean || c.is_closed() {
            return;
        }
        if let Some(p) = lock(&self.session.pools).get_mut(&self.database) {
            p.idle.push(c);
        }
    }
}

/// The transaction of one call. Dropped without `finish` (error in `begin`, future dropped half way), the
/// client is closed instead of being reused.
pub(super) struct Tx<'a> {
    pub(super) c: Pooled<'a>,
    commit: bool,
}

/// Puts back what SQL from the user (scripts, grid filters) may have changed for the whole session: SET ROLE,
/// set_config(…, false), search_path, LISTEN, advisory locks, temp tables… so it never reaches the next query
/// on this pooled client (Claude's read-only queries included). DISCARD ALL without DEALLOCATE ALL, which
/// would drop the driver's own prepared statements.
const RESET_SESSION: &str = "CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; UNLISTEN *; \
     SELECT pg_advisory_unlock_all(); DISCARD PLANS; DISCARD SEQUENCES; DISCARD TEMP";

impl Tx<'_> {
    /// Ends the transaction: COMMIT when `res` is Ok and the transaction may write, else ROLLBACK.
    pub(super) async fn finish<T>(self, res: AppResult<T>) -> AppResult<T> {
        self.end(res, true).await
    }

    /// Ends the transaction (COMMIT only when `commit`, `res` is Ok and it may write), then resets the session.
    /// The client goes back to the pool only when both worked.
    pub(super) async fn end<T>(mut self, res: AppResult<T>, commit: bool) -> AppResult<T> {
        if self.commit && commit && res.is_ok() {
            // COMMIT alone first: its error is the result, a reset error after it is not
            self.c.batch_execute("COMMIT").await?;
            if self.c.batch_execute(RESET_SESSION).await.is_ok() {
                self.c.clean = true;
            }
            return res;
        }
        if self.c.batch_execute(&format!("ROLLBACK; {RESET_SESSION}")).await.is_ok() {
            self.c.clean = true;
        }
        res
    }
}

/// Connection errors with a hint the user can act on.
fn connect_error(e: tokio_postgres::Error) -> AppError {
    let needs_tls = e
        .as_db_error()
        .is_some_and(|d| d.code().code() == "28000" && d.message().contains("no encryption"));
    if needs_tls {
        return AppError::msg("This server only accepts encrypted connections. Edit the connection and set TLS to \"Required\".");
    }
    AppError::from(e)
}

#[cfg(test)]
mod tests {
    //! Run with a Postgres server: ROWLINE_TEST_POSTGRES="host:port:user:password:database"
    use super::test_support::*;
    use super::*;

    /// TCP proxy to the test server. `freeze()` turns every connection open at that moment into a silent
    /// black hole, like a connection that died while the laptop slept. Later connections work normally.
    async fn sleepy_proxy(target: (String, u16)) -> (u16, Arc<tokio::sync::watch::Sender<u64>>) {
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
                    while *freeze.borrow() == born_in {
                        if freeze.changed().await.is_err() {
                            return;
                        }
                    }
                    up.abort();
                    down.abort();
                });
            }
        });
        (port, Arc::new(freeze_tx))
    }

    #[tokio::test]
    async fn reconnects_after_the_pooled_connection_died_silently() {
        let Some(p) = params() else { return };
        let (proxy_port, freeze) = sleepy_proxy((p.host.clone(), p.port)).await;
        let s = PostgresSession::connect(PostgresParams { port: proxy_port, ..p.as_params(false) }).await.expect("connect through the proxy");
        assert_eq!(s.execute(None, None, "SELECT 1", 1, false).await.unwrap()[0].rows[0][0], 1);
        freeze.send_modify(|n| *n += 1); // the laptop sleeps
        s.pretend_idle_since(SystemTime::now() - Duration::from_secs(60));
        let res = tokio::time::timeout(Duration::from_secs(20), s.execute(None, None, "SELECT 2", 1, false))
            .await
            .expect("must not hang")
            .expect("must reconnect instead of failing");
        assert_eq!(res[0].rows[0][0], 2);
        assert_eq!(s.pings.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn recently_used_clients_are_not_pinged() {
        let Some(s) = session(false).await else { return };
        s.execute(None, None, "SELECT 1", 1, false).await.unwrap();
        s.execute(None, None, "SELECT 1", 1, false).await.unwrap();
        assert_eq!(s.pings.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn wrong_password_fails_with_the_sqlstate() {
        let Some(p) = params() else { return };
        let r = PostgresSession::connect(PostgresParams { password: Some("wrong"), ..p.as_params(false) }).await;
        let err = r.err().expect("must fail").to_string();
        assert!(err.starts_with("ERROR 28P01: "), "{err}");
    }

    #[tokio::test]
    async fn tls_required_on_a_server_without_tls_fails() {
        let Some(p) = params() else { return };
        let r = PostgresSession::connect(PostgresParams { tls: TlsMode::Required, ..p.as_params(false) }).await;
        assert!(r.is_err(), "the test server has no TLS: an encrypted connection can't be made");
    }

    #[tokio::test]
    async fn at_most_four_clients_per_database() {
        let Some(s) = session(false).await else { return };
        let mut held = Vec::new();
        for _ in 0..POOL_SIZE {
            held.push(s.checkout("shop").await.unwrap());
        }
        assert!(tokio::time::timeout(Duration::from_millis(300), s.checkout("shop")).await.is_err(), "a fifth client must wait");
        held.pop();
        assert!(tokio::time::timeout(Duration::from_secs(5), s.checkout("shop")).await.is_ok());
    }

    #[tokio::test]
    async fn idle_pools_of_other_databases_are_closed() {
        let Some(s) = session(false).await else { return };
        s.execute(Some("postgres"), None, "SELECT 1", 1, false).await.unwrap();
        assert!(lock(&s.pools).contains_key("postgres"));
        s.pretend_idle_since(SystemTime::now() - IDLE_POOL_CLOSE - Duration::from_secs(1));
        s.execute(None, None, "SELECT 1", 1, false).await.unwrap();
        assert!(!lock(&s.pools).contains_key("postgres"));
    }

    #[tokio::test]
    async fn a_time_zone_the_server_does_not_know_is_not_set() {
        let Some(p) = params() else { return };
        // with `SET LOCAL TimeZone = '<unknown>'` in begin() every query failed (22023)
        let s = PostgresSession::connect_with_zone(p.as_params(false), Some("Mars/Olympus_Mons".into())).await.unwrap();
        assert_eq!(s.time_zone, None);
        assert_eq!(s.execute(None, None, "SELECT 1", 1, false).await.unwrap()[0].rows[0][0], 1);
        let s = PostgresSession::connect_with_zone(p.as_params(false), Some("America/New_York".into())).await.unwrap();
        assert_eq!(s.time_zone.as_deref(), Some("America/New_York"));
        let r = s.execute(None, None, "SHOW TimeZone", 1, false).await.unwrap();
        assert_eq!(r[0].rows[0][0], "America/New_York");
    }

    #[test]
    fn every_transaction_has_standard_conforming_strings() {
        // the checker and the splitter read '…' with backslash escapes off: the server must too
        for access in [Access::ReadWrite, Access::ReadOnly, Access::Guarded] {
            let sql = begin_sql(Some("billing"), Some("UTC"), access);
            assert!(sql.contains("SET LOCAL standard_conforming_strings = on"), "{access:?}: {sql}");
        }
        assert!(begin_sql(None, None, Access::Guarded).contains("statement_timeout"));
        assert!(!begin_sql(None, None, Access::ReadWrite).contains("statement_timeout"));
        assert!(begin_sql(None, None, Access::ReadOnly).starts_with("BEGIN READ ONLY"));
    }

    #[test]
    fn time_zone_is_a_plain_name() {
        if let Some(tz) = local_time_zone() {
            assert!(!tz.contains('\''));
        }
    }
}
