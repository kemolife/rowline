import { describe, expect, it } from 'vitest';
import { isTextLike, nowKeyword, prettyJson, valueOptions, type FieldInfo } from './fieldValues';

const field = (type: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({ type, nullable: true, primaryKey: false, autoIncrement: false, defaultValue: null, ...extra });
const kinds = (opts: { kind: string }[]) => opts.map((o) => o.kind);

describe('field value menu', () => {
  it('picks the right NOW() keyword', () => {
    expect(nowKeyword('datetime')).toBe('CURRENT_TIMESTAMP');
    expect(nowKeyword('timestamp(6)')).toBe('CURRENT_TIMESTAMP');
    expect(nowKeyword('DATE')).toBe('CURRENT_DATE');
    expect(nowKeyword('time')).toBe('CURRENT_TIME');
    expect(nowKeyword('varchar(20)')).toBeNull();
  });

  it('knows text-like columns', () => {
    expect(isTextLike('varchar(255)')).toBe(true);
    expect(isTextLike('json')).toBe(true);
    expect(isTextLike('')).toBe(true); // SQLite column without a type
    expect(isTextLike('int(11) unsigned')).toBe(false);
    expect(isTextLike('decimal(10,2)')).toBe(false);
    expect(isTextLike('datetime')).toBe(false);
  });

  it('pretty-prints JSON objects and arrays only', () => {
    expect(prettyJson('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('[1]')).toBe('[\n  1\n]');
    expect(prettyJson('12')).toBeNull();
    expect(prettyJson('{broken')).toBeNull();
  });

  it('offers what fits the column, like TablePlus', () => {
    expect(kinds(valueOptions(field('text'), 'mysql', false, 'x'))).toEqual(['null', 'default', 'empty', 'file']);
    expect(kinds(valueOptions(field('timestamp', { nullable: false, defaultValue: 'CURRENT_TIMESTAMP' }), 'mysql', false, 'x'))).toEqual(['default', 'now']);
    expect(kinds(valueOptions(field('int', { nullable: false, primaryKey: true, autoIncrement: true }), 'mysql', false, 1))).toEqual(['default']);
    expect(kinds(valueOptions(field('int', { nullable: false }), 'mysql', false, 1))).toEqual([]);
    expect(kinds(valueOptions(field('json'), 'mysql', false, '{"a":1}'))).toContain('pretty');
    expect(kinds(valueOptions(field('json'), 'mysql', false, '{\n  "a": 1\n}'))).not.toContain('pretty');
  });

  it('SQLite offers DEFAULT only for new rows', () => {
    expect(kinds(valueOptions(field('TEXT', { defaultValue: "'x'" }), 'sqlite', false, 'y'))).not.toContain('default');
    expect(kinds(valueOptions(field('TEXT', { defaultValue: "'x'" }), 'sqlite', true, 'y'))).toContain('default');
  });
});
