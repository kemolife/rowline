import { describe, expect, it } from 'vitest';
import {
  addInsert,
  countChanges,
  emptyChanges,
  emptyHistory,
  pushChange,
  redo,
  removeInsert,
  rowKeyString,
  setCell,
  setInsertCell,
  toChangeSet,
  toggleDelete,
  undo,
} from './changes';

const key1 = { id: 1 };
const key2 = { id: 2 };

describe('pending changes', () => {
  it('records cell edits per row and drops them when value goes back to original', () => {
    let c = emptyChanges();
    c = setCell(c, key1, 'name', 'Bob', 'Ann');
    c = setCell(c, key1, 'email', null, 'a@x.io');
    expect(c.updates[rowKeyString(key1)].values).toEqual({ name: 'Bob', email: null });
    expect(countChanges(c)).toBe(1);

    c = setCell(c, key1, 'name', 'Ann', 'Ann');
    expect(c.updates[rowKeyString(key1)].values).toEqual({ email: null });
    c = setCell(c, key1, 'email', 'a@x.io', 'a@x.io');
    expect(c.updates[rowKeyString(key1)]).toBeUndefined();
    expect(countChanges(c)).toBe(0);
  });

  it('handles inserted rows and their cells', () => {
    let c = addInsert(emptyChanges(), 'n1');
    c = setInsertCell(c, 'n1', 'name', 'New');
    c = addInsert(c, 'n2');
    expect(countChanges(c)).toBe(2);
    c = removeInsert(c, 'n2');
    expect(toChangeSet(c).inserts).toEqual([{ name: 'New' }]);
  });

  it('toggles deletes and a deleted row drops its pending update', () => {
    let c = setCell(emptyChanges(), key2, 'name', 'X', 'Y');
    c = toggleDelete(c, key2);
    expect(toChangeSet(c)).toEqual({ updates: [], inserts: [], deletes: [key2] });
    c = toggleDelete(c, key2);
    expect(toChangeSet(c).deletes).toEqual([]);
  });

  it('builds a change set for the backend', () => {
    let c = setCell(emptyChanges(), key1, 'name', 'Bob', 'Ann');
    c = toggleDelete(c, key2);
    c = setInsertCell(addInsert(c, 'n1'), 'n1', 'name', 'Cid');
    expect(toChangeSet(c)).toEqual({
      updates: [{ key: key1, values: { name: 'Bob' } }],
      inserts: [{ name: 'Cid' }],
      deletes: [key2],
    });
  });

  it('row keys are stable regardless of property order', () => {
    expect(rowKeyString({ a: 1, b: 'x' })).toBe(rowKeyString({ b: 'x', a: 1 }));
  });
});

describe('undo / redo', () => {
  it('undoes and redoes in order, new change clears redo', () => {
    let h = emptyHistory();
    h = pushChange(h, (c) => setCell(c, key1, 'name', 'B', 'A'));
    h = pushChange(h, (c) => setCell(c, key1, 'name', 'C', 'A'));
    expect(h.present.updates[rowKeyString(key1)].values.name).toBe('C');

    h = undo(h);
    expect(h.present.updates[rowKeyString(key1)].values.name).toBe('B');
    h = undo(h);
    expect(countChanges(h.present)).toBe(0);
    h = undo(h); // nothing more to undo
    expect(countChanges(h.present)).toBe(0);

    h = redo(h);
    expect(h.present.updates[rowKeyString(key1)].values.name).toBe('B');
    h = pushChange(h, (c) => toggleDelete(c, key2));
    expect(h.future).toHaveLength(0);
  });
});
