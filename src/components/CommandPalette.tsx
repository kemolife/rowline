import { installCli } from '../lib/cliInstall';
import { Code2, Database, Eye, LogOut, Moon, PanelLeft, RefreshCw, Search, Table2, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MOD, cx } from '../lib/ui';
import { useApp } from '../store/app';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/** ⌘K / ⌘P: quick open tables and run actions */
export default function CommandPalette() {
  const s = useApp();
  const cid = s.activeConnectionId!;
  const session = s.workspaces[cid].session;
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => s.setPaletteOpen(false);

  const items = useMemo<Item[]>(() => {
    const objects: Item[] = session.objects.map((o) => ({
      id: `obj:${o.name}`,
      label: o.name,
      hint: o.kind === 'view' ? 'View' : 'Table',
      icon: o.kind === 'view' ? <Eye size={14} /> : <Table2 size={14} />,
      run: () => s.openTable(cid, o.name, o.kind),
    }));
    const structure: Item[] = session.objects.map((o) => ({
      id: `struct:${o.name}`,
      label: `${o.name} — structure`,
      hint: 'Structure',
      icon: <Table2 size={14} />,
      run: () => s.openTable(cid, o.name, o.kind, 'structure'),
    }));
    const actions: Item[] = [
      ...s.openOrder
        .filter((id) => id !== cid)
        .map((id) => ({
          id: `c:${id}`,
          label: `Switch to ${s.workspaces[id].session.config.name}`,
          hint: s.openOrder.indexOf(id) < 9 ? `${MOD}${s.openOrder.indexOf(id) + 1}` : undefined,
          icon: <Database size={14} />,
          run: () => s.switchTo(id),
        })),
      { id: 'a:query', label: 'New query', hint: `${MOD}T`, icon: <Code2 size={14} />, run: () => s.openQuery(cid) },
      { id: 'a:sidebar', label: 'Toggle sidebar', hint: `${MOD}B`, icon: <PanelLeft size={14} />, run: s.toggleSidebar },
      { id: 'a:refresh', label: 'Refresh tables', icon: <RefreshCw size={14} />, run: () => s.refreshObjects(cid) },
      {
        id: 'a:theme',
        label: `Theme: switch to ${s.theme === 'system' ? 'light' : s.theme === 'light' ? 'dark' : 'system'}`,
        icon: <Moon size={14} />,
        run: () => s.setTheme(s.theme === 'system' ? 'light' : s.theme === 'light' ? 'dark' : 'system'),
      },
      { id: 'a:cli', label: 'Install the rowline command (read-only queries for agents)', icon: <Terminal size={14} />, run: installCli },
      { id: 'a:disconnect', label: 'Disconnect', icon: <LogOut size={14} />, run: () => s.disconnect(cid) },
      ...session.databases
        .filter((d) => d !== session.database && session.config.engine === 'mysql')
        .map((d) => ({ id: `db:${d}`, label: `Switch database: ${d}`, hint: 'Database', icon: <Search size={14} />, run: () => s.selectDatabase(cid, d) })),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return [...objects.slice(0, 50), ...actions];
    const score = (label: string) => {
      const l = label.toLowerCase();
      if (l === needle) return 0;
      if (l.startsWith(needle)) return 1;
      if (l.includes(needle)) return 2;
      // fuzzy: all characters in order
      let i = 0;
      for (const ch of l) if (ch === needle[i]) i++;
      return i === needle.length ? 3 : 99;
    };
    return [...objects, ...structure, ...actions]
      .map((it) => ({ it, sc: score(it.label) }))
      .filter((x) => x.sc < 99)
      .sort((a, b) => a.sc - b.sc || a.it.label.length - b.it.label.length)
      .slice(0, 60)
      .map((x) => x.it);
  }, [q, session, cid, s]);

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
            placeholder="Search tables and actions"
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
            <button
              key={it.id}
              data-index={i}
              className={cx('flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px]', i === index ? 'bg-accent-soft text-ink' : 'text-ink-2')}
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(it)}
            >
              <span className={i === index ? 'text-accent' : 'text-ink-3'}>{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-[11.5px] text-ink-3">{it.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}
