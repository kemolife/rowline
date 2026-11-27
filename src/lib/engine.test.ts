import { describe, expect, it } from 'vitest';
import { defaultPort, defaultUser, engineLabel, isServer, pickSchema, prodLocked, quoteIdent, sqlDialectName } from './engine';
import type { DbObject } from './types';

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
