import { describe, expect, it } from 'vitest';
import { boolValue, columnMeta, groupByPrefix, middleTruncate, shortType, weekdayName } from './columns';
import type { TableStructure } from './types';

const col = (name: string, dataType: string, primaryKey = false) => ({ name, dataType, nullable: true, defaultValue: null, primaryKey, autoIncrement: false, comment: null });

describe('column display', () => {
  it('shortens types', () => {
    expect(shortType('bigint unsigned')).toBe('bigint');
    expect(shortType('varchar(255)')).toBe('varchar');
    expect(shortType('tinyint(1)')).toBe('bool');
    expect(shortType('decimal(10,2) unsigned zerofill')).toBe('decimal');
    expect(shortType('TEXT')).toBe('text');
  });

  it('finds keys, booleans and weekday columns', () => {
    const structure: TableStructure = {
      name: 'agenda_availability',
      kind: 'table',
      columns: [col('id', 'bigint unsigned', true), col('user_team_id', 'bigint unsigned'), col('day_of_week', 'smallint'), col('unavailable', 'tinyint(1)'), col('note', 'text')],
      indexes: [],
      foreignKeys: [{ name: 'fk', columns: ['user_team_id'], refTable: 'user_team', refColumns: ['id'], onUpdate: null, onDelete: null }],
      ddl: null,
    };
    const meta = columnMeta(structure.columns.map((c) => ({ name: c.name, typeName: 'x' })), structure);
    expect(meta[0]).toMatchObject({ primaryKey: true, numeric: true, typeHint: 'bigint' });
    expect(meta[1].foreignKey).toEqual({ table: 'user_team', column: 'id' });
    expect(meta[2].weekday).toBe(true);
    expect(meta[3]).toMatchObject({ boolean: true, numeric: false, typeHint: 'bool' });
    expect(meta[4]).toMatchObject({ numeric: false, foreignKey: null });
  });

  it('names weekdays and reads booleans', () => {
    expect(weekdayName(1)).toBe('Mon');
    expect(weekdayName('7')).toBe('Sun');
    expect(weekdayName(9)).toBeNull();
    expect(boolValue(1)).toBe(true);
    expect(boolValue('0')).toBe(false);
    expect(boolValue(null)).toBeNull();
  });

  it('truncates in the middle and groups by prefix', () => {
    expect(middleTruncate('agenda_event_client_page_uploads')).toMatch(/^agenda_event_.*….*_uploads$/);
    expect(middleTruncate('short')).toBe('short');
    const groups = groupByPrefix(['agenda', 'agenda_assets', 'agenda_event', 'client', 'client_view', 'orders'].map((name) => ({ name })));
    expect(groups.map((g) => [g.prefix, g.items.map((i) => i.name)])).toEqual([
      ['agenda_', ['agenda', 'agenda_assets', 'agenda_event']],
      ['client_', ['client', 'client_view']],
      [null, ['orders']],
    ]);
  });
});
