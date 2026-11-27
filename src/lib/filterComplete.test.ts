import { describe, expect, it } from 'vitest';
import { columnIdent, filterCompletions } from './filterComplete';

describe('filter completions', () => {
  it('quotes only names that need it', () => {
    expect(columnIdent('client_id', 'mysql')).toBe('client_id');
    expect(columnIdent('order', 'mysql')).toBe('`order`');
    expect(columnIdent('my col', 'sqlite')).toBe('"my col"');
  });

  it('lists columns first, then operators and functions', () => {
    const items = filterCompletions([{ name: 'order', type: 'INT' }, { name: 'name', type: 'VARCHAR(255)' }], 'mysql');
    expect(items[0]).toMatchObject({ label: 'order', apply: '`order`', detail: 'int', type: 'property' });
    expect(items[1]).toMatchObject({ label: 'name', apply: 'name' });
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['IS NULL', 'LIKE', 'IN ()', 'NOW()']));
  });

  it('Postgres: quotes names that are not all lower case (they would fold to lower case)', () => {
    expect(columnIdent('client_id', 'postgres')).toBe('client_id');
    expect(columnIdent('ClientId', 'postgres')).toBe('"ClientId"');
    expect(columnIdent('a.b', 'postgres')).toBe('"a.b"');
    expect(columnIdent('order', 'postgres')).toBe('"order"');
    expect(columnIdent('ClientId', 'mysql')).toBe('ClientId');
  });
});
