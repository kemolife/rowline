import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Engine } from './types';

export interface FilterColumn {
  name: string;
  type: string;
}

const KEYWORDS = ['AND', 'OR', 'NOT', 'IS NULL', 'IS NOT NULL', 'LIKE', 'NOT LIKE', 'IN ()', 'NOT IN ()', 'BETWEEN', 'TRUE', 'FALSE'];

const FUNCTIONS: Record<Engine, string[]> = {
  mysql: ['NOW()', 'CURDATE()', 'DATE()', 'LOWER()', 'UPPER()', 'LENGTH()', 'COALESCE()', 'IFNULL()', 'CONCAT()', 'FIND_IN_SET()', 'JSON_EXTRACT()', 'DATE_SUB()', 'INTERVAL'],
  sqlite: ["datetime('now')", "date('now')", 'date()', 'lower()', 'upper()', 'length()', 'coalesce()', 'ifnull()', 'instr()', 'json_extract()'],
};

const RESERVED = new Set(['and', 'or', 'not', 'is', 'null', 'like', 'in', 'between', 'order', 'group', 'select', 'from', 'where', 'key', 'index', 'table', 'limit', 'desc', 'asc', 'by']);

/** Column name as it should be typed in the filter: plain when safe, quoted otherwise. */
export function columnIdent(name: string, engine: Engine): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  return engine === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** Completion items for the WHERE filter: columns first, then operators and functions. */
export function filterCompletions(columns: FilterColumn[], engine: Engine): Completion[] {
  // functions with "()" put the cursor between the brackets
  const withCursor = (label: string, type: string, boost: number): Completion => ({
    label,
    type,
    boost,
    apply: label.endsWith('()')
      ? (view, _c, from, to) => {
          view.dispatch({ changes: { from, to, insert: label }, selection: { anchor: from + label.length - 1 } });
        }
      : label,
  });
  return [
    ...columns.map((c) => ({ label: c.name, apply: columnIdent(c.name, engine), detail: c.type.toLowerCase(), type: 'property', boost: 2 })),
    ...KEYWORDS.map((k) => withCursor(k, 'keyword', 1)),
    ...FUNCTIONS[engine].map((f) => withCursor(f, 'function', 0)),
  ];
}

/** CodeMirror completion source: suggests while typing a word, or anywhere on Ctrl-Space. */
export function filterCompletionSource(getOptions: () => Completion[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[`"]?[\w$]*/);
    if (!word) return null;
    // inside a string literal: no suggestions
    const before = ctx.state.sliceDoc(0, word.from);
    if ((before.match(/'/g)?.length ?? 0) % 2 === 1) return null;
    if (word.from === word.to && !ctx.explicit) return null;
    // numbers are values, not names
    if (/^\d/.test(word.text)) return null;
    return { from: word.from, options: getOptions(), validFor: /^[`"]?[\w$]*$/ };
  };
}
