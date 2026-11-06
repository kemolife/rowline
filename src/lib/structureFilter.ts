import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableStructure } from './types';

export interface StructureFilter {
  /** text found in a column's name, type, default or comment, or in an index or foreign key name */
  q: string;
  /** primary and foreign key columns only */
  keys: boolean;
  /** columns that are part of an index only */
  indexed: boolean;
}

export interface FilteredStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** per column: the indexes it is part of */
  indexesOf: Map<string, IndexInfo[]>;
  /** per column: the foreign key that starts at it */
  foreignKeyOf: Map<string, ForeignKeyInfo>;
}

/** The Structure tab after a search: matching columns, and the indexes and foreign keys that touch them */
export function filterStructure(s: TableStructure, f: StructureFilter): FilteredStructure {
  const indexesOf = new Map<string, IndexInfo[]>();
  for (const i of s.indexes) for (const c of i.columns) indexesOf.set(c, [...(indexesOf.get(c) ?? []), i]);
  const foreignKeyOf = new Map<string, ForeignKeyInfo>();
  for (const k of s.foreignKeys) for (const c of k.columns) if (!foreignKeyOf.has(c)) foreignKeyOf.set(c, k);

  const needle = f.q.trim().toLowerCase();
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);
  if (!needle && !f.keys && !f.indexed) return { columns: s.columns, indexes: s.indexes, foreignKeys: s.foreignKeys, indexesOf, foreignKeyOf };

  const columns = s.columns.filter(
    (c) =>
      (!needle || has(c.name) || has(c.dataType) || has(c.defaultValue) || has(c.comment)) &&
      (!f.keys || c.primaryKey || foreignKeyOf.has(c.name)) &&
      (!f.indexed || indexesOf.has(c.name)),
  );
  const shown = new Set(columns.map((c) => c.name));
  const touches = (cols: string[]) => cols.some((c) => shown.has(c));
  return {
    columns,
    indexes: s.indexes.filter((i) => touches(i.columns) || (needle && has(i.name))),
    foreignKeys: s.foreignKeys.filter((k) => touches(k.columns) || (needle && (has(k.name) || has(k.refTable)))),
    indexesOf,
    foreignKeyOf,
  };
}
