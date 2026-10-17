import { FileCode2, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../lib/api';
import type { SavedQuery } from '../lib/types';
import { MOD, cx } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';
import { useQueries } from '../store/queries';
import { useConnectionId, useWs, useWsActions } from '../store/workspace';

/** one shared empty list, so the store selector returns a stable value */
const NONE: SavedQuery[] = [];

/** Sidebar "Queries": the saved queries of this connection. */
export default function SavedQueriesPane() {
  const cid = useConnectionId();
  const queries = useQueries((s) => s.byConnection[cid] ?? NONE);
  const openTabQueryId = useWs((w) => {
    const t = w.tabs.find((x) => x.id === w.activeTabId);
    return t?.kind === 'query' ? t.savedQueryId ?? null : null;
  });
  const { openQuery } = useWsActions();
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; q: SavedQuery; rename?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);

  useEffect(() => {
    useQueries.getState().load(cid);
  }, [cid]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? queries.filter((q) => q.name.toLowerCase().includes(f) || q.sql.toLowerCase().includes(f)) : queries;
  }, [queries, filter]);

  const open = (q: SavedQuery) => openQuery(q.sql, { title: q.name, savedQueryId: q.id, database: q.database });
  const item = 'flex w-full rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3';

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="saved-queries">
      <div className="p-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className="field h-8 pl-8 text-[12.5px]" placeholder="Filter queries" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {queries.length === 0 ? (
          <div className="px-2 py-3 text-[12.5px] leading-relaxed text-ink-3">
            No saved queries yet. In a SQL tab, press <span className="kbd">{MOD} S</span> to save the query here.
          </div>
        ) : shown.length === 0 ? (
          <div className="px-2 py-3 text-ink-3">Nothing matches.</div>
        ) : (
          shown.map((q) => (
            <button
              key={q.id}
              className={cx(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]',
                openTabQueryId === q.id ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )}
              onClick={() => open(q)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, q });
              }}
              title={q.sql}
              data-testid="saved-query"
            >
              <FileCode2 size={14} className={cx('shrink-0', openTabQueryId === q.id ? 'text-accent' : 'text-ink-3')} />
              <span className="min-w-0 flex-1 truncate">{q.name}</span>
            </button>
          ))
        )}
      </div>

      {menu && (
        <div ref={menuRef} className="fade-in fixed z-50 w-56 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]" style={{ left: menu.x, top: menu.y }}>
          {menu.rename !== undefined ? (
            <form
              className="flex gap-1 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                useQueries.getState().rename(menu.q, menu.rename ?? '');
                setMenu(null);
              }}
            >
              <input
                className="field h-7 text-[12.5px]"
                value={menu.rename}
                onChange={(e) => setMenu({ ...menu, rename: e.target.value })}
                onKeyDown={(e) => e.key === 'Escape' && setMenu(null)}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Query name"
              />
              <button type="submit" className="btn h-7 px-2" disabled={!menu.rename.trim()}>
                Save
              </button>
            </form>
          ) : (
            <>
              <button className={item} onClick={() => { open(menu.q); setMenu(null); }}>
                Open
              </button>
              <button className={item} onClick={() => setMenu({ ...menu, rename: menu.q.name })}>
                Rename…
              </button>
              <button className={item} onClick={() => { navigator.clipboard?.writeText(menu.q.sql); setMenu(null); }}>
                Copy SQL
              </button>
              <div className="my-1 h-px bg-line" />
              <button
                className={cx(item, 'text-danger')}
                onClick={async () => {
                  const q = menu.q;
                  setMenu(null);
                  if (await confirmDialog(`Delete the saved query "${q.name}"?`, { danger: true })) await useQueries.getState().remove(q);
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
