import { CheckCircle2, DatabaseBackup, Loader2, MoreHorizontal, RotateCcw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, confirmDialog, pickOpenPath, pickSavePath } from '../lib/api';
import type { JobStatus } from '../lib/types';
import { cx } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useApp } from '../store/app';
import { useWs, useWsActions } from '../store/workspace';

/** "shop-2026-10-16-1042" */
export function backupFileName(base: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const safe = base.replace(/\.(sqlite3?|db3?|s3db)$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'database';
  return `${safe}-${stamp}`;
}

interface RunningJob {
  jobId: string;
  kind: 'backup' | 'restore';
  path: string;
  status: JobStatus | null;
}

/** "⋯" menu in the header: Backup database…, Restore database… with a progress window. */
export default function BackupMenu() {
  const session = useWs((w) => w.session);
  const { refreshObjects } = useWsActions();
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<RunningJob | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, close, open);

  const engine = session.config.engine;
  const database = engine === 'mysql' ? session.database : null;
  const target = engine === 'mysql' ? database ?? '' : session.info.currentDatabase ?? session.config.name;
  const extension = engine === 'mysql' ? 'sql' : 'sqlite';
  const toast = useApp((s) => s.toast);

  const start = async (kind: 'backup' | 'restore') => {
    setOpen(false);
    if (engine === 'mysql' && !database) {
      toast('Select a database first.', 'info');
      return;
    }
    let path: string | null;
    if (kind === 'backup') {
      path = await pickSavePath(`${backupFileName(target)}.${extension}`, extension, true);
    } else {
      path = engine === 'mysql' ? await pickOpenPath('SQL file', ['sql']) : await pickOpenPath('SQLite database', ['sqlite', 'sqlite3', 'db', 'db3', 's3db']);
      if (!path) return;
      const prod = session.config.environment === 'prod';
      const what = engine === 'mysql' ? `This runs every statement of the file in "${target}". Tables in the file are dropped and created again.` : `This replaces everything in "${target}" with the backup.`;
      const ok = await confirmDialog(`${prod ? 'This is a PRODUCTION connection.\n\n' : ''}Restore "${target}" from\n${path}?\n\n${what} It can't be undone.`, {
        title: 'Restore database',
        danger: true,
      });
      if (!ok) return;
    }
    if (!path) return;
    try {
      const { jobId } = kind === 'backup' ? await api.backupStart(session.connectionId, database, path) : await api.restoreStart(session.connectionId, database, path);
      setJob({ jobId, kind, path, status: null });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // poll the running job
  useEffect(() => {
    if (!job || job.status?.finished) return;
    let stop = false;
    const tick = async () => {
      try {
        const status = await api.jobStatus(job.jobId);
        if (stop) return;
        setJob((j) => (j && j.jobId === job.jobId ? { ...j, status } : j));
        if (status.finished) {
          if (!status.error && job.kind === 'restore') refreshObjects();
          return;
        }
      } catch {
        /* status of a finished job that was already read */
      }
      if (!stop) setTimeout(tick, 300);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [job?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3';

  return (
    <div className="relative" ref={ref}>
      <button className="icon-btn no-drag" onClick={() => setOpen(!open)} title="More" aria-label="More actions" data-testid="more-menu">
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="fade-in absolute right-0 top-9 z-50 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]">
          <button className={item} onClick={() => start('backup')} data-testid="backup-database">
            <DatabaseBackup size={14} /> Backup database…
          </button>
          <button className={item} onClick={() => start('restore')} data-testid="restore-database">
            <RotateCcw size={14} /> Restore database…
          </button>
        </div>
      )}
      {job && <JobDialog job={job} target={target} onClose={() => setJob(null)} />}
    </div>
  );
}

function JobDialog({ job, target, onClose }: { job: RunningJob; target: string; onClose: () => void }) {
  const s = job.status;
  const finished = !!s?.finished;
  const failed = finished && !!s?.error;
  const cancelled = failed && s?.error === 'Cancelled.';
  const percent = s && s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;
  const title = job.kind === 'backup' ? `Backup of ${target}` : `Restore of ${target}`;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-6 backdrop-blur-[2px]" data-testid="job-dialog">
      <div className="fade-in w-full max-w-[440px] rounded-2xl border border-line bg-surface shadow-[var(--shadow)]">
        <div className="border-b border-line px-5 py-3.5 text-[14px] font-semibold">{title}</div>
        <div className="space-y-3 px-5 py-4 text-[12.5px]">
          {!finished ? (
            <>
              <div className="flex items-center gap-2 text-ink-2">
                <Loader2 size={14} className="animate-spin" />
                <span className="truncate">{s?.label ?? 'Starting…'}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className={cx('h-full rounded-full bg-accent transition-[width]', percent == null && 'w-1/3 animate-pulse')} style={percent != null ? { width: `${percent}%` } : undefined} />
              </div>
              {percent != null && <div className="text-[11.5px] text-ink-3">{percent}%</div>}
            </>
          ) : failed ? (
            <div className={cx('selectable flex gap-2 rounded-lg px-3 py-2', cancelled ? 'bg-surface-2 text-ink-2' : 'bg-danger-soft text-danger')}>
              {!cancelled && <XCircle size={15} className="mt-px shrink-0" />}
              <span className="whitespace-pre-wrap break-words">
                {cancelled ? (job.kind === 'backup' ? 'Backup cancelled. No file was written.' : 'Restore cancelled. Statements that already ran stay applied.') : s?.error}
              </span>
            </div>
          ) : (
            <div className="flex gap-2 text-success">
              <CheckCircle2 size={15} className="mt-px shrink-0" />
              <span className="selectable break-all">{job.kind === 'backup' ? `Saved to ${job.path}` : 'Restored. Open tables show the new data after a refresh (⌘R).'}</span>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          {finished ? (
            <button className="btn btn-primary" onClick={onClose} autoFocus>
              Close
            </button>
          ) : (
            <button className="btn" onClick={() => api.jobCancel(job.jobId).catch(() => undefined)} data-testid="cancel-job">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
