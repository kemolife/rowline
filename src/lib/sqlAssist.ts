import type { Relation } from './diagram';

/** Helpers for the SQL editor: tables and aliases of a query, JOIN suggestions, warnings. */

/** Strings and comments replaced by spaces (same length), so keywords inside them are not seen */
export function maskSql(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.|'')*'?|"(?:[^"\\]|\\.)*"?|--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => {
    // keep the quotes of string literals; identifiers in double quotes are kept as they are
    if (m.startsWith('"')) return m;
    if (m.startsWith("'")) return `'${' '.repeat(Math.max(0, m.length - 2))}${m.length > 1 ? "'" : ''}`;
    return m.replace(/[^\n]/g, ' ');
  });
}

const KEYWORDS = new Set(
  'where join left right inner outer full cross natural straight_join on using set group order limit having union values select as with into from update delete insert window for lock'.split(' '),
);
const unquote = (s: string) => s.replace(/^[`"[]|[`"\]]$/g, '');

export interface TableRef {
  table: string;
  /** alias, or the table name itself */
  alias: string;
  /** offset of the table name in the text */
  at: number;
  /** written with a database (`shop.orders`): not checked against this database */
  qualified: boolean;
}

const IDENT = '(?:`[^`]+`|"[^"]+"|[\\w$]+)';

/** Tables of a statement with their aliases: FROM a x, b, JOIN c AS y, UPDATE d, INSERT INTO e, DELETE FROM f */
export function tableRefs(sql: string): TableRef[] {
  const text = maskSql(sql);
  const out: TableRef[] = [];
  const add = (name: string, alias: string | undefined, at: number) => {
    const parts = name.split('.');
    const table = unquote(parts[parts.length - 1]);
    const a = alias && !KEYWORDS.has(alias.toLowerCase()) ? unquote(alias) : table;
    out.push({ table, alias: a, at: at + name.lastIndexOf(parts[parts.length - 1]), qualified: parts.length > 1 });
  };
  const one = new RegExp(`(${IDENT}(?:\\s*\\.\\s*${IDENT})?)(?:\\s+(?:as\\s+)?(${IDENT}))?`, 'iy');
  const head = /\b(from|join|update|into)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text))) {
    let pos = m.index + m[0].length;
    // FROM a, b, c: a comma list
    for (;;) {
      one.lastIndex = pos;
      const t = one.exec(text);
      if (!t || KEYWORDS.has(t[1].toLowerCase()) || t[1].startsWith('(')) break;
      add(t[1].replace(/\s+/g, ''), t[2], pos);
      pos = one.lastIndex;
      const comma = /\s*,\s*/y;
      comma.lastIndex = pos;
      if (m[1].toLowerCase() !== 'from' || !comma.exec(text)) break;
      pos = comma.lastIndex;
    }
  }
  return out;
}

/** `ds_person` → `dp`, `orders` → `o`; never an alias that is taken */
export function aliasFor(table: string, taken: Set<string>): string {
  const parts = table
    .toLowerCase()
    .split(/[_\W]+/)
    .filter(Boolean);
  const base = parts.map((p) => p[0]).join('') || 't';
  let a = base;
  for (let i = 2; taken.has(a) || KEYWORDS.has(a); i++) a = `${base}${i}`;
  return a;
}

export interface JoinSuggestion {
  /** shown in the list: `ds_person dp ON dp.ds_person_id = r.ds_person_id` */
  text: string;
  table: string;
  detail: 'foreign key' | 'virtual' | 'guessed';
}

/** JOINs that connect a new table to the tables already in the statement, using the relations */
export function joinSuggestions(refs: TableRef[], relations: Relation[]): JoinSuggestion[] {
  const byTable = new Map<string, TableRef>();
  for (const r of refs) if (!byTable.has(r.table.toLowerCase())) byTable.set(r.table.toLowerCase(), r);
  const taken = new Set(refs.map((r) => r.alias.toLowerCase()));
  const out: JoinSuggestion[] = [];
  const seen = new Set<string>();
  for (const rel of relations) {
    if (rel.fromColumns.length !== 1 || rel.toColumns.length !== 1) continue;
    const detail = rel.guessed ? 'guessed' : rel.virtual ? 'virtual' : 'foreign key';
    const from = byTable.get(rel.from.toLowerCase());
    const to = byTable.get(rel.to.toLowerCase());
    // this statement has the referencing table: join the referenced one, and the other way round
    const pairs: [TableRef | undefined, string, string, string][] = [
      [from, rel.to, rel.toColumns[0], rel.fromColumns[0]],
      [to, rel.from, rel.fromColumns[0], rel.toColumns[0]],
    ];
    for (const [have, table, newCol, haveCol] of pairs) {
      if (!have) continue;
      const alias = aliasFor(table, taken);
      const text = `${table} ${alias} ON ${alias}.${newCol} = ${have.alias}.${haveCol}`;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ text, table, detail });
    }
  }
  const rank = { 'foreign key': 0, virtual: 1, guessed: 2 } as const;
  return out.sort((a, b) => rank[a.detail] - rank[b.detail] || a.table.localeCompare(b.table));
}

export interface SqlIssue {
  from: number;
  to: number;
  message: string;
  severity: 'warning' | 'error';
  /** one-click fix: put `insert` in place of from..to */
  fix?: { label: string; insert: string };
}

/**
 * `ds_request.col` while the query calls the table `r` (`FROM ds_request AS r`): MySQL then only knows `r`,
 * and fails with "Unknown column 'ds_request.col'". One issue per such use, with the alias as the fix.
 */
export function aliasedTableUses(sql: string): SqlIssue[] {
  const text = maskSql(sql);
  const refs = tableRefs(sql);
  const aliasOf = new Map<string, string>();
  for (const r of refs) if (r.alias.toLowerCase() !== r.table.toLowerCase()) aliasOf.set(r.table.toLowerCase(), r.alias);
  // a table that is also used without an alias (joined twice) is fine
  for (const r of refs) if (r.alias.toLowerCase() === r.table.toLowerCase()) aliasOf.delete(r.table.toLowerCase());
  const known = new Set(refs.map((r) => r.alias.toLowerCase()));
  const out: SqlIssue[] = [];
  for (const m of text.matchAll(/(?<![\w$.`])([\w$]+)\.([\w$]+)\b(?!\s*\()/g)) {
    const alias = aliasOf.get(m[1].toLowerCase());
    if (!alias || known.has(m[1].toLowerCase())) continue;
    out.push({
      from: m.index!,
      to: m.index! + m[1].length,
      message: `${m[1]} is called ${alias} in this query (… ${m[1]} AS ${alias}); MySQL only knows ${alias}.${m[2]}`,
      severity: 'error',
      fix: { label: `Use ${alias}`, insert: alias },
    });
  }
  return out;
}

/** Changes every row: UPDATE or DELETE without WHERE */
export function updatesAllRows(sql: string): boolean {
  const t = maskSql(sql).trim();
  return /^(update|delete)\b/i.test(t) && !/\bwhere\b/i.test(t);
}

/**
 * Warnings for one statement: UPDATE / DELETE without WHERE, tables this database does not have,
 * and `alias.column` where the table has no such column. `schema`: table → columns (lower case).
 */
export function lintStatement(sql: string, schema: Map<string, Set<string>>): SqlIssue[] {
  const issues: SqlIssue[] = [];
  const text = maskSql(sql);
  const lead = text.search(/\S/);
  if (lead >= 0 && updatesAllRows(sql)) {
    const word = /^\w+/.exec(text.slice(lead))![0];
    issues.push({ from: lead, to: lead + word.length, message: `${word.toUpperCase()} without WHERE changes every row of the table.`, severity: 'warning' });
  }
  issues.push(...aliasedTableUses(sql));
  if (!schema.size) return issues;
  // CTE names and derived tables are not real tables
  const ctes = new Set([...text.matchAll(/(?:\bwith|,)\s*([\w$]+)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const refs = tableRefs(sql);
  const aliases = new Map<string, string>();
  for (const r of refs) {
    const t = r.table.toLowerCase();
    aliases.set(r.alias.toLowerCase(), t);
    if (r.qualified || ctes.has(t) || schema.has(t)) continue;
    issues.push({ from: r.at, to: r.at + r.table.length, message: `Unknown table: ${r.table}`, severity: 'warning' });
  }
  for (const m of text.matchAll(/\b([\w$]+)\.([\w$]+)\b(?!\s*\()/g)) {
    const table = aliases.get(m[1].toLowerCase());
    const cols = table ? schema.get(table) : undefined;
    if (!cols || cols.has(m[2].toLowerCase())) continue;
    const at = m.index! + m[1].length + 1;
    issues.push({ from: at, to: at + m[2].length, message: `${table} has no column ${m[2]}`, severity: 'warning' });
  }
  return issues;
}

/** A plain-language hint for a database error, when Rowline can tell what went wrong */
export function explainSqlError(message: string, sql: string): string | null {
  // ERROR 1054: Unknown column 'ds_request.ds_request_id' in 'on clause'
  const m = /Unknown column '([\w$]+)\.([\w$]+)'/i.exec(message);
  if (m) {
    const ref = tableRefs(sql).find((r) => r.table.toLowerCase() === m[1].toLowerCase() && r.alias.toLowerCase() !== r.table.toLowerCase());
    if (ref) return `In this query \`${m[1]}\` is called \`${ref.alias}\` (${m[1]} AS ${ref.alias}). Write ${ref.alias}.${m[2]} instead of ${m[1]}.${m[2]}.`;
  }
  return null;
}
