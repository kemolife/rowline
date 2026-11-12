import { Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { HistoryEntry } from '../lib/types';
import { cx } from '../lib/ui';
import { useConnectionId, useWsActions } from '../store/workspace';

/** "12:04" today, "Mon 12:04" this week, else "14 Oct 12:04" */
export function historyTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** first line of a statement, without extra spaces */
export function firstLine(sql: string): string {
  return sql.trim().split('\n')[0].replace(/\s+/g, ' ');
}

/** Sidebar "History": statements run on this connection, newest first. Click one to open it in a new SQL tab. */
export default function HistoryPane() {
  const cid = useConnectionId();
  const { openQuery } = useWsActions();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setEntries(await api.listHistory(cid).catch(() => []));
  }, [cid]);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (entries ?? []).filter((h) => !f || h.sql.toLowerCase().includes(f));
  }, [entries, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history">
      <div className="flex items-center gap-1.5 p-2.5">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className="field h-8 pl-8 text-[12.5px]" placeholder="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="icon-btn h-8 w-8 shrink-0" onClick={load} title="Refresh" aria-label="Refresh history">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {entries === null ? (
          <div className="flex items-center gap-2 px-2 py-3 text-ink-3">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-3 text-[12.5px] text-ink-3">Queries you run on this connection show up here.</div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-3 text-ink-3">Nothing matches.</div>
        ) : (
          shown.map((h) => (
            <button
              key={h.id}
              className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
              onClick={() => openQuery(h.sql, { database: h.database })}
              title={h.error ? `${h.sql}\n\n${h.error}` : h.sql}
              data-testid="history-entry"
            >
              <div className="mono truncate text-[11.5px] text-ink">{firstLine(h.sql)}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', h.ok ? 'bg-[var(--success)]' : 'bg-[var(--danger)]')} />
                {h.source === 'cli' && (
                  <span className="rounded bg-surface-3 px-1 text-[9.5px] font-bold tracking-wide text-ink-2" title="Run by an agent with the rowline command (read-only)">
                    CLI
                  </span>
                )}
                <span>{historyTime(h.executedAt)}</span>
                <span>· {h.elapsedMs} ms</span>
                {h.rows != null && <span>· {h.rows} row{h.rows === 1 ? '' : 's'}</span>}
                {h.database && <span className="truncate">· {h.database}</span>}
              </div>
              {h.error?.startsWith('Blocked:') && <div className="mt-0.5 truncate text-[11px] text-danger">{h.error}</div>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
