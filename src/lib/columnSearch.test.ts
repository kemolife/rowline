import { expect, it } from 'vitest';
import { searchColumns } from './columnSearch';

const cols = ['id', 'uid', 'created_by_user', 'user_id', 'status', 'username', 'default_language'].map((name) => ({ name, type: 'int' }));
const names = (q: string, frequent: string[] = []) => searchColumns(cols, q, frequent).map((c) => c.name);

it('without a query: most used first, then table order', () => {
  expect(names('', ['status'])).toEqual(['status', 'id', 'uid', 'created_by_user', 'user_id', 'username', 'default_language']);
  expect(searchColumns(cols, '', ['status'])[0].frequent).toBe(true);
});

it('finds any part of the name, any case, best matches first', () => {
  // starts with "user" first, then a word that starts with it, the rest is not a match
  expect(names('USER')).toEqual(['user_id', 'username', 'created_by_user']);
  expect(names('lang')).toEqual(['default_language']);
  expect(names('zzz')).toEqual([]);
});

it('marks where it matched and keeps most used first inside a group', () => {
  expect(searchColumns(cols, 'user')[0].match).toEqual([0, 4]);
  expect(searchColumns(cols, 'user').find((c) => c.name === 'created_by_user')?.match).toEqual([11, 15]);
  expect(names('user', ['username'])).toEqual(['username', 'user_id', 'created_by_user']);
});
