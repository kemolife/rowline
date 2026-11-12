import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { HEAD_H, ROW_H } from '../lib/diagram';
import type { ColumnView, TableView } from '../lib/schemaDiff';
import { cx, shortCount } from '../lib/ui';

/** below this zoom the boxes show only the table name */
export const COMPACT_ZOOM = 0.85;

export type TableNodeData = {
  table: TableView;
  /** the key columns shown in the box (see visibleColumns) */
  columns: ColumnView[];
  /** group colour from the outline */
  color: string;
  /** faded: another table is in focus and this one is not related to it, or it does not match the search */
  dim: boolean;
  /** this table is in focus (hovered or selected) */
  focus: boolean;
  /** columns of the relations in focus: highlighted */
  active: readonly string[];
};
export type TableNodeType = Node<TableNodeData, 'table'>;

const CHANGE_TEXT: Record<string, string> = { added: 'new', removed: 'removed', changed: 'changed' };
const CHANGE_COLOR: Record<string, string> = { added: 'var(--success)', removed: 'var(--danger)', changed: 'var(--warning)' };

/** One table on the relation diagram: name, row count and its key columns, with change marks */
function DiagramTableNode({ data, selected }: NodeProps<TableNodeType>) {
  const { table: t, columns: cols, color, dim, focus, active } = data;
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM);
  const hidden = t.columns.length - cols.length;
  const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
  const ring = selected || focus;
  const border = t.change ? CHANGE_COLOR[t.change] : ring ? 'var(--accent)' : 'var(--border-strong)';

  return (
    <div
      className={cx('w-full overflow-hidden rounded-lg border bg-surface text-[11.5px] transition-[opacity,box-shadow] duration-150', t.change === 'removed' && 'opacity-60')}
      style={{
        borderColor: border,
        opacity: dim ? 0.28 : undefined,
        boxShadow: ring ? '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent), 0 6px 16px rgba(40, 30, 20, 0.1)' : '0 1px 2px rgba(40, 30, 20, 0.06)',
      }}
      data-testid="diagram-table"
    >
      {/* table-level handles: used when the column is not shown (or the box is compact) */}
      <Handle type="target" position={Position.Left} id="table-in" className="!opacity-0" style={{ top: HEAD_H / 2 }} />
      <Handle type="source" position={Position.Right} id="table-out" className="!opacity-0" style={{ top: HEAD_H / 2 }} />
      <div
        className={cx('flex items-center gap-[7px] px-2.5', !compact && 'border-b border-line')}
        style={{ height: HEAD_H, background: ring ? 'color-mix(in srgb, var(--accent-soft) 60%, var(--surface))' : 'color-mix(in srgb, var(--surface-2) 40%, var(--surface))' }}
      >
        <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: color }} />
        <span className={cx('mono min-w-0 flex-1 truncate text-[12px] font-bold text-ink', t.change === 'removed' && 'line-through')} title={t.name}>
          {t.name}
        </span>
        {t.change && (
          <span className="shrink-0 rounded px-1 py-px text-[9.5px] font-bold uppercase text-white" style={{ background: CHANGE_COLOR[t.change] }}>
            {CHANGE_TEXT[t.change]}
          </span>
        )}
        {t.rowEstimate != null && <span className="shrink-0 tabular-nums text-[11px] text-ink-3">{shortCount(t.rowEstimate)}</span>}
      </div>
      {!compact && (
        <>
          {cols.map((c) => {
            const on = active.includes(c.name);
            return (
              <div
                key={c.name}
                className={cx(
                  'mono relative flex items-center gap-1.5 px-2.5',
                  on && 'bg-accent-soft',
                  !on && c.change === 'added' && 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)]',
                  !on && c.change === 'removed' && 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-ink-3 line-through',
                  !on && c.change === 'changed' && 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)]',
                )}
                style={{ height: ROW_H }}
                title={c.detail ?? `${c.name} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}${c.comment ? ` — ${c.comment}` : ''}`}
              >
                <Handle type="target" position={Position.Left} id={`${c.name}-in`} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
                <Handle type="source" position={Position.Right} id={`${c.name}-out`} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
                <span className={cx('w-[18px] shrink-0 font-[family-name:var(--font-ui)] text-[8.5px] font-bold', c.primaryKey ? 'text-warning' : 'text-link')}>
                  {c.primaryKey ? 'PK' : fkCols.has(c.name) ? 'FK' : ''}
                </span>
                <span className={cx('min-w-0 flex-1 truncate', on ? 'font-semibold text-accent' : c.primaryKey ? 'font-semibold text-ink' : 'text-ink-2')}>{c.name}</span>
                <span className="max-w-[40%] shrink-0 truncate text-[10.5px] text-ink-3 opacity-80">{c.dataType}</span>
              </div>
            );
          })}
          {hidden > 0 && (
            <div className="flex items-center border-t border-line pl-[34px] pr-2.5 text-[11px] text-ink-3" style={{ height: ROW_H }}>
              +{hidden} column{hidden === 1 ? '' : 's'}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default memo(DiagramTableNode);
