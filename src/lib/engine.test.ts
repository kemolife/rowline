import { describe, expect, it } from 'vitest';
import { defaultPort, defaultUser, engineLabel, isServer, pickSchema, prodLocked, quoteIdent, rollbackNote, scopeKey, splitTableKey, sqlDialectName, tableTitle, unlockQuestion } from './engine';
import type { DbObject, QueryResult } from './types';

it('knows server engines', () => {
  expect(isServer('mysql')).toBe(true);
  expect(isServer('postgres')).toBe(true);
  expect(isServer('sqlite')).toBe(false);
});

it('quotes names per engine', () => {
  expect(quoteIdent('mysql', 'or`ders')).toBe('`or``ders`');
  expect(quoteIdent('sqlite', 'a"b')).toBe('"a""b"');
  expect(quoteIdent('postgres', 'Orders')).toBe('"Orders"');
  expect(quoteIdent('postgres', 'a.b')).toBe('"a.b"');
  expect(quoteIdent('postgres', 'say "hi"')).toBe('"say ""hi"""');
});

it('names engines, ports, users and SQL dialects', () => {
  expect(engineLabel('mysql')).toBe('MySQL');
  expect(engineLabel('sqlite')).toBe('SQLite');
  expect(engineLabel('postgres')).toBe('PostgreSQL');
  expect(defaultPort('mysql')).toBe(3306);
  expect(defaultPort('postgres')).toBe(5432);
  expect(defaultPort('sqlite')).toBeNull();
  expect(defaultUser('mysql')).toBe('root');
  expect(defaultUser('postgres')).toBe('postgres');
  expect(defaultUser('sqlite')).toBeNull();
  expect(sqlDialectName('mysql')).toBe('mysql');
  expect(sqlDialectName('postgres')).toBe('postgresql');
  expect(sqlDialectName('sqlite')).toBe('sqlite');
});

it('locks writes only on prod Postgres', () => {
  expect(prodLocked({ engine: 'postgres', environment: 'prod' })).toBe(true);
  expect(prodLocked({ engine: 'postgres', environment: 'staging' })).toBe(false);
  expect(prodLocked({ engine: 'mysql', environment: 'prod' })).toBe(false);
  expect(prodLocked({ engine: 'sqlite', environment: 'prod' })).toBe(false);
});

const t = (name: string, kind: DbObject['kind'] = 'table'): DbObject => ({ name, kind, rowEstimate: null });

describe('default schema', () => {
  const lister = (data: Record<string, DbObject[]>) => {
    const calls: string[] = [];
    return { calls, objectsOf: async (s: string) => (calls.push(s), data[s] ?? []) };
  };

  it('takes public when it has tables, with one call', async () => {
    const l = lister({ public: [t('users')], billing: [t('invoices')] });
    expect(await pickSchema(['billing', 'public'], l.objectsOf)).toEqual({ schema: 'public', objects: [t('users')] });
    expect(l.calls).toEqual(['public']);
  });

  it('takes the first schema with tables when public is empty or missing', async () => {
    const l = lister({ billing: [t('v', 'view')], sales: [t('orders')] });
    expect(await pickSchema(['public', 'billing', 'sales', 'zz'], l.objectsOf)).toEqual({ schema: 'sales', objects: [t('orders')] });
    expect(l.calls).toEqual(['public', 'billing', 'sales']);
    expect((await pickSchema(['app', 'sales'], lister({ sales: [t('x')] }).objectsOf)).schema).toBe('sales');
  });

  it('falls back to the first schema, then to null', async () => {
    expect(await pickSchema(['app', 'public'], lister({}).objectsOf)).toEqual({ schema: 'app', objects: [] });
    expect(await pickSchema([], lister({}).objectsOf)).toEqual({ schema: null, objects: [] });
  });
});

describe('schemas in names', () => {
  it('titles a table with its schema unless it is public', () => {
    expect(tableTitle('invoices', 'public')).toBe('invoices');
    expect(tableTitle('invoices', null)).toBe('invoices');
    expect(tableTitle('invoices', undefined)).toBe('invoices');
    expect(tableTitle('invoices', 'billing')).toBe('billing.invoices');
  });

  it('splits a schema_columns key or a foreign key target into schema and table', () => {
    const schemas = ['public', 'billing'];
    expect(splitTableKey('billing.invoices', 'public', schemas)).toEqual({ schema: 'billing', table: 'invoices' });
    expect(splitTableKey('invoices', 'public', schemas)).toEqual({ schema: 'public', table: 'invoices' });
    // a dot inside a table name of the own schema stays part of the name
    expect(splitTableKey('a.b', 'public', schemas)).toEqual({ schema: 'public', table: 'a.b' });
    expect(splitTableKey('public.Orders', 'billing', schemas)).toEqual({ schema: 'public', table: 'Orders' });
    expect(splitTableKey('billing.x', 'billing', schemas)).toEqual({ schema: 'billing', table: 'billing.x' });
  });

  it('keys per-schema data by database and schema; MySQL and SQLite keep the database alone', () => {
    expect(scopeKey('shop', null)).toBe('shop');
    expect(scopeKey(null, null)).toBeNull();
    expect(scopeKey('shop', 'billing')).toBe('shop/billing');
    expect(scopeKey('shop', 'public')).toBe('shop/public');
  });
});

it('asks to unlock writes with the connection and database', () => {
  expect(unlockQuestion('prod-db', 'shop')).toBe('Allow changes to prod-db / shop in this tab? Other tabs, Claude and udb stay read-only.');
});

describe('rollback note', () => {
  const r = (extra: Partial<QueryResult> = {}): QueryResult => ({ columns: [], rows: [], affectedRows: 1, elapsedMs: 1, truncated: false, statement: 'x', ...extra });
  it('says earlier statements were rolled back when a Postgres script fails after them', () => {
    expect(rollbackNote('postgres', [r(), r({ error: 'ERROR 23505: dup' })])).toMatch(/rolled back/);
  });
  it('says nothing when the first statement fails, when all ran, or for MySQL and SQLite', () => {
    expect(rollbackNote('postgres', [r({ error: 'ERROR 42P01: x' })])).toBeNull();
    expect(rollbackNote('postgres', [r(), r()])).toBeNull();
    expect(rollbackNote('mysql', [r(), r({ error: 'x' })])).toBeNull();
    expect(rollbackNote('sqlite', [r(), r({ error: 'x' })])).toBeNull();
  });
});
