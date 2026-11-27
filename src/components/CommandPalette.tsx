import { installCli } from '../lib/cliInstall';
import { Bookmark, Code2, Columns3, Database, Eye, LogOut, Moon, Palette, PanelLeft, RefreshCw, Search, Sun, SunMoon, Table2, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { isServer, splitTableKey } from '../lib/engine';
import { columnHits, score, tableHits } from '../lib/paletteSearch';
import { MOD, cx } from '../lib/ui';
import { tableKey, useApp } from '../store/app';
import { useQueries } from '../store/queries';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  /** heading the item shows under */
  group: string;
  /** shown in a lighter color before the label (the table of a column) */
  prefix?: string;
}

// column lists per connection and database, loaded once (the same command feeds the SQL autocomplete)
const columnCache = new Map<string, Promise<Record<string, string[]>>>();
function loadColumns(cid: string, db: string | null) {
  const key = tableKey(cid, db);
  if (!columnCache.has(key)) columnCache.set(key, api.schemaColumns(cid, db).catch(() => (columnCache.delete(key), {})));
  return columnCache.get(key)!;
}

/**
 * ⌘K: go anywhere. Empty: recent tables and the actions. Typing: tables, columns of all tables ("which table
 * has user_id?"), saved queries (by name or SQL) and actions, each under its own heading.
 */
export default function CommandPalette() {
  const s = useApp();
  const cid = s.activeConnectionId!;
  const session = s.workspaces[cid].session;
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => s.setPaletteOpen(false);
  const [columns, setColumns] = useState<Record<string, string[]>>({});
  const saved = useQueries((x) => x.byConnection[cid]);
  useEffect(() => {
    let live = true;
    loadColumns(cid, session.database).then((c) => live && setColumns(c));
    if (!saved) useQueries.getState().load(cid);
    return () => {
      live = false;
    };
  }, [cid, session.database]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<Item[]>(() => {
    const pg = session.config.engine === 'postgres';
    const sidebarSchema = session.schema ?? 'public';
    // Postgres: `schema_columns` keys name the schema outside `public` (`billing.invoices`); the sidebar's own
    // tables are known by their plain name
    const where = (key: string) => (pg ? splitTableKey(key, 'public', session.schemas) : null);
    const keyOf = (name: string) => (pg && sidebarSchema !== 'public' ? `${sidebarSchema}.${name}` : name);
    const kindOf = new Map(session.objects.map((o) => [keyOf(o.name), o.kind]));
    /** opens a table by its key; Postgres also switches the sidebar to its schema */
    const open = (key: string, view?: 'data' | 'structure') => {
      const at = where(key);
      if (!at) return s.openTable(cid, key, kindOf.get(key) ?? 'table', view);
      if (at.schema !== session.schema) s.setSchema(cid, at.schema);
      s.openTable(cid, at.table, kindOf.get(key) ?? 'table', view, { schema: at.schema });
    };
    const table = (name: string, group: string): Item => ({
      id: `${group}:${name}`,
      label: name,
      hint: kindOf.get(name) === 'view' ? 'View' : 'Table',
      icon: kindOf.get(name) === 'view' ? <Eye size={14} /> : <Table2 size={14} />,
      run: () => open(name),
      group,
    });
    const structure: Item[] = session.objects.map((o) => ({
      id: `struct:${keyOf(o.name)}`,
      label: `${keyOf(o.name)} — structure`,
      hint: 'Structure',
      icon: <Table2 size={14} />,
      run: () => open(keyOf(o.name), 'structure'),
      group: 'Tables',
    }));
    const current = (yes: boolean) => (yes ? 'Current' : undefined);
    const actions: Item[] = [
      { id: 'a:query', label: 'New query', hint: `${MOD}T`, icon: <Code2 size={14} />, run: () => s.openQuery(cid), group: 'Actions' },
      ...s.openOrder
        .filter((id) => id !== cid)
        .map((id) => ({
          id: `c:${id}`,
          label: `Switch to ${s.workspaces[id].session.config.name}`,
          hint: s.openOrder.indexOf(id) < 9 ? `${MOD}${s.openOrder.indexOf(id) + 1}` : undefined,
          icon: <Database size={14} />,
          run: () => s.switchTo(id),
          group: 'Actions',
        })),
      { id: 'a:sidebar', label: 'Toggle sidebar', hint: `${MOD}B`, icon: <PanelLeft size={14} />, run: s.toggleSidebar, group: 'Actions' },
      { id: 'a:refresh', label: 'Refresh tables', icon: <RefreshCw size={14} />, run: () => s.refreshObjects(cid), group: 'Actions' },
      { id: 'a:disconnect', label: 'Disconnect', icon: <LogOut size={14} />, run: () => s.disconnect(cid), group: 'Actions' },
      { id: 'a:light', label: 'Appearance: Light', hint: current(s.theme === 'light'), icon: <Sun size={14} />, run: () => s.setTheme('light'), group: 'Settings' },
      { id: 'a:dark', label: 'Appearance: Dark', hint: current(s.theme === 'dark'), icon: <Moon size={14} />, run: () => s.setTheme('dark'), group: 'Settings' },
      { id: 'a:system', label: 'Appearance: System', hint: current(s.theme === 'system'), icon: <SunMoon size={14} />, run: () => s.setTheme('system'), group: 'Settings' },
      { id: 'a:blue', label: 'Style: Blue', hint: current(s.colorStyle === 'blue'), icon: <Palette size={14} />, run: () => s.setColorStyle('blue'), group: 'Settings' },
      { id: 'a:warm', label: 'Style: Warm (beige and terracotta)', hint: current(s.colorStyle === 'warm'), icon: <Palette size={14} />, run: () => s.setColorStyle('warm'), group: 'Settings' },
      { id: 'a:cli', label: 'Install the udb command (read-only queries for agents)', icon: <Terminal size={14} />, run: installCli, group: 'Settings' },
      ...session.databases
        .filter((d) => d !== session.database && isServer(session.config.engine))
        .map((d) => ({ id: `db:${d}`, label: `Switch database: ${d}`, hint: 'Database', icon: <Search size={14} />, run: () => s.selectDatabase(cid, d), group: 'Databases' })),
    ];
    const needle = q.trim();
    if (!needle) {
      const recent = (s.recent[tableKey(cid, session.database, session.schema)] ?? []).map(keyOf).filter((n) => kindOf.has(n)).map((n) => table(n, 'Recent'));
      const seen = new Set(recent.map((r) => r.label));
      const tables = session.objects.map((o) => keyOf(o.name)).filter((k) => !seen.has(k)).slice(0, 30).map((k) => table(k, 'Tables'));
      return [...recent, ...actions.filter((a) => a.group !== 'Databases'), ...tables];
    }
    // `alt`: a second text that may match better (Postgres: the table part of `billing.invoices`)
    const ranked = (list: Item[], text: (it: Item) => string, max: number, alt?: (it: Item) => string) =>
      list
        .map((it) => ({ it, sc: Math.min(score(text(it), needle), alt ? score(alt(it), needle) : 99) }))
        .filter((x) => x.sc < 99)
        .sort((a, b) => a.sc - b.sc || a.it.label.length - b.it.label.length)
        .slice(0, max)
        .map((x) => x.it);
    // Postgres: tables of every schema (keys of the column lists), the sidebar's own first when they tie
    const allTables = pg ? [...new Set([...session.objects.map((o) => keyOf(o.name)), ...tableHits(Object.keys(columns), needle, 40)])] : session.objects.map((o) => o.name);
    const tables = ranked([...allTables.map((k) => table(k, 'Tables')), ...structure], (it) => it.label, 15, pg ? (it) => it.label.slice(it.label.indexOf('.') + 1) : undefined);
    const cols: Item[] = columnHits(columns, needle).map((h) => ({
      id: `col:${h.table}.${h.column}`,
      label: h.column,
      prefix: `${h.table}.`,
      hint: 'Column',
      icon: <Columns3 size={14} />,
      run: () => open(h.table),
      group: 'Columns',
    }));
    const queries: Item[] = ranked(
      (saved ?? []).map((sq) => ({
        id: `sq:${sq.id}`,
        label: sq.name,
        hint: 'Saved query',
        icon: <Bookmark size={14} />,
        run: () => s.openQuery(cid, sq.sql, { title: sq.name, savedQueryId: sq.id, database: sq.database }),
        group: 'Saved queries',
        sql: sq.sql,
      })) as (Item & { sql: string })[],
      (it) => `${it.label} ${(it as Item & { sql: string }).sql}`,
      8,
    );
    return [...tables, ...cols, ...queries, ...ranked(actions, (it) => it.label, 12)];
  }, [q, session, cid, s, columns, saved]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (it?: Item) => {
    if (!it) return;
    close();
    it.run();
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-center bg-black/20 pt-[14vh]" onMouseDown={close}>
      <div className="fade-in flex h-fit max-h-[60vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow)]" onMouseDown={(e) => e.stopPropagation()} data-testid="command-palette">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-ink-3" />
          <input
            autoFocus
            className="h-12 flex-1 bg-transparent text-[14px] outline-none"
            placeholder="Go to table, column, saved query or action…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') choose(items[index]);
            }}
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.length === 0 && <div className="px-3 py-6 text-center text-ink-3">Nothing found.</div>}
          {items.map((it, i) => (
            <div key={it.id}>
            {(i === 0 || items[i - 1].group !== it.group) && <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{it.group}</div>}
            <button
              data-index={i}
              className={cx('flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px]', i === index ? 'bg-accent-soft text-ink' : 'text-ink-2')}
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(it)}
            >
              <span className={i === index ? 'text-accent' : 'text-ink-3'}>{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">
                {it.prefix && <span className="text-ink-3">{it.prefix}</span>}
                {it.label}
              </span>
              {it.hint && <span className="text-[11.5px] text-ink-3">{it.hint}</span>}
            </button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}
