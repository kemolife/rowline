import type { Cell, Engine, SqlKeyword } from './types';

/** One entry of the value menu next to a field in the row panel */
export type ValueOption =
  | { kind: 'null' }
  | { kind: 'default' }
  | { kind: 'empty' }
  | { kind: 'now'; keyword: SqlKeyword }
  | { kind: 'pretty' }
  | { kind: 'file' };

export interface FieldInfo {
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  /** the column's default as the database reports it; null = none */
  defaultValue: string | null;
}

/** The SQL keyword for "now" that fits the column type, or null for non-date/time columns. */
export function nowKeyword(type: string): SqlKeyword | null {
  const t = type.toLowerCase();
  if (t.includes('datetime') || t.includes('timestamp')) return 'CURRENT_TIMESTAMP';
  if (t.startsWith('date')) return 'CURRENT_DATE';
  if (t.startsWith('time')) return 'CURRENT_TIME';
  return null;
}

const NUMERIC = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|bool|boolean|serial)\b/;

/** Columns that hold text (empty string and files make sense). SQLite columns may have no type at all. */
export function isTextLike(type: string): boolean {
  const t = type.toLowerCase().trim();
  return !NUMERIC.test(t) && !nowKeyword(t) && !t.startsWith('year');
}

/** `text` formatted as indented JSON, or null when it is not a JSON object or array. */
export function prettyJson(text: string): string | null {
  const s = text.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

/** The menu entries a field offers, in display order. */
export function valueOptions(field: FieldInfo, engine: Engine, isNewRow: boolean, value: Cell): ValueOption[] {
  const out: ValueOption[] = [];
  if (field.nullable && !field.primaryKey) out.push({ kind: 'null' });
  // SQLite can't set DEFAULT in an UPDATE; for a new row it simply leaves the column out
  const hasDefault = field.defaultValue != null || field.autoIncrement || field.nullable;
  if (hasDefault && (engine === 'mysql' || isNewRow)) out.push({ kind: 'default' });
  if (isTextLike(field.type)) out.push({ kind: 'empty' });
  const now = nowKeyword(field.type);
  if (now) out.push({ kind: 'now', keyword: now });
  if (typeof value === 'string' && prettyJson(value) !== null && prettyJson(value) !== value) out.push({ kind: 'pretty' });
  if (isTextLike(field.type)) out.push({ kind: 'file' });
  return out;
}
