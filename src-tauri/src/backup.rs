//! Backup and restore jobs: run in the background, report progress, can be cancelled.
//! MySQL: a plain .sql file written by Rowline itself (no mysqldump). SQLite: SQLite's own online backup.

use crate::error::{AppError, AppResult};
use crate::sqlgen;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// One running (or finished) backup or restore
#[derive(Default)]
pub struct Job {
    label: Mutex<String>,
    done: AtomicU64,
    total: AtomicU64,
    finished: AtomicBool,
    error: Mutex<Option<String>>,
    cancel: AtomicBool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub label: String,
    pub done: u64,
    pub total: u64,
    pub finished: bool,
    pub error: Option<String>,
}

impl Job {
    pub fn set_label(&self, label: impl Into<String>) {
        if let Ok(mut l) = self.label.lock() {
            *l = label.into();
        }
    }

    pub fn set_total(&self, total: u64) {
        self.total.store(total, Ordering::SeqCst);
    }

    pub fn set_done(&self, done: u64) {
        self.done.store(done, Ordering::SeqCst);
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Err when the user pressed Cancel; call it between steps.
    pub fn check(&self) -> AppResult<()> {
        if self.cancelled() { Err(AppError::msg("Cancelled.")) } else { Ok(()) }
    }

    fn finish(&self, result: AppResult<()>) {
        if let (Err(e), Ok(mut slot)) = (result, self.error.lock()) {
            *slot = Some(e.to_string());
        }
        self.finished.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub fn cancel_for_test(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn status(&self) -> JobStatus {
        JobStatus {
            label: self.label.lock().map(|l| l.clone()).unwrap_or_default(),
            done: self.done.load(Ordering::SeqCst),
            total: self.total.load(Ordering::SeqCst),
            finished: self.finished.load(Ordering::SeqCst),
            error: self.error.lock().ok().and_then(|e| e.clone()),
        }
    }
}

#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Jobs {
    /// Starts `work` in the background and returns the job id.
    pub fn spawn<F>(&self, label: &str, work: impl FnOnce(Arc<Job>) -> F) -> String
    where
        F: std::future::Future<Output = AppResult<()>> + Send + 'static,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(Job::default());
        job.set_label(label);
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(id.clone(), job.clone());
        }
        let fut = work(job.clone());
        tokio::spawn(async move {
            let res = fut.await;
            job.finish(res);
        });
        id
    }

    fn get(&self, id: &str) -> AppResult<Arc<Job>> {
        self.jobs.lock().ok().and_then(|j| j.get(id).cloned()).ok_or_else(|| AppError::msg(format!("Unknown job: {id}")))
    }

    /// Status; a finished job is forgotten once its final status was read.
    pub fn status(&self, id: &str) -> AppResult<JobStatus> {
        let status = self.get(id)?.status();
        if status.finished {
            if let Ok(mut jobs) = self.jobs.lock() {
                jobs.remove(id);
            }
        }
        Ok(status)
    }

    pub fn cancel(&self, id: &str) -> AppResult<()> {
        self.get(id)?.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Splits a .sql script into statements, honouring `DELIMITER` lines (used around triggers and
/// routines, like mysqldump does). Comment-only parts are dropped.
pub fn split_script(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut delimiter = ";".to_string();
    let mut chunk = String::new();
    let flush = |chunk: &mut String, delimiter: &str, out: &mut Vec<String>| {
        if delimiter == ";" {
            out.extend(sqlgen::split_statements(chunk).into_iter().map(|s| s.text));
        } else {
            out.extend(chunk.split(delimiter).map(str::trim).filter(|s| !s.is_empty() && !s.starts_with("--")).map(str::to_string));
        }
        chunk.clear();
    };
    for line in sql.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.len() > 10 && trimmed[..10].eq_ignore_ascii_case("delimiter ") {
            flush(&mut chunk, &delimiter, &mut out);
            delimiter = trimmed[10..].trim().to_string();
            continue;
        }
        chunk.push_str(line);
    }
    flush(&mut chunk, &delimiter, &mut out);
    out
}

/// Writes to `<path>.part` and renames on success, so a cancelled or failed backup leaves no half file.
pub struct AtomicFile {
    path: std::path::PathBuf,
    tmp: std::path::PathBuf,
    pub writer: std::io::BufWriter<std::fs::File>,
    committed: bool,
}

impl AtomicFile {
    pub fn create(path: &str) -> AppResult<Self> {
        let path = std::path::PathBuf::from(path);
        let mut tmp = path.clone().into_os_string();
        tmp.push(".part");
        let tmp = std::path::PathBuf::from(tmp);
        let file = std::fs::File::create(&tmp)?;
        Ok(Self { path, tmp, writer: std::io::BufWriter::new(file), committed: false })
    }

    pub fn tmp_path(&self) -> &std::path::Path {
        &self.tmp
    }

    pub fn commit(mut self) -> AppResult<()> {
        use std::io::Write;
        self.writer.flush()?;
        std::fs::rename(&self.tmp, &self.path)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for AtomicFile {
    fn drop(&mut self) {
        // not committed (error / cancel): remove the partial file
        if !self.committed {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_scripts_with_delimiter_blocks() {
        let sql = "-- header\nSET NAMES utf8mb4;\nCREATE TABLE t (a TEXT);\nINSERT INTO t VALUES ('x;y'),('it''s');\n\
                   DELIMITER ;;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 'z'; SET @x = 1; END ;;\nDELIMITER ;\n\
                   SET FOREIGN_KEY_CHECKS=1;\n";
        let parts = split_script(sql);
        assert_eq!(parts.len(), 5, "{parts:#?}");
        assert!(parts[2].contains("'x;y'"));
        assert!(parts[3].starts_with("CREATE TRIGGER") && parts[3].ends_with("END"), "{}", parts[3]);
        assert_eq!(parts[4], "SET FOREIGN_KEY_CHECKS=1");
    }

    #[tokio::test]
    async fn jobs_report_progress_errors_and_cancel() {
        let jobs = Jobs::default();
        let ok = jobs.spawn("Working", |job| async move {
            job.set_total(2);
            job.set_done(2);
            Ok(())
        });
        let failing = jobs.spawn("Failing", |_job| async move { Err(AppError::msg("boom")) });
        let cancelled = jobs.spawn("Long", |job| async move {
            loop {
                job.check()?;
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        });
        jobs.cancel(&cancelled).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(jobs.status(&ok).unwrap(), JobStatus { label: "Working".into(), done: 2, total: 2, finished: true, error: None });
        assert_eq!(jobs.status(&failing).unwrap().error.as_deref(), Some("boom"));
        assert_eq!(jobs.status(&cancelled).unwrap().error.as_deref(), Some("Cancelled."));
        assert!(jobs.status(&ok).is_err(), "a finished job is forgotten after its final status was read");
    }

    #[test]
    fn atomic_file_leaves_nothing_when_not_committed() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.sql");
        let mut f = AtomicFile::create(path.to_str().unwrap()).unwrap();
        f.writer.write_all(b"x").unwrap();
        drop(f);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let mut f = AtomicFile::create(path.to_str().unwrap()).unwrap();
        f.writer.write_all(b"done").unwrap();
        f.commit().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "done");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
