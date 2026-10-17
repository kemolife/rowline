import { describe, expect, it } from 'vitest';
import { isVirtual, schemaWithKeys, structureWithKeys, virtualKeyId, type VirtualKey } from './virtualKeys';

const key: VirtualKey = { id: 'k1', connectionId: 'c', database: 'shop', table: 'visits', columns: ['ds_person_id'], refTable: 'ds_person', refColumns: ['ds_person_id'] };

describe('virtual keys', () => {
  it('adds virtual keys as foreign keys, but never over a real one', () => {
    const s = { name: 'visits', kind: 'table' as const, columns: [], indexes: [], foreignKeys: [], ddl: null };
    const merged = structureWithKeys(s, [key]);
    expect(merged.foreignKeys).toHaveLength(1);
    expect(isVirtual(merged.foreignKeys[0])).toBe(true);
    expect(virtualKeyId(merged.foreignKeys[0])).toBe('k1');
    const real = { ...s, foreignKeys: [{ name: 'fk', columns: ['ds_person_id'], refTable: 'ds_person', refColumns: ['ds_person_id'], onUpdate: null, onDelete: null }] };
    expect(structureWithKeys(real, [key]).foreignKeys).toHaveLength(1);
    expect(structureWithKeys({ ...s, name: 'other' }, [key])).toEqual({ ...s, name: 'other' });
  });

  it('adds them to the schema of the diagram', () => {
    const t = { name: 'visits', kind: 'table' as const, columns: [], foreignKeys: [], rowEstimate: null, comment: null };
    expect(schemaWithKeys([t], [key])[0].foreignKeys[0].refTable).toBe('ds_person');
    expect(schemaWithKeys([t], [])[0]).toBe(t);
  });
});
