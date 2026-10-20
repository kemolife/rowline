import { describe, expect, it } from 'vitest';
import type { Relation } from './diagram';
import { completeSql, opensNextSuggestions } from './sqlComplete';

const schema = new Map([
  ['customers', ['id', 'email', 'full_name', 'country']],
  ['orders', ['id', 'customer_id', 'status', 'total']],
  ['order_items', ['id', 'order_id', 'sku']],
]);
const labels = (before: string, usage?: Record<string, number>, relations: Relation[] = []) => completeSql(before, schema, relations, usage)?.options.map((o) => o.label) ?? [];

describe('SQL completion', () => {
  it('offers statement words at the start; SE → SELECT first', () => {
    expect(labels('SE')[0]).toBe('SELECT');
    expect(labels('se')).not.toContain('FROM');
    expect(labels('SELECT 1; up')[0]).toBe('UPDATE');
  });

  it('offers tables after FROM, then what comes after a table', () => {
    expect(labels('SELECT * FROM ord')).toEqual(['orders', 'order_items']);
    // a space follows the table, ready for the alias
    expect(completeSql('SELECT * FROM ord', schema)?.options[0].insert).toBe('orders ');
    expect(labels('SELECT * FROM orders o ')).toContain('WHERE');
    expect(labels('SELECT * FROM orders o W')[0]).toBe('WHERE');
    expect(labels('SELECT * FROM orders o J')[0]).toBe('JOIN');
  });

  it('offers columns of the query tables after SELECT / WHERE', () => {
    expect(labels('SELECT * FROM orders WHERE st')[0]).toBe('status');
    expect(labels('SELECT * FROM orders WHERE status = 1 a')[0]).toBe('AND');
    // two tables: columns with their alias
    expect(labels('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE em')).toEqual(['c.email']);
    expect(labels('SELECT * FROM orders ORDER BY total d')[0]).toBe('DESC');
  });

  it('offers the columns of an alias', () => {
    expect(labels('SELECT o. FROM orders o'.slice(0, 9))).toEqual([]); // alias not known yet at that point
    expect(labels('SELECT * FROM orders o WHERE o.cu')).toEqual(['customer_id']);
  });

  it('puts JOINs with ON first after JOIN', () => {
    const rel: Relation = { id: 'r', from: 'orders', fromColumns: ['customer_id'], to: 'customers', toColumns: ['id'], change: null, kind: 'many-to-one', optional: false, guessed: false };
    const l = labels('SELECT * FROM orders o JOIN ', {}, [rel]);
    expect(l[0]).toBe('customers c ON c.id = o.customer_id');
    expect(l).toContain('order_items');
    // a table picked often still comes after the JOINs with ON
    expect(labels('SELECT * FROM orders o JOIN ', { orders: 9 }, [rel])[0]).toBe('customers c ON c.id = o.customer_id');
  });

  it('ranks by what you use: often picked words move up among equal matches', () => {
    expect(labels('SELECT * FROM orders WHERE ')[0]).toBe('id');
    // usage reorders within a kind: a column picked often comes first among the columns
    expect(labels('SELECT * FROM orders WHERE ', { total: 5 })[0]).toBe('total');
  });

  it('stays quiet inside strings and with nothing typed at the start', () => {
    expect(completeSql("SELECT * FROM orders WHERE status = 'pa", schema)).toBeNull();
    expect(completeSql('', schema)).toBeNull();
  });

  it('opens the next suggestions after keywords that need a name', () => {
    expect(opensNextSuggestions('LEFT JOIN')).toBe(true);
    expect(opensNextSuggestions('FROM')).toBe(true);
    expect(opensNextSuggestions('WHERE')).toBe(true);
    expect(opensNextSuggestions('LIMIT')).toBe(false);
    expect(opensNextSuggestions('DESC')).toBe(false);
    // and after LEFT JOIN the tables come
    expect(labels('SELECT * FROM orders o LEFT JOIN ')).toContain('customers');
  });

  it('offers WHERE and more JOINs after a JOIN … ON condition', () => {
    const s2 = new Map([...schema, ['ds_request', ['ds_request_id', 'status']], ['automation_run_logs_v2', ['id', 'lead_id']]]);
    const sql = 'SELECT\n  *\nFROM\n  ds_request\n  LEFT JOIN automation_run_logs_v2 arlv ON arlv.lead_id = ds_request.ds_request_id\nWHE';
    expect(completeSql(sql, s2)?.options.map((o) => o.label)[0]).toBe('WHERE');
    expect(completeSql(sql.replace(/WHE$/, 'LEFT J'), s2)?.options.map((o) => o.label)[0]).toBe('LEFT JOIN');
    expect(labels('SELECT * FROM orders ORDER B')).toEqual(['ORDER BY']);
    // the replaced text starts at the first word
    expect(completeSql('SELECT * FROM orders LEFT J', schema)?.from).toBe('SELECT * FROM orders '.length);
    // once there is a WHERE it is not offered again
    expect(completeSql('SELECT * FROM orders WHERE id = 1 AND st', schema)?.options.map((o) => o.label)).not.toContain('WHERE');
  });

  it('knows the tables named after the cursor (SELECT list written first)', () => {
    const s2 = new Map([...schema, ['ds_request', ['ds_request_id', 'status', 'created_at']], ['automation_run_logs_v2', ['id', 'lead_id']]]);
    const before = 'SELECT\n  r.ds_request_id, r.';
    const after = '\nFROM\n  ds_request AS r\n  LEFT JOIN automation_run_logs_v2 arlv ON arlv.lead_id = ds_request.ds_request_id\nWHERE\n';
    expect(completeSql(before, s2, [], {}, after)?.options.map((o) => o.label)).toEqual(['ds_request_id', 'status', 'created_at']);
    // plain column names in the SELECT list come from the tables after the cursor too
    expect(completeSql('SELECT sta', s2, [], {}, ' FROM ds_request')?.options[0].label).toBe('status');
    // the next statement does not count
    expect(completeSql('SELECT x.', s2, [], {}, ' FROM a; SELECT * FROM ds_request x')).toBeNull();
    expect(completeSql('SELECT x.', s2, [], {}, '; SELECT * FROM ds_request x')).toBeNull();
  });

  it('after a column comes an operator, not another column', () => {
    const s2 = new Map([...schema, ['ds_request', ['ds_request_id', 'location_id', 'language', 'lead_group_id']]]);
    const l = completeSql('SELECT * FROM ds_request AS r WHERE r.ds_request_id L', s2)?.options.map((o) => o.label) ?? [];
    expect(l[0]).toBe('LIKE');
    expect(l).not.toContain('r.location_id');
    expect(l).not.toContain('location_id');
    // after an operator or AND, columns again
    expect(completeSql('SELECT * FROM ds_request r WHERE r.ds_request_id = 5 AND lo', s2)?.options[0].label).toBe('location_id');
    expect(completeSql('SELECT * FROM ds_request r WHERE r.ds_request_id = lo', s2)?.options[0].label).toBe('location_id');
    // `= 5 A` → AND; `IS N` still → IS NULL / IS NOT NULL; SELECT list → AS / FROM; ORDER BY x → ASC / DESC
    expect(labels('SELECT * FROM orders WHERE total = 5 A')[0]).toBe('AND');
    expect(labels('SELECT * FROM orders WHERE note IS N')).toEqual(['IS NULL', 'IS NOT NULL']);
    expect(labels('SELECT total F')).toEqual(['FROM']);
    expect(labels('SELECT * FROM orders ORDER BY total ')).toEqual(['ASC', 'DESC', 'LIMIT']);
  });
});

