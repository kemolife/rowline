import type { FilterColumn } from './filterComplete';

export interface ColumnHit extends FilterColumn {
  /** in the "most used" group */
  frequent: boolean;
  /** where the query matches in the name: [start, end), or null without a query */
  match: [number, number] | null;
}

/**
 * Columns for the searchable column field. Without a query: most used first, then the table order.
 * With a query: names that contain it (any case); a name that starts with it comes first, then a word
 * inside the name that starts with it (`_user` in `created_by_user`), then any other place. Most used
 * columns go first inside each of those groups.
 */
export function searchColumns(columns: readonly FilterColumn[], query: string, frequent: readonly string[] = []): ColumnHit[] {
  const often = new Set(frequent);
  const ordered = [...frequent.map((n) => columns.find((c) => c.name === n)).filter((c): c is FilterColumn => !!c), ...columns.filter((c) => !often.has(c.name))];
  const q = query.trim().toLowerCase();
  if (!q) return ordered.map((c) => ({ ...c, frequent: often.has(c.name), match: null }));
  const rank = (name: string, at: number) => (at === 0 ? 0 : /[_\W]/.test(name[at - 1]) ? 1 : 2);
  return ordered
    .map((c) => ({ c, at: c.name.toLowerCase().indexOf(q) }))
    .filter(({ at }) => at >= 0)
    .map(({ c, at }, i) => ({ hit: { ...c, frequent: often.has(c.name), match: [at, at + q.length] as [number, number] }, r: rank(c.name, at), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ hit }) => hit);
}
