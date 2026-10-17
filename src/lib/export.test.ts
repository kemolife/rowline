import { describe, expect, it } from 'vitest';
import { forClaude, guessTable, toCsv, toJson, toMarkdown, toSqlInsert, toTextTable, toTsv } from './export';

const cols = [{ name: 'id', typeName: 'int' }, { name: 'note', typeName: 'text' }];

describe('export', () => {
  it('escapes CSV fields and writes NULL as empty', () => {
    expect(toCsv(cols, [[1, 'a,"b"'], [2, null], [3, 'line\nbreak']])).toBe('id,note\n1,"a,""b"""\n2,\n3,"line\nbreak"\n');
  });

  it('writes JSON objects keyed by column', () => {
    expect(JSON.parse(toJson(cols, [[1, null]]))).toEqual([{ id: 1, note: null }]);
  });

  it('writes TSV without tabs or newlines inside values', () => {
    expect(toTsv(cols, [[1, 'a\tb\nc']])).toBe('id\tnote\n1\ta b c\n');
  });

  it('writes Markdown with escaped pipes and NULL', () => {
    expect(toMarkdown(cols, [[1, 'a|b'], [2, null]])).toBe('| id | note |\n| --- | --- |\n| 1 | a\\|b |\n| 2 | NULL |\n');
  });

  it('writes SQL INSERT with quoted values', () => {
    expect(toSqlInsert(cols, [[1, "it's"], [2, null]], 'notes', 'mysql')).toBe("INSERT INTO `notes` (`id`, `note`) VALUES\n  (1, 'it''s'),\n  (2, NULL);\n");
    expect(toSqlInsert(cols, [], 'notes', 'mysql')).toBe('');
  });

  it('writes a text table', () => {
    expect(toTextTable(cols, [[1, null]])).toBe('+----+------+\n| id | note |\n+----+------+\n| 1  | NULL |\n+----+------+\n');
  });

  it('prepares a result for Claude with a row cap', () => {
    const text = forClaude('SELECT 1', cols, [[1, 'a'], [2, 'b'], [3, 'c']], 2);
    expect(text).toContain('```sql\nSELECT 1\n```');
    expect(text).toContain('Result (3 rows)');
    expect(text).toContain('| 2 | b |');
    expect(text).not.toContain('| 3 | c |');
    expect(text).toContain('(2 of 3 rows shown)');
  });

  it('guesses the table of a query', () => {
    expect(guessTable('select * from `shop`.`orders` o where 1')).toBe('orders');
    expect(guessTable('SELECT * FROM customers LIMIT 3')).toBe('customers');
    expect(guessTable('SELECT 1')).toBe('result');
  });
});
