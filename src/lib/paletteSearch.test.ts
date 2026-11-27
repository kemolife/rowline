import { expect, it } from 'vitest';
import { columnHits, score, tableHits } from './paletteSearch';

it('ranks same text, prefix, contains, then letters in order', () => {
  expect(score('orders', 'orders')).toBe(0);
  expect(score('orders_log', 'ord')).toBe(1);
  expect(score('client_orders', 'ord')).toBe(2);
  expect(score('client_api_settings', 'cas')).toBe(3);
  expect(score('agenda', 'xyz')).toBe(99);
});

it('finds which tables have a column, best matches first', () => {
  const cols = { client_api_settings: ['id', 'client_id', 'user_id', 'config'], tbl_project_lead: ['id', 'user_id'], api: ['id', 'user_name'] };
  expect(columnHits(cols, 'user_id')).toEqual([
    { table: 'client_api_settings', column: 'user_id' },
    { table: 'tbl_project_lead', column: 'user_id' },
  ]);
  expect(columnHits(cols, 'user').map((h) => `${h.table}.${h.column}`)).toEqual(['client_api_settings.user_id', 'tbl_project_lead.user_id', 'api.user_name']);
  // one letter or a fuzzy match is not enough
  expect(columnHits(cols, 'u')).toEqual([]);
  expect(columnHits(cols, 'cfg')).toEqual([]);
});

it('finds tables of every schema, by the whole key or the table part', () => {
  const keys = ['orders', 'billing.invoices', 'invoice_lines', 'sales.leads'];
  expect(tableHits(keys, 'inv')).toEqual(['invoice_lines', 'billing.invoices']);
  expect(tableHits(keys, 'billing.inv')).toEqual(['billing.invoices']);
  expect(tableHits(keys, 'zzz')).toEqual([]);
});
