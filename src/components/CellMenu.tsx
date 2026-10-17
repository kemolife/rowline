import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { ruleForValue, type FilterRule } from '../lib/filters';
import { type Cell, type RowValues } from '../lib/types';
import { formatCell } from '../lib/ui';
import { useDismiss } from '../lib/useDismiss';

interface Props {
  x: number;
  y: number;
  column: string;
  value: Cell;
  row: RowValues;
  editable: boolean;
  /** referenced table when the column is a foreign key */
  foreignKey: { table: string; column: string } | null;
  onFilter: (rule: FilterRule) => void;
  onOpenRelated: (sameTab: boolean) => void;
  /** tables whose rows point to this value: open them filtered */
  referencing?: { label: string; onOpen: () => void }[];
  onSetNull: () => void;
  onDeleteRow: () => void;
  onClose: () => void;
}

export default function CellMenu({ x, y, column, value, row, editable, foreignKey, onFilter, onOpenRelated, referencing = [], onSetNull, onDeleteRow, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const related = foreignKey && value !== null;

  type Item = [string, () => void, boolean?] | null;
  const relatedItems: Item[] = related
    ? [[`Open related row in ${foreignKey.table}`, () => onOpenRelated(false)], ['Open related row in this tab', () => onOpenRelated(true)], null]
    : [];
  const refs = value === null ? [] : referencing;
  const refItems: Item[] = refs.length ? [...refs.slice(0, 10).map((r): Item => [`Rows in ${r.label}`, r.onOpen]), null] : [];
  const items: Item[] = [
    ...relatedItems,
    ...refItems,
    ['Copy value', () => navigator.clipboard?.writeText(value === null ? '' : formatCell(value))],
    ['Copy row as JSON', () => navigator.clipboard?.writeText(JSON.stringify(row, null, 2))],
    null,
    [`Filter: ${column} ${value === null ? 'IS NULL' : '= value'}`, () => onFilter(ruleForValue(column, value))],
    [`Filter: ${column} ${value === null ? 'IS NOT NULL' : '≠ value'}`, () => onFilter(ruleForValue(column, value, true))],
    null,
    ['Set NULL', onSetNull, !editable || value === null],
    ['Delete row', onDeleteRow, !editable],
  ];

  // keep the menu inside the window
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.max(8, Math.min(y, window.innerHeight - (related ? 330 : 260) - Math.min(refs.length, 10) * 30));

  return createPortal(
    <div ref={ref} className="fade-in fixed z-50 w-60 rounded-lg border border-line-strong bg-surface-2 p-1 text-[12.5px] shadow-[var(--shadow)]" style={{ left, top }} data-testid="cell-menu">
      {items.map((it, i) =>
        it === null ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={it[0]}
            disabled={it[2]}
            className="flex w-full truncate rounded-md px-2.5 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={() => {
              it[1]();
              onClose();
            }}
          >
            {it[0]}
          </button>
        ),
      )}
    </div>,
    document.getElementById('portal') ?? document.body,
  );
}
