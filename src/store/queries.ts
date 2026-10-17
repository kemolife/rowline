import { create } from 'zustand';
import { api } from '../lib/api';
import type { SavedQuery } from '../lib/types';
import { useApp } from './app';

interface QueriesState {
  /** saved queries per connection id, sorted by name */
  byConnection: Record<string, SavedQuery[]>;
  load: (cid: string) => Promise<void>;
  /** creates (no id) or updates a saved query; returns it, or null when saving failed */
  save: (q: { id?: string; connectionId: string; name: string; sql: string; database: string | null }) => Promise<SavedQuery | null>;
  rename: (q: SavedQuery, name: string) => Promise<void>;
  remove: (q: SavedQuery) => Promise<void>;
}

const sortByName = (list: SavedQuery[]) => [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

export const useQueries = create<QueriesState>((set, get) => {
  const put = (cid: string, list: SavedQuery[]) => set({ byConnection: { ...get().byConnection, [cid]: sortByName(list) } });

  return {
    byConnection: {},

    load: async (cid) => {
      try {
        put(cid, await api.listSavedQueries(cid));
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },

    save: async (q) => {
      try {
        const saved = await api.saveQuery(q);
        const list = get().byConnection[q.connectionId] ?? [];
        put(q.connectionId, [...list.filter((x) => x.id !== saved.id), saved]);
        // an open tab of this query shows the new name
        const s = useApp.getState();
        const tab = s.workspaces[q.connectionId]?.tabs.find((t) => t.kind === 'query' && t.savedQueryId === saved.id);
        if (tab) s.updateTab(q.connectionId, tab.id, { title: saved.name });
        return saved;
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
        return null;
      }
    },

    rename: async (q, name) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === q.name) return;
      await get().save({ ...q, name: trimmed });
    },

    remove: async (q) => {
      try {
        await api.deleteSavedQuery(q.id);
        put(q.connectionId, (get().byConnection[q.connectionId] ?? []).filter((x) => x.id !== q.id));
        // an open tab keeps its text but is no longer linked to the deleted query
        const s = useApp.getState();
        const tab = s.workspaces[q.connectionId]?.tabs.find((t) => t.kind === 'query' && t.savedQueryId === q.id);
        if (tab) s.updateTab(q.connectionId, tab.id, { savedQueryId: undefined });
      } catch (e) {
        useApp.getState().toast((e as Error).message, 'error');
      }
    },
  };
});
