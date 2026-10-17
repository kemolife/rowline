import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Eye, KeyRound, Link2, Table2 } from 'lucide-react';
import { memo } from 'react';
import { HEAD_H, ROW_H } from '../lib/diagram';
import type { ColumnView, TableView } from '../lib/schemaDiff';
import { cx, formatCount } from '../lib/ui';

export type TableNodeData = {
  table: TableView;
  /** the key columns shown in the box (see visibleColumns) */
  columns: ColumnView[];
  /** faded: another table is selected and this one is not related to it */
  dim: boolean;
  /** related to the selected table */
  related: boolean;
};
export type TableNodeType = Node<TableNodeData, 'table'>;

const CHANGE_TEXT: Record<string, string> = { added: 'new', removed: 'removed', changed: 'changed' };

/** One table on the relation diagram: name, row count and its columns, with change marks */
function DiagramTableNode({ data, selected }: NodeProps<TableNodeType>) {
  const { table: t, columns: cols, dim, related } = data;
  const hidden = t.columns.length - cols.length;
  const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
  const border =
    t.change === 'added' ? 'var(--success)' : t.change === 'removed' ? 'var(--danger)' : t.change === 'changed' ? 'var(--warning)' : selected ? 'var(--sel-strong)' : related ? 'color-mix(in srgb, var(--sel-strong) 55%, var(--border))' : 'var(--border-strong)';

  return (
    <div
      className={cx('w-full overflow-hidden rounded-lg border bg-surface text-[11.5px] shadow-sm transition-opacity', dim && 'opacity-35', t.change === 'removed' && 'opacity-60')}
      style={{ borderColor: border, boxShadow: selected ? '0 0 0 2px var(--sel-strong)' : undefined }}
      data-testid="diagram-table"
    >
      {/* node-level handles for relations whose column is hidden */}
      <Handle type="target" position={Position.Left} id="table-in" className="!opacity-0" style={{ top: HEAD_H / 2 }} />
      <Handle type="source" position={Position.Right} id="table-out" className="!opacity-0" style={{ top: HEAD_H / 2 }} />
      <div className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-2.5" style={{ height: HEAD_H }}>
        {t.kind === 'view' ? <Eye size={12} className="shrink-0 text-ink-3" /> : <Table2 size={12} className="shrink-0 text-ink-3" />}
        <span className={cx('mono min-w-0 flex-1 truncate text-[12px] font-semibold text-ink', t.change === 'removed' && 'line-through')} title={t.name}>
          {t.name}
        </span>
        {t.change && (
          <span
            className="shrink-0 rounded px-1 py-px text-[9.5px] font-bold uppercase text-white"
            style={{ background: t.change === 'added' ? 'var(--success)' : t.change === 'removed' ? 'var(--danger)' : 'var(--warning)' }}
          >
            {CHANGE_TEXT[t.change]}
          </span>
        )}
        {t.rowEstimate != null && <span className="shrink-0 tabular-nums text-[10.5px] text-ink-3">{formatCount(t.rowEstimate)}</span>}
      </div>
      <div className="py-[3px]">
        {cols.map((c) => (
          <div
            key={c.name}
            className={cx(
              'relative flex items-center gap-1.5 px-2.5',
              c.change === 'added' && 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)]',
              c.change === 'removed' && 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-ink-3 line-through',
              c.change === 'changed' && 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)]',
            )}
            style={{ height: ROW_H }}
            title={c.detail ?? `${c.name} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}${c.comment ? ` — ${c.comment}` : ''}`}
          >
            <Handle type="target" position={Position.Left} id={`${c.name}-in`} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
            <Handle type="source" position={Position.Right} id={`${c.name}-out`} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
            <span className="flex w-3 shrink-0 justify-center">
              {c.primaryKey ? <KeyRound size={10} className="text-warning" /> : fkCols.has(c.name) ? <Link2 size={10} className="text-link" /> : null}
            </span>
            <span className={cx('mono min-w-0 flex-1 truncate', c.primaryKey ? 'font-semibold text-ink' : 'text-ink-2')}>{c.name}</span>
            <span className="mono max-w-[45%] shrink-0 truncate text-[10.5px] text-ink-3">{c.dataType}</span>
          </div>
        ))}
        {hidden > 0 && (
          <div className="flex items-center px-2.5 pl-7 text-[10.5px] text-ink-3" style={{ height: ROW_H }}>
            +{hidden} more column{hidden === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(DiagramTableNode);
