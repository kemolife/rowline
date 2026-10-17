import { Check, Loader2, Network } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { diffSchema, hasChanges, summaryText } from '../lib/schemaDiff';
import { cx } from '../lib/ui';
import { tableKey } from '../store/app';
import { emptySchema, useSchema } from '../store/schema';
import { useWs, useWsActions } from '../store/workspace';

/** Sidebar "Diagram": opens the relation diagram and lists schema changes since the last "mark as seen" */
export default function DiagramPane() {
  const session = useWs((w) => w.session);
  const { openDiagram } = useWsActions();
  const cid = session.connectionId;
  const database = session.config.engine === 'mysql' ? session.database : null;
  const entry = useSchema((s) => s.entries[tableKey(cid, database)]) ?? emptySchema;

  useEffect(() => {
    if (session.config.engine === 'sqlite' || database) useSchema.getState().load(cid, database);
  }, [cid, database, session.config.engine]);

  const last = entry.snapshots[entry.snapshots.length - 1] ?? null;
  const diff = useMemo(() => (entry.live && last ? diffSchema(last.tables, entry.live) : null), [entry.live, last]);
  const changed = diff ? diff.tables.filter((t) => t.change) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2.5" data-testid="diagram-pane">
      <button className="btn btn-primary h-8 justify-center" onClick={() => openDiagram()} data-testid="open-diagram" disabled={session.config.engine === 'mysql' && !database}>
        <Network size={14} /> Open relation diagram
      </button>
      <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-ink-3">Tables and their foreign keys. Select tables or lines on the diagram to ask Claude about them.</p>

      <div className="mt-4 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Schema changes</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1.5 text-[12px]">
        {entry.loading && !entry.live ? (
          <div className="flex items-center gap-2 text-ink-3">
            <Loader2 size={13} className="animate-spin" /> Reading the schema…
          </div>
        ) : entry.error ? (
          <div className="selectable text-danger">{entry.error}</div>
        ) : !last ? (
          <div className="space-y-2 text-ink-3">
            <p>Not tracked yet. Mark the current schema as seen; later changes (new tables, columns, keys, for example after a migration) show here and on the diagram.</p>
            <button className="btn h-7" onClick={() => useSchema.getState().markSeen(cid, database)} disabled={!entry.live}>
              <Check size={13} /> Mark as seen
            </button>
          </div>
        ) : diff && hasChanges(diff.summary) ? (
          <div className="space-y-2">
            <div className="text-ink-2">
              Since {new Date(last.takenAt).toLocaleString()}: <span className="font-medium text-warning">{summaryText(diff.summary)}</span>
            </div>
            <div className="space-y-0.5">
              {changed.map((t) => (
                <button key={t.name} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2" onClick={() => openDiagram(t.name)} title="Show on the diagram">
                  <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', t.change === 'added' ? 'bg-success' : t.change === 'removed' ? 'bg-danger' : 'bg-warning')} />
                  <span className={cx('mono min-w-0 flex-1 truncate', t.change === 'removed' && 'line-through')}>{t.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">{t.change}</span>
                </button>
              ))}
            </div>
            <button className="btn h-7" onClick={() => useSchema.getState().markSeen(cid, database)}>
              <Check size={13} /> Mark as seen
            </button>
          </div>
        ) : (
          <div className="text-ink-3">No changes since {new Date(last.takenAt).toLocaleString()}.</div>
        )}
      </div>
    </div>
  );
}
