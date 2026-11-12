import { describe, expect, it } from 'vitest';
import type { Relation } from './diagram';
import { aliasFor, aliasedTableUses, explainSqlError, joinSuggestions, lintStatement, maskSql, tableRefs, updatesAllRows } from './sqlAssist';

const rel = (from: string, fromCol: string, to: string, toCol: string, extra: Partial<Relation> = {}): Relation => ({
  id: `${from}.${fromCol}`,
  from,
  fromColumns: [fromCol],
  to,
  toColumns: [toCol],
  change: null,
  kind: 'many-to-one',
  optional: true,
  guessed: false,
  ...extra,
});

const schema = new Map([
  ['ds_request', new Set(['id', 'ds_person_id', 'status'])],
  ['ds_person', new Set(['ds_person_id', 'name'])],
  ['orders', new Set(['id', 'customer_id'])],
]);

describe('SQL assist', () => {
  it('ignores strings and comments', () => {
    expect(maskSql("select 'from x' -- join y\nfrom z")).toBe("select '      '          \nfrom z");
  });

  it('finds tables and aliases', () => {
    const refs = tableRefs('SELECT * FROM ds_request r, orders JOIN `ds_person` AS p ON p.ds_person_id = r.ds_person_id WHERE 1');
    expect(refs.map((r) => [r.table, r.alias])).toEqual([
      ['ds_request', 'r'],
      ['orders', 'orders'],
      ['ds_person', 'p'],
    ]);
    expect(tableRefs('select * from shop.orders o')[0]).toMatchObject({ table: 'orders', alias: 'o', qualified: true });
    expect(tableRefs('UPDATE orders SET x = 1')[0].alias).toBe('orders');
    expect(tableRefs('select * from orders where id in (select 1)').map((r) => r.table)).toEqual(['orders']);
  });

  it('suggests JOINs from relations, real foreign keys first', () => {
    const refs = tableRefs('SELECT * FROM ds_request r');
    const s = joinSuggestions(refs, [rel('ds_request', 'ds_person_id', 'ds_person', 'ds_person_id', { guessed: true }), rel('notes', 'ds_request_id', 'ds_request', 'id')]);
    expect(s.map((x) => [x.text, x.detail])).toEqual([
      ['notes n ON n.ds_request_id = r.id', 'foreign key'],
      ['ds_person dp ON dp.ds_person_id = r.ds_person_id', 'guessed'],
    ]);
    expect(aliasFor('orders', new Set(['o']))).toBe('o2');
  });

  it('warns about UPDATE / DELETE without WHERE', () => {
    expect(updatesAllRows('DELETE FROM orders')).toBe(true);
    expect(updatesAllRows('  update orders set a = 1 -- where id = 1')).toBe(true);
    expect(updatesAllRows("UPDATE orders SET note = 'where' WHERE id = 1")).toBe(false);
    expect(updatesAllRows('SELECT * FROM orders')).toBe(false);
    expect(lintStatement('DELETE FROM orders', schema)[0]).toMatchObject({ from: 0, to: 6, severity: 'warning' });
  });

  it('warns about unknown tables and columns', () => {
    const sql = 'SELECT r.statuz, p.name FROM ds_request r JOIN ds_persons p ON p.id = r.ds_person_id';
    const issues = lintStatement(sql, schema);
    expect(issues.map((i) => [sql.slice(i.from, i.to), i.message])).toEqual([
      ['ds_persons', 'Unknown table: ds_persons'],
      ['statuz', 'ds_request has no column statuz'],
    ]);
    // CTEs, other databases and functions are fine
    expect(lintStatement('WITH x AS (SELECT 1) SELECT * FROM x JOIN other.t ON 1 WHERE DATE(now())', schema)).toEqual([]);
    // without a schema only the WHERE check runs
    expect(lintStatement('SELECT * FROM nothing', new Map())).toEqual([]);
  });

  it('catches the table name used after it got an alias, with a fix', () => {
    const sql = 'SELECT r.ds_request_id FROM ds_request AS r LEFT JOIN automation_run_logs_v2 arlv ON arlv.lead_id = ds_request.ds_request_id';
    const issues = aliasedTableUses(sql);
    expect(issues).toHaveLength(1);
    expect(sql.slice(issues[0].from, issues[0].to)).toBe('ds_request');
    expect(issues[0].fix).toEqual({ label: 'Use r', insert: 'r' });
    // the alias itself, other databases and strings are fine
    expect(aliasedTableUses("SELECT r.x FROM ds_request r WHERE r.y = 'ds_request.z'")).toEqual([]);
    expect(aliasedTableUses('SELECT shop.ds_request.x FROM ds_request r')).toEqual([]);
    // no alias: fine
    expect(aliasedTableUses('SELECT ds_request.x FROM ds_request')).toEqual([]);
    // part of the normal warnings, even without a schema
    expect(lintStatement(sql, new Map()).some((i) => i.fix)).toBe(true);
  });

  it('explains the MySQL error in plain words', () => {
    const sql = 'SELECT * FROM ds_request AS r LEFT JOIN logs l ON l.lead_id = ds_request.ds_request_id';
    expect(explainSqlError("ERROR 1054 (42S22): Unknown column 'ds_request.ds_request_id' in 'on clause'", sql)).toBe(
      'In this query `ds_request` is called `r` (ds_request AS r). Write r.ds_request_id instead of ds_request.ds_request_id.',
    );
    expect(explainSqlError("Unknown column 'x.y' in 'field list'", sql)).toBeNull();
  });
});

