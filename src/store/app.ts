import { create } from 'zustand';
import { api, confirmDialog } from '../lib/api';
import type { FilterRule } from '../lib/filters';
import { useMemo } from 'react';
import { isServer, pickSchema, scopeKey } from '../lib/engine';
import { effectiveProjects, insertGrouped, type ProjectInfo } from '../lib/projects';
import type { ConnectionConfig, ConnectionInput, DbObject, ObjectKind, ServerInfo, SortSpec } from '../lib/types';

export type ThemeMode = 'system' | 'light' | 'dark';
/** color style, independent of light/dark: blue (default) or warm (beige and terracotta) */
export type ColorStyle = 'blue' | 'warm';

export interface TableTab {
  id: string;
  kind: 'table';
  table: string;
  objectKind: ObjectKind;
  view: 'data' | 'structure';
  /** database the tab belongs to (MySQL, Postgres) */
  database: string | null;
  /** Postgres schema of the table (absent for MySQL and SQLite; null/absent = `public`) */
  schema?: string | null;
  /** filter chips; kept with the tab so they survive a restart */
  filters?: FilterRule[];
  /** WHERE clause typed in SQL mode */
  sqlFilter?: string;
  filterMode?: 'chips' | 'sql';
  sort?: SortSpec[];
  /** prod Postgres: the user unlocked writes in this tab. Never saved; gone when the tab closes. */
  writesUnlocked?: boolean;
}

export interface TableOpenOptions {
  /** opens a new tab with these filters (foreign key jump) */
  filters?: FilterRule[];
  /** shows the table in this tab instead of a new one */
  replaceTabId?: string;
  /** Postgres: the schema of the table (default: the one the sidebar shows) */
  schema?: string | null;
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
  /** prod Postgres: the user unlocked writes in this tab. Never saved; gone when the tab closes. */
  writesUnlocked?: boolean;
  /**
   * The database and schema the unlock was given for. The editor runs against the sidebar's database and
   * schema, so the unlock holds only while those are the same (see `queryTabUnlocked`).
   */
  unlockedFor?: { database: string | null; schema: string | null };
}

/** True when this query tab may write: it was unlocked for the database and schema the session shows now. */
export function queryTabUnlocked(tab: QueryTab, session: Pick<Session, 'database' | 'schema'>): boolean {
  const target = tab.unlockedFor;
  return !!tab.writesUnlocked && !!target && target.database === session.database && target.schema === (session.schema ?? null);
}

/** Relation diagram of one database */
export interface DiagramTab {
  id: string;
  kind: 'diagram';
  database: string | null;
  /** Postgres: the schema the diagram shows (absent for MySQL and SQLite) */
  schema?: string | null;
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
  /** user schemas of the selected database (Postgres; [] for MySQL and SQLite) */
  schemas: string[];
  /** the schema the sidebar shows (Postgres); null for MySQL and SQLite, or a database without user schemas */
  schema: string | null;
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
  colorStyle: ColorStyle;
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
  setColorStyle: (s: ColorStyle) => void;
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
  /** Reloads the tables of the selected database (Postgres: also its schemas, keeping the selected one when it still exists) */
  refreshObjects: (cid: string) => Promise<void>;
  /** Shows another Postgres schema in the sidebar (and makes it the default for Claude and `udb`) */
  setSchema: (cid: string, schema: string) => Promise<void>;
  /** Lets this tab change data on a prod Postgres connection; other tabs stay read-only */
  unlockWrites: (cid: string, tabId: string) => void;
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
  /** Opens the relation diagram of the selected database (one tab per database; Postgres: per schema) */
  openDiagram: (cid: string, focus?: string) => void;
  closeTab: (cid: string, tabId: string) => Promise<void>;
  /** Closes several tabs; asks once when some of them have unsaved changes */
  closeTabs: (cid: string, tabIds: string[]) => Promise<void>;
  /** Moves a tab to a new place in the tab bar (index among the other tabs) */
  moveTab: (cid: string, tabId: string, toIndex: number) => void;
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

const readColorStyle = (): ColorStyle => {
  try {
    return localStorage.getItem('rowline.style') === 'warm' ? 'warm' : 'blue';
  } catch {
    return 'blue';
  }
};

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

/** Key of per-database sidebar lists (pinned, recent) and schema data; Postgres adds the schema (`id/shop/billing`) */
export const tableKey = (cid: string, database: string | null, schema?: string | null) => `${cid}/${scopeKey(database, schema) ?? ''}`;

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
    colorStyle: readColorStyle(),
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

    setColorStyle: (colorStyle) => {
      try {
        localStorage.setItem('rowline.style', colorStyle);
      } catch {
        /* storage not available */
      }
      applyColorStyle(colorStyle);
      set({ colorStyle });
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
        const databases = isServer(config.engine) ? await api.listDatabases(id) : ['main'];
        const database = isServer(config.engine) ? config.database || info.currentDatabase || null : null;
        api.setActiveDatabase(id, database).catch(() => {});
        const restored = loadSavedTabs(id);
        set({
          workspaces: {
            ...get().workspaces,
            [id]: {
              session: { connectionId: id, config, info, databases, database, schemas: [], schema: null, objects: [], loadingObjects: false },
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
        if (!isServer(config.engine) || database) await get().refreshObjects(id);
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
        const databases = isServer(config.engine) ? await api.listDatabases(id) : ['main'];
        const current = w.session.database;
        const database = isServer(config.engine) ? (current && databases.includes(current) ? current : config.database || info.currentDatabase || null) : null;
        // the schema stays when the database stays (refreshObjects checks it still exists); the backend forgot it on disconnect
        const schema = config.engine === 'postgres' && database === current ? w.session.schema : null;
        patchSession(id, () => ({ config, info, databases, database, schemas: [], schema, objects: [] }));
        if (!isServer(config.engine) || database) await get().refreshObjects(id);
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
      // query tabs follow the picker: their unlock was for the old database
      patchWs(cid, (ws) => ({ tabs: ws.tabs.map(lockQueryTab) }));
      // Postgres: the new database gets its own schemas and default schema
      patchSession(cid, () => ({ database: db, schemas: [], schema: null, objects: [] }));
      api.setActiveDatabase(cid, db).catch(() => {});
      await get().refreshObjects(cid);
    },

    refreshObjects: async (cid) => {
      const w = get().workspaces[cid];
      if (!w) return;
      const { database, schema } = w.session;
      patchSession(cid, () => ({ loadingObjects: true }));
      try {
        if (w.session.config.engine !== 'postgres') {
          const objects = await api.listObjects(cid, database);
          patchSession(cid, (s) => (s.database === database ? { objects, loadingObjects: false } : {}));
          return;
        }
        const schemas = database ? await api.listSchemas(cid, database) : [];
        const picked =
          schema && schemas.includes(schema) ? { schema, objects: await api.listObjects(cid, database, schema) } : await pickSchema(schemas, (sc) => api.listObjects(cid, database, sc));
        let applied = false;
        patchSession(cid, (s) => {
          // the user picked another database or schema meanwhile: that load wins
          if (s.database !== database || s.schema !== schema) return {};
          applied = true;
          return { schemas, schema: picked.schema, objects: picked.objects, loadingObjects: false };
        });
        if (applied) api.setActiveSchema(cid, picked.schema).catch(() => {});
      } catch (e) {
        patchSession(cid, () => ({ loadingObjects: false }));
        get().toast((e as Error).message, 'error');
      }
    },

    setSchema: async (cid, schema) => {
      const w = get().workspaces[cid];
      if (!w || w.session.config.engine !== 'postgres' || w.session.schema === schema) return;
      patchWs(cid, (ws) => ({ tabs: ws.tabs.map(lockQueryTab) }));
      patchSession(cid, () => ({ schema, objects: [] }));
      await get().refreshObjects(cid);
    },

    unlockWrites: (cid, id) =>
      patchWs(cid, (w) => ({
        tabs: w.tabs.map((t) => {
          if (t.id !== id || t.kind === 'diagram') return t;
          // a query tab runs against the sidebar's database and schema: the unlock is for those only
          if (t.kind === 'query') return { ...t, writesUnlocked: true, unlockedFor: { database: w.session.database, schema: w.session.schema ?? null } };
          return { ...t, writesUnlocked: true };
        }),
      })),

    openTable: (cid, name, kind = 'table', view = 'data', opts = {}) => {
      const w = get().workspaces[cid];
      if (!w) return;
      // Postgres tabs remember their schema; MySQL and SQLite tabs have none
      const pg = w.session.config.engine === 'postgres';
      const schema = pg ? (opts.schema !== undefined ? opts.schema : w.session.schema) : null;
      const where = pg ? { schema } : {};
      const key = tableKey(cid, w.session.database, schema);
      const recent = { ...get().recent, [key]: [name, ...(get().recent[key] ?? []).filter((t) => t !== name)].slice(0, 8) };
      set({ recent });
      writeJson('rowline.recent', recent);
      if (opts.filters || opts.replaceTabId) {
        const tab: TableTab = { id: opts.replaceTabId ?? newTabId(), kind: 'table', table: name, objectKind: kind, view, database: w.session.database, ...where, filters: opts.filters };
        patchWs(cid, (ws) => ({
          tabs: opts.replaceTabId ? ws.tabs.map((t) => (t.id === opts.replaceTabId ? tab : t)) : [...ws.tabs, tab],
          activeTabId: tab.id,
        }));
        return;
      }
      const existing = w.tabs.find((t) => t.kind === 'table' && t.table === name && t.database === w.session.database && (t.schema ?? null) === schema);
      if (existing) {
        patchWs(cid, () => ({ activeTabId: existing.id }));
        if (existing.kind === 'table' && existing.view !== view) get().updateTab(cid, existing.id, { view });
        return;
      }
      const tab: TableTab = { id: newTabId(), kind: 'table', table: name, objectKind: kind, view, database: w.session.database, ...where };
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
      const pg = w.session.config.engine === 'postgres';
      const schema = pg ? w.session.schema : null;
      const existing = w.tabs.find((t) => t.kind === 'diagram' && t.database === w.session.database && (t.schema ?? null) === schema);
      if (existing) {
        patchWs(cid, (ws) => ({ activeTabId: existing.id, tabs: ws.tabs.map((t) => (t.id === existing.id ? { ...t, focus } : t)) }));
        return;
      }
      const tab: DiagramTab = { id: newTabId(), kind: 'diagram', database: w.session.database, ...(pg ? { schema } : {}), focus };
      patchWs(cid, (ws) => ({ tabs: [...ws.tabs, tab], activeTabId: tab.id }));
    },

    updateTab: (cid, id, patch) => patchWs(cid, (w) => ({ tabs: w.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),

    moveTab: (cid, id, to) =>
      patchWs(cid, (w) => {
        const tab = w.tabs.find((t) => t.id === id);
        if (!tab) return {};
        const rest = w.tabs.filter((t) => t.id !== id);
        const at = Math.max(0, Math.min(to, rest.length));
        if (w.tabs[at] === tab) return {};
        return { tabs: [...rest.slice(0, at), tab, ...rest.slice(at)] };
      }),

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
      const key = tableKey(cid, w.session.database, w.session.schema);
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

/** Settings that change how uDB connects; changing any of them needs a reconnect. */
export function needsReconnect(a: ConnectionConfig, b: ConnectionConfig): boolean {
  const keys: (keyof ConnectionConfig)[] = ['engine', 'host', 'port', 'user', 'tls', 'filePath'];
  return keys.some((k) => (a[k] ?? null) !== (b[k] ?? null));
}

/** Sets the light/dark colors on the page (CSS variables follow `data-theme`; "system" follows macOS). */
/** data-style on <html>: 'warm' switches the CSS colors (see styles.css); blue needs no attribute */
export function applyColorStyle(style: ColorStyle) {
  if (typeof document === 'undefined') return;
  if (style === 'warm') document.documentElement.setAttribute('data-style', 'warm');
  else document.documentElement.removeAttribute('data-style');
}

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
    const tabs = saved.tabs.map((t) => ({ ...withoutUnlock(t as Tab), id: newTabId(), autoRun: undefined }) as Tab);
    return { tabs, activeTabId: tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)]?.id ?? null };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

/** A tab without its write unlock: the unlock is never saved or restored */
function withoutUnlock<T extends Tab>(t: T): T {
  if (!('writesUnlocked' in t) && !('unlockedFor' in t)) return t;
  const { writesUnlocked: _unlocked, unlockedFor: _for, ...rest } = t as T & { writesUnlocked?: unknown; unlockedFor?: unknown };
  return rest as unknown as T;
}

/** A query tab locked again (the database or schema it writes to changed) */
function lockQueryTab(t: Tab): Tab {
  return t.kind === 'query' ? withoutUnlock(t) : t;
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
        localStorage.setItem(TABS_KEY(cid), JSON.stringify({ tabs: tabs.map((t) => ({ ...withoutUnlock(t), id: undefined, autoRun: undefined })), active }));
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
