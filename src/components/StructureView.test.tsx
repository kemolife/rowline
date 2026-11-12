import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { TableStructure } from '../lib/types';
import StructureView from './StructureView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const values = Array.from({ length: 14 }, (_, i) => `s${i + 1}`);
const structure: TableStructure = {
  name: 'jobs',
  kind: 'table',
  columns: [{ name: 'status', dataType: `enum(${values.map((v) => `'${v}'`).join(',')})`, nullable: false, defaultValue: 's12', primaryKey: false, autoIncrement: false, comment: null }],
  indexes: [],
  foreignKeys: [],
  ddl: null,
};

it('a long enum shows the first values and the default, the rest after a click', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<StructureView structure={structure} />));
  const chips = () => [...host.querySelectorAll('[data-testid=enum-value]')].map((e) => e.textContent);
  expect(chips()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's12']);
  act(() => (host.querySelector('[data-testid=enum-more]') as HTMLButtonElement).click());
  expect(chips()).toEqual(values);
  act(() => root.unmount());
  host.remove();
});
