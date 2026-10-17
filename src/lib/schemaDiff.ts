import type { ColumnInfo, ForeignKeyInfo, ObjectKind } from './types';

/** Mirrors model::SchemaTable */
export interface SchemaTable {
  name: string;
  kind: ObjectKind;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowEstimate: number | null;
  comment: string | null;
  /** primary key and unique indexes; missing in snapshots made before it existed */
  uniqueKeys?: string[][];
}

/** Mirrors model::SchemaSnapshot */
export interface SchemaSnapshot {
  takenAt: string;
  tables: SchemaTable[];
}

export type Change = 'added' | 'removed' | 'changed';

export interface ColumnView extends ColumnInfo {
  change: Change | null;
  /** what changed, e.g. `varchar(100) → varchar(255)` */
  detail: string | null;
}

export interface ForeignKeyView extends ForeignKeyInfo {
  change: Exclude<Change, 'changed'> | null;
}

/** A table as the diagram shows it: the live table, with dropped columns and keys kept as "removed" */
export interface TableView {
  name: string;
  kind: ObjectKind;
  rowEstimate: number | null;
  comment: string | null;
  change: Change | null;
  columns: ColumnView[];
  foreignKeys: ForeignKeyView[];
  uniqueKeys: string[][];
}

export interface SchemaDiff {
  tables: TableView[];
  summary: { tablesAdded: number; tablesRemoved: number; tablesChanged: number; columnsAdded: number; columnsRemoved: number; columnsChanged: number };
}

const fkKey = (f: ForeignKeyInfo) => `${f.columns.join(',')}->${f.refTable}(${f.refColumns.join(',')})`;

function columnDetail(a: ColumnInfo, b: ColumnInfo): string | null {
  const parts: string[] = [];
  if (a.dataType !== b.dataType) parts.push(`${a.dataType} → ${b.dataType}`);
  if (a.nullable !== b.nullable) parts.push(b.nullable ? 'now NULL allowed' : 'now NOT NULL');
  if ((a.defaultValue ?? null) !== (b.defaultValue ?? null)) parts.push(`default ${a.defaultValue ?? 'none'} → ${b.defaultValue ?? 'none'}`);
  if (a.primaryKey !== b.primaryKey) parts.push(b.primaryKey ? 'now primary key' : 'no longer primary key');
  return parts.length ? parts.join(', ') : null;
}

const plainTable = (t: SchemaTable, change: Change | null = null): TableView => ({
  name: t.name,
  kind: t.kind,
  rowEstimate: t.rowEstimate,
  comment: t.comment,
  change,
  uniqueKeys: t.uniqueKeys ?? [],
  columns: t.columns.map((c) => ({ ...c, change: change === 'changed' ? null : change, detail: null })),
  foreignKeys: t.foreignKeys.map((f) => ({ ...f, change: change === 'added' || change === 'removed' ? change : null })),
});

/**
 * Compares the live schema with a snapshot. Without a snapshot nothing is marked.
 * Removed tables and columns stay in the result (as ghosts) so the diagram can show what disappeared.
 */
export function diffSchema(snapshot: SchemaTable[] | null, live: SchemaTable[]): SchemaDiff {
  const summary = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0 };
  if (!snapshot) return { tables: live.map((t) => plainTable(t)), summary };
  const before = new Map(snapshot.map((t) => [t.name, t]));
  const tables: TableView[] = [];

  for (const t of live) {
    const old = before.get(t.name);
    if (!old) {
      summary.tablesAdded++;
      tables.push(plainTable(t, 'added'));
      continue;
    }
    const oldCols = new Map(old.columns.map((c) => [c.name, c]));
    const liveNames = new Set(t.columns.map((c) => c.name));
    const columns: ColumnView[] = [];
    for (const c of t.columns) {
      const prev = oldCols.get(c.name);
      if (!prev) {
        summary.columnsAdded++;
        columns.push({ ...c, change: 'added', detail: null });
      } else {
        const detail = columnDetail(prev, c);
        if (detail) summary.columnsChanged++;
        columns.push({ ...c, change: detail ? 'changed' : null, detail });
      }
    }
    for (const c of old.columns) {
      if (liveNames.has(c.name)) continue;
      summary.columnsRemoved++;
      columns.push({ ...c, change: 'removed', detail: null });
    }
    const oldFks = new Set(old.foreignKeys.map(fkKey));
    const liveFks = new Set(t.foreignKeys.map(fkKey));
    const foreignKeys: ForeignKeyView[] = [
      ...t.foreignKeys.map((f) => ({ ...f, change: oldFks.has(fkKey(f)) ? null : ('added' as const) })),
      ...old.foreignKeys.filter((f) => !liveFks.has(fkKey(f))).map((f) => ({ ...f, change: 'removed' as const })),
    ];
    const changed = columns.some((c) => c.change) || foreignKeys.some((f) => f.change);
    if (changed) summary.tablesChanged++;
    tables.push({ name: t.name, kind: t.kind, rowEstimate: t.rowEstimate, comment: t.comment, change: changed ? 'changed' : null, columns, foreignKeys, uniqueKeys: t.uniqueKeys ?? [] });
  }
  const liveNames = new Set(live.map((t) => t.name));
  for (const t of snapshot) {
    if (liveNames.has(t.name)) continue;
    summary.tablesRemoved++;
    tables.push(plainTable(t, 'removed'));
  }
  return { tables, summary };
}

export function hasChanges(s: SchemaDiff['summary']): boolean {
  return Object.values(s).some((n) => n > 0);
}

/** "+2 tables, 5 columns changed" */
export function summaryText(s: SchemaDiff['summary']): string {
  const parts: string[] = [];
  const n = (v: number, word: string) => `${v} ${word}${v === 1 ? '' : 's'}`;
  if (s.tablesAdded) parts.push(`+${n(s.tablesAdded, 'table')}`);
  if (s.tablesRemoved) parts.push(`−${n(s.tablesRemoved, 'table')}`);
  if (s.tablesChanged) parts.push(`${n(s.tablesChanged, 'table')} changed`);
  if (s.columnsAdded) parts.push(`+${n(s.columnsAdded, 'column')}`);
  if (s.columnsRemoved) parts.push(`−${n(s.columnsRemoved, 'column')}`);
  if (s.columnsChanged) parts.push(`${n(s.columnsChanged, 'column')} changed`);
  return parts.length ? parts.join(', ') : 'No changes';
}

/** Lines describing the changes of some tables, for Claude */
export function changeLines(tables: TableView[]): string[] {
  const out: string[] = [];
  for (const t of tables) {
    if (t.change === 'added') out.push(`- table ${t.name} was added`);
    else if (t.change === 'removed') out.push(`- table ${t.name} was removed`);
    for (const c of t.columns) {
      if (t.change === 'added' || t.change === 'removed') break;
      if (c.change === 'added') out.push(`- ${t.name}.${c.name} was added (${c.dataType})`);
      if (c.change === 'removed') out.push(`- ${t.name}.${c.name} was removed`);
      if (c.change === 'changed') out.push(`- ${t.name}.${c.name} changed: ${c.detail}`);
    }
    for (const f of t.foreignKeys) {
      if (t.change === 'added' || t.change === 'removed') break;
      if (f.change) out.push(`- foreign key ${t.name}(${f.columns.join(', ')}) → ${f.refTable}(${f.refColumns.join(', ')}) was ${f.change}`);
    }
  }
  return out;
}
