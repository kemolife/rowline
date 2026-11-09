import { Check, Copy, KeyRound, Plus, Search, Table2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { enumValues } from '../lib/filters';
import { filterStructure, type StructureFilter } from '../lib/structureFilter';
import type { TableStructure } from '../lib/types';
import { cx } from '../lib/ui';
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
  onOpenTable,
  onShowInData,
}: {
  structure: TableStructure;
  /** tables of the database, for the referenced table field */
  tables?: string[];
  onAddVirtualKey?: (key: NewKey) => Promise<boolean>;
  onDeleteVirtualKey?: (id: string) => void;
  /** opens a referenced table */
  onOpenTable?: (table: string) => void;
  /** switches to Data and shows only these columns there */
  onShowInData?: (columns: string[]) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<StructureFilter>({
    q: '',
    keys: false,
    indexed: false,
  });
  const [copiedNames, setCopiedNames] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const f = useMemo(() => filterStructure(structure, filter), [structure, filter]);
  const filtered = !!filter.q.trim() || filter.keys || filter.indexed;
  const names = f.columns.map((c) => c.name);

  // "/" or ⌘F puts the cursor in the search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable=true]');
      if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  return (
    <div data-testid="structure-view">
      <div className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-2 px-6 py-2.5">
          <div className="relative w-72">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              ref={search}
              className="field h-7 pl-8 pr-7 text-[12.5px]"
              placeholder={`Find among ${structure.columns.length} columns  /`}
              value={filter.q}
              onChange={(e) => setFilter((p) => ({ ...p, q: e.target.value }))}
              onKeyDown={(e) => e.key === 'Escape' && setFilter((p) => ({ ...p, q: '' }))}
              data-testid="structure-search"
            />
            {filter.q && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" onClick={() => setFilter((p) => ({ ...p, q: '' }))} aria-label="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
          <Toggle on={filter.keys} onClick={() => setFilter((p) => ({ ...p, keys: !p.keys }))} title="Primary and foreign key columns" testId="structure-keys">
            Keys
          </Toggle>
          <Toggle on={filter.indexed} onClick={() => setFilter((p) => ({ ...p, indexed: !p.indexed }))} title="Columns that are part of an index: fast in WHERE and JOIN" testId="structure-indexed">
            Indexed
          </Toggle>
          {filtered && (
            <>
              <span className="text-[12px] text-ink-3" data-testid="structure-count">
                {names.length} of {structure.columns.length}
              </span>
              {names.length > 0 && (
                <button
                  className="btn btn-ghost h-7"
                  onClick={() => {
                    navigator.clipboard?.writeText(names.join(', '));
                    setCopiedNames(true);
                    setTimeout(() => setCopiedNames(false), 1500);
                  }}
                  title="Copy these column names, comma separated (for a SELECT)"
                >
                  {copiedNames ? <Check size={13} /> : <Copy size={13} />} {copiedNames ? 'Copied' : 'Copy names'}
                </button>
              )}
              {onShowInData && names.length > 0 && (
                <button className="btn btn-ghost h-7" onClick={() => onShowInData(names)} title="Open Data with only these columns and the primary key" data-testid="structure-show-in-data">
                  <Table2 size={13} /> View data
                </button>
              )}
            </>
          )}
          <div className="ml-auto flex gap-1 text-[12px] text-ink-3">
            {(
              [
                ['structure-columns', 'Columns', f.columns.length],
                ['structure-indexes', 'Indexes', f.indexes.length],
                ['structure-fks', 'Foreign keys', f.foreignKeys.length],
                ...(structure.ddl ? [['structure-ddl', 'DDL', null]] : []),
              ] as [string, string, number | null][]
            ).map(([id, label, n]) => (
              <button key={id} className="rounded-md px-2 py-1 hover:bg-surface-2 hover:text-ink" onClick={() => jump(id)}>
                {label} {n != null && <span className="tabular-nums">{n}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1100px] space-y-6 p-6">
        <Section id="structure-columns" title="Columns" count={filtered ? `${f.columns.length} of ${structure.columns.length}` : structure.columns.length}>
          {f.columns.length ? (
            <Table head={['#', '', 'Name', 'Type', 'Nullable', 'Default', 'Keys', 'Comment']}>
              {f.columns.map((c) => {
                const fk = f.foreignKeyOf.get(c.name);
                const idx = (f.indexesOf.get(c.name) ?? []).filter((i) => !i.primary);
                return (
                  <tr key={c.name} className="group border-t border-line" data-testid="structure-column">
                    <td className="w-8 py-2 pl-3 pr-2 text-right text-[11px] tabular-nums text-ink-3">{structure.columns.indexOf(c) + 1}</td>
                    <td className="w-5">{c.primaryKey && <KeyRound size={12} className="text-accent" />}</td>
                    <td className="mono py-2 pr-4 font-medium text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        <span>
                          <Mark text={c.name} q={filter.q} />
                        </span>
                        <CopyName name={c.name} />
                      </span>
                    </td>
                    <td className="mono max-w-[380px] py-2 pr-4 text-ink-2">
                      <TypeCell type={c.dataType} defaultValue={c.defaultValue} q={filter.q} />
                    </td>
                    <td className="pr-4 text-ink-2">{c.nullable ? 'YES' : <span className="text-ink-3">NO</span>}</td>
                    <td className="mono pr-4 text-ink-2">{c.defaultValue ?? <span className="text-[var(--null)]">NULL</span>}</td>
                    <td className="pr-4">
                      <span className="flex flex-wrap items-center gap-1">
                        {c.autoIncrement && <Badge title="auto increment">AI</Badge>}
                        {fk && (
                          <button
                            className="mono rounded bg-sel px-1.5 py-px text-[11px] text-link hover:underline disabled:no-underline"
                            disabled={!onOpenTable}
                            onClick={() => onOpenTable?.(fk.refTable)}
                            title={`Foreign key ${isVirtual(fk) ? '(virtual)' : fk.name}: open ${fk.refTable}`}
                          >
                            → {fk.refTable}.{fk.refColumns[fk.columns.indexOf(c.name)] ?? fk.refColumns[0]}
                          </button>
                        )}
                        {idx.map((i) => (
                          <Badge key={i.name} title={`${i.unique ? 'Unique index' : 'Index'} ${i.name} (${i.columns.join(', ')})`}>
                            {i.unique ? 'unique' : 'index'}
                            {i.columns.length > 1 && ` ${i.columns.indexOf(c.name) + 1}/${i.columns.length}`}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td className="pr-3 text-ink-3">
                      <Mark text={c.comment ?? ''} q={filter.q} />
                    </td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <Empty text={`No column matches${filter.q.trim() ? ` “${filter.q.trim()}”` : ''}`} />
          )}
        </Section>

        <Section id="structure-indexes" title="Indexes" count={f.indexes.length}>
          {f.indexes.length ? (
            <Table head={['Name', 'Columns', 'Type']}>
              {f.indexes.map((i) => (
                <tr key={i.name} className="border-t border-line">
                  <td className="mono py-2 pl-3 pr-4 font-medium text-ink">
                    <Mark text={i.name} q={filter.q} />
                  </td>
                  <td className="mono pr-4 text-ink-2">{i.columns.join(', ')}</td>
                  <td className="pr-3 text-ink-2">{i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX'}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text={filtered ? 'No index on these columns' : 'No indexes'} />
          )}
        </Section>

        <Section
          id="structure-fks"
          title="Foreign keys"
          count={f.foreignKeys.length}
          action={
            onAddVirtualKey && (
              <button
                className="btn btn-ghost h-7"
                onClick={() => setAdding(!adding)}
                title="A relation the database does not know: used for jumps, referencing rows, the diagram and JOIN completion"
                data-testid="add-virtual-key"
              >
                <Plus size={13} /> Virtual foreign key
              </button>
            )
          }
        >
          {adding && onAddVirtualKey && <VirtualKeyForm structure={structure} tables={tables} onSave={async (k) => (await onAddVirtualKey(k)) && setAdding(false)} onCancel={() => setAdding(false)} />}
          {f.foreignKeys.length ? (
            <Table head={['Name', 'Columns', 'References', 'On update', 'On delete']}>
              {f.foreignKeys.map((k) => (
                <tr key={k.name} className="border-t border-line">
                  <td className="mono py-2 pl-3 pr-4 font-medium text-ink">
                    {isVirtual(k) ? (
                      <span className="flex items-center gap-2">
                        <span className="rounded bg-sel px-1.5 py-px font-sans text-[10.5px] font-semibold text-link">virtual</span>
                        {onDeleteVirtualKey && (
                          <button className="icon-btn h-6 w-6" onClick={() => onDeleteVirtualKey(virtualKeyId(k)!)} title="Remove this virtual foreign key" aria-label="Remove virtual foreign key">
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ) : (
                      k.name
                    )}
                  </td>
                  <td className="mono pr-4 text-ink-2">{k.columns.join(', ')}</td>
                  <td className="mono pr-4 text-ink-2">
                    {onOpenTable ? (
                      <button className="text-link hover:underline" onClick={() => onOpenTable(k.refTable)} title={`Open ${k.refTable}`}>
                        {k.refTable}({k.refColumns.join(', ')})
                      </button>
                    ) : (
                      `${k.refTable}(${k.refColumns.join(', ')})`
                    )}
                  </td>
                  <td className="pr-4 text-ink-2">{k.onUpdate}</td>
                  <td className="pr-3 text-ink-2">{k.onDelete}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text={filtered ? 'No foreign key on these columns' : 'No foreign keys'} />
          )}
        </Section>

        {structure.ddl && (
          <Section
            id="structure-ddl"
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
    </div>
  );
}

function Section({ id, title, count, action, children }: { id?: string; title: string; count?: number | string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-14">
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
    <div className="selectable overflow-x-auto rounded-xl border border-line bg-surface">
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

function Toggle({ on, onClick, title, testId, children }: { on: boolean; onClick: () => void; title: string; testId: string; children: React.ReactNode }) {
  return (
    <button
      className={cx('h-7 rounded-md px-2.5 text-[12px]', on ? 'bg-sel font-medium text-link' : 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink')}
      onClick={onClick}
      aria-pressed={on}
      title={title}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function Badge({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span className="rounded bg-surface-2 px-1.5 py-px text-[10.5px] text-ink-2" title={title}>
      {children}
    </span>
  );
}

/** Column type; an ENUM or SET shows every value, the default one marked */
function TypeCell({ type, defaultValue, q }: { type: string; defaultValue: string | null; q: string }) {
  const [all, setAll] = useState(false);
  const values = enumValues(type);
  if (!values) return <Mark text={type} q={q} />;
  const needle = q.trim().toLowerCase();
  // long lists: the first values, the default and the searched ones; the rest on hover or click
  const shown = all || values.length <= 10 ? values : values.filter((v, i) => i < 8 || v === defaultValue || (needle && v.toLowerCase().includes(needle)));
  const rest = values.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1" title={type}>
      <span className="mr-0.5">{/^\s*set/i.test(type) ? 'set' : 'enum'}</span>
      {shown.map((v) => (
        <span
          key={v}
          className={cx('rounded px-1.5 py-px text-[11px]', v === defaultValue ? 'bg-sel text-link' : 'bg-surface-2')}
          title={v === defaultValue ? 'Default value' : v}
          data-testid="enum-value"
        >
          {v === '' ? <span className="text-ink-3">empty</span> : <Mark text={v} q={q} />}
        </span>
      ))}
      {rest > 0 && (
        <button
          className="rounded px-1.5 py-px text-[11px] text-link hover:bg-surface-2"
          onClick={() => setAll(true)}
          title={values.filter((v) => !shown.includes(v)).join(', ')}
          data-testid="enum-more"
        >
          +{rest} more
        </button>
      )}
    </span>
  );
}

/** Text with the searched part highlighted */
function Mark({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-[var(--accent)]/25 text-inherit">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function CopyName({ name }: { name: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100"
      onClick={() => {
        navigator.clipboard?.writeText(name);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      title={`Copy ${name}`}
      aria-label={`Copy ${name}`}
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
    </button>
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
        if (column && refTable.trim() && refColumn.trim())
          onSave({
            columns: [column],
            refTable: refTable.trim(),
            refColumns: [refColumn.trim()],
          });
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
