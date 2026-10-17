import { describe, expect, it } from 'vitest';
import { diagramPrompt, focusedTables, wrapTallLayers, hubTables, kindLabel, layout, neighbourMap, nodeSize, presetQuestions, relationsOf, visibleColumns, type Relation } from './diagram';
import { diffSchema, type SchemaTable } from './schemaDiff';

const col = (name: string, dataType = 'int', primaryKey = false) => ({ name, dataType, nullable: true, defaultValue: null, primaryKey, autoIncrement: false, comment: null });
const tables: SchemaTable[] = [
  { name: 'customers', kind: 'table', columns: [col('id', 'int', true), col('email', 'varchar(255)'), col('country', 'char(2)')], foreignKeys: [], rowEstimate: 500, comment: null },
  {
    name: 'orders',
    kind: 'table',
    columns: [col('id', 'int', true), col('customer_id'), col('total', 'decimal(10,2)')],
    foreignKeys: [{ name: 'fk_c', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onUpdate: null, onDelete: null }],
    rowEstimate: 5000,
    comment: 'Customer orders',
  },
  { name: 'external', kind: 'table', columns: [col('id', 'int', true), col('x_id')], foreignKeys: [{ name: 'fk_x', columns: ['x_id'], refTable: 'other.thing', refColumns: ['id'], onUpdate: null, onDelete: null }], rowEstimate: null, comment: null },
];

describe('diagram', () => {
  const view = diffSchema(null, tables).tables;

  it('builds relations only between known tables', () => {
    expect(relationsOf(view).map((r) => [r.from, r.to])).toEqual([['orders', 'customers']]);
  });

  it('shows only key columns, at most 12', () => {
    expect(visibleColumns(view[1]).map((c) => c.name)).toEqual(['id', 'customer_id']);
    expect(visibleColumns(view[0], new Set(['email'])).map((c) => c.name)).toEqual(['id', 'email']);
    const wide = diffSchema(null, [{ name: 'wide', kind: 'table', columns: Array.from({ length: 120 }, (_, i) => col(`c${i}`, 'int', true)), foreignKeys: [], rowEstimate: null, comment: null }]).tables[0];
    expect(visibleColumns(wide)).toHaveLength(12);
    expect(nodeSize(wide).height).toBeLessThan(400);
  });

  it('lays out every table', async () => {
    const pos = await layout(
      view.map((t) => ({ id: t.name, ...nodeSize(t) })),
      relationsOf(view),
    );
    expect(Object.keys(pos).sort()).toEqual(['customers', 'external', 'orders']);
    // orders points to customers: left to right
    expect(pos.orders.x).toBeLessThan(pos.customers.x);
  });

  it('writes the question with the selection as context', () => {
    const text = diagramPrompt({
      question: 'How are these tables connected?',
      database: 'shop',
      engine: 'mysql',
      tables: view.slice(0, 2),
      relations: relationsOf(view),
      changesSince: null,
      projectFolder: '/Users/me/app',
    });
    expect(text.split('\n')[0]).toBe('How are these tables connected?');
    expect(text).toContain('- orders (~5000 rows) — Customer orders: id int PK, customer_id int FK→customers.id, total decimal(10,2)');
    expect(text).toContain('- orders(customer_id) → customers(id)');
    expect(text).toContain('project folder');
    expect(text).not.toContain('Schema changes');
  });

  it('offers questions that fit the selection', () => {
    expect(presetQuestions(1, false).map((q) => q.label)).toEqual(['Explain this table', 'What refers to it?', 'Write a query']);
    expect(presetQuestions(3, true).map((q) => q.label)).toContain('What changed here?');
  });

  it('tells one-to-one from many-to-one and optional from required', () => {
    const t = (name: string, cols: ReturnType<typeof col>[], fks: SchemaTable['foreignKeys'] = [], uniqueKeys: string[][] = []): SchemaTable => ({ name, kind: 'table', columns: cols, foreignKeys: fks, rowEstimate: null, comment: null, uniqueKeys });
    const fk = (c: string, ref: string) => ({ name: `fk_${c}`, columns: [c], refTable: ref, refColumns: ['id'], onUpdate: null, onDelete: null });
    const v = diffSchema(null, [
      t('users', [col('id', 'int', true)]),
      t('profiles', [col('id', 'int', true), { ...col('user_id'), nullable: false }], [fk('user_id', 'users')], [['user_id']]),
      t('posts', [col('id', 'int', true), col('user_id')], [fk('user_id', 'users')]),
    ]).tables;
    const rs = relationsOf(v);
    expect(rs.map((r) => [r.from, kindLabel(r), r.optional])).toEqual([
      ['profiles', '1:1', false],
      ['posts', 'N:1', true],
    ]);
  });

  it('guesses relations from column names only when asked', () => {
    const t = (name: string, cols: ReturnType<typeof col>[]): SchemaTable => ({ name, kind: 'table', columns: cols, foreignKeys: [], rowEstimate: null, comment: null });
    const v = diffSchema(null, [
      t('ds_person', [col('ds_person_id', 'int unsigned', true), col('name', 'varchar(50)')]),
      t('person_marketing_consent', [col('id', 'int', true), col('ds_person_id', 'int unsigned')]),
      t('customers', [col('id', 'int', true)]),
      t('orders', [col('id', 'int', true), col('customer_id'), col('session_id', 'varchar(64)')]),
      t('categories', [col('id', 'int', true)]),
      t('articles', [col('id', 'int', true), col('category_id', 'varchar(10)')]),
    ]).tables;
    expect(relationsOf(v)).toEqual([]);
    const guessed = relationsOf(v, true).map((r) => `${r.from}.${r.fromColumns[0]} → ${r.to}.${r.toColumns[0]}`);
    expect(guessed).toEqual(['person_marketing_consent.ds_person_id → ds_person.ds_person_id', 'orders.customer_id → customers.id']);
    expect(relationsOf(v, true).every((r) => r.guessed)).toBe(true);
  });

  it('focus mode shows chosen tables with their neighbours; hubs come first', () => {
    const rel = (from: string, to: string): Relation => ({ id: `${from}-${to}`, from, fromColumns: ['x'], to, toColumns: ['id'], change: null, kind: 'many-to-one', optional: true, guessed: false });
    const n = neighbourMap([rel('a', 'hub'), rel('b', 'hub'), rel('c', 'hub'), rel('c', 'd'), rel('e', 'e')]);
    expect([...focusedTables(['c'], n)].sort()).toEqual(['c', 'd', 'hub']);
    expect(focusedTables([], n).size).toBe(0);
    expect(hubTables(n, 2)).toEqual([
      { name: 'hub', links: 3 },
      { name: 'c', links: 2 },
    ]);
  });

  it('wraps a very tall column into several, without overlap', () => {
    // a hub with 60 tables pointing to it: one column of 60 boxes
    const boxes = [{ id: 'hub', x: 400, y: 3200, width: 200, height: 80 }, ...Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, x: 0, y: i * 110, width: 220, height: 80 }))];
    const pos = wrapTallLayers(boxes);
    const ys = Object.entries(pos).filter(([id]) => id !== 'hub').map(([, p]) => p.y);
    expect(Math.max(...ys)).toBeLessThan(1600);
    // the hub sits next to them, not far below
    expect(pos.hub.y).toBeLessThan(1600);
    // the hub moves right, past the new columns
    expect(pos.hub.x).toBeGreaterThan(Math.max(...Object.entries(pos).filter(([id]) => id !== 'hub').map(([, p]) => p.x)));
    const seen = new Set(Object.values(pos).map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(61);
    // a few boxes spread over a tall area are packed together
    const spread = wrapTallLayers([0, 3000, 6000].map((y, i) => ({ id: `s${i}`, x: 0, y, width: 200, height: 80 })));
    expect(Math.max(...Object.values(spread).map((p) => p.y))).toBeLessThan(300);
  });
});
