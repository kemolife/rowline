//! Which tab started a query. Commands run the work inside `scope(owner, …)`; the drivers read `current()`
//! when they register a running query, so Cancel in one tab stops only that tab's queries.

use std::future::Future;

tokio::task_local! {
    static OWNER: Option<String>;
}

/// Runs `fut` with `owner` as the owner of every query it starts.
pub async fn scope<F: Future>(owner: Option<String>, fut: F) -> F::Output {
    OWNER.scope(owner, fut).await
}

/// The owner of the current task, if any.
pub fn current() -> Option<String> {
    OWNER.try_with(|o| o.clone()).ok().flatten()
}
