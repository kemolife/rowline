import type { ColumnInfo, ResultColumn, TableStructure } from './types';

/** How the grid shows a column: header badges, type hint and value style. */
export interface ColumnMeta {
  name: string;
  /** short type for the header: `bigint`, `varchar`, `bool` */
  typeHint: string;
  primaryKey: boolean;
  /** referenced table and column when this column alone is a foreign key */
  foreignKey: { table: string; column: string } | null;
  boolean: boolean;
  numeric: boolean;
  /** small integers 1–7 shown with a weekday name */
  weekday: boolean;
}

const NUMERIC = /int|decimal|numeric|float|double|real|year|serial/i;

/** `bigint unsigned` → `bigint`, `varchar(255)` → `varchar`, `tinyint(1)` → `bool` */
export function shortType(dataType: string): string {
  const t = dataType.trim().toLowerCase();
  if (isBooleanType(t)) return 'bool';
  return t.replace(/\(.*?\)/g, '').replace(/\b(unsigned|signed|zerofill)\b/g, '').trim().split(/\s+/)[0] || t;
}

export function isBooleanType(dataType: string): boolean {
  return /^(tinyint\(1\)|bool|boolean|bit\(1\))(\s|$)/i.test(dataType.trim());
}

const WEEKDAY_NAME = /(^|_)(day_of_week|weekday|dow)$/i;

export function columnMeta(columns: ResultColumn[], structure: TableStructure | null): ColumnMeta[] {
  const info = new Map<string, ColumnInfo>(structure?.columns.map((c) => [c.name, c]) ?? []);
  const fks = new Map<string, { table: string; column: string }>();
  for (const fk of structure?.foreignKeys ?? []) {
    if (fk.columns.length === 1 && fk.refColumns.length === 1) fks.set(fk.columns[0], { table: fk.refTable, column: fk.refColumns[0] });
  }
  return columns.map((c) => {
    const col = info.get(c.name);
    const type = col?.dataType ?? c.typeName;
    const boolean = isBooleanType(type);
    const numeric = !boolean && NUMERIC.test(type);
    return {
      name: c.name,
      typeHint: shortType(type),
      primaryKey: !!col?.primaryKey,
      foreignKey: fks.get(c.name) ?? null,
      boolean,
      numeric,
      weekday: numeric && WEEKDAY_NAME.test(c.name),
    };
  });
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** 1 = Mon … 7 = Sun (0 = Sun as well); null for anything else */
export function weekdayName(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 7 ? DAYS[n] : null;
}

/** Truthy for 1 / '1' / true; null for NULL; false otherwise */
export function boolValue(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** `agenda_event_client_page_uploads` → `agenda_event_…ge_uploads` (keeps the ending readable) */
export function middleTruncate(name: string, max = 26): string {
  if (name.length <= max) return name;
  const tail = Math.floor((max - 1) * 0.42);
  return `${name.slice(0, max - 1 - tail)}…${name.slice(-tail)}`;
}

/** Table groups by name prefix (`agenda_*`). Prefixes shared by fewer than `min` tables are not groups. */
export function groupByPrefix<T extends { name: string }>(items: T[], min = 2): { prefix: string | null; items: T[] }[] {
  // `agenda` itself belongs with `agenda_assets`, `agenda_event`
  const prefixOf = (n: string) => {
    const i = n.indexOf('_');
    return i > 0 ? n.slice(0, i + 1) : `${n}_`;
  };
  const counts = new Map<string, number>();
  for (const it of items) {
    const p = prefixOf(it.name);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const it of items) {
    const p = prefixOf(it.name);
    const key = (counts.get(p) ?? 0) >= min ? p : `\u0000${it.name}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(it);
  }
  return order.map((k) => ({ prefix: k.startsWith('\u0000') ? null : k, items: groups.get(k)! }));
}
