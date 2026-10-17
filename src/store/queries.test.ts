import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  isTauri: false,
  api: {
    connect: vi.fn(async () => ({ version: 'v', currentDatabase: null })),
    listObjects: vi.fn(async () => []),
    listSavedQueries: vi.fn(async () => []),
    saveQuery: vi.fn(async (q: Record<string, unknown>) => ({ id: q.id || 'new-id', updatedAt: 'now', database: null, ...q })),
    deleteSavedQuery: vi.fn(async () => true),
  },
  confirmDialog: vi.fn(async () => true),
}));

import { api } from '../lib/api';
import { firstLine, historyTime } from '../components/HistoryPane';
import { useApp } from './app';
import { useQueries } from './queries';

const q = (id: string, name: string) => ({ id, connectionId: 'c', name, sql: `SELECT '${name}'`, database: null, updatedAt: 'x' });

describe('saved queries', () => {
  beforeEach(async () => {
    useQueries.setState({ byConnection: {} });
    useApp.setState({ connections: [{ id: 'c', name: 'c', engine: 'sqlite', environment: 'local' }], workspaces: {}, openOrder: [], activeConnectionId: null });
    await useApp.getState().connect('c');
  });

  it('loads sorted by name and keeps the list sorted after saving', async () => {
    vi.mocked(api.listSavedQueries).mockResolvedValueOnce([q('2', 'zeta'), q('1', 'Alpha')]);
    await useQueries.getState().load('c');
    expect(useQueries.getState().byConnection.c.map((x) => x.name)).toEqual(['Alpha', 'zeta']);
    await useQueries.getState().save({ connectionId: 'c', name: 'beta', sql: 'SELECT 1', database: null });
    expect(useQueries.getState().byConnection.c.map((x) => x.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('opening a saved query twice shows the same tab; renaming updates its title', async () => {
    const saved = q('1', 'Top customers');
    useQueries.setState({ byConnection: { c: [saved] } });
    const s = useApp.getState();
    s.openQuery('c', saved.sql, { title: saved.name, savedQueryId: saved.id });
    s.openQuery('c', saved.sql, { title: saved.name, savedQueryId: saved.id });
    let tabs = useApp.getState().workspaces.c.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'query', title: 'Top customers', savedQueryId: '1' });

    await useQueries.getState().rename(saved, 'Best customers');
    tabs = useApp.getState().workspaces.c.tabs;
    expect(tabs[0]).toMatchObject({ title: 'Best customers' });
    expect(useQueries.getState().byConnection.c[0].name).toBe('Best customers');
  });

  it('deleting a saved query unlinks its open tab', async () => {
    const saved = q('1', 'Old');
    useQueries.setState({ byConnection: { c: [saved] } });
    useApp.getState().openQuery('c', saved.sql, { title: saved.name, savedQueryId: saved.id });
    await useQueries.getState().remove(saved);
    expect(useQueries.getState().byConnection.c).toEqual([]);
    expect(useApp.getState().workspaces.c.tabs[0]).toMatchObject({ title: 'Old', savedQueryId: undefined });
  });
});

describe('history helpers', () => {
  it('shows the first line of a statement', () => {
    expect(firstLine('  SELECT *\n  FROM   t\nLIMIT 5')).toBe('SELECT *');
    expect(firstLine('select   a,\tb')).toBe('select a, b');
  });

  it('shows short times', () => {
    const now = new Date('2026-10-15T15:00:00');
    expect(historyTime('2026-10-15T12:04:00', now)).toMatch(/12[:.]04/);
    expect(historyTime('2026-10-13T12:04:00', now)).not.toBe(historyTime('2026-10-15T12:04:00', now));
    expect(historyTime('2026-09-01T12:04:00', now)).toMatch(/Sep|9/);
  });
});
