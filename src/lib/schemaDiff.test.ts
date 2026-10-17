import { describe, expect, it } from 'vitest';
import { changeLines, diffSchema, hasChanges, summaryText, type SchemaTable } from './schemaDiff';

const col = (name: string, dataType = 'int', extra: Partial<SchemaTable['columns'][number]> = {}) => ({
  name,
  dataType,
  nullable: true,
  defaultValue: null,
  primaryKey: false,
  autoIncrement: false,
  comment: null,
  ...extra,
});
const table = (name: string, columns: SchemaTable['columns'], foreignKeys: SchemaTable['foreignKeys'] = []): SchemaTable => ({ name, kind: 'table', columns, foreignKeys, rowEstimate: null, comment: null });
const fk = (column: string, refTable: string) => ({ name: `fk_${column}`, columns: [column], refTable, refColumns: ['id'], onUpdate: null, onDelete: null });

describe('schema diff', () => {
  const before = [table('customers', [col('id', 'int', { primaryKey: true }), col('name', 'varchar(100)')]), table('legacy', [col('id')]), table('orders', [col('id'), col('customer_id'), col('old_note', 'text')])];
  const live = [
    table('customers', [col('id', 'int', { primaryKey: true }), col('name', 'varchar(255)', { nullable: false })]),
    table('orders', [col('id'), col('customer_id'), col('status', "enum('new','paid')")], [fk('customer_id', 'customers')]),
    table('invoices', [col('id')]),
  ];

  it('marks nothing without a snapshot', () => {
    const d = diffSchema(null, live);
    expect(d.tables.every((t) => t.change === null && t.columns.every((c) => c.change === null))).toBe(true);
    expect(hasChanges(d.summary)).toBe(false);
  });

  it('finds added, removed and changed tables, columns and keys', () => {
    const d = diffSchema(before, live);
    const by = (n: string) => d.tables.find((t) => t.name === n)!;
    expect(by('invoices').change).toBe('added');
    expect(by('legacy').change).toBe('removed');
    expect(by('customers').change).toBe('changed');
    expect(by('customers').columns.find((c) => c.name === 'name')).toMatchObject({ change: 'changed', detail: 'varchar(100) → varchar(255), now NOT NULL' });
    const orders = by('orders');
    expect(orders.columns.map((c) => [c.name, c.change])).toEqual([
      ['id', null],
      ['customer_id', null],
      ['status', 'added'],
      ['old_note', 'removed'],
    ]);
    expect(orders.foreignKeys[0].change).toBe('added');
    expect(d.summary).toEqual({ tablesAdded: 1, tablesRemoved: 1, tablesChanged: 2, columnsAdded: 1, columnsRemoved: 1, columnsChanged: 1 });
    expect(summaryText(d.summary)).toBe('+1 table, −1 table, 2 tables changed, +1 column, −1 column, 1 column changed');
  });

  it('describes changes for Claude', () => {
    const d = diffSchema(before, live);
    expect(changeLines(d.tables)).toEqual([
      '- customers.name changed: varchar(100) → varchar(255), now NOT NULL',
      "- orders.status was added (enum('new','paid'))",
      '- orders.old_note was removed',
      '- foreign key orders(customer_id) → customers(id) was added',
      '- table invoices was added',
      '- table legacy was removed',
    ]);
  });
});
