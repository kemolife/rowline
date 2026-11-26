import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchColumns } from '../lib/columnSearch';
import type { FilterColumn } from '../lib/filterComplete';
import { cx } from '../lib/ui';

interface Extra {
  value: string;
  label: string;
}

interface Props {
  columns: readonly FilterColumn[];
  value: string;
  onChange: (name: string) => void;
  /** most used columns (shown first) */
  frequent?: readonly string[];
  /** choices that are not columns, at the end of the list ("Raw SQL…") or the start ("No sorting") */
  extraEnd?: Extra[];
  extraStart?: Extra[];
  /** called after a choice with the keyboard, to move on (e.g. to the operator) */
  onPicked?: () => void;
  autoFocus?: boolean;
  ariaLabel: string;
}

/**
 * Column field you can type in: wide tables have too many columns for a plain select, and the macOS select
 * only jumps by the first letter. Typing filters by any part of the name; arrows move; Enter picks; Esc closes the list.
 */
export default function ColumnPicker({ columns, value, onChange, frequent = [], extraEnd = [], extraStart = [], onPicked, autoFocus, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => searchColumns(columns, query, frequent), [columns, query, frequent]);
  // non-column choices show while not searching, or when their label matches
  const q = query.trim().toLowerCase();
  const pick = (e: Extra[]) => e.filter((x) => !q || x.label.toLowerCase().includes(q));
  const items: { value: string; label: string; type?: string; match?: [number, number] | null; group?: string }[] = [
    ...pick(extraStart),
    ...hits.map((h, i) => ({
      value: h.name,
      label: h.name,
      type: h.type,
      match: h.match,
      group: !q && i === 0 && h.frequent ? 'Most used' : !q && !h.frequent && (i === 0 || hits[i - 1].frequent) && frequent.length ? 'All columns' : undefined,
    })),
    ...pick(extraEnd),
  ];
  const label = [...extraStart, ...extraEnd].find((x) => x.value === value)?.label ?? value;

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const openList = () => {
    setQuery('');
    // start on the chosen column
    setCursor(Math.max(0, items.findIndex((i) => i.value === value)));
    setOpen(true);
  };
  const choose = (v: string, viaKeyboard: boolean) => {
    onChange(v);
    setOpen(false);
    setQuery('');
    if (viaKeyboard) onPicked?.();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return openList();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((c) => Math.min(items.length - 1, Math.max(0, c + step)));
    } else if (e.key === 'Enter') {
      if (!open) return; // Enter on a closed field: the form applies the rule
      e.preventDefault();
      e.stopPropagation();
      const it = items[cursor];
      if (it) choose(it.value, true);
    } else if (e.key === 'Escape' && open) {
      // only the list closes, not the popup around it
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
      setQuery('');
    } else if (e.key === 'Tab' && open) {
      const it = items[cursor];
      if (it && q) onChange(it.value);
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div className={cx('field flex h-8 items-center gap-1.5 px-2', open && 'border-sel-strong shadow-[0_0_0_3px_var(--sel)]')}>
        {open && <Search size={13} className="shrink-0 text-ink-3" />}
        <input
          ref={input}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
          value={open ? query : label}
          placeholder={open ? `Search ${columns.length} columns` : ''}
          onChange={(e) => {
            if (!open) setOpen(true);
            setQuery(e.target.value);
          }}
          onFocus={openList}
          onMouseDown={() => !open && openList()}
          onBlur={() => {
            setOpen(false);
            setQuery('');
          }}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          data-testid="column-picker"
          spellCheck={false}
        />
        <ChevronDown size={14} className="shrink-0 text-ink-3" />
      </div>
      {open && (
        <div
          ref={list}
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-[260px] overflow-y-auto rounded-lg border border-line-strong bg-surface-2 p-1 shadow-[var(--shadow)]"
          role="listbox"
          // keep the focus in the field while clicking an item
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.length === 0 && <div className="px-2 py-1.5 text-ink-3">No column matches “{query}”</div>}
          {items.map((it, i) => (
            <div key={`${it.value}-${i}`}>
              {it.group && <div className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{it.group}</div>}
              <div
                data-index={i}
                role="option"
                aria-selected={i === cursor}
                className={cx('flex cursor-default items-center gap-2 rounded-md px-2 py-1', i === cursor ? 'bg-sel text-ink' : 'text-ink-2', it.value === value && 'font-semibold')}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(it.value, false)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {it.match ? (
                    <>
                      {it.label.slice(0, it.match[0])}
                      <mark className="rounded-sm bg-accent-soft px-px text-ink">{it.label.slice(it.match[0], it.match[1])}</mark>
                      {it.label.slice(it.match[1])}
                    </>
                  ) : (
                    it.label
                  )}
                </span>
                {it.type && <span className="mono shrink-0 text-[11px] text-ink-3">{it.type.replace(/\(.*$/, '')}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
