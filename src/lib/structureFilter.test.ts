import { expect, it } from 'vitest';
import { filterStructure } from './structureFilter';
import type { ColumnInfo, TableStructure } from './types';

const col = (name: string, dataType = 'int', extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  nullable: true,
  defaultValue: null,
  primaryKey: false,
  autoIncrement: false,
  comment: null,
  ...extra,
});

const s: TableStructure = {
  name: 'orders',
  kind: 'table',
  columns: [col('id', 'int', { primaryKey: true }), col('customer_id'), col('status', 'enum'), col('note', 'text', { comment: 'free text from support' }), col('created_at', 'datetime')],
  indexes: [
    { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
    { name: 'idx_customer_status', columns: ['customer_id', 'status'], unique: false, primary: false },
  ],
  foreignKeys: [{ name: 'fk_customer', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onUpdate: null, onDelete: null }],
  ddl: null,
};
const names = (f: ReturnType<typeof filterStructure>) => f.columns.map((c) => c.name);

it('no filter keeps everything', () => {
  const f = filterStructure(s, { q: '', keys: false, indexed: false });
  expect(f.columns).toHaveLength(5);
  expect(f.indexesOf.get('status')?.map((i) => i.name)).toEqual(['idx_customer_status']);
  expect(f.foreignKeyOf.get('customer_id')?.refTable).toBe('customers');
});

it('search finds names, types and comments, and the indexes and keys that touch them', () => {
  const f = filterStructure(s, { q: 'STAT', keys: false, indexed: false });
  expect(names(f)).toEqual(['status']);
  expect(f.indexes.map((i) => i.name)).toEqual(['idx_customer_status']);
  expect(f.foreignKeys).toEqual([]);
  expect(names(filterStructure(s, { q: 'datetime', keys: false, indexed: false }))).toEqual(['created_at']);
  expect(names(filterStructure(s, { q: 'support', keys: false, indexed: false }))).toEqual(['note']);
});

it('search by referenced table shows the foreign key', () => {
  const f = filterStructure(s, { q: 'customers', keys: false, indexed: false });
  expect(f.columns).toEqual([]);
  expect(f.foreignKeys.map((k) => k.name)).toEqual(['fk_customer']);
});

it('keys and indexed narrow the columns', () => {
  expect(names(filterStructure(s, { q: '', keys: true, indexed: false }))).toEqual(['id', 'customer_id']);
  expect(names(filterStructure(s, { q: '', keys: false, indexed: true }))).toEqual(['id', 'customer_id', 'status']);
  expect(names(filterStructure(s, { q: 'stat', keys: true, indexed: false }))).toEqual([]);
});
