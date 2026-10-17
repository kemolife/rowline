import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useApp, type DiagramTab, type QueryOpenOptions, type QueryTab, type TableOpenOptions, type TableTab, type Workspace } from './app';
import type { ObjectKind } from '../lib/types';

const ConnectionContext = createContext<string | null>(null);

/** Everything rendered inside belongs to one open connection. */
export function ConnectionScope({ id, children }: { id: string; children: ReactNode }) {
  return <ConnectionContext.Provider value={id}>{children}</ConnectionContext.Provider>;
}

export function useConnectionId(): string {
  const id = useContext(ConnectionContext);
  if (!id) throw new Error('useConnectionId must be used inside <ConnectionScope>');
  return id;
}

/**
 * Reads from this scope's workspace. While a connection closes, components may render once more
 * after their workspace is gone; they then keep the last value instead of crashing.
 */
export function useWs<T>(select: (w: Workspace) => T): T {
  const id = useConnectionId();
  const last = useRef<T>(undefined as T);
  return useApp((s) => {
    const w = s.workspaces[id];
    if (w) last.current = select(w);
    return last.current;
  });
}

/** Store actions with this scope's connection id filled in. */
export function useWsActions() {
  const id = useConnectionId();
  return useMemo(() => {
    const s = () => useApp.getState();
    return {
      openTable: (name: string, kind?: ObjectKind, view?: 'data' | 'structure', opts?: TableOpenOptions) => s().openTable(id, name, kind, view, opts),
      togglePin: (table: string) => s().togglePin(id, table),
      openQuery: (sql?: string, opts?: QueryOpenOptions) => s().openQuery(id, sql, opts),
      updateTab: (tabId: string, patch: Partial<TableTab> | Partial<QueryTab> | Partial<DiagramTab>) => s().updateTab(id, tabId, patch),
      openDiagram: (focus?: string) => s().openDiagram(id, focus),
      closeTab: (tabId: string) => s().closeTab(id, tabId),
      setActiveTab: (tabId: string) => s().setActiveTab(id, tabId),
      setDirty: (tabId: string, count: number) => s().setDirty(id, tabId, count),
      selectDatabase: (db: string) => s().selectDatabase(id, db),
      refreshObjects: () => s().refreshObjects(id),
      disconnect: () => s().disconnect(id),
    };
  }, [id]);
}
