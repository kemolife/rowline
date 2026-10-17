import type { Cell, ResultColumn, RowValues } from './types';

const isRowIndex = (row: number, count: number) => Number.isInteger(row) && row >= 0 && row < count;

/**
 * Primary key values of a loaded row, or null when the row does not exist (the grid can report -1 for the
 * header, and a selection can point past the end after a reload) or the table has no usable primary key.
 */
export function primaryKeyAt(rows: Cell[][], columns: ResultColumn[], pkColumns: string[], row: number): RowValues | null {
  if (!pkColumns.length || !isRowIndex(row, rows.length)) return null;
  const key: RowValues = {};
  for (const pk of pkColumns) {
    const col = columns.findIndex((c) => c.name === pk);
    if (col < 0) return null;
    key[pk] = rows[row][col];
  }
  return key;
}

/** Selected row indexes that exist, sorted and unique */
export function validRowIndexes(rows: number[], rowCount: number): number[] {
  return [...new Set(rows.filter((r) => isRowIndex(r, rowCount)))].sort((a, b) => a - b);
}
