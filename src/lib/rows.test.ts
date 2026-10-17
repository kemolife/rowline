import { describe, expect, it } from 'vitest';
import { primaryKeyAt, validRowIndexes } from './rows';

const columns = [{ name: 'id', typeName: 'int' }, { name: 'name', typeName: 'text' }];
const rows = [[1, 'a'], [2, 'b']];

describe('row lookups', () => {
  it('returns the primary key of an existing row', () => {
    expect(primaryKeyAt(rows, columns, ['id'], 1)).toEqual({ id: 2 });
  });

  it('returns null for invalid indexes instead of throwing', () => {
    expect(primaryKeyAt(rows, columns, ['id'], -1)).toBeNull();
    expect(primaryKeyAt(rows, columns, ['id'], 2)).toBeNull();
    expect(primaryKeyAt(rows, columns, ['id'], 0.5)).toBeNull();
    expect(primaryKeyAt([], columns, ['id'], 0)).toBeNull();
  });

  it('returns null without a primary key or when the key column is not in the result', () => {
    expect(primaryKeyAt(rows, columns, [], 0)).toBeNull();
    expect(primaryKeyAt(rows, columns, ['missing'], 0)).toBeNull();
  });

  it('keeps only selected rows that exist', () => {
    expect(validRowIndexes([-1, 0, 3, 1, 5], 4)).toEqual([0, 1, 3]);
  });
});
