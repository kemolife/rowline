import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  isTauri: false,
  api: {
    listSchemas: vi.fn(async () => ['public', 'billing']),
    listObjects: vi.fn(async () => [{ name: 'invoices', kind: 'table', rowEstimate: 1 }]),
    setActiveSchema: vi.fn(async () => true),
  },
  confirmDialog: vi.fn(async () => true),
  logClientError: vi.fn(),
}));

import { api } from '../lib/api';
import type { Engine } from '../lib/types';
import { useApp, type Session } from '../store/app';
import { ConnectionScope } from '../store/workspace';
import Sidebar from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout
Element.prototype.scrollIntoView ??= () => {};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function renderSidebar(engine: Engine, schemas: string[], schema: string | null) {
  const session: Session = {
    connectionId: 'p',
    config: { id: 'p', name: 'p', engine, environment: 'dev' },
    info: { version: 'v', currentDatabase: 'shop' },
    databases: ['shop'],
    database: 'shop',
    schemas,
    schema,
    // a Postgres database without user schemas has no tables
    objects: engine === 'postgres' && !schemas.length ? [] : [{ name: 'orders', kind: 'table', rowEstimate: 1 }],
    loadingObjects: false,
  };
  useApp.setState({ workspaces: { p: { session, tabs: [], activeTabId: null, dirtyTabs: {} } }, activeConnectionId: 'p', openOrder: ['p'] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <ConnectionScope id="p">
        <Sidebar />
      </ConnectionScope>,
    ),
  );
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

it('hides the schema picker when the database has one schema or none', () => {
  let host = renderSidebar('postgres', ['public'], 'public');
  expect(host.querySelector('[data-testid=schema-picker]')).toBeNull();
  expect(host.querySelector('[data-testid=table-filter]')).not.toBeNull();
  cleanup!();
  host = renderSidebar('postgres', [], null);
  expect(host.querySelector('[data-testid=schema-picker]')).toBeNull();
  expect(host.textContent).toContain('No tables');
});

it('shows the schema picker above the table filter with two schemas, and switches schema', async () => {
  const host = renderSidebar('postgres', ['public', 'billing'], 'public');
  const picker = host.querySelector<HTMLSelectElement>('[data-testid=schema-picker]')!;
  expect(picker).not.toBeNull();
  expect([...picker.options].map((o) => o.value)).toEqual(['public', 'billing']);
  expect(picker.value).toBe('public');
  // above the filter
  const filter = host.querySelector('[data-testid=table-filter]')!;
  expect(picker.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await act(async () => {
    picker.value = 'billing';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(useApp.getState().workspaces.p.session.schema).toBe('billing');
  expect(api.listObjects).toHaveBeenLastCalledWith('p', 'shop', 'billing');
});

it('MySQL shows no schema picker', () => {
  const host = renderSidebar('mysql', [], null);
  expect(host.querySelector('[data-testid=schema-picker]')).toBeNull();
  expect(host.querySelector('[data-testid=database-select]')).not.toBeNull();
});
