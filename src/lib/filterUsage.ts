import { RAW_SQL, type FilterOp, type FilterRule } from './filters';

/**
 * What you filter by most: columns per table and operators overall. The filter editor lists them first,
 * so in a table with 100 columns the few you always check are at the top. Kept in this browser only.
 */
export interface FilterUsage {
  ops: Record<string, number>;
  /** by table key (`connection/database/table`), then column */
  columns: Record<string, Record<string, number>>;
}

const KEY = 'rowline.filterUsage';
const TOP_COLUMNS = 5;
const TOP_OPS = 4;

export function loadFilterUsage(): FilterUsage {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FilterUsage> | null;
    return { ops: u?.ops ?? {}, columns: u?.columns ?? {} };
  } catch {
    return { ops: {}, columns: {} };
  }
}

/** Counts an applied filter and saves; returns the new usage */
export function recordFilterUse(usage: FilterUsage, table: string, rule: FilterRule): FilterUsage {
  if (rule.column === RAW_SQL) return usage;
  const cols = usage.columns[table] ?? {};
  const next: FilterUsage = {
    ops: { ...usage.ops, [rule.op]: (usage.ops[rule.op] ?? 0) + 1 },
    columns: { ...usage.columns, [table]: { ...cols, [rule.column]: (cols[rule.column] ?? 0) + 1 } },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage not available: the order is just not remembered */
  }
  return next;
}

/** The most used items (at most `top`, used at least once, most used first) and the rest in their own order */
function split<T extends string>(items: readonly T[], counts: Record<string, number> = {}, top: number): { frequent: T[]; rest: T[] } {
  const frequent = items
    .filter((i) => (counts[i] ?? 0) > 0)
    .sort((a, b) => counts[b] - counts[a] || items.indexOf(a) - items.indexOf(b))
    .slice(0, top);
  return { frequent, rest: items.filter((i) => !frequent.includes(i)) };
}

export const rankColumns = (names: readonly string[], usage: FilterUsage, table: string) => split(names, usage.columns[table], TOP_COLUMNS);

export const rankOps = (ops: readonly FilterOp[], usage: FilterUsage) => split(ops, usage.ops, TOP_OPS);
