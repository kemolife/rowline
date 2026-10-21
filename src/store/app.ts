import { create } from 'zustand';
import { api, confirmDialog } from '../lib/api';
import type { FilterRule } from '../lib/filters';
import { useMemo } from 'react';
import { effectiveProjects, insertGrouped, type ProjectInfo } from '../lib/projects';
import type { ConnectionConfig, ConnectionInput, DbObject, ObjectKind, ServerInfo, SortSpec } from '../lib/types';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface TableTab {
  id: string;
  kind: 'table';
  table: string;
  objectKind: ObjectKind;
  view: 'data' | 'structure';
  /** database the tab belongs to (MySQL) */
  database: string | null;
  /** filter chips; kept with the tab so they survive a restart */
  filters?: FilterRule[];
  /** WHERE clause typed in SQL mode */
  sqlFilter?: string;
  filterMode?: 'chips' | 'sql';
  sort?: SortSpec[];
}

export interface TableOpenOptions {
  /** opens a new tab with these filters (foreign key jump) */
  filters?: FilterRule[];
  /** shows the table in this tab instead of a new one */
  replaceTabId?: string;
}

export interface QueryTab {
  id: string;
  kind: 'query';
  title: string;
  sql: string;
  database: string | null;
  /** run all statements once when the tab opens (Claude "Open in grid") */
  autoRun?: boolean;
  /** set when the tab shows a saved query; ⌘S then updates it */
  savedQueryId?: string;
  /** rows fetched per statement; 0 = no limit */
  maxRows?: number;
}

/** Relation diagram of one database */
export interface DiagramTab {
  id: string;
  kind: 'diagram';
  database: string | null;
  /** table to show and select when the tab opens */
  focus?: string;
}

export type Tab = TableTab | QueryTab | DiagramTab;

export interface QueryOpenOptions {
  autoRun?: boolean;
  database?: string | null;
  title?: string;
  savedQueryId?: string;
}

export interface Session {
  connectionId: string;
  config: ConnectionConfig;
  info: ServerInfo;
  databases: string[];
  database: string | null;
  objects: DbObject[];
  loadingObjects: boolean;
}

/** Everything that belongs to one open connection */
export interface Workspace {
  session: Session;
  tabs: Tab[];
  activeTabId: string | null;
  /** pending change counts of table tabs, for close confirmation */
  dirtyTabs: Record<string, number>;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface AppState {
  theme: ThemeMode;
  connections: ConnectionConfig[];
  connecting: string | null;
  workspaces: Record<string, Workspace>;
  /** open connections in rail order */
  openOrder: string[];
  activeConnectionId: string | null;
  /** connection list shown in the main area while connections stay open */
  launcherOpen: boolean;
  sidebarOpen: boolean;
  rowPanelOpen: boolean;
  claudeOpen: boolean;
  editing: ConnectionInput | null;
  paletteOpen: boolean;
  toasts: Toast[];

  setTheme: (t: ThemeMode) => void;
  loadConnections: () => Promise<void>;
  connect: (id: string) => Promise<void>;
  /** After a connection was saved: updates an open workspace and offers to reconnect when needed. */
  applySavedConnection: (config: ConnectionConfig, passwordChanged: boolean) => Promise<void>;
  /** Opens the connection again with its saved settings; tabs stay. */
  reconnect: (id: string) => Promise<void>;
  renameConnection: (id: string, name: string) => Promise<void>;
  switchTo: (id: string) => void;
  showLauncher: (open: boolean) => void;
  disconnect: (id: string) => Promise<void>;
  /** Disconnects first when open; false when the user kept it open (unsaved changes). Throws on backend errors. */
  deleteConnection: (id: string) => Promise<boolean>;
  selectDatabase: (cid: string, db: string) => Promise<void>;
  refreshObjects: (cid: string) => Promise<void>;
  openTable: (cid: string, name: string, kind?: ObjectKind, view?: 'data' | 'structure', opts?: TableOpenOptions) => void;
  /** pinned tables per connection and database (sidebar) */
  pinned: Record<string, string[]>;
  /** recently opened tables per connection and database, newest first */
  recent: Record<string, string[]>;
  togglePin: (cid: string, table: string) => void;
  /** when each connection was last opened (ms), for "2 h ago" on the start screen */
  lastUsed: Record<string, number>;
  /** puts connections into a project (null: no project); saves each connection */
  setProject: (ids: string[], project: string | null) => Promise<void>;
  /** `database`: run in this database instead of the selected one (Claude "Open in grid") */
  openQuery: (cid: string, sql?: string, opts?: QueryOpenOptions) => void;
  updateTab: (cid: string, tabId: string, patch: Partial<TableTab> | Partial<QueryTab> | Partial<DiagramTab>) => void;
  /** Opens the relation diagram of the selected database (one tab per database) */
  openDiagram: (cid: string, focus?: string) => void;
  closeTab: (cid: string, tabId: string) => Promise<void>;
  /** Closes several tabs; asks once when some of them have unsaved changes */
  closeTabs: (cid: string, tabIds: string[]) => Promise<void>;
  setActiveTab: (cid: string, tabId: string) => void;
  setDirty: (cid: string, tabId: string, count: number) => void;
  toggleSidebar: () => void;
  toggleRowPanel: () => void;
  toggleClaude: () => void;
  setEditing: (c: ConnectionInput | null) => void;
  setPaletteOpen: (open: boolean) => void;
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;
let tabId = 0;
const newTabId = () => `tab-${++tabId}`;

const readTheme = (): ThemeMode => {
  try {
    return (localStorage.getItem('rowline.theme') as ThemeMode) || 'dark';
  } catch {
    return 'dark';
  }
};

const readFlag = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage not available */
  }
}

/** Key of per-database sidebar lists (pinned, recent) */
export const tableKey = (cid: string, database: string | null) => `${cid}/${database ?? ''}`;

export const useApp = create<AppState>((set, get) => {
  /** Updates one workspace; does nothing when the connection was closed meanwhile. */
  const patchWs = (cid: string, fn: (w: Workspace) => Partial<Workspace>) => {
    const w = get().workspaces[cid];
    if (!w) return;
    set({ workspaces: { ...get().workspaces, [cid]: { ...w, ...fn(w) } } });
  };
  const patchSession = (cid: string, fn: (s: Session) => Partial<Session>) => patchWs(cid, (w) => ({ session: { ...w.session, ...fn(w.session) } }));
  /** project of a connection: the saved config (fresh after an edit), else the open session's copy */
  const projectOf = (id: string) => {
    const all = get().connections.length ? get().connections : Object.values(get().workspaces).map((w) => w.session.config);
    return effectiveProjects(all).get(id)?.name ?? null;
  };

  return {
    theme: readTheme(),
    connections: [],
    connecting: null,
    workspaces: {},
    openOrder: [],
    activeConnectionId: null,
    launcherOpen: false,
    sidebarOpen: true,
    rowPanelOpen: true,
    claudeOpen: readFlag('rowline.claudeOpen', false),
    pinned: readJson('rowline.pinned', {}),
    lastUsed: readJson('rowline.lastUsed', {}),
    recent: readJson('rowline.recent', {}),
    editing: null,
    paletteOpen: false,
    toasts: [],

    setTheme: (theme) => {
      try {
        localStorage.setItem('rowline.theme', theme);
      } catch {
        /* storage not available */
      }
      // switch the page colors before React re-renders: the data grid reads the CSS colors while rendering
      applyThemeAttribute(theme);
      set({ theme });
    },

    loadConnections: async () => {
      try {
        set({ connections: await api.listConnections() });
      } catch (e) {
        get().toast(`Could not load connections: ${(e as Error).message}`, 'error');
      }
    },

    connect: async (id) => {
      if (get().workspaces[id]) {
        get().switchTo(id);
        return;
      }
      if (get().connecting === id) return; // a double-click: the first connect is still running
      const config = get().connections.find((c) => c.id === id);
      if (!config) return;
      set({ connecting: id });
      try {
        const info = await api.connect(id);
        const databases = config.engine === 'mysql' ? await api.listDatabases(id) : ['main'];
        const database = config.engine === 'mysql' ? config.database || info.currentDatabase || null : null;
        api.setActiveDatabase(id, database).catch(() => {});
        const restored = loadSavedTabs(id);
        set({
          workspaces: {
            ...get().workspaces,
            [id]: {
              session: { connectionId: id, config, info, databases, database, objects: [], loadingObjects: false },
              tabs: restored.tabs,
              activeTabId: restored.activeTabId,
              dirtyTabs: {},
            },
          },
          openOrder: insertGrouped(get().openOrder, id, (o) => projectOf(o)),
          lastUsed: { ...get().lastUsed, [id]: Date.now() },
          activeConnectionId: id,
          launcherOpen: false,
        });
        writeJson('rowline.lastUsed', get().lastUsed);
        if (config.engine === 'sqlite' || database) await get().refreshObjects(id);
      } catch (e) {
        get().toast((e as Error).message, 'error');
      } finally {
        set({ connecting: null });
      }
    },

    applySavedConnection: async (config, passwordChanged) => {
      const w = get().workspaces[config.id];
      if (!w) return;
      const old = w.session.config;
      patchSession(config.id, () => ({ config }));
      // a new project: move it next to the other connections of that project
      if ((old.group ?? null) !== (config.group ?? null) || old.name !== config.name) set({ openOrder: insertGrouped(get().openOrder, config.id, (o) => projectOf(o)) });
      if (!passwordChanged && !needsReconnect(old, config)) return;
      if (await confirmDialog(`Reconnect "${config.name}" now to use the new connection settings? Your tabs stay open.`)) {
        await get().reconnect(config.id);
      }
    },

    reconnect: async (id) => {
      const w = get().workspaces[id];
      const config = get().connections.find((c) => c.id === id);
      if (!w || !config) return;
      set({ connecting: id });
      try {
        await api.disconnect(id).catch(() => undefined);
        const info = await api.connect(id);
        const databases = config.engine === 'mysql' ? await api.listDatabases(id) : ['main'];
        const current = w.session.database;
        const database =
          config.engine === 'mysql' ? (current && databases.includes(current) ? current : config.database || info.currentDatabase || null) : null;
        patchSession(id, () => ({ config, info, databases, database, objects: [] }));
        if (config.engine === 'sqlite' || database) await get().refreshObjects(id);
        get().toast(`Reconnected to ${config.name}`, 'success');
      } catch (e) {
        get().toast((e as Error).message, 'error');
      } finally {
        set({ connecting: null });
      }
    },

    renameConnection: async (id, name) => {
      const config = get().connections.find((c) => c.id === id) ?? get().workspaces[id]?.session.config;
      const trimmed = name.trim();
      if (!config || !trimmed || trimmed === config.name) return;
      try {
        const saved = await api.saveConnection({ ...config, name: trimmed, password: undefined });
        await get().loadConnections();
        patchSession(id, () => ({ config: saved }));
      } catch (e) {
        get().toast((e as Error).message, 'error');
      }
    },

    switchTo: (id) => {
      if (!get().workspaces[id]) return;
      set({ activeConnectionId: id, launcherOpen: false, paletteOpen: false });
    },

    showLauncher: (launcherOpen) => set({ launcherOpen: launcherOpen && get().openOrder.length > 0, paletteOpen: false }),

    disconnect: async (id) => {
      const w = get().workspaces[id];
      if (!w) return;
      const dirty = Object.values(w.dirtyTabs).some((n) => n > 0);
      if (dirty && !(await confirmDialog(`"${w.session.config.name}" has unsaved changes. Disconnect anyway?`))) return;
      try {
        await api.disconnect(id);
      } catch {
        /* already closed */
      }
      const { [id]: _closed, ...workspaces } = get().workspaces;
      const order = get().openOrder;
      const idx = order.indexOf(id);
      const openOrder = order.filter((o) => o !== id);
      let activeConnectionId = get().activeConnectionId;
      if (activeConnectionId === id) activeConnectionId = openOrder[Math.min(idx, openOrder.length - 1)] ?? null;
      set({ workspaces, openOrder, activeConnectionId, launcherOpen: get().launcherOpen && openOrder.length > 0 });
    },

    deleteConnection: async (id) => {
      if (get().workspaces[id]) {
        await get().disconnect(id);
        if (get().workspaces[id]) return false;
      }
      await api.deleteConnection(id);
      await get().loadConnections();
      return true;
    },

    selectDatabase: async (cid, db) => {
      const w = get().workspaces[cid];
      if (!w || w.session.database === db) return;
      patchSession(cid, () => ({ database: db, objects: [] }));
      api.setActiveDatabase(cid, db).catch(() => {});
      await get().refreshObjects(cid);
    },

    refreshObjects: async (cid) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const database = w.session.database;
      patchSession(cid, () => ({ loadingObjects: true }));
      try {
        const objects = await api.listObjects(cid, database);
        patchSession(cid, (s) => (s.database === database ? { objects, loadingObjects: false } : {}));
      } catch (e) {
        patchSession(cid, () => ({ loadingObjects: false }));
        get().toast((e as Error).message, 'error');
      }
    },

    openTable: (cid, name, kind = 'table', view = 'data', opts = {}) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const key = tableKey(cid, w.session.database);
      const recent = { ...get().recent, [key]: [name, ...(get().recent[key] ?? []).filter((t) => t !== name)].slice(0, 8) };
      set({ recent });
      writeJson('rowline.recent', recent);
      if (opts.filters || opts.replaceTabId) {
        const tab: TableTab = { id: opts.replaceTabId ?? newTabId(), kind: 'table', table: name, objectKind: kind, view, database: w.session.database, filters: opts.filters };
        patchWs(cid, (ws) => ({
          tabs: opts.replaceTabId ? ws.tabs.map((t) => (t.id === opts.replaceTabId ? tab : t)) : [...ws.tabs, tab],
          activeTabId: tab.id,
        }));
        return;
      }
      const existing = w.tabs.find((t) => t.kind === 'table' && t.table === name && t.database === w.session.database);
      if (existing) {
        patchWs(cid, () => ({ activeTabId: existing.id }));
        if (existing.kind === 'table' && existing.view !== view) get().updateTab(cid, existing.id, { view });
        return;
      }
      const tab: TableTab = { id: newTabId(), kind: 'table', table: name, objectKind: kind, view, database: w.session.database };
      patchWs(cid, (ws) => ({ tabs: [...ws.tabs, tab], activeTabId: tab.id }));
    },

    openQuery: (cid, sql = '', opts = {}) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const n = w.tabs.filter((t) => t.kind === 'query').length + 1;
      if (opts.savedQueryId) {
        // a saved query that is already open: show that tab
        const open = w.tabs.find((t) => t.kind === 'query' && t.savedQueryId === opts.savedQueryId);
        if (open) {
          patchWs(cid, () => ({ activeTabId: open.id }));
          return;
        }
      }
      const tab: QueryTab = {
        id: newTabId(),
        kind: 'query',
        title: opts.title ?? `Query ${n}`,
        sql,
        database: opts.database ?? w.session.database,
        ...(opts.autoRun ? { autoRun: true } : {}),
        ...(opts.savedQueryId ? { savedQueryId: opts.savedQueryId } : {}),
      };
      patchWs(cid, (ws) => ({ tabs: [...ws.tabs, tab], activeTabId: tab.id }));
    },

    openDiagram: (cid, focus) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const existing = w.tabs.find((t) => t.kind === 'diagram' && t.database === w.session.database);
      if (existing) {
        patchWs(cid, (ws) => ({ activeTabId: existing.id, tabs: ws.tabs.map((t) => (t.id === existing.id ? { ...t, focus } : t)) }));
        return;
      }
      const tab: DiagramTab = { id: newTabId(), kind: 'diagram', database: w.session.database, focus };
      patchWs(cid, (ws) => ({ tabs: [...ws.tabs, tab], activeTabId: tab.id }));
    },

    updateTab: (cid, id, patch) => patchWs(cid, (w) => ({ tabs: w.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),

    closeTabs: async (cid, ids) => {
      const w = get().workspaces[cid];
      if (!w || !ids.length) return;
      const closing = new Set(ids);
      const dirty = ids.reduce((n, id) => n + (w.dirtyTabs[id] ?? 0), 0);
      const dirtyTabs = ids.filter((id) => (w.dirtyTabs[id] ?? 0) > 0).length;
      if (dirty > 0 && !(await confirmDialog(`Discard ${dirty} unsaved change${dirty > 1 ? 's' : ''} in ${dirtyTabs} tab${dirtyTabs > 1 ? 's' : ''}?`))) return;
      patchWs(cid, (ws) => {
        const rest = ws.tabs.filter((t) => !closing.has(t.id));
        const dirtyLeft = Object.fromEntries(Object.entries(ws.dirtyTabs).filter(([id]) => !closing.has(id)));
        let activeTabId = ws.activeTabId;
        if (activeTabId && closing.has(activeTabId)) {
          // the nearest tab that stays, to the left first
          const idx = ws.tabs.findIndex((t) => t.id === activeTabId);
          const left = ws.tabs.slice(0, idx).reverse().find((t) => !closing.has(t.id));
          const right = ws.tabs.slice(idx + 1).find((t) => !closing.has(t.id));
          activeTabId = (left ?? right)?.id ?? null;
        }
        return { tabs: rest, activeTabId, dirtyTabs: dirtyLeft };
      });
    },

    closeTab: async (cid, id) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const dirty = w.dirtyTabs[id] ?? 0;
      if (dirty > 0 && !(await confirmDialog(`Discard ${dirty} unsaved change${dirty > 1 ? 's' : ''}?`))) return;
      patchWs(cid, (ws) => {
        const idx = ws.tabs.findIndex((t) => t.id === id);
        const rest = ws.tabs.filter((t) => t.id !== id);
        const { [id]: _gone, ...dirtyTabs } = ws.dirtyTabs;
        const activeTabId = ws.activeTabId === id ? rest[Math.min(idx, rest.length - 1)]?.id ?? null : ws.activeTabId;
        return { tabs: rest, activeTabId, dirtyTabs };
      });
    },

    setProject: async (ids, project) => {
      const group = project?.trim() || null;
      try {
        for (const id of ids) {
          const c = get().connections.find((x) => x.id === id);
          if (!c || (c.group ?? null) === group) continue;
          const saved = await api.saveConnection({ ...c, group, password: undefined });
          patchSession(id, () => ({ config: saved }));
        }
        await get().loadConnections();
        for (const id of ids) if (get().workspaces[id]) set({ openOrder: insertGrouped(get().openOrder, id, (o) => projectOf(o)) });
      } catch (e) {
        get().toast((e as Error).message, 'error');
      }
    },

    togglePin: (cid, table) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const key = tableKey(cid, w.session.database);
      const list = get().pinned[key] ?? [];
      const pinned = { ...get().pinned, [key]: list.includes(table) ? list.filter((t) => t !== table) : [...list, table] };
      set({ pinned });
      writeJson('rowline.pinned', pinned);
    },

    setActiveTab: (cid, id) => patchWs(cid, () => ({ activeTabId: id })),
    setDirty: (cid, id, count) => {
      const w = get().workspaces[cid];
      if (!w || (w.dirtyTabs[id] ?? 0) === count) return;
      patchWs(cid, (ws) => ({ dirtyTabs: { ...ws.dirtyTabs, [id]: count } }));
    },
    toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
    toggleRowPanel: () => set({ rowPanelOpen: !get().rowPanelOpen }),
    toggleClaude: () => {
      const claudeOpen = !get().claudeOpen;
      try {
        localStorage.setItem('rowline.claudeOpen', claudeOpen ? '1' : '0');
      } catch {
        /* storage not available */
      }
      set({ claudeOpen });
    },
    setEditing: (editing) => set({ editing }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

    toast: (message, kind = 'info') => {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, kind, message }] });
      // longer messages (several lines, e.g. setup steps) stay longer
      setTimeout(() => get().dismissToast(id), message.includes('\n') ? 12000 : kind === 'error' ? 7000 : 3500);
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  };
});

/** Settings that change how Rowline connects; changing any of them needs a reconnect. */
export function needsReconnect(a: ConnectionConfig, b: ConnectionConfig): boolean {
  const keys: (keyof ConnectionConfig)[] = ['engine', 'host', 'port', 'user', 'tls', 'filePath'];
  return keys.some((k) => (a[k] ?? null) !== (b[k] ?? null));
}

/** Sets the light/dark colors on the page (CSS variables follow `data-theme`; "system" follows macOS). */
export function applyThemeAttribute(theme: ThemeMode) {
  if (typeof document === 'undefined') return;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export const activeWorkspace = (s: AppState): Workspace | null => (s.activeConnectionId ? s.workspaces[s.activeConnectionId] ?? null : null);
export const wsActiveTab = (w: Workspace): Tab | null => w.tabs.find((t) => t.id === w.activeTabId) ?? null;

// Open tabs (and query text) are remembered per connection and restored on the next connect.
const TABS_KEY = (connectionId: string) => `rowline.tabs.${connectionId}`;

function loadSavedTabs(connectionId: string): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY(connectionId)) ?? 'null') as { tabs: Omit<Tab, 'id'>[]; active: number } | null;
    if (!saved?.tabs?.length) return { tabs: [], activeTabId: null };
    const tabs = saved.tabs.map((t) => ({ ...t, id: newTabId(), autoRun: undefined }) as Tab);
    return { tabs, activeTabId: tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)]?.id ?? null };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
useApp.subscribe((state, prev) => {
  if (state.workspaces === prev.workspaces) return;
  for (const [cid, w] of Object.entries(state.workspaces)) {
    const old = prev.workspaces[cid];
    if (old && old.tabs === w.tabs && old.activeTabId === w.activeTabId) continue;
    const tabs = w.tabs;
    const active = tabs.findIndex((t) => t.id === w.activeTabId);
    clearTimeout(saveTimers[cid]);
    saveTimers[cid] = setTimeout(() => {
      try {
        localStorage.setItem(TABS_KEY(cid), JSON.stringify({ tabs: tabs.map(({ id: _id, ...rest }) => ({ ...rest, autoRun: undefined })), active }));
      } catch {
        /* storage not available */
      }
    }, 300);
  }
});

/** Projects of all saved connections: typed by the user, or guessed from names and databases */
export function useProjects(): Map<string, ProjectInfo> {
  const connections = useApp((s) => s.connections);
  return useMemo(() => effectiveProjects(connections), [connections]);
}
