import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';
import type { SchemaSnapshot, SchemaTable } from '../lib/schemaDiff';
import { relationsOf, type Relation } from '../lib/diagram';
import { diffSchema, snapshotsFor } from '../lib/schemaDiff';
import { schemaWithKeys, type VirtualKey } from '../lib/virtualKeys';
import { scopeKey } from '../lib/engine';
import { tableKey, useApp } from './app';

/**
 * Schema of one database for the relation diagram, plus its saved snapshots. Postgres passes the schema too:
 * entries, snapshots and virtual keys are then kept per `<db>/<schema>` (scopeKey).
 */
export interface SchemaEntry {
  live: SchemaTable[] | null;
  snapshots: SchemaSnapshot[];
  /** snapshot the live schema is compared with (index); -1 = none */
  compareTo: number;
  loading: boolean;
  error: string | null;
}

interface SchemaState {
  entries: Record<string, SchemaEntry>;
  load: (cid: string, database: string | null, force?: boolean, schema?: string | null) => Promise<void>;
  /** saves the live schema as a snapshot: everything counts as seen */
  markSeen: (cid: string, database: string | null, schema?: string | null) => Promise<void>;
  setCompare: (cid: string, database: string | null, index: number, schema?: string | null) => void;
  /** virtual foreign keys per database (key: tableKey) */
  keys: Record<string, VirtualKey[]>;
  loadKeys: (cid: string, database: string | null, schema?: string | null) => Promise<void>;
  saveKey: (cid: string, database: string | null, key: Pick<VirtualKey, 'table' | 'columns' | 'refTable' | 'refColumns'>, schema?: string | null) => Promise<boolean>;
  deleteKey: (cid: string, database: string | null, id: string, schema?: string | null) => Promise<void>;
}

const empty: SchemaEntry = { live: null, snapshots: [], compareTo: -1, loading: false, error: null };

export const useSchema = create<SchemaState>((set, get) => {
  const patch = (key: string, p: Partial<SchemaEntry>) => set({ entries: { ...get().entries, [key]: { ...(get().entries[key] ?? empty), ...p } } });
  return {
    entries: {},
    load: async (cid, database, force = false, schema = null) => {
      const key = tableKey(cid, database, schema);
      const scope = scopeKey(database, schema);
      const cur = get().entries[key];
      if (cur?.loading || (cur?.live && !force)) return;
      patch(key, { loading: true, error: null });
      try {
        const [live, saved] = await Promise.all([schema ? api.schemaGraph(cid, database, schema) : api.schemaGraph(cid, database), api.schemaSnapshots(cid, scope)]);
        const snapshots = snapshotsFor(saved, scope);
        patch(key, { live, snapshots, compareTo: snapshots.length - 1, loading: false });
      } catch (e) {
        patch(key, { loading: false, error: (e as Error).message });
      }
    },
    markSeen: async (cid, database, schema = null) => {
      const key = tableKey(cid, database, schema);
      try {
        const snap = schema ? await api.saveSchemaSnapshot(cid, database, schema, scopeKey(database, schema)) : await api.saveSchemaSnapshot(cid, database);
        const snapshots = [...(get().entries[key]?.snapshots ?? []), snap].slice(-5);
        patch(key, { snapshots, compareTo: snapshots.length - 1, live: snap.tables });
        useApp.getState().toast('Schema saved as seen. New changes show from now on.', 'success');
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },
    setCompare: (cid, database, index, schema = null) => patch(tableKey(cid, database, schema), { compareTo: index }),

    keys: {},
    loadKeys: async (cid, database, schema = null) => {
      const k = tableKey(cid, database, schema);
      if (get().keys[k] || loadingKeys.has(k)) return;
      loadingKeys.add(k);
      try {
        const list = await api.listVirtualKeys(cid, scopeKey(database, schema));
        set({ keys: { ...get().keys, [k]: list } });
      } catch {
        /* not available (e.g. old backend): no virtual keys */
      } finally {
        loadingKeys.delete(k);
      }
    },
    saveKey: async (cid, database, key, schema = null) => {
      try {
        const saved = await api.saveVirtualKey({ ...key, connectionId: cid, database: scopeKey(database, schema) });
        const k = tableKey(cid, database, schema);
        set({ keys: { ...get().keys, [k]: [...(get().keys[k] ?? []).filter((x) => x.id !== saved.id), saved] } });
        useApp.getState().toast(`Saved ${saved.table}.${saved.columns.join(', ')} → ${saved.refTable} as a virtual foreign key`, 'success');
        return true;
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
        return false;
      }
    },
    deleteKey: async (cid, database, id, schema = null) => {
      try {
        await api.deleteVirtualKey(id);
        const k = tableKey(cid, database, schema);
        set({ keys: { ...get().keys, [k]: (get().keys[k] ?? []).filter((x) => x.id !== id) } });
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },
  };
});

export const emptySchema = empty;

const loadingKeys = new Set<string>();
const NO_KEYS: VirtualKey[] = [];

/** Virtual foreign keys of a database (loaded on first use) */
export function useVirtualKeys(cid: string, database: string | null, schema: string | null = null): VirtualKey[] {
  const keys = useSchema((s) => s.keys[tableKey(cid, database, schema)]) ?? NO_KEYS;
  useEffect(() => {
    useSchema.getState().loadKeys(cid, database, schema);
  }, [cid, database, schema]);
  return keys;
}

const NO_RELATIONS: Relation[] = [];

/**
 * Relations that point to this table (single column only): real foreign keys, virtual keys and
 * relations guessed from column names. Reads the schema once per database (cached).
 */
/** Every relation of a database (real, virtual and guessed); for JOIN completion */
export function useRelations(cid: string, database: string | null, enabled = true, schema: string | null = null): Relation[] {
  const entry = useSchema((s) => s.entries[tableKey(cid, database, schema)]);
  const keys = useVirtualKeys(cid, database, schema);
  useEffect(() => {
    if (enabled) useSchema.getState().load(cid, database, false, schema);
  }, [cid, database, enabled, schema]);
  const live = entry?.live;
  return useMemo(() => (live ? relationsOf(diffSchema(null, schemaWithKeys(live, keys)).tables, true) : NO_RELATIONS), [live, keys]);
}

export function useReferencing(cid: string, database: string | null, table: string, schema: string | null = null): Relation[] {
  const entry = useSchema((s) => s.entries[tableKey(cid, database, schema)]);
  const keys = useVirtualKeys(cid, database, schema);
  useEffect(() => {
    useSchema.getState().load(cid, database, false, schema);
  }, [cid, database, schema]);
  const live = entry?.live;
  return useMemo(() => {
    if (!live) return NO_RELATIONS;
    const tables = diffSchema(null, schemaWithKeys(live, keys)).tables;
    return relationsOf(tables, true).filter((r) => r.to === table && r.toColumns.length === 1 && r.fromColumns.length === 1);
  }, [live, keys, table]);
}
