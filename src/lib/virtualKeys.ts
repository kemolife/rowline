import type { SchemaTable } from './schemaDiff';
import type { ForeignKeyInfo, TableStructure } from './types';

/** Mirrors model::VirtualKey: a relation the user confirmed, used like a foreign key */
export interface VirtualKey {
  id: string;
  connectionId: string;
  database: string | null;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

const PREFIX = 'virtual:';
export const isVirtual = (fk: Pick<ForeignKeyInfo, 'name'>) => fk.name.startsWith(PREFIX);
export const virtualKeyId = (fk: Pick<ForeignKeyInfo, 'name'>) => (isVirtual(fk) ? fk.name.slice(PREFIX.length) : null);

const asForeignKey = (k: VirtualKey): ForeignKeyInfo => ({ name: `${PREFIX}${k.id}`, columns: k.columns, refTable: k.refTable, refColumns: k.refColumns, onUpdate: null, onDelete: null });

/** A table's foreign keys plus its virtual ones (a real foreign key on the same columns wins) */
function merge(table: string, fks: ForeignKeyInfo[], keys: VirtualKey[]): ForeignKeyInfo[] {
  const taken = new Set(fks.map((f) => f.columns.join(',')));
  const extra = keys.filter((k) => k.table === table && !taken.has(k.columns.join(','))).map(asForeignKey);
  return extra.length ? [...fks, ...extra] : fks;
}

export function structureWithKeys(s: TableStructure, keys: VirtualKey[]): TableStructure {
  const foreignKeys = merge(s.name, s.foreignKeys, keys);
  return foreignKeys === s.foreignKeys ? s : { ...s, foreignKeys };
}

export function schemaWithKeys(tables: SchemaTable[], keys: VirtualKey[]): SchemaTable[] {
  if (!keys.length) return tables;
  return tables.map((t) => {
    const foreignKeys = merge(t.name, t.foreignKeys, keys);
    return foreignKeys === t.foreignKeys ? t : { ...t, foreignKeys };
  });
}
