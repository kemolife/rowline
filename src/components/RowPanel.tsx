import { KeyRound, Link2, MoreHorizontal, Search } from 'lucide-react';
import { ResizeHandle, usePanelWidth } from '../lib/panelWidth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pickTextFileContent } from '../lib/api';
import { prettyJson, valueOptions, type FieldInfo, type ValueOption } from '../lib/fieldValues';
import { useDismiss } from '../lib/useDismiss';
import { useApp } from '../store/app';
import { isSqlExpr, type Cell, type Engine, type ResultColumn, type TableStructure } from '../lib/types';
import { cx } from '../lib/ui';
import type { RowState } from './DataGrid';

interface Props {
  columns: ResultColumn[];
  structure: TableStructure | null;
  row: number | null;
  selectedCount: number;
  getValue: (row: number, col: number) => Cell;
  rowState: RowState;
  editable: boolean;
  engine: Engine;
  onChange: (col: number, value: Cell) => void;
  /** unsaved edit in this field of the selected row */
  isEdited: (col: number) => boolean;
  /** primary key text of the row, e.g. `id 91` */
  rowLabel: string | null;
  pending: number;
  onSave: () => void;
  onDiscard: () => void;
  /** tables whose rows point to this row */
  referencedBy?: { id: string; table: string; column: string; guessed: boolean; onOpen: () => void }[];
}

/** Right panel: all fields of the selected row, editable like TablePlus. */
export default function RowPanel({ columns, structure, row, selectedCount, getValue, rowState, editable, engine, onChange, isEdited, rowLabel, pending, onSave, onDiscard, referencedBy = [] }: Props) {
  const [filter, setFilter] = useState('');
  const info = useMemo(() => new Map(structure?.columns.map((c) => [c.name, c]) ?? []), [structure]);
  const fkColumns = useMemo(() => new Set(structure?.foreignKeys.filter((f) => f.columns.length === 1).map((f) => f.columns[0]) ?? []), [structure]);
  const readOnly = !editable || rowState === 'deleted';
  const width = usePanelWidth('rowPanel');

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-bg" style={{ width }} data-testid="row-panel">
      <ResizeHandle panel="rowPanel" edge="left" />
      <div className="shrink-0 space-y-2 border-b border-line px-3 pb-2.5 pt-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-ink">Row</span>
          {rowLabel && <span className="mono truncate text-[12px] text-ink-2">{rowLabel}</span>}
          {rowState && (
            <span className={cx('rounded-full px-2 py-px text-[10.5px] font-medium capitalize', rowState === 'deleted' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent')}>{rowState}</span>
          )}
          {selectedCount > 1 && <span className="text-[11.5px] text-ink-3">first of {selectedCount}</span>}
          <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">{columns.length} fields</span>
        </div>
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input className="field h-7 pl-7 text-[12px]" placeholder="Find field" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      {row == null ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-ink-3">Select a row to see all its fields.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {columns.map((c, i) => {
            if (filter && !c.name.toLowerCase().includes(filter.toLowerCase())) return null;
            const meta = info.get(c.name);
            return (
              <Field
                key={`${row}-${c.name}`}
                name={c.name}
                info={{
                  type: meta?.dataType ?? c.typeName,
                  primaryKey: !!meta?.primaryKey,
                  nullable: meta?.nullable ?? true,
                  autoIncrement: !!meta?.autoIncrement,
                  defaultValue: meta?.defaultValue ?? null,
                }}
                foreignKey={fkColumns.has(c.name)}
                edited={isEdited(i)}
                engine={engine}
                isNewRow={rowState === 'inserted'}
                value={getValue(row, i)}
                readOnly={readOnly}
                onCommit={(v) => onChange(i, v)}
              />
            );
          })}
          {referencedBy.length > 0 && (
            <div className="mt-2 border-t border-line px-3 pb-2 pt-2.5" data-testid="referenced-by">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Referenced by</div>
              {referencedBy.map((r) => (
                <button key={r.id} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-surface-2" onClick={r.onOpen} title={`Open the rows of ${r.table} that point to this row`}>
                  <span className="text-ink-3">←</span>
                  <span className="mono min-w-0 flex-1 truncate text-link">
                    {r.table}.{r.column}
                  </span>
                  {r.guessed && <span className="shrink-0 text-[10.5px] text-ink-3">guessed</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {pending > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-2/60 px-3 py-2">
          <span className="flex-1 text-[12px] text-ink-2">
            {pending} unsaved {pending === 1 ? 'change' : 'changes'}
          </span>
          <button className="btn btn-ghost h-7" onClick={onDiscard}>
            Discard
          </button>
          <button className="btn btn-primary h-7" onClick={onSave}>
            Save
          </button>
        </div>
      )}
    </aside>
  );
}

const OPTION_LABEL: Record<ValueOption['kind'], string> = {
  null: 'NULL',
  default: 'DEFAULT',
  empty: 'EMPTY',
  now: 'NOW()',
  pretty: 'PRETTY',
  file: 'Load from file…',
};

interface FieldProps {
  name: string;
  info: FieldInfo;
  foreignKey: boolean;
  edited: boolean;
  engine: Engine;
  isNewRow: boolean;
  value: Cell;
  readOnly: boolean;
  onCommit: (v: Cell) => void;
}

function Field({ name, info, foreignKey, edited, engine, isNewRow, value, readOnly, onCommit }: FieldProps) {
  const expr = isSqlExpr(value) ? value.$expr : null;
  const text = value === null || expr ? '' : String(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menuRef, closeMenu, !!menu);
  const multiline = text.length > 60 || text.includes('\n');
  const commit = () => {
    if (draft !== text || ((value === null || expr) && draft !== '')) onCommit(draft);
  };
  const options = readOnly ? [] : valueOptions(info, engine, isNewRow, value);
  const placeholder = expr ?? (value === null ? 'null' : '');

  const choose = async (o: ValueOption) => {
    setMenu(null);
    if (o.kind === 'null') onCommit(null);
    else if (o.kind === 'default') onCommit({ $expr: 'DEFAULT' });
    else if (o.kind === 'empty') onCommit('');
    else if (o.kind === 'now') onCommit({ $expr: o.keyword });
    else if (o.kind === 'pretty') {
      const pretty = typeof value === 'string' ? prettyJson(value) : null;
      if (pretty !== null) onCommit(pretty);
    } else if (o.kind === 'file') {
      try {
        const content = await pickTextFileContent();
        if (content !== null) onCommit(content);
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    }
  };

  const inputClass =
    'mono block w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-[12px] text-ink outline-none placeholder:text-[var(--null-faint)] hover:border-line focus:border-sel-strong focus:bg-surface read-only:hover:border-transparent';

  return (
    <div className={cx('group grid grid-cols-[minmax(92px,40%)_1fr] items-start gap-2 px-3 py-[3px]', edited ? 'bg-[var(--edited)]' : 'hover:bg-surface-2/60')} data-testid="row-field">
      <div className="min-w-0 pt-[3px]">
        <div className="flex items-center gap-1">
          {edited && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Changed, not saved yet" />}
          {info.primaryKey && <KeyRound size={10} className="shrink-0 text-warning" />}
          {foreignKey && <Link2 size={10} className="shrink-0 text-link" />}
          <span className="mono truncate text-[12px] font-semibold text-ink" title={name}>
            {name}
          </span>
        </div>
        <div className="mono truncate text-[10.5px] text-ink-3" title={info.type}>
          {info.type}
        </div>
      </div>
      <div className="flex min-w-0 items-start gap-0.5">
        {multiline ? (
          <textarea
            className={cx(inputClass, 'min-h-[52px] resize-y py-1')}
            value={draft}
            placeholder={placeholder}
            readOnly={readOnly}
            rows={Math.min(6, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        ) : (
          <input
            className={cx(inputClass, 'h-7')}
            value={draft}
            placeholder={placeholder}
            readOnly={readOnly}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setDraft(text);
            }}
          />
        )}
        {options.length > 0 && (
          <button
            className={cx('icon-btn mt-0.5 h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100', menu && 'bg-surface-2 text-ink opacity-100')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
            }}
            title="Set NULL, DEFAULT, NOW() or load from a file"
            aria-label={`Value options for ${name}`}
            data-testid="field-menu"
          >
            <MoreHorizontal size={13} />
          </button>
        )}
      </div>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="fade-in fixed z-50 w-44 -translate-x-full rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]"
            style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 40 * options.length - 16) }}
          >
            {options.map((o, i) => {
              // a line between the "special values" and the "change the text" groups
              const groupStart = i > 0 && (o.kind === 'empty' || o.kind === 'now' || o.kind === 'pretty' || o.kind === 'file') && !['empty', 'now', 'pretty', 'file'].includes(options[i - 1].kind);
              return (
                <div key={o.kind}>
                  {groupStart && <div className="my-1 h-px bg-line" />}
                  <button className="flex w-full rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3" onClick={() => choose(o)}>
                    <span className={cx(o.kind !== 'file' && 'mono text-[12px]')}>{OPTION_LABEL[o.kind]}</span>
                  </button>
                </div>
              );
            })}
          </div>,
          document.getElementById('portal') ?? document.body,
        )}
    </div>
  );
}
