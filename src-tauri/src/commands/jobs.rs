//! Backup and restore jobs (they run in the background; the frontend polls their status).

use super::{AppState, ok, parse};
use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::{Value, json};
use crate::manager::Session;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupArgs {
    id: String,
    database: Option<String>,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobArgs {
    job_id: String,
}

pub(super) const COMMANDS: &[&str] = &["backup_start", "restore_start", "job_status", "job_cancel"];

pub(super) async fn run(state: &AppState, command: &str, args: Value) -> AppResult<Value> {
    match command {
        "backup_start" | "restore_start" => {
            let a: BackupArgs = parse(args)?;
            let session = state.manager.get(&a.id).await?;
            let restore = command == "restore_start";
            let database = match &*session {
                Session::Mysql(_) => Some(a.database.filter(|d| !d.is_empty()).ok_or_else(|| AppError::msg("Select a database first."))?),
                Session::Sqlite(_) => None,
            };
            let label = if restore { "Restoring" } else { "Backing up" };
            let job_id = state.jobs.spawn(label, move |job| async move {
                match (&*session, restore) {
                    (Session::Mysql(s), false) => crate::drivers::mysql::backup::backup(s, database.as_deref().unwrap_or_default(), &a.path, None, &job).await,
                    (Session::Mysql(s), true) => crate::drivers::mysql::backup::restore(s, database.as_deref().unwrap_or_default(), &a.path, &job).await,
                    (Session::Sqlite(s), false) => s.backup_to(a.path.clone(), job.clone()).await,
                    (Session::Sqlite(s), true) => s.restore_from(a.path.clone(), job.clone()).await,
                }
            });
            ok(json!({ "jobId": job_id }))
        }
        "job_status" => {
            let a: JobArgs = parse(args)?;
            ok(state.jobs.status(&a.job_id)?)
        }
        "job_cancel" => {
            let a: JobArgs = parse(args)?;
            state.jobs.cancel(&a.job_id)?;
            ok(true)
        }
        other => Err(super::unknown(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;

    #[tokio::test]
    async fn backup_and_restore_jobs_through_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let (state, id) = sqlite_state(dir.path()).await;
        dispatch(&state, "execute_sql", json!({ "id": id, "sql": "INSERT INTO t (id) VALUES (1), (2)" })).await.unwrap();
        let file = dir.path().join("backup.sqlite");
        let wait = |job: String| {
            let state = state.clone();
            async move {
                for _ in 0..100 {
                    let st = dispatch(&state, "job_status", json!({ "jobId": job })).await.unwrap();
                    if st["finished"] == true {
                        return st;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                panic!("job did not finish");
            }
        };
        let job = dispatch(&state, "backup_start", json!({ "id": id, "path": file })).await.unwrap()["jobId"].as_str().unwrap().to_string();
        assert_eq!(wait(job).await["error"], Value::Null);
        assert!(file.exists());
        dispatch(&state, "execute_sql", json!({ "id": id, "sql": "DELETE FROM t" })).await.unwrap();
        let job = dispatch(&state, "restore_start", json!({ "id": id, "path": file })).await.unwrap()["jobId"].as_str().unwrap().to_string();
        assert_eq!(wait(job).await["error"], Value::Null);
        let n = dispatch(&state, "execute_sql", json!({ "id": id, "sql": "SELECT count(*) FROM t" })).await.unwrap();
        assert_eq!(n[0]["rows"][0][0], 2);
    }
}
