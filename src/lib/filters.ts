import { isSqlExpr, type Cell, type Engine } from './types';

/** Column filters of a table tab ("chips"), turned into the WHERE clause the backend runs. */

export const FILTER_OPS = [
  '=',
  '<>',
  '<',
  '>',
  '<=',
  '>=',
  'contains',
  'not contains',
  'starts with',
  'ends with',
  'LIKE',
  'NOT LIKE',
  'IN',
  'NOT IN',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
  'is empty',
  'is not empty',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Operators that take no value */
export const NO_VALUE_OPS: FilterOp[] = ['IS NULL', 'IS NOT NULL', 'is empty', 'is not empty'];

/** Column name of a rule that holds raw SQL instead of column / operator / value */
export const RAW_SQL = '';

export interface FilterRule {
  id: string;
  enabled: boolean;
  /** RAW_SQL: `value` is a SQL condition */
  column: string;
  op: FilterOp;
  value: string;
  /** second value of BETWEEN */
  value2?: string;
}

let ruleSeq = 0;
export function newRule(column: string, op: FilterOp = '=', value = ''): FilterRule {
  return { id: `f${Date.now().toString(36)}${++ruleSeq}`, enabled: true, column, op, value };
}

export function quoteIdent(engine: Engine, name: string): string {
  return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** A string literal; MySQL also treats backslash as an escape character in strings. */
export function stringLiteral(engine: Engine, s: string): string {
  const body = engine === 'mysql' ? s.replace(/\\/g, '\\\\').replace(/'/g, "''") : s.replace(/'/g, "''");
  return `'${body}'`;
}

/** SQL literal for a cell value (filters built from cell values) */
export function cellLiteral(engine: Engine, v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (isSqlExpr(v)) return v.$expr;
  return stringLiteral(engine, v);
}

const NUMERIC_TYPE = /int|decimal|numeric|float|double|real|year|bit|bool|serial/i;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** Value literal: numbers stay unquoted in numeric columns, everything else is a quoted string. */
function valueLiteral(engine: Engine, value: string, columnType: string | undefined): string {
  const v = value.trim();
  if (columnType && NUMERIC_TYPE.test(columnType) && NUMBER.test(v)) return v;
  return stringLiteral(engine, value);
}

/** LIKE pattern with % and _ in the value matched literally (escape character `!`, same in MySQL and SQLite) */
function likePattern(engine: Engine, value: string, before: string, after: string): string {
  const escaped = value.replace(/[!%_]/g, (c) => `!${c}`);
  return `${stringLiteral(engine, `${before}${escaped}${after}`)} ESCAPE '!'`;
}

/** Condition for one rule, or null when it is incomplete (e.g. no column, or BETWEEN without both values). */
export function ruleCondition(rule: FilterRule, engine: Engine, columnTypes: Record<string, string> = {}): string | null {
  if (rule.column === RAW_SQL) return rule.value.trim() || null;
  const col = quoteIdent(engine, rule.column);
  const type = columnTypes[rule.column];
  const lit = (v: string) => valueLiteral(engine, v, type);
  const list = (v: string) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '')
      .map(lit);
  switch (rule.op) {
    case 'IS NULL':
    case 'IS NOT NULL':
      return `${col} ${rule.op}`;
    case 'is empty':
      return `(${col} IS NULL OR ${col} = '')`;
    case 'is not empty':
      return `(${col} IS NOT NULL AND ${col} <> '')`;
    case 'contains':
      return `${col} LIKE ${likePattern(engine, rule.value, '%', '%')}`;
    case 'not contains':
      return `${col} NOT LIKE ${likePattern(engine, rule.value, '%', '%')}`;
    case 'starts with':
      return `${col} LIKE ${likePattern(engine, rule.value, '', '%')}`;
    case 'ends with':
      return `${col} LIKE ${likePattern(engine, rule.value, '%', '')}`;
    case 'LIKE':
    case 'NOT LIKE':
      return `${col} ${rule.op} ${stringLiteral(engine, rule.value)}`;
    case 'IN':
    case 'NOT IN': {
      const items = list(rule.value);
      return items.length ? `${col} ${rule.op} (${items.join(', ')})` : null;
    }
    case 'BETWEEN':
      return rule.value.trim() !== '' && (rule.value2 ?? '').trim() !== '' ? `${col} BETWEEN ${lit(rule.value)} AND ${lit(rule.value2 ?? '')}` : null;
    default:
      return `${col} ${rule.op} ${lit(rule.value)}`;
  }
}

/** WHERE clause (without the keyword) of the enabled rules joined with AND; null when there is nothing to filter. */
export function compileFilter(rules: FilterRule[], engine: Engine, columnTypes: Record<string, string> = {}): string | null {
  const parts = rules
    .filter((r) => r.enabled)
    .map((r) => ruleCondition(r, engine, columnTypes))
    .filter((c): c is string => !!c);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return parts.map((p) => `(${p})`).join(' AND ');
}

/** Short text for a chip: `user_team_id = 90` */
export function ruleLabel(rule: FilterRule): { column: string; op: string; value: string } {
  if (rule.column === RAW_SQL) return { column: 'SQL', op: '', value: rule.value };
  if (NO_VALUE_OPS.includes(rule.op)) return { column: rule.column, op: rule.op, value: '' };
  if (rule.op === 'BETWEEN') return { column: rule.column, op: 'between', value: `${rule.value} – ${rule.value2 ?? ''}` };
  return { column: rule.column, op: rule.op, value: rule.value };
}

/** Rule that matches a cell value exactly (filter by value, foreign key jumps) */
export function ruleForValue(column: string, value: Cell, negate = false): FilterRule {
  if (value === null) return newRule(column, negate ? 'IS NOT NULL' : 'IS NULL');
  const text = typeof value === 'boolean' ? (value ? '1' : '0') : isSqlExpr(value) ? value.$expr : String(value);
  return newRule(column, negate ? '<>' : '=', text);
}

/** Values of an ENUM / SET column type: `enum('new','it''s')` → ['new', "it's"]; null for other types */
export function enumValues(dataType: string): string[] | null {
  const m = /^\s*(?:enum|set)\s*\((.*)\)\s*$/is.exec(dataType);
  if (!m) return null;
  const out: string[] = [];
  const re = /'((?:[^'\\]|''|\\.)*)'/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[1]))) out.push(hit[1].replace(/''/g, "'").replace(/\\(.)/g, '$1'));
  return out;
}
