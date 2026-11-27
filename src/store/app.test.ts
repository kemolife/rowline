import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmAnswer = { value: true };
vi.mock('../lib/api', () => ({
  isTauri: false,
  api: {
    listConnections: vi.fn(async () => []),
    connect: vi.fn(async () => ({ version: 'v', currentDatabase: 'shop' })),
    disconnect: vi.fn(async () => true),
    setActiveDatabase: vi.fn(async () => true),
    deleteConnection: vi.fn(async () => true),
    saveConnection: vi.fn(async (c: unknown) => c),
    listDatabases: vi.fn(async () => ['shop']),
    listObjects: vi.fn(async () => [{ name: 'orders', kind: 'table', rowEstimate: 1 }]),
    listSchemas: vi.fn(async () => [] as string[]),
    setActiveSchema: vi.fn(async () => true),
  },
  confirmDialog: vi.fn(async () => confirmAnswer.value),
}));

import { api } from '../lib/api';
import { activeWorkspace, needsReconnect, useApp } from './app';

const conn = (id: string, engine: 'mysql' | 'sqlite' | 'postgres' = 'mysql', environment: 'dev' | 'prod' = 'dev') => ({ id, name: id, engine, environment });

describe('workspaces', () => {
  beforeEach(() => {
    confirmAnswer.value = true;
    vi.mocked(api.connect).mockClear();
    useApp.setState({ connections: [conn('a'), conn('b', 'sqlite')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
  });

  it('opens several connections and switches between them', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    let s = useApp.getState();
    expect(s.openOrder).toEqual(['a', 'b']);
    expect(s.activeConnectionId).toBe('b');
    await s.connect('a'); // already open: only switches
    s = useApp.getState();
    expect(s.activeConnectionId).toBe('a');
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(activeWorkspace(s)?.session.database).toBe('shop');
  });

  it('keeps tabs per connection', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    useApp.getState().openTable('a', 'orders');
    useApp.getState().openQuery('b', 'select 1', { autoRun: true });
    const s = useApp.getState();
    expect(s.workspaces.a.tabs.map((t) => t.kind)).toEqual(['table']);
    expect(s.workspaces.b.tabs).toMatchObject([{ kind: 'query', sql: 'select 1', autoRun: true }]);
    expect(s.workspaces.b.activeTabId).toBe(s.workspaces.b.tabs[0].id);
  });

  it('opens a query in the database Claude used, not the selected one', async () => {
    await useApp.getState().connect('a');
    useApp.getState().openQuery('a', 'select 1', { autoRun: true, database: 'analytics' });
    useApp.getState().openQuery('a', 'select 2', { database: null });
    const tabs = useApp.getState().workspaces.a.tabs;
    expect(tabs).toMatchObject([{ sql: 'select 1', database: 'analytics' }, { sql: 'select 2', database: 'shop' }]);
  });

  it('disconnecting the active connection activates a neighbour', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    await useApp.getState().disconnect('b');
    const s = useApp.getState();
    expect(s.openOrder).toEqual(['a']);
    expect(s.activeConnectionId).toBe('a');
    expect(s.workspaces.b).toBeUndefined();
  });

  it('asks before disconnecting with unsaved edits', async () => {
    await useApp.getState().connect('a');
    useApp.getState().openTable('a', 'orders');
    const tabId = useApp.getState().workspaces.a.tabs[0].id;
    useApp.getState().setDirty('a', tabId, 2);
    confirmAnswer.value = false;
    await useApp.getState().disconnect('a');
    expect(useApp.getState().openOrder).toEqual(['a']);
  });

  it('a double-click connects once and switching closes the palette', async () => {
    const first = useApp.getState().connect('a');
    const second = useApp.getState().connect('a');
    await Promise.all([first, second]);
    expect(api.connect).toHaveBeenCalledTimes(1);
    await useApp.getState().connect('b');
    useApp.getState().setPaletteOpen(true);
    useApp.getState().switchTo('a');
    expect(useApp.getState().paletteOpen).toBe(false);
    useApp.getState().setPaletteOpen(true);
    useApp.getState().showLauncher(true);
    expect(useApp.getState().paletteOpen).toBe(false);
  });

  it('the launcher shows the connection list without closing connections', async () => {
    await useApp.getState().connect('a');
    useApp.getState().showLauncher(true);
    expect(useApp.getState().launcherOpen).toBe(true);
    await useApp.getState().connect('a');
    expect(useApp.getState().launcherOpen).toBe(false);
  });
});

import { initials } from '../components/ConnectionRail';

describe('rail initials', () => {
  it('uses two letters', () => {
    expect(initials('development-core-cluster')).toBe('DC');
    expect(initials('shop')).toBe('SH');
    expect(initials('   ')).toBe('?');
  });
});

describe('deleting a connection', () => {
  beforeEach(() => {
    confirmAnswer.value = true;
    vi.mocked(api.deleteConnection).mockClear();
    vi.mocked(api.disconnect).mockClear();
    useApp.setState({ connections: [conn('a')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
  });

  it('disconnects an open connection first', async () => {
    await useApp.getState().connect('a');
    expect(await useApp.getState().deleteConnection('a')).toBe(true);
    expect(api.disconnect).toHaveBeenCalledWith('a');
    expect(api.deleteConnection).toHaveBeenCalledWith('a');
    expect(useApp.getState().workspaces.a).toBeUndefined();
    expect(vi.mocked(api.disconnect).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.deleteConnection).mock.invocationCallOrder[0]);
  });

  it('keeps it when the user cancels the disconnect (unsaved changes)', async () => {
    await useApp.getState().connect('a');
    useApp.getState().setDirty('a', 't1', 2);
    confirmAnswer.value = false;
    expect(await useApp.getState().deleteConnection('a')).toBe(false);
    expect(api.deleteConnection).not.toHaveBeenCalled();
    expect(useApp.getState().workspaces.a).toBeDefined();
  });

  it('deletes a closed connection directly', async () => {
    expect(await useApp.getState().deleteConnection('a')).toBe(true);
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(api.deleteConnection).toHaveBeenCalledWith('a');
  });
});

describe('editing open connections', () => {
  beforeEach(() => {
    confirmAnswer.value = true;
    vi.mocked(api.connect).mockClear();
    vi.mocked(api.disconnect).mockClear();
    vi.mocked(api.saveConnection).mockClear();
    useApp.setState({ connections: [conn('a')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
  });

  it('knows which changes need a reconnect', () => {
    const base = { ...conn('a'), host: 'h', port: 3306, user: 'u', tls: 'off' as const };
    expect(needsReconnect(base, { ...base, name: 'new name', environment: 'prod', database: 'x', claudeAccess: 'off' })).toBe(false);
    expect(needsReconnect(base, { ...base, host: 'other' })).toBe(true);
    expect(needsReconnect(base, { ...base, port: 3307 })).toBe(true);
    expect(needsReconnect(base, { ...base, tls: 'required' })).toBe(true);
    // a missing field and null mean the same
    expect(needsReconnect({ ...base, filePath: undefined }, { ...base, filePath: null })).toBe(false);
  });

  it('renames an open connection everywhere', async () => {
    await useApp.getState().connect('a');
    vi.mocked(api.listConnections).mockResolvedValueOnce([{ ...conn('a'), name: 'Shop prod' }]);
    await useApp.getState().renameConnection('a', '  Shop prod  ');
    expect(api.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', name: 'Shop prod', password: undefined }));
    expect(useApp.getState().connections[0].name).toBe('Shop prod');
    expect(useApp.getState().workspaces.a.session.config.name).toBe('Shop prod');
  });

  it('a name-only edit updates the workspace without reconnecting', async () => {
    await useApp.getState().connect('a');
    await useApp.getState().applySavedConnection({ ...conn('a'), name: 'Renamed', environment: 'prod' }, false);
    expect(useApp.getState().workspaces.a.session.config).toMatchObject({ name: 'Renamed', environment: 'prod' });
    expect(api.disconnect).not.toHaveBeenCalled();
  });

  it('a new host offers a reconnect that keeps the tabs', async () => {
    await useApp.getState().connect('a');
    useApp.getState().openTable('a', 'orders');
    const moved = { ...conn('a'), host: 'db2' };
    useApp.setState({ connections: [moved] });
    await useApp.getState().applySavedConnection(moved, false);
    expect(api.disconnect).toHaveBeenCalledWith('a');
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(useApp.getState().workspaces.a.tabs).toHaveLength(1);
    expect(useApp.getState().workspaces.a.session.config.host).toBe('db2');
  });

  it('a changed password asks too, and "no" keeps the old session', async () => {
    await useApp.getState().connect('a');
    confirmAnswer.value = false;
    await useApp.getState().applySavedConnection(conn('a'), true);
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(api.connect).toHaveBeenCalledTimes(1);
  });
});

describe('theme', () => {
  it('switches the page colors at once, before components re-render', () => {
    let seenDuringRender: string | null = 'unset';
    const unsub = useApp.subscribe((state) => {
      // a subscriber runs where a component would re-render: the page must already have the new colors
      seenDuringRender = document.documentElement.getAttribute('data-theme');
      void state;
    });
    useApp.getState().setTheme('light');
    expect(seenDuringRender).toBe('light');
    useApp.getState().setTheme('system');
    expect(seenDuringRender).toBeNull();
    useApp.getState().setTheme('dark');
    expect(seenDuringRender).toBe('dark');
    unsub();
  });
});

describe('closing several tabs', () => {
  beforeEach(async () => {
    confirmAnswer.value = true;
    useApp.setState({ connections: [conn('a')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
    await useApp.getState().connect('a');
    const s = useApp.getState();
    for (const sql of ['q1', 'q2', 'q3', 'q4']) s.openQuery('a', sql);
  });
  const tabs = () => useApp.getState().workspaces.a.tabs;

  it('moves a tab to another place', () => {
    const [t1, t2, t3, t4] = tabs().map((t) => t.id);
    useApp.getState().moveTab('a', t1, 2);
    expect(tabs().map((t) => t.id)).toEqual([t2, t3, t1, t4]);
    useApp.getState().moveTab('a', t4, 0);
    expect(tabs().map((t) => t.id)).toEqual([t4, t2, t3, t1]);
    useApp.getState().moveTab('a', t2, 99);
    expect(tabs().map((t) => t.id)).toEqual([t4, t3, t1, t2]);
  });

  it('closes others and keeps the right tab active', async () => {
    const [t1, t2, t3, t4] = tabs().map((t) => t.id);
    useApp.getState().setActiveTab('a', t3);
    await useApp.getState().closeTabs('a', [t1, t2, t4]);
    expect(tabs().map((t) => t.id)).toEqual([t3]);
    expect(useApp.getState().workspaces.a.activeTabId).toBe(t3);
  });

  it('moves to the nearest tab on the left when the active one closes', async () => {
    const [t1, t2, t3, t4] = tabs().map((t) => t.id);
    useApp.getState().setActiveTab('a', t3);
    await useApp.getState().closeTabs('a', [t3, t4]);
    expect(tabs().map((t) => t.id)).toEqual([t1, t2]);
    expect(useApp.getState().workspaces.a.activeTabId).toBe(t2);
  });

  it('asks once for unsaved changes and keeps everything when the answer is no', async () => {
    const ids = tabs().map((t) => t.id);
    useApp.getState().setDirty('a', ids[0], 2);
    useApp.getState().setDirty('a', ids[1], 1);
    confirmAnswer.value = false;
    await useApp.getState().closeTabs('a', ids);
    expect(tabs()).toHaveLength(4);
    confirmAnswer.value = true;
    await useApp.getState().closeTabs('a', ids);
    expect(tabs()).toHaveLength(0);
    expect(useApp.getState().workspaces.a.activeTabId).toBeNull();
    expect(useApp.getState().workspaces.a.dirtyTabs).toEqual({});
  });
});

describe('projects in the rail', () => {
  it('opens a connection next to the open ones of its project', async () => {
    useApp.setState({
      connections: [
        { ...conn('a1'), group: 'A' },
        { ...conn('b1'), group: 'B' },
        { ...conn('a2'), group: 'A' },
      ],
      workspaces: {},
      openOrder: [],
      activeConnectionId: null,
    });
    for (const id of ['a1', 'b1', 'a2']) await useApp.getState().connect(id);
    expect(useApp.getState().openOrder).toEqual(['a1', 'a2', 'b1']);
  });
});


describe('color style', () => {
  it('is saved and switches the data-style attribute, apart from light/dark', () => {
    useApp.getState().setColorStyle('warm');
    expect(document.documentElement.getAttribute('data-style')).toBe('warm');
    expect(localStorage.getItem('rowline.style')).toBe('warm');
    useApp.getState().setTheme('light');
    expect(document.documentElement.getAttribute('data-style')).toBe('warm');
    useApp.getState().setColorStyle('blue');
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    expect(useApp.getState().colorStyle).toBe('blue');
  });
});

describe('postgres schemas', () => {
  const objects: Record<string, { name: string; kind: 'table' | 'view'; rowEstimate: number | null }[]> = {
    public: [],
    billing: [{ name: 'invoices', kind: 'table', rowEstimate: 3 }],
    sales: [{ name: 'orders', kind: 'table', rowEstimate: 9 }],
  };
  beforeEach(() => {
    vi.mocked(api.listSchemas).mockReset().mockResolvedValue(['public', 'billing', 'sales']);
    vi.mocked(api.setActiveSchema).mockClear();
    vi.mocked(api.listObjects).mockReset().mockImplementation(async (_id, _db, schema) => objects[schema ?? 'public'] ?? []);
    vi.mocked(api.listDatabases).mockResolvedValue(['shop', 'crm']);
    useApp.setState({ connections: [conn('p', 'postgres')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
  });
  const session = () => useApp.getState().workspaces.p.session;

  it('picks the first schema with tables when public is empty and tells the backend', async () => {
    await useApp.getState().connect('p');
    expect(api.listSchemas).toHaveBeenCalledWith('p', 'shop');
    expect(session()).toMatchObject({ database: 'shop', schemas: ['public', 'billing', 'sales'], schema: 'billing' });
    expect(session().objects.map((o) => o.name)).toEqual(['invoices']);
    expect(api.setActiveSchema).toHaveBeenCalledWith('p', 'billing');
  });

  it('switches schema and lists its tables', async () => {
    await useApp.getState().connect('p');
    await useApp.getState().setSchema('p', 'sales');
    expect(session().schema).toBe('sales');
    expect(session().objects.map((o) => o.name)).toEqual(['orders']);
    expect(api.setActiveSchema).toHaveBeenLastCalledWith('p', 'sales');
    expect(api.listObjects).toHaveBeenLastCalledWith('p', 'shop', 'sales');
  });

  it('keeps the chosen schema on reconnect', async () => {
    await useApp.getState().connect('p');
    await useApp.getState().setSchema('p', 'sales');
    await useApp.getState().reconnect('p');
    expect(session().schema).toBe('sales');
    expect(session().objects.map((o) => o.name)).toEqual(['orders']);
  });

  it('loads the schemas of another database', async () => {
    await useApp.getState().connect('p');
    vi.mocked(api.listSchemas).mockResolvedValue(['public']);
    objects.public = [{ name: 'leads', kind: 'table', rowEstimate: 1 }];
    try {
      await useApp.getState().selectDatabase('p', 'crm');
      expect(api.listSchemas).toHaveBeenLastCalledWith('p', 'crm');
      expect(session()).toMatchObject({ database: 'crm', schemas: ['public'], schema: 'public' });
      expect(session().objects.map((o) => o.name)).toEqual(['leads']);
    } finally {
      objects.public = [];
    }
  });

  it('shows no tables for a database without user schemas', async () => {
    vi.mocked(api.listSchemas).mockResolvedValue([]);
    await useApp.getState().connect('p');
    expect(session()).toMatchObject({ schemas: [], schema: null, objects: [], loadingObjects: false });
    expect(api.listObjects).not.toHaveBeenCalled();
  });

  it('MySQL and SQLite have no schemas', async () => {
    useApp.setState({ connections: [conn('a'), conn('b', 'sqlite')] });
    await useApp.getState().connect('a');
    await useApp.getState().connect('b');
    expect(api.listSchemas).not.toHaveBeenCalled();
    expect(useApp.getState().workspaces.a.session).toMatchObject({ schemas: [], schema: null });
    expect(useApp.getState().workspaces.b.session).toMatchObject({ schemas: [], schema: null });
  });
});

describe('postgres table tabs', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.mocked(api.listSchemas).mockReset().mockResolvedValue(['public', 'billing']);
    vi.mocked(api.listObjects).mockReset().mockImplementation(async (_id, _db, schema) => [{ name: schema === 'billing' ? 'invoices' : 'orders', kind: 'table', rowEstimate: 1 }]);
    useApp.setState({ connections: [conn('p', 'postgres')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false, pinned: {}, recent: {} });
    await useApp.getState().connect('p');
  });
  const tabs = () => useApp.getState().workspaces.p.tabs;

  it('a table tab keeps the schema it was opened in', async () => {
    useApp.getState().openTable('p', 'orders');
    await useApp.getState().setSchema('p', 'billing');
    useApp.getState().openTable('p', 'invoices');
    expect(tabs()).toMatchObject([
      { kind: 'table', table: 'orders', database: 'shop', schema: 'public' },
      { kind: 'table', table: 'invoices', database: 'shop', schema: 'billing' },
    ]);
  });

  it('the same table name in two schemas opens two tabs; the same schema reuses the tab', async () => {
    useApp.getState().openTable('p', 'orders');
    useApp.getState().openTable('p', 'orders', 'table', 'data', { schema: 'billing' });
    useApp.getState().openTable('p', 'orders');
    expect(tabs().map((t) => (t.kind === 'table' ? `${t.schema}.${t.table}` : ''))).toEqual(['public.orders', 'billing.orders']);
    expect(useApp.getState().workspaces.p.activeTabId).toBe(tabs()[0].id);
  });

  it('pins and recent tables are kept per schema', async () => {
    useApp.getState().togglePin('p', 'orders');
    useApp.getState().openTable('p', 'orders');
    expect(useApp.getState().pinned['p/shop/public']).toEqual(['orders']);
    expect(useApp.getState().recent['p/shop/public']).toEqual(['orders']);
    expect(useApp.getState().pinned['p/shop']).toBeUndefined();
  });

  it('a diagram tab belongs to one schema', async () => {
    useApp.getState().openDiagram('p');
    await useApp.getState().setSchema('p', 'billing');
    useApp.getState().openDiagram('p');
    expect(tabs()).toMatchObject([{ kind: 'diagram', schema: 'public' }, { kind: 'diagram', schema: 'billing' }]);
  });

  it('MySQL tabs have no schema and keep their keys', async () => {
    useApp.setState({ connections: [conn('a')] });
    await useApp.getState().connect('a');
    useApp.getState().openTable('a', 'orders');
    useApp.getState().togglePin('a', 'orders');
    expect(useApp.getState().workspaces.a.tabs[0]).not.toHaveProperty('schema');
    expect(useApp.getState().pinned['a/shop']).toEqual(['orders']);
  });
});

describe('unlocking writes per tab', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.mocked(api.listSchemas).mockResolvedValue(['public']);
    useApp.setState({ connections: [conn('p', 'postgres', 'prod')], workspaces: {}, openOrder: [], activeConnectionId: null, launcherOpen: false });
    await useApp.getState().connect('p');
    useApp.getState().openQuery('p', 'update a set b = 1');
    useApp.getState().openTable('p', 'orders');
  });
  const tabs = () => useApp.getState().workspaces.p.tabs;
  const unlocked = (id: string) => (tabs().find((t) => t.id === id) as { writesUnlocked?: boolean } | undefined)?.writesUnlocked ?? false;

  it('unlocks one tab only, and closing it drops the unlock', async () => {
    const [a, b] = tabs().map((t) => t.id);
    useApp.getState().unlockWrites('p', a);
    expect(unlocked(a)).toBe(true);
    expect(unlocked(b)).toBe(false);
    await useApp.getState().closeTab('p', a);
    expect(tabs().map((t) => t.id)).toEqual([b]);
    expect(unlocked(b)).toBe(false);
    expect(tabs().some((t) => 'writesUnlocked' in t && t.writesUnlocked)).toBe(false);
  });

  it('closing several tabs drops their unlock too', async () => {
    const [a, b] = tabs().map((t) => t.id);
    useApp.getState().unlockWrites('p', a);
    useApp.getState().unlockWrites('p', b);
    await useApp.getState().closeTabs('p', [a]);
    expect(unlocked(b)).toBe(true);
    expect(tabs()).toHaveLength(1);
  });

  it('is never saved with the tabs and never restored', async () => {
    const [a] = tabs().map((t) => t.id);
    useApp.getState().unlockWrites('p', a);
    await new Promise((r) => setTimeout(r, 350));
    const saved = localStorage.getItem('rowline.tabs.p') ?? '';
    expect(saved).toContain('update a set b = 1');
    expect(saved).not.toContain('writesUnlocked');
    // a saved copy that has the flag anyway (older build, edited storage) is restored locked
    localStorage.setItem('rowline.tabs.p', JSON.stringify({ tabs: [{ kind: 'query', title: 'Q', sql: 'x', database: 'shop', writesUnlocked: true }], active: 0 }));
    await useApp.getState().disconnect('p');
    await useApp.getState().connect('p');
    expect(tabs()).toHaveLength(1);
    expect(unlocked(tabs()[0].id)).toBe(false);
  });
});
