/**
 * Columns hidden in a table's grid, remembered per table (`connection/database/table`) in this browser.
 * Only the grid hides them: filters, sort, the row panel and edits still know every column.
 */

const KEY = 'rowline.hiddenColumns';

function readAll(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export function loadHidden(table: string): string[] {
  const list = readAll()[table];
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
}

export function saveHidden(table: string, hidden: string[]) {
  const all = readAll();
  if (hidden.length) all[table] = [...new Set(hidden)];
  else delete all[table];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage not available: the choice lasts until the tab closes */
  }
}

/** Indexes of the columns to show. Never none: when every column would be hidden, all are shown. */
export function visibleIndexes(names: string[], hidden: readonly string[]): number[] {
  const h = new Set(hidden);
  const shown = names.map((_, i) => i).filter((i) => !h.has(names[i]));
  return shown.length ? shown : names.map((_, i) => i);
}

/** Hidden list that leaves only the key columns (primary and foreign keys) visible */
export function hideAllButKeys(names: string[], keys: ReadonlySet<string>): string[] {
  return keys.size ? names.filter((n) => !keys.has(n)) : [];
}

/** "Hide all": the grid needs one column, so the first primary key (or the first column) stays */
export function hideAllButOne(names: string[], primary: readonly string[]): string[] {
  const keep = primary.find((p) => names.includes(p)) ?? names[0];
  return names.filter((n) => n !== keep);
}
