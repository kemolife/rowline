import type { Relation } from './diagram';
import { joinSuggestions, maskSql, tableRefs } from './sqlAssist';

/**
 * SQL completion that depends on where the cursor is, like PhpStorm / DataGrip: statement keywords at the
 * start, tables after FROM / JOIN, columns after SELECT / WHERE / ON / BY, `alias.` → that table's columns.
 * Pure: text before the cursor in, ordered suggestions out.
 */

export type SuggestionKind = 'keyword' | 'table' | 'column' | 'function' | 'join';

export interface Suggestion {
  label: string;
  /** text inserted; defaults to label */
  insert?: string;
  kind: SuggestionKind;
  detail?: string;
}

export interface CompleteResult {
  /** offset (in the text given) where the replaced word starts */
  from: number;
  options: Suggestion[];
}

const START = [
  'SELECT',
  'INSERT INTO',
  'UPDATE',
  'DELETE FROM',
  'WITH',
  'SHOW TABLES',
  'SHOW CREATE TABLE',
  'DESCRIBE',
  'EXPLAIN',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'TRUNCATE TABLE',
  'SET',
];
const AFTER_TABLE = ['WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'LIMIT', 'AS', 'UNION', 'SET', 'VALUES'];
const CONDITION = ['AND', 'OR', 'NOT', 'IN ()', 'NOT IN ()', 'IS NULL', 'IS NOT NULL', 'LIKE', 'NOT LIKE', 'BETWEEN', 'EXISTS ()', 'ORDER BY', 'GROUP BY', 'LIMIT'];
const SELECT_LIST = ['FROM', 'AS', 'DISTINCT', 'CASE WHEN', 'THEN', 'ELSE', 'END'];
const GROUP = ['HAVING', 'ORDER BY', 'LIMIT', 'WITH ROLLUP'];
/** after a column or value in a condition: comparison words first */
const AFTER_OPERAND = ['LIKE', 'NOT LIKE', 'IN ()', 'NOT IN ()', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'LIMIT'];
/** words after which a column or value comes (not an operator) */
const OPERAND_STOP = new Set([
  'select',
  'distinct',
  'where',
  'on',
  'and',
  'or',
  'not',
  'by',
  'having',
  'set',
  'when',
  'then',
  'else',
  'case',
  'between',
  'like',
  'in',
  'is',
  'as',
  'from',
  'join',
  'values',
  'limit',
  'update',
  'into',
  'exists',
]);
const ORDER = ['ASC', 'DESC', 'LIMIT'];
const FUNCTIONS = [
  'COUNT(*)',
  'COUNT()',
  'SUM()',
  'AVG()',
  'MIN()',
  'MAX()',
  'CONCAT()',
  'COALESCE()',
  'IFNULL()',
  'NOW()',
  'DATE()',
  'LOWER()',
  'UPPER()',
  'LENGTH()',
  'ROUND()',
  'GROUP_CONCAT()',
  'JSON_EXTRACT()',
  'DATE_FORMAT()',
  'CAST()',
];

type Context = 'start' | 'tables' | 'join' | 'select' | 'condition' | 'group' | 'order' | 'set' | 'other';

/** The clause the cursor is in, from the last keyword before it */
function contextOf(masked: string): Context {
  const re = /\b(select|from|join|where|on|and|or|having|group\s+by|order\s+by|set|into|update|values|limit|table|by|as)\b|[(,;]/gi;
  let last: string | null = null;
  let prev: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (m[0] === ';') {
      last = null;
      prev = null;
      continue;
    }
    if (m[0] === '(' || m[0] === ',') {
      // "FROM a, " is still a table list; "SELECT a, " still a select list
      continue;
    }
    prev = last;
    last = m[1].toLowerCase().replace(/\s+/g, ' ');
  }
  void prev;
  if (!last) return 'start';
  switch (last) {
    case 'from':
    case 'update':
    case 'into':
    case 'table':
      return 'tables';
    case 'join':
      return 'join';
    case 'select':
    case 'as':
      return 'select';
    case 'where':
    case 'on':
    case 'and':
    case 'or':
    case 'having':
      return 'condition';
    case 'group by':
      return 'group';
    case 'order by':
    case 'by':
      return 'order';
    case 'set':
      return 'set';
    default:
      return 'other';
  }
}

/** usage counts → a small boost, so what you pick often comes first among equally good matches */
const boost = (usage: Record<string, number>, label: string) => Math.log2(1 + (usage[label.toLowerCase()] ?? 0));

/**
 * Suggestions for the text before the cursor. `schema`: table → columns. `relations`: for JOIN … ON.
 * Only words that start with what was typed come first; words that contain it follow.
 */
export function completeSql(
  before: string,
  schema: Map<string, string[]>,
  relations: Relation[] = [],
  usage: Record<string, number> = {},
  /** the text after the cursor: `SELECT r.| FROM ds_request r` names its tables after the cursor */
  after = '',
): CompleteResult | null {
  // only the statement the cursor is in
  const stmtStart = Math.max(0, maskSql(before).lastIndexOf(';') + 1);
  const text = before.slice(stmtStart);
  const masked = maskSql(text);
  const word = /[\w$]*$/.exec(masked)![0];
  const from = before.length - word.length;
  const head = masked.slice(0, masked.length - word.length);
  // inside a string or comment the masked text no longer ends like the real text: nothing to suggest
  const maskedAll = maskSql(before);
  if (before.length && maskedAll[maskedAll.length - 1] !== before[before.length - 1]) return null;

  // tables and aliases of the whole statement, also the part after the cursor (up to the next `;`)
  const semi = maskSql(after).indexOf(';');
  const rest = semi >= 0 ? after.slice(0, semi) : after;
  const refs = tableRefs(`${text.slice(0, text.length - word.length)} ${rest}`);
  const tablesInQuery = refs.filter((r) => schema.has(r.table) || schema.has(r.table.toLowerCase()));
  const colsOf = (t: string) => schema.get(t) ?? schema.get(t.toLowerCase()) ?? [];

  // alias.column
  const dot = /([\w$]+)\.\s*$/.exec(head);
  if (dot) {
    const ref = refs.find((r) => r.alias.toLowerCase() === dot[1].toLowerCase());
    const table = ref?.table ?? (schema.has(dot[1]) ? dot[1] : null);
    if (!table) return null;
    return rank(
      word,
      from,
      colsOf(table).map((c) => ({ label: c, kind: 'column' as const, detail: table })),
      usage,
    );
  }

  const ctx = contextOf(head);
  const kw = (list: string[]): Suggestion[] => list.map((k) => ({ label: k, insert: k.endsWith('()') ? k : `${k} `, kind: 'keyword' as const }));
  const fn = (): Suggestion[] => FUNCTIONS.map((f) => ({ label: f, kind: 'function' as const }));
  // a space after a table, so the alias or the next keyword can be typed right away
  const tables = (): Suggestion[] => [...schema.keys()].map((t) => ({ label: t, insert: `${t} `, kind: 'table' as const }));
  const columns = (): Suggestion[] => {
    const many = tablesInQuery.length > 1;
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const r of tablesInQuery) {
      for (const c of colsOf(r.table)) {
        const label = many ? `${r.alias}.${c}` : c;
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({ label, kind: 'column', detail: r.table });
      }
    }
    return out;
  };
  // a word right after a table name or a column list item means the clause is done: offer what comes next
  const lastToken = /([\w$`"]+)\s+$/.exec(head)?.[1]?.toLowerCase();
  const afterTableName = ctx === 'tables' && !!lastToken && !['from', 'update', 'into', 'table'].includes(lastToken) && !/,\s*$/.test(head);

  // right after a column or value (`WHERE r.id L`) comes an operator or keyword, never another column
  const prevTok = /(`[^`]*`|"[^"]*"|'[^']*'|[\w$.]+|\))\s+$/.exec(head)?.[1];
  const afterOperand = !!prevTok && !OPERAND_STOP.has(prevTok.toLowerCase());
  if (afterOperand && ctx !== 'start' && ctx !== 'tables' && ctx !== 'join') {
    const next =
      ctx === 'select'
        ? ['AS', 'FROM']
        : ctx === 'group'
          ? GROUP
          : ctx === 'order'
            ? ORDER
            : ctx === 'set'
              ? ['WHERE']
              : [...AFTER_OPERAND, ...(/\bwhere\b/i.test(head) ? [] : ['WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN'])];
    return rankOrTwoWord(kw(next));
  }

  let options: Suggestion[];
  switch (ctx) {
    case 'start':
      options = kw(START);
      break;
    case 'tables':
      options = afterTableName ? kw(AFTER_TABLE) : tables();
      break;
    case 'join': {
      if (/[\w$`"]\s+$/.test(head) && !/\bjoin\s+$/i.test(head)) {
        options = kw(['ON', 'AS', 'USING ()', 'WHERE', 'JOIN', 'LEFT JOIN']);
        break;
      }
      const joins = joinSuggestions(refs, relations).map((j) => ({ label: j.text, insert: `${j.text} `, kind: 'join' as const, detail: j.detail }));
      options = [...joins, ...tables()];
      break;
    }
    case 'select':
      options = [...columns(), ...fn(), ...kw(SELECT_LIST)];
      break;
    case 'condition':
      // after `JOIN … ON a = b` the statement can still go on with WHERE or another JOIN
      options = [...columns(), ...kw(/\bwhere\b/i.test(head) ? CONDITION : [...CONDITION, 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN']), ...fn()];
      break;
    case 'group':
      options = [...columns(), ...kw(GROUP)];
      break;
    case 'order':
      options = [...columns(), ...kw(ORDER)];
      break;
    case 'set':
      options = [...columns(), ...kw(['WHERE'])];
      break;
    default:
      options = [...columns(), ...kw([...CONDITION, ...AFTER_TABLE])];
  }
  // nothing typed yet: only after a space following a keyword (avoid popping up everywhere)
  if (!word && ctx === 'start') return null;
  return rankOrTwoWord(options);

  /** two-word keywords: `LEFT J` → LEFT JOIN, `ORDER B` → ORDER BY (the first word is replaced too) */
  function rankOrTwoWord(list: Suggestion[]): CompleteResult | null {
    const two = /([A-Za-z]+)\s+([A-Za-z]*)$/.exec(masked);
    if (two) {
      const phrase = `${two[1]} ${two[2]}`.toLowerCase();
      const multi = list.filter((o) => o.kind === 'keyword' && o.label.includes(' ') && o.label.toLowerCase().startsWith(phrase));
      if (multi.length) return { from: before.length - two[0].length, options: multi };
    }
    return rank(word, from, list, usage);
  }
}

/** Starts-with matches first (in the given order, then usage), then contains-matches; case-insensitive */
function rank(word: string, from: number, options: Suggestion[], usage: Record<string, number>): CompleteResult | null {
  const w = word.toLowerCase();
  const kindOrder = new Map<SuggestionKind, number>();
  for (const o of options) if (!kindOrder.has(o.kind)) kindOrder.set(o.kind, kindOrder.size);
  const scored = options
    .map((o, i) => {
      const l = o.label.toLowerCase();
      // `customer_id` also matches `cid`… no: keep it simple, start of the label or of a word in it
      const starts = l.startsWith(w) || (o.label.includes('.') && l.split('.').pop()!.startsWith(w));
      const wordStart = !starts && l.split(/[_\s.]/).some((part) => part.startsWith(w));
      const contains = !starts && !wordStart && w.length >= 2 && l.includes(w);
      const tier = !w ? 0 : starts ? 0 : wordStart ? 1 : contains ? 2 : -1;
      return { o, tier, i, k: kindOrder.get(o.kind)!, b: boost(usage, o.label) };
    })
    .filter((s) => s.tier >= 0 && !(s.o.label.toLowerCase() === w && s.o.kind === 'keyword'))
    // better match first; then the kinds in the order the context gives (JOINs before tables, columns before
    // keywords); usage only reorders within a kind
    .sort((a, b) => a.tier - b.tier || a.k - b.k || b.b - a.b || a.i - b.i);
  if (!scored.length) return null;
  return { from, options: scored.slice(0, 80).map((s) => s.o) };
}

const USAGE_KEY = 'rowline.completionUse';

/** How often each suggestion was picked (lower case label → count), kept on this Mac */
export function loadUsage(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export function recordUse(usage: Record<string, number>, label: string) {
  const k = label.toLowerCase();
  usage[k] = (usage[k] ?? 0) + 1;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    /* storage not available */
  }
}

/** Keywords followed by a name (table or column): after picking one, the suggestions open again */
const LEADS_TO_NAME =
  /^(select|select distinct|from|join|left join|inner join|right join|where|on|and|or|group by|order by|having|set|update|insert into|delete from|describe|show create table|alter table|truncate table|drop table)$/i;
export const opensNextSuggestions = (label: string) => LEADS_TO_NAME.test(label.trim());
