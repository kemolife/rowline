/**
 * Ranking for the ⌘K palette. Lower is better: 0 same text, 1 starts with, 2 contains,
 * 3 the letters in order (fuzzy, "cas" finds client_api_settings), 99 no match.
 */
export function score(label: string, needle: string): number {
  const l = label.toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return 0;
  if (l === n) return 0;
  if (l.startsWith(n)) return 1;
  if (l.includes(n)) return 2;
  let i = 0;
  for (const ch of l) if (ch === n[i]) i++;
  return i === n.length ? 3 : 99;
}

export interface ColumnHit {
  table: string;
  column: string;
}

/**
 * Columns whose name matches, over all tables of the database: "which table has user_id?".
 * Only for 2+ letters and no fuzzy matches (they would flood a database with thousands of columns).
 */
export function columnHits(columns: Record<string, string[]>, needle: string, limit = 25): ColumnHit[] {
  const n = needle.trim();
  if (n.length < 2) return [];
  const hits: (ColumnHit & { sc: number })[] = [];
  for (const [table, cols] of Object.entries(columns)) {
    for (const column of cols) {
      const sc = score(column, n);
      if (sc <= 2) hits.push({ table, column, sc });
    }
  }
  return hits
    .sort((a, b) => a.sc - b.sc || a.column.length - b.column.length || a.table.localeCompare(b.table))
    .slice(0, limit)
    .map(({ table, column }) => ({ table, column }));
}

/**
 * Tables for ⌘K from `schema_columns` keys (Postgres: `billing.invoices` outside `public`). A key matches by its whole
 * text or by the table part, so "inv" finds `billing.invoices` as well as `invoice_lines`.
 */
export function tableHits(keys: string[], needle: string, limit = 15): string[] {
  return keys
    .map((k) => ({ k, sc: Math.min(score(k, needle), score(k.slice(k.indexOf('.') + 1), needle)) }))
    .filter((x) => x.sc < 99)
    .sort((a, b) => a.sc - b.sc || a.k.length - b.k.length || a.k.localeCompare(b.k))
    .slice(0, limit)
    .map((x) => x.k);
}
