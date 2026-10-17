import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmAnswer = { value: true };
vi.mock('../lib/api', () => ({
  isTauri: false,
  api: {
    listConnections: vi.fn(async () => []),
    connect: vi.fn(async () => ({ version: 'v', currentDatabase: 'shop' })),
    disconnect: vi.fn(async () => true),
    deleteConnection: vi.fn(async () => true),
    saveConnection: vi.fn(async (c: unknown) => c),
    listDatabases: vi.fn(async () => ['shop']),
    listObjects: vi.fn(async () => [{ name: 'orders', kind: 'table', rowEstimate: 1 }]),
  },
  confirmDialog: vi.fn(async () => confirmAnswer.value),
}));

import { api } from '../lib/api';
import { activeWorkspace, needsReconnect, useApp } from './app';

const conn = (id: string, engine: 'mysql' | 'sqlite' = 'mysql') => ({ id, name: id, engine, environment: 'dev' as const });

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
