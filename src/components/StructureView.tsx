import { Check, Copy, KeyRound, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { TableStructure } from '../lib/types';
import { isVirtual, virtualKeyId } from '../lib/virtualKeys';

interface NewKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export default function StructureView({
  structure,
  tables = [],
  onAddVirtualKey,
  onDeleteVirtualKey,
}: {
  structure: TableStructure;
  /** tables of the database, for the referenced table field */
  tables?: string[];
  onAddVirtualKey?: (key: NewKey) => Promise<boolean>;
  onDeleteVirtualKey?: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  return (
    <div className="mx-auto max-w-[1100px] space-y-6 p-6" data-testid="structure-view">
      <Section title="Columns" count={structure.columns.length}>
        <Table head={['', 'Name', 'Type', 'Nullable', 'Default', 'Extra', 'Comment']}>
          {structure.columns.map((c) => (
            <tr key={c.name} className="border-t border-line">
              <td className="w-6 pl-3">{c.primaryKey && <KeyRound size={12} className="text-accent" />}</td>
              <td className="mono py-2 pr-4 font-medium text-ink">{c.name}</td>
              <td className="mono pr-4 text-ink-2">{c.dataType}</td>
              <td className="pr-4 text-ink-2">{c.nullable ? 'YES' : <span className="text-ink-3">NO</span>}</td>
              <td className="mono pr-4 text-ink-2">{c.defaultValue ?? <span className="text-[var(--null)]">NULL</span>}</td>
              <td className="pr-4 text-ink-2">{c.autoIncrement ? 'auto increment' : ''}</td>
              <td className="pr-3 text-ink-3">{c.comment}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Indexes" count={structure.indexes.length}>
        {structure.indexes.length ? (
          <Table head={['Name', 'Columns', 'Type']}>
            {structure.indexes.map((i) => (
              <tr key={i.name} className="border-t border-line">
                <td className="mono py-2 pl-3 pr-4 font-medium text-ink">{i.name}</td>
                <td className="mono pr-4 text-ink-2">{i.columns.join(', ')}</td>
                <td className="pr-3 text-ink-2">{i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX'}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No indexes" />
        )}
      </Section>

      <Section
        title="Foreign keys"
        count={structure.foreignKeys.length}
        action={
          onAddVirtualKey && (
            <button className="btn btn-ghost h-7" onClick={() => setAdding(!adding)} title="A relation the database does not know: used for jumps, referencing rows, the diagram and JOIN completion" data-testid="add-virtual-key">
              <Plus size={13} /> Virtual foreign key
            </button>
          )
        }
      >
        {adding && onAddVirtualKey && <VirtualKeyForm structure={structure} tables={tables} onSave={async (k) => (await onAddVirtualKey(k)) && setAdding(false)} onCancel={() => setAdding(false)} />}
        {structure.foreignKeys.length ? (
          <Table head={['Name', 'Columns', 'References', 'On update', 'On delete']}>
            {structure.foreignKeys.map((f) => (
              <tr key={f.name} className="border-t border-line">
                <td className="mono py-2 pl-3 pr-4 font-medium text-ink">
                  {isVirtual(f) ? (
                    <span className="flex items-center gap-2">
                      <span className="rounded bg-sel px-1.5 py-px font-sans text-[10.5px] font-semibold text-link">virtual</span>
                      {onDeleteVirtualKey && (
                        <button className="icon-btn h-6 w-6" onClick={() => onDeleteVirtualKey(virtualKeyId(f)!)} title="Remove this virtual foreign key" aria-label="Remove virtual foreign key">
                          <X size={12} />
                        </button>
                      )}
                    </span>
                  ) : (
                    f.name
                  )}
                </td>
                <td className="mono pr-4 text-ink-2">{f.columns.join(', ')}</td>
                <td className="mono pr-4 text-ink-2">
                  {f.refTable}({f.refColumns.join(', ')})
                </td>
                <td className="pr-4 text-ink-2">{f.onUpdate}</td>
                <td className="pr-3 text-ink-2">{f.onDelete}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No foreign keys" />
        )}
      </Section>

      {structure.ddl && (
        <Section
          title="DDL"
          action={
            <button
              className="btn btn-ghost h-7"
              onClick={() => {
                navigator.clipboard?.writeText(structure.ddl ?? '');
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          }
        >
          <pre className="selectable mono overflow-x-auto rounded-xl border border-line bg-bg p-4 text-[12px] leading-relaxed text-ink">{structure.ddl}</pre>
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          {title} {count != null && <span className="font-normal">{count}</span>}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="selectable overflow-hidden rounded-xl border border-line bg-surface">
      <table className="w-full text-left text-[12.5px]">
        <thead>
          <tr className="bg-bg text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            {head.map((h, i) => (
              <th key={i} className={i === 0 ? 'py-2 pl-3 pr-4 font-semibold' : 'pr-4 font-semibold'}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-line px-4 py-3 text-[12.5px] text-ink-3">{text}</div>;
}

function VirtualKeyForm({ structure, tables, onSave, onCancel }: { structure: TableStructure; tables: string[]; onSave: (k: NewKey) => void; onCancel: () => void }) {
  const idCols = structure.columns.filter((c) => /_id$/i.test(c.name) && !c.primaryKey);
  const [column, setColumn] = useState(idCols[0]?.name ?? structure.columns[0]?.name ?? '');
  // `ds_person_id` → table `ds_person`, column `ds_person_id`; `customer_id` → `customers`, `id`
  const guessTable = (col: string) => {
    const base = col.replace(/_id$/i, '');
    return [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies')].find((t) => tables.includes(t)) ?? '';
  };
  const [refTable, setRefTable] = useState(() => guessTable(column));
  const [refColumn, setRefColumn] = useState(() => (refTable && `${refTable}_id` === column ? column : 'id'));
  const pick = (col: string) => {
    setColumn(col);
    const t = guessTable(col);
    setRefTable(t);
    setRefColumn(t && `${t}_id` === col ? col : 'id');
  };
  return (
    <form
      className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-bg p-3 text-[12.5px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (column && refTable.trim() && refColumn.trim()) onSave({ columns: [column], refTable: refTable.trim(), refColumns: [refColumn.trim()] });
      }}
      data-testid="virtual-key-form"
    >
      <label className="space-y-1">
        <div className="label">Column</div>
        <select className="field h-8 w-48" value={column} onChange={(e) => pick(e.target.value)}>
          {structure.columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <span className="pb-2 text-ink-3">→</span>
      <label className="space-y-1">
        <div className="label">Table</div>
        <input className="field field-mono h-8 w-56" list="vk-tables" value={refTable} onChange={(e) => setRefTable(e.target.value)} placeholder="ds_person" />
        <datalist id="vk-tables">
          {tables.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      <label className="space-y-1">
        <div className="label">Column</div>
        <input className="field field-mono h-8 w-40" value={refColumn} onChange={(e) => setRefColumn(e.target.value)} placeholder="id" />
      </label>
      <div className="flex gap-1.5 pb-px">
        <button type="submit" className="btn btn-primary h-8" disabled={!column || !refTable.trim() || !refColumn.trim()}>
          Save
        </button>
        <button type="button" className="btn btn-ghost h-8" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
