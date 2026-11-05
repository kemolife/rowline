import { beforeEach, describe, expect, it } from 'vitest';
import { FILTER_OPS, RAW_SQL, newRule } from './filters';
import { loadFilterUsage, rankColumns, rankOps, recordFilterUse } from './filterUsage';

describe('filter usage', () => {
  beforeEach(() => localStorage.clear());
  const cols = ['id', 'name', 'status', 'city', 'created_at', 'email', 'phone', 'note'];

  it('puts the columns used in this table first, the rest keeps its order', () => {
    let u = loadFilterUsage();
    expect(rankColumns(cols, u, 't')).toEqual({ frequent: [], rest: cols });
    u = recordFilterUse(u, 'c/db/t', newRule('status'));
    u = recordFilterUse(u, 'c/db/t', newRule('status', 'IN'));
    u = recordFilterUse(u, 'c/db/t', newRule('email', 'LIKE'));
    expect(rankColumns(cols, u, 'c/db/t')).toEqual({ frequent: ['status', 'email'], rest: ['id', 'name', 'city', 'created_at', 'phone', 'note'] });
    // another table is not affected
    expect(rankColumns(cols, u, 'c/db/other').frequent).toEqual([]);
    // remembered across loads
    expect(rankColumns(cols, loadFilterUsage(), 'c/db/t').frequent).toEqual(['status', 'email']);
  });

  it('puts the most used operators first, at most four', () => {
    let u = loadFilterUsage();
    for (const op of ['=', '=', '=', 'IN', 'IN', 'LIKE', 'contains', 'BETWEEN'] as const) u = recordFilterUse(u, 't', newRule('id', op));
    const { frequent, rest } = rankOps(FILTER_OPS, u);
    expect(frequent).toEqual(['=', 'IN', 'contains', 'LIKE']); // a tie keeps the list order
    expect(rest[0]).toBe('<>');
    expect(rest).toContain('BETWEEN');
    expect(frequent.length + rest.length).toBe(FILTER_OPS.length);
  });

  it('ignores raw SQL rules and survives broken storage', () => {
    const u = recordFilterUse(loadFilterUsage(), 't', newRule(RAW_SQL));
    expect(u).toEqual({ ops: {}, columns: {} });
    localStorage.setItem('rowline.filterUsage', '{oops');
    expect(loadFilterUsage()).toEqual({ ops: {}, columns: {} });
  });
});
