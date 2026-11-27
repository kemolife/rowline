import { describe, expect, it } from 'vitest';
import { RAW_SQL, cellLiteral, compileFilter, enumValues, newRule, ruleCondition, ruleForValue, stringLiteral, type FilterRule } from './filters';

const rule = (column: string, op: FilterRule['op'], value = '', extra: Partial<FilterRule> = {}): FilterRule => ({ ...newRule(column, op, value), ...extra });
const types = { id: 'bigint unsigned', name: 'varchar(255)', price: 'decimal(10,2)' };

describe('filter rules', () => {
  it('quotes values safely for each engine', () => {
    expect(stringLiteral('mysql', "O'Brien \\ x")).toBe("'O''Brien \\\\ x'");
    expect(stringLiteral('sqlite', "O'Brien \\ x")).toBe("'O''Brien \\ x'");
    expect(ruleCondition(rule('name', '=', "O'Brien"), 'mysql', types)).toBe("`name` = 'O''Brien'");
    expect(ruleCondition(rule('weird"col', '=', 'x'), 'sqlite')).toBe(`"weird""col" = 'x'`);
  });

  it('keeps numbers unquoted only in numeric columns', () => {
    expect(ruleCondition(rule('id', '>=', '90'), 'mysql', types)).toBe('`id` >= 90');
    expect(ruleCondition(rule('price', '<', '9.5'), 'mysql', types)).toBe('`price` < 9.5');
    expect(ruleCondition(rule('name', '=', '90'), 'mysql', types)).toBe("`name` = '90'");
    expect(ruleCondition(rule('id', '=', '1 OR 1=1'), 'mysql', types)).toBe("`id` = '1 OR 1=1'");
  });

  it('matches % and _ literally in contains / starts with', () => {
    expect(ruleCondition(rule('name', 'contains', '50%_off!'), 'mysql', types)).toBe("`name` LIKE '%50!%!_off!!%' ESCAPE '!'");
    expect(ruleCondition(rule('name', 'starts with', 'ab'), 'sqlite', types)).toBe(`"name" LIKE 'ab%' ESCAPE '!'`);
  });

  it('handles lists, ranges, null and empty', () => {
    expect(ruleCondition(rule('id', 'IN', '1, 2,,3'), 'mysql', types)).toBe('`id` IN (1, 2, 3)');
    expect(ruleCondition(rule('id', 'IN', ' , '), 'mysql', types)).toBeNull();
    expect(ruleCondition(rule('id', 'BETWEEN', '1', { value2: '9' }), 'mysql', types)).toBe('`id` BETWEEN 1 AND 9');
    expect(ruleCondition(rule('id', 'BETWEEN', '1'), 'mysql', types)).toBeNull();
    expect(ruleCondition(rule('name', 'IS NULL'), 'mysql', types)).toBe('`name` IS NULL');
    expect(ruleCondition(rule('name', 'is empty'), 'mysql', types)).toBe("(`name` IS NULL OR `name` = '')");
  });

  it('joins enabled rules with AND and passes raw SQL through', () => {
    const rules = [rule('id', '=', '5'), rule('name', 'contains', 'x', { enabled: false }), rule(RAW_SQL, '=', '`price` > 3 OR `price` IS NULL')];
    expect(compileFilter(rules, 'mysql', types)).toBe("(`id` = 5) AND (`price` > 3 OR `price` IS NULL)");
    expect(compileFilter([rule('id', '=', '5')], 'mysql', types)).toBe('`id` = 5');
    expect(compileFilter([], 'mysql')).toBeNull();
  });

  it('builds a rule from a cell value', () => {
    expect(ruleCondition(ruleForValue('id', 5245), 'mysql', types)).toBe('`id` = 5245');
    expect(ruleCondition(ruleForValue('name', null), 'mysql', types)).toBe('`name` IS NULL');
    expect(ruleCondition(ruleForValue('name', null, true), 'mysql', types)).toBe('`name` IS NOT NULL');
  });

  it('reads ENUM values from the column type', () => {
    expect(enumValues("enum('new','paid','it''s')")).toEqual(['new', 'paid', "it's"]);
    expect(enumValues("set('a','b')")).toEqual(['a', 'b']);
    expect(enumValues('varchar(20)')).toBeNull();
  });

  it('Postgres: quotes mixed case, contains is case-insensitive and casts non-text columns to text', () => {
    const pg = { name: 'character varying(80)', id: 'integer', Note: 'text', active: 'boolean', created: 'timestamp with time zone' };
    expect(ruleCondition(rule('name', 'contains', 'x'), 'postgres')).toBe(`"name"::text ILIKE '%x%' ESCAPE '!'`);
    expect(ruleCondition(rule('name', 'contains', 'x'), 'postgres', pg)).toBe(`"name" ILIKE '%x%' ESCAPE '!'`);
    expect(ruleCondition(rule('Note', 'not contains', 'x'), 'postgres', pg)).toBe(`"Note" NOT ILIKE '%x%' ESCAPE '!'`);
    expect(ruleCondition(rule('id', 'starts with', '12'), 'postgres', pg)).toBe(`"id"::text ILIKE '12%' ESCAPE '!'`);
    expect(ruleCondition(rule('created', 'ends with', '05'), 'postgres', pg)).toBe(`"created"::text ILIKE '%05' ESCAPE '!'`);
    expect(ruleCondition(rule('id', 'LIKE', '1%'), 'postgres', pg)).toBe(`"id"::text LIKE '1%'`);
    expect(ruleCondition(rule('id', 'is empty'), 'postgres', pg)).toBe(`("id" IS NULL OR "id"::text = '')`);
    expect(ruleCondition(rule('Note', '=', "it's"), 'postgres', pg)).toBe(`"Note" = 'it''s'`);
    expect(ruleCondition(rule('id', '>', '5'), 'postgres', pg)).toBe(`"id" > 5`);
    // backslash is plain text in Postgres strings
    expect(stringLiteral('postgres', 'a\\b')).toBe("'a\\b'");
  });

  it('Postgres: booleans from a cell filter are quoted (boolean = 1 is an error)', () => {
    const pg = { active: 'boolean' };
    expect(ruleCondition(ruleForValue('active', true), 'postgres', pg)).toBe(`"active" = '1'`);
    expect(ruleCondition(ruleForValue('active', true), 'mysql', { active: 'tinyint(1)' })).toBe('`active` = 1');
  });

  it('Postgres writes booleans as TRUE / FALSE', () => {
    expect(cellLiteral('postgres', true)).toBe('TRUE');
    expect(cellLiteral('postgres', false)).toBe('FALSE');
    expect(cellLiteral('mysql', true)).toBe('1');
  });

  it('MySQL and SQLite keep LIKE for contains', () => {
    expect(ruleCondition(rule('id', 'contains', '1'), 'mysql', types)).toBe("`id` LIKE '%1%' ESCAPE '!'");
    expect(ruleCondition(rule('id', 'is empty'), 'sqlite', types)).toBe(`("id" IS NULL OR "id" = '')`);
  });
});
