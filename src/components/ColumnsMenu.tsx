import { Columns3, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';

export interface ColumnChoice {
  name: string;
  type: string;
  key: 'PK' | 'FK' | null;
}

interface Props {
  columns: ColumnChoice[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}

/** Toolbar button "Columns": choose which columns the grid shows (remembered per table) */
export default function ColumnsMenu({ columns, hidden, onChange }: Props) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const hiddenNow = hidden.filter((h) => columns.some((c) => c.name === h));
  const shown = columns.length - hiddenNow.length;
  return (
    <>
      <button
        className={cx('btn btn-ghost h-7 gap-1.5 px-2', hiddenNow.length > 0 && 'text-link')}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 6 });
        }}
        title="Choose the columns to show"
        data-testid="columns-button"
      >
        <Columns3 size={13} /> Columns
        {hiddenNow.length > 0 && (
          <span className="tabular-nums" data-testid="columns-count">
            {shown}/{columns.length}
          </span>
        )}
      </button>
      {open && <ColumnsPopover x={open.x} y={open.y} columns={columns} hidden={hiddenNow} onChange={onChange} onClose={() => setOpen(null)} />}
    </>
  );
}

function ColumnsPopover({ x, y, columns, hidden, onChange, onClose }: Props & { x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // a list you work in: switching apps does not close it
  useDismiss(ref, onClose, true, false);
  const [q, setQ] = useState('');
  const h = new Set(hidden);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? columns.filter((c) => c.name.toLowerCase().includes(needle)) : columns;
  }, [columns, q]);
  const keys = columns.filter((c) => c.key).map((c) => c.name);
  const width = 300;

  const toggle = (name: string) => {
    if (h.has(name)) onChange(hidden.filter((x) => x !== name));
    // the last visible column stays
    else if (columns.length - hidden.length > 1) onChange([...hidden, name]);
  };
  // the search result only: show those, or hide those
  const setList = (show: boolean) => {
    const names = new Set(list.map((c) => c.name));
    const next = show ? hidden.filter((x) => !names.has(x)) : [...new Set([...hidden, ...list.map((c) => c.name)])];
    onChange(next.length >= columns.length ? hidden : next);
  };

  return createPortal(
    <div
      ref={ref}
      className="fade-in fixed z-50 flex max-h-[min(520px,calc(100vh-80px))] flex-col rounded-xl border border-line-strong bg-surface text-[12.5px] shadow-[var(--shadow)]"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: y, width }}
      data-testid="columns-popover"
    >
      <div className="space-y-2 border-b border-line p-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className="field h-7 pl-8 text-[12.5px]" placeholder={`Find among ${columns.length} columns`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus data-testid="columns-search" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {q.trim() ? (
            <>
              <button className="h-6 rounded-md bg-surface-2 px-2 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink" onClick={() => setList(true)}>
                Show these
              </button>
              <button className="h-6 rounded-md bg-surface-2 px-2 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink" onClick={() => setList(false)}>
                Hide these
              </button>
              <button
                className="h-6 rounded-md bg-surface-2 px-2 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink"
                onClick={() => {
                  const names = new Set(list.map((c) => c.name));
                  if (names.size) onChange(columns.filter((c) => !names.has(c.name)).map((c) => c.name));
                }}
                data-testid="columns-only-these"
              >
                Only these
              </button>
            </>
          ) : (
            <>
              <button className="h-6 rounded-md bg-surface-2 px-2 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink" onClick={() => onChange([])} data-testid="columns-show-all">
                Show all
              </button>
              <button
                className="h-6 rounded-md bg-surface-2 px-2 text-[12px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-40"
                disabled={!keys.length}
                onClick={() => onChange(columns.filter((c) => !c.key).map((c) => c.name))}
                title="Primary key and foreign key columns"
                data-testid="columns-only-keys"
              >
                Only keys
              </button>
            </>
          )}
          <span className="ml-auto self-center text-[11.5px] text-ink-3">
            {columns.length - hidden.length} of {columns.length} shown
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {list.map((c) => (
          <label key={c.name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2" data-testid="column-choice">
            <input type="checkbox" className="accent-[var(--accent)]" checked={!h.has(c.name)} onChange={() => toggle(c.name)} />
            <span className={cx('mono min-w-0 flex-1 truncate', h.has(c.name) ? 'text-ink-3' : 'text-ink')} title={c.name}>
              {c.name}
            </span>
            {c.key && <span className={cx('shrink-0 text-[9px] font-bold', c.key === 'PK' ? 'text-warning' : 'text-link')}>{c.key}</span>}
            <span className="mono max-w-[90px] shrink-0 truncate text-[10.5px] text-ink-3">{c.type}</span>
          </label>
        ))}
        {!list.length && <div className="px-2 py-3 text-ink-3">No column matches “{q}”.</div>}
      </div>
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}

/** Right click on a column header */
export function HeaderMenu({ x, y, column, canHide, onHide, onOnlyKeys, onShowAll, onClose }: { x: number; y: number; column: string; canHide: boolean; onHide: () => void; onOnlyKeys?: () => void; onShowAll?: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const items: [string, () => void, boolean?][] = [
    [`Hide column ${column}`, onHide, !canHide],
    ...(onOnlyKeys ? [['Show only key columns', onOnlyKeys] as [string, () => void]] : []),
    ...(onShowAll ? [['Show all columns', onShowAll] as [string, () => void]] : []),
  ];
  return createPortal(
    <div
      ref={ref}
      className="fade-in fixed z-50 w-60 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]"
      style={{ left: Math.min(x, window.innerWidth - 260), top: Math.min(y, window.innerHeight - 120) }}
      data-testid="header-menu"
    >
      {items.map(([label, run, disabled]) => (
        <button
          key={label}
          disabled={disabled}
          className="flex w-full truncate rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
          onClick={() => {
            run();
            onClose();
          }}
        >
          {label}
        </button>
      ))}
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}
