import { isSqlExpr, type Cell, type ChangeSet, type RowValues } from './types';

/** Pending (unsaved) grid edits of one table. Immutable; every function returns a new object. */
export interface Changes {
  /** rowKeyString(key) -> primary key + changed values */
  updates: Record<string, { key: RowValues; values: RowValues }>;
  inserts: { id: string; values: RowValues }[];
  /** rowKeyString(key) -> primary key */
  deletes: Record<string, RowValues>;
}

export const emptyChanges = (): Changes => ({ updates: {}, inserts: [], deletes: {} });

export function rowKeyString(key: RowValues): string {
  return JSON.stringify(Object.keys(key).sort().map((k) => [k, key[k]]));
}

const sameValue = (a: Cell, b: Cell) => {
  if (isSqlExpr(a) || isSqlExpr(b)) return isSqlExpr(a) && isSqlExpr(b) && a.$expr === b.$expr;
  return a === b || (a != null && b != null && String(a) === String(b));
};

export function setCell(c: Changes, key: RowValues, column: string, value: Cell, original: Cell): Changes {
  const k = rowKeyString(key);
  const current = c.updates[k] ?? { key, values: {} };
  const values = { ...current.values };
  if (sameValue(value, original)) delete values[column];
  else values[column] = value;
  const updates = { ...c.updates };
  if (Object.keys(values).length) updates[k] = { key, values };
  else delete updates[k];
  return { ...c, updates };
}

export function addInsert(c: Changes, id: string, values: RowValues = {}): Changes {
  return { ...c, inserts: [...c.inserts, { id, values }] };
}

export function setInsertCell(c: Changes, id: string, column: string, value: Cell): Changes {
  return { ...c, inserts: c.inserts.map((r) => (r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r)) };
}

export function removeInsert(c: Changes, id: string): Changes {
  return { ...c, inserts: c.inserts.filter((r) => r.id !== id) };
}

export function toggleDelete(c: Changes, key: RowValues): Changes {
  const k = rowKeyString(key);
  const deletes = { ...c.deletes };
  const updates = { ...c.updates };
  if (deletes[k]) delete deletes[k];
  else {
    deletes[k] = key;
    delete updates[k];
  }
  return { ...c, deletes, updates };
}

export function countChanges(c: Changes): number {
  return Object.keys(c.updates).length + c.inserts.length + Object.keys(c.deletes).length;
}

export function toChangeSet(c: Changes): ChangeSet {
  return {
    updates: Object.values(c.updates).map((u) => ({ key: u.key, values: u.values })),
    inserts: c.inserts.map((r) => r.values),
    deletes: Object.values(c.deletes),
  };
}

/** Undo/redo history of a Changes value */
export interface History {
  past: Changes[];
  present: Changes;
  future: Changes[];
}

const HISTORY_LIMIT = 200;

export const emptyHistory = (): History => ({ past: [], present: emptyChanges(), future: [] });

export function pushChange(h: History, fn: (c: Changes) => Changes): History {
  const next = fn(h.present);
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo(h: History): History {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}
