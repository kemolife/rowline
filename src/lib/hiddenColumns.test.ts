import { beforeEach, expect, it } from 'vitest';
import { hideAllButKeys, hideAllButOne, loadHidden, saveHidden, visibleIndexes } from './hiddenColumns';

beforeEach(() => localStorage.clear());

it('remembers hidden columns per table', () => {
  expect(loadHidden('c/db/orders')).toEqual([]);
  saveHidden('c/db/orders', ['note', 'note', 'total']);
  expect(loadHidden('c/db/orders')).toEqual(['note', 'total']);
  expect(loadHidden('c/db/customers')).toEqual([]);
  saveHidden('c/db/orders', []);
  expect(localStorage.getItem('rowline.hiddenColumns')).toBe('{}');
  localStorage.setItem('rowline.hiddenColumns', 'nope');
  expect(loadHidden('c/db/orders')).toEqual([]);
});

it('maps visible columns to their real indexes and never hides everything', () => {
  const names = ['id', 'customer_id', 'status', 'note'];
  expect(visibleIndexes(names, ['status'])).toEqual([0, 1, 3]);
  expect(visibleIndexes(names, ['gone_column'])).toEqual([0, 1, 2, 3]);
  expect(visibleIndexes(names, names)).toEqual([0, 1, 2, 3]);
  expect(hideAllButKeys(names, new Set(['id', 'customer_id']))).toEqual(['status', 'note']);
  expect(hideAllButKeys(names, new Set())).toEqual([]);
});

it('hide all keeps the primary key, or the first column', () => {
  expect(hideAllButOne(['name', 'id', 'email'], ['id'])).toEqual(['name', 'email']);
  expect(hideAllButOne(['name', 'email'], [])).toEqual(['email']);
});
