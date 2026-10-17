import { ChevronDown, ChevronRight, Clock, Eye, Loader2, RefreshCw, Search, Star, Table2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ResizeHandle, usePanelWidth } from '../lib/panelWidth';
import { useDismiss } from '../lib/useDismiss';
import type { DbObject } from '../lib/types';
import { cx, formatCount } from '../lib/ui';
import { groupByPrefix, middleTruncate } from '../lib/columns';
import { tableKey, useApp, wsActiveTab } from '../store/app';
import { useWs, useWsActions } from '../store/workspace';
import DiagramPane from './DiagramPane';
import HistoryPane from './HistoryPane';
import SavedQueriesPane from './SavedQueriesPane';

function ItemsPane() {
  const session = useWs((w) => w.session);
  const tab = useWs(wsActiveTab);
  const { selectDatabase, refreshObjects, openTable, openQuery, togglePin } = useWsActions();
  const key = tableKey(session.connectionId, session.database);
  const pinned = useApp((s) => s.pinned[key]) ?? EMPTY;
  const recent = useApp((s) => s.recent[key]) ?? EMPTY;
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; obj: DbObject } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);

  const activeName = tab?.kind === 'table' ? tab.table : null;
  const q = (name: string) => (session.config.engine === 'mysql' ? `\`${name}\`` : `"${name}"`);
  const byName = useMemo(() => new Map(session.objects.map((o) => [o.name, o])), [session.objects]);
  const query = filter.trim().toLowerCase();

  const { tables, views, matches } = useMemo(() => {
    const tables = session.objects.filter((o) => o.kind === 'table');
    const views = session.objects.filter((o) => o.kind === 'view');
    const matches = query ? session.objects.filter((o) => o.name.toLowerCase().includes(query)) : [];
    return { tables, views, matches };
  }, [session.objects, query]);
  const groups = useMemo(() => groupByPrefix(tables), [tables]);
  const pinnedObjs = pinned.map((n) => byName.get(n)).filter((o): o is DbObject => !!o);
  const recentObjs = recent
    .filter((n) => !pinned.includes(n))
    .map((n) => byName.get(n))
    .filter((o): o is DbObject => !!o)
    .slice(0, 5);

  const Item = ({ o, indent, icon = 'kind' }: { o: DbObject; indent?: boolean; icon?: 'kind' | 'pin' | 'recent' }) => {
    const isPinned = pinned.includes(o.name);
    const active = activeName === o.name;
    return (
      <div
        className={cx(
          'group flex h-7 w-full items-center gap-2 rounded-md pr-1 text-left text-[12.5px]',
          indent ? 'pl-6' : 'pl-2',
          active ? 'bg-surface-3 font-semibold text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        )}
        onClick={() => openTable(o.name, o.kind)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, obj: o });
        }}
        role="button"
        data-testid="sidebar-item"
        title={o.name}
      >
        {icon === 'pin' ? (
          <Star size={12} className="shrink-0 fill-current text-accent" />
        ) : icon === 'recent' ? (
          <Clock size={12} className="shrink-0 text-ink-3" />
        ) : o.kind === 'view' ? (
          <Eye size={13} className="shrink-0 text-ink-3" />
        ) : (
          <Table2 size={13} className={cx('shrink-0', active ? 'text-accent' : 'text-ink-3')} />
        )}
        <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{middleTruncate(o.name, 30)}</span>
        {o.rowEstimate != null && <span className="shrink-0 text-[11px] tabular-nums text-ink-3 opacity-0 group-hover:opacity-100">{formatCount(o.rowEstimate)}</span>}
        <button
          className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-surface-3', isPinned ? 'text-accent' : 'text-ink-3 opacity-0 group-hover:opacity-100')}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(o.name);
          }}
          title={isPinned ? 'Unpin' : 'Pin to the top'}
          aria-label={isPinned ? `Unpin ${o.name}` : `Pin ${o.name}`}
        >
          <Star size={11} className={cx(isPinned && 'fill-current')} />
        </button>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}>
      <div className="space-y-2 p-2.5">
        {session.config.engine === 'mysql' && (
          <div className="relative">
            <select
              className="field h-8 appearance-none pr-8 font-medium"
              value={session.database ?? ''}
              onChange={(e) => selectDatabase(e.target.value)}
              aria-label="Database"
              data-testid="database-select"
            >
              {!session.database && <option value="">Select database…</option>}
              {session.databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          </div>
        )}
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className="field h-8 pl-8 text-[12.5px]" placeholder={`Filter ${formatCount(tables.length)} tables`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {session.loadingObjects ? (
          <div className="flex items-center gap-2 px-2 py-3 text-ink-3">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : session.config.engine === 'mysql' && !session.database ? (
          <div className="px-2 py-3 text-ink-3">Select a database above.</div>
        ) : query ? (
          <Section title="Matches" count={matches.length}>
            {matches.map((o) => (
              <Item key={o.name} o={o} />
            ))}
            {!matches.length && <div className="px-2 py-3 text-ink-3">Nothing matches.</div>}
          </Section>
        ) : (
          <>
            {pinnedObjs.length > 0 && (
              <Section title="Pinned">
                {pinnedObjs.map((o) => (
                  <Item key={o.name} o={o} icon="pin" />
                ))}
              </Section>
            )}
            {recentObjs.length > 0 && (
              <Section title="Recent">
                {recentObjs.map((o) => (
                  <Item key={o.name} o={o} icon="recent" />
                ))}
              </Section>
            )}
            <Section title="Tables" count={tables.length} onRefresh={refreshObjects}>
              {groups.map((g) =>
                g.prefix ? (
                  <div key={g.prefix}>
                    {(() => {
                      const isOpen = open[g.prefix] ?? g.items.some((o) => o.name === activeName);
                      return (
                        <>
                          <button
                            className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink"
                            onClick={() => setOpen((s) => ({ ...s, [g.prefix!]: !isOpen }))}
                            aria-expanded={isOpen}
                            data-testid="table-group"
                          >
                            <ChevronRight size={12} className={cx('shrink-0 text-ink-3 transition-transform', isOpen && 'rotate-90')} />
                            <span className="mono min-w-0 flex-1 truncate text-[12px]">{g.prefix}</span>
                            <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{g.items.length}</span>
                          </button>
                          {isOpen && g.items.map((o) => <Item key={o.name} o={o} indent />)}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <Item key={g.items[0].name} o={g.items[0]} />
                ),
              )}
              {!tables.length && <div className="px-2 py-3 text-ink-3">No tables.</div>}
            </Section>
            {views.length > 0 && (
              <Section title="Views" count={views.length}>
                {views.map((o) => (
                  <Item key={o.name} o={o} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>

      {menu && (
        <div ref={menuRef} className="fade-in fixed z-50 w-52 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]" style={{ left: menu.x, top: menu.y }}>
          {[
            ['Open data', () => openTable(menu.obj.name, menu.obj.kind, 'data')],
            ['Open structure', () => openTable(menu.obj.name, menu.obj.kind, 'structure')],
            [pinned.includes(menu.obj.name) ? 'Unpin' : 'Pin to the top', () => togglePin(menu.obj.name)],
            ['New query: SELECT', () => openQuery(`SELECT *\nFROM ${q(menu.obj.name)}\nLIMIT 100;`)],
            ['Copy name', () => navigator.clipboard?.writeText(menu.obj.name)],
          ].map(([label, fn]) => (
            <button key={label as string} className="flex w-full rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3" onClick={() => { (fn as () => void)(); setMenu(null); }}>
              {label as string}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY: string[] = [];

type Pane = 'items' | 'queries' | 'history' | 'diagram';
const PANES: { key: Pane; label: string }[] = [
  { key: 'items', label: 'Tables' },
  { key: 'queries', label: 'Queries' },
  { key: 'history', label: 'History' },
  { key: 'diagram', label: 'Diagram' },
];

/** Left sidebar: tables (Items), saved queries and query history of this connection. */
export default function Sidebar() {
  const [pane, setPane] = useState<Pane>('items');
  const width = usePanelWidth('sidebar');
  return (
    <aside className="relative flex shrink-0 flex-col border-r border-line bg-bg" style={{ width }}>
      <ResizeHandle panel="sidebar" edge="right" />
      <div className="px-2.5 pt-2.5">
        <div className="flex rounded-lg bg-surface-2 p-0.5" role="tablist">
          {PANES.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={pane === p.key}
              className={cx('h-7 flex-1 rounded-md text-[12px] font-medium', pane === p.key ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
              onClick={() => setPane(p.key)}
              data-testid={`sidebar-pane-${p.key}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {/* Items stays mounted so its filter and scroll survive a switch */}
      <div className="flex min-h-0 flex-1 flex-col" style={{ display: pane === 'items' ? 'flex' : 'none' }}>
        <ItemsPane />
      </div>
      {pane === 'queries' && <SavedQueriesPane />}
      {pane === 'history' && <HistoryPane />}
      {pane === 'diagram' && <DiagramPane />}
    </aside>
  );
}

function Section({ title, count, onRefresh, children }: { title: string; count?: number; onRefresh?: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex h-7 items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        <span>
          {title} {count != null && <span className="font-normal">{count}</span>}
        </span>
        {onRefresh && (
          <button className="icon-btn h-6 w-6" onClick={onRefresh} title="Refresh" aria-label="Refresh tables">
            <RefreshCw size={12} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
